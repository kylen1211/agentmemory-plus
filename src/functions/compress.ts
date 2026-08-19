import { TriggerAction, type ISdk } from "iii-sdk";
import { readFileSync } from "node:fs";
import { isManagedImagePath } from "../utils/image-store.js";
import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
  MemoryProvider,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  COMPRESSION_SYSTEM,
  EXECUTION_FLOW_COMPRESSION_SYSTEM,
  buildCompressionPrompt,
} from "../prompts/compression.js";
import { VISION_DESCRIPTION_PROMPT } from "../prompts/vision.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import { CompressOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreCompression } from "../eval/quality.js";
import { compressWithRetry } from "../eval/self-correct.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { logger } from "../logger.js";
import { shouldPruneLowValue } from "./prune.js";
import { recordAudit } from "./audit.js";
import { isLowValuePruneDryRun } from "../config.js";

const VALID_TYPES = new Set<string>([
  "file_read",
  "file_write",
  "file_edit",
  "command_run",
  "search",
  "web_fetch",
  "conversation",
  "error",
  "decision",
  "discovery",
  "subagent",
  "notification",
  "task",
  "image",
  "other",
]);

function parseCompressionXml(
  xml: string,
): Omit<CompressedObservation, "id" | "sessionId" | "timestamp"> | null {
  const rawType = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  if (!rawType || !title) return null;
  const type = VALID_TYPES.has(rawType) ? rawType : "other";

  return {
    type: type as ObservationType,
    title,
    subtitle: getXmlTag(xml, "subtitle") || undefined,
    facts: getXmlChildren(xml, "facts", "fact"),
    narrative: getXmlTag(xml, "narrative"),
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    importance: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "importance") || "5", 10) || 5),
    ),
  };
}

export function registerCompressFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction("mem::compress", 
    async (data: {
      observationId: string;
      sessionId: string;
      raw: RawObservation;
    }) => {
      const startMs = Date.now();

      let imageDescription: string | undefined;
      const hasImage = data.raw.modality === "image" || data.raw.modality === "mixed";

      if (hasImage && data.raw.imageData && provider.describeImage) {
        try {
          let base64Data = data.raw.imageData;
          let mimeType = "image/png";

          if (!data.raw.imageData.startsWith("/9j/") && !data.raw.imageData.startsWith("iVBOR")) {
            if (!isManagedImagePath(data.raw.imageData)) {
              throw new Error(`Refusing to read image outside managed store: ${data.raw.imageData}`);
            }
            const fileBuffer = readFileSync(data.raw.imageData);
            base64Data = fileBuffer.toString("base64");
            if (data.raw.imageData.endsWith(".jpg") || data.raw.imageData.endsWith(".jpeg")) mimeType = "image/jpeg";
            else if (data.raw.imageData.endsWith(".webp")) mimeType = "image/webp";
            else if (data.raw.imageData.endsWith(".gif")) mimeType = "image/gif";
          }

          imageDescription = await provider.describeImage(base64Data, mimeType, VISION_DESCRIPTION_PROMPT);
          logger.info("Image described by vision model", { obsId: data.observationId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Vision model call failed, falling back to text-only compression", {
            obsId: data.observationId,
            error: msg,
          });
        }
      }

      // FR-2 / design.md ADR-5: execution-subject observations get the
      // slimmed "flow" audit-record prompt (title/facts/narrative only,
      // no concepts/files) instead of the full compression prompt.
      const isExecutionFlow = data.raw.subject === "execution";

      const prompt = buildCompressionPrompt({
        hookType: data.raw.hookType,
        toolName: data.raw.toolName,
        toolInput: data.raw.toolInput,
        toolOutput: imageDescription
          ? `[Image Description]: ${imageDescription}\n\n${data.raw.toolOutput ?? ""}`
          : data.raw.toolOutput,
        userPrompt: data.raw.userPrompt,
        timestamp: data.raw.timestamp,
      });

      try {
        const validator = (response: string) => {
          const parsed = parseCompressionXml(response);
          if (!parsed) return { valid: false, errors: ["xml_parse_failed"] };
          // The flow variant never produces <concepts>/<files> — schema
          // validation still runs against the same CompressOutputSchema,
          // which is fine since parseCompressionXml() already defaults
          // those to empty arrays for absent tags (see below).
          const result = validateOutput(
            CompressOutputSchema,
            parsed,
            "mem::compress",
          );
          return result.valid
            ? { valid: true }
            : { valid: false, errors: result.result.errors };
        };

        const { response, retried } = await compressWithRetry(
          provider,
          isExecutionFlow ? EXECUTION_FLOW_COMPRESSION_SYSTEM : COMPRESSION_SYSTEM,
          prompt,
          validator,
          1,
        );

        const parsed = parseCompressionXml(response);
        if (!parsed) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::compress", latencyMs, false);
          }
          logger.warn("Failed to parse compression XML", {
            obsId: data.observationId,
            retried,
          });
          return { success: false, error: "parse_failed" };
        }

        const qualityScore = scoreCompression(parsed);

        // ADR-7 race guard: observe.ts's dedup-hit path can kv.update
        // repeatCount onto this same record while compression is still
        // in flight (mem::compress is fired Void() before this response
        // returns). This kv.set below is a full-record overwrite, so
        // without reading the current repeatCount first that write would
        // silently get clobbered back to undefined.
        let priorRepeatCount: number | undefined;
        try {
          const priorRecord = await kv.get<{ repeatCount?: number }>(
            KV.observations(data.sessionId),
            data.observationId,
          );
          priorRepeatCount = priorRecord?.repeatCount;
        } catch (err) {
          logger.warn("Failed to read prior record before compress overwrite", {
            obsId: data.observationId,
            sessionId: data.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const compressed: CompressedObservation = {
          id: data.observationId,
          sessionId: data.sessionId,
          timestamp: data.raw.timestamp,
          ...parsed,
          confidence: qualityScore / 100,
          ...(hasImage ? { modality: data.raw.modality } : {}),
          ...(imageDescription ? { imageDescription } : {}),
          ...(data.raw.imageData ? { imageRef: data.raw.imageData } : {}),
          ...(data.raw.agentId ? { agentId: data.raw.agentId } : {}),
          // FR-1: passthrough, same shape as agentId above.
          ...(data.raw.subject ? { subject: data.raw.subject } : {}),
          // FR-6 / ADR-7: carry the dedup-hit counter forward.
          ...(priorRepeatCount ? { repeatCount: priorRepeatCount } : {}),
          // FR-2 / design.md ADR-5: this is the "flow" audit-record half
          // of execution-subject observations (the "self_report" half is
          // a separate record written by execution-record.ts). violation
          // is a pure rule-level string comparison on hookType — never
          // derived from the LLM's XML output above — satisfying PRD
          // FR-2's "产生路径是规则匹配,不经 LLM 输出解析" judgment.
          ...(isExecutionFlow
            ? {
                executionKind: "flow" as const,
                ...(data.raw.hookType === "post_tool_failure"
                  ? { violation: true }
                  : {}),
                ...(data.raw.subagentId
                  ? { subagentId: data.raw.subagentId }
                  : {}),
                ...(data.raw.execHookType
                  ? { execHookType: data.raw.execHookType }
                  : {}),
              }
            : {}),
        };

        // FR-4 bullet 2 / design.md ADR-3: low-value gate sits here —
        // after `compressed` is assembled, strictly before kv.set. A hit
        // deletes the observe-stage raw record and returns; kv.set /
        // getSearchIndex().add() / vectorIndexAddGuarded() below never
        // run, so a pruned record never produces an index entry.
        if (shouldPruneLowValue(compressed)) {
          const dryRun = isLowValuePruneDryRun();
          await recordAudit(
            kv,
            "delete",
            "mem::compress",
            [data.observationId],
            {
              reason: "low_value",
              importance: compressed.importance,
              confidence: compressed.confidence,
              dryRun,
            },
          );
          if (!dryRun) {
            await kv.delete(KV.observations(data.sessionId), data.observationId);
            logger.info("Pruned low-value observation after compression", {
              obsId: data.observationId,
              sessionId: data.sessionId,
              importance: compressed.importance,
              confidence: compressed.confidence,
            });
            return { success: true, pruned: true, reason: "low_value" };
          }
          logger.info("Low-value observation flagged (dry-run, not deleted)", {
            obsId: data.observationId,
            sessionId: data.sessionId,
            importance: compressed.importance,
            confidence: compressed.confidence,
          });
          // Dry-run: fall through to the normal persist/index path below
          // so behavior is unchanged until the dry-run flag is turned off.
        }

        await kv.set(
          KV.observations(data.sessionId),
          data.observationId,
          compressed,
        );

        // FR-2 hard constraint (design.md ADR-5): execution-subject "flow"
        // records are never added to BM25 or the vector index — neither
        // getSearchIndex().add() nor vectorIndexAddGuarded() may be called
        // for them, full stop. This is the flow-record half of "两类记录
        // 都只落 KV...不进检索面"; the self_report half enforces the same
        // rule independently in execution-record.ts.
        if (!isExecutionFlow) {
          try {
            getSearchIndex().add(compressed);
          } catch (err) {
            logger.warn("Failed to index compressed observation into BM25", {
              obsId: compressed.id,
              sessionId: compressed.sessionId,
              title: compressed.title,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          await vectorIndexAddGuarded(
            compressed.id,
            compressed.sessionId,
            compressed.title + " " + (compressed.narrative || ""),
            { kind: "observation", logId: compressed.id },
          );
        }

        const streamResults = await Promise.allSettled([
          sdk.trigger({
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.group(data.sessionId),
              item_id: data.observationId,
              data: { type: "compressed", observation: compressed },
            },
          }),
          sdk.trigger({
            function_id: "stream::send",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.viewerGroup,
              id: `compressed-${data.observationId}`,
              type: "compressed_observation",
              data: {
                type: "compressed",
                observation: compressed,
                sessionId: data.sessionId,
              },
            },
            action: TriggerAction.Void(),
          }),
        ]);
        for (const result of streamResults) {
          if (result.status === "rejected") {
            logger.warn("Non-fatal stream publish failure after compress", {
              sessionId: data.sessionId,
              observationId: data.observationId,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
          }
        }

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::compress",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Observation compressed", {
          obsId: data.observationId,
          type: compressed.type,
          importance: compressed.importance,
          qualityScore,
          retried,
        });

        return { success: true, compressed, qualityScore };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::compress", latencyMs, false);
        }
        logger.error("Compression failed", {
          obsId: data.observationId,
          error: msg,
        });
        return { success: false, error: "compression_failed" };
      }
    },
  );
}
