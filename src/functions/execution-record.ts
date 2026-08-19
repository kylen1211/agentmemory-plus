import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  ExecutionDetail,
  MemoryProvider,
  RawObservation,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SELF_REPORT_SYSTEM, buildSelfReportPrompt } from "../prompts/self-report.js";
import { compressWithRetry } from "../eval/self-correct.js";
import { scoreCompression } from "../eval/quality.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { logger } from "../logger.js";

// FR-2 / design.md ADR-4 + appendix A-3.
//
// Deliberately does NOT import getSearchIndex / vectorIndexAddGuarded
// from ./search.js anywhere in this file — the FR-2 hard constraint
// ("绝不调用 getSearchIndex().add() / vectorIndexAddGuarded()") is
// enforced structurally here, not just by omission at call sites.

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Deterministic, not random — this is what makes re-triggering with the
// same observationId idempotent (A-3: "同一 observationId 重复触发覆盖
// 同一条记录,不产生第二条"). Distinct from `data.observationId` itself:
// the raw subagent_stop observation this call was triggered from also
// independently becomes a "flow" record (compress.ts) at that same id,
// in the same KV.observations(sessionId) scope — self_report needs its
// own key or the two records collide despite design.md's "同 scope" only
// meaning "same collection", not "same id" (self_report and flow are two
// separate records that must both survive under one sessionId).
function selfReportRecordId(observationId: string): string {
  return `sr_${observationId}`;
}

function parseSelfReportXml(
  xml: string,
): { executionDetail: ExecutionDetail; importance: number } | null {
  const task = getXmlTag(xml, "task");
  const selfAssessment = getXmlTag(xml, "self_assessment");
  // task/self_assessment are the two fields the prompt requires to always
  // be non-empty; key_decisions/deviations may legitimately be empty
  // arrays (a clean self-report with no notable decisions or deviations
  // is a valid outcome, not an extraction failure).
  if (!task || !selfAssessment) return null;

  const decisionBlocks = getXmlChildren(xml, "key_decisions", "decision");
  const keyDecisions = decisionBlocks.map((block) => ({
    decision: getXmlTag(block, "what"),
    tool: getXmlTag(block, "tool"),
    reason: getXmlTag(block, "reason"),
  }));
  const deviations = getXmlChildren(xml, "deviations", "deviation");

  const importanceRaw = parseInt(getXmlTag(xml, "importance") || "5", 10);
  const importance = Math.max(
    1,
    Math.min(10, Number.isNaN(importanceRaw) ? 5 : importanceRaw),
  );

  return {
    executionDetail: { task, keyDecisions, deviations, selfAssessment },
    importance,
  };
}

export function registerExecutionRecordFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction(
    "mem::exec-self-report",
    async (data: {
      observationId: string;
      sessionId: string;
      raw: RawObservation;
    }) => {
      const startMs = Date.now();
      const recordId = selfReportRecordId(data.observationId);
      const assistantResponse =
        typeof data.raw.assistantResponse === "string"
          ? data.raw.assistantResponse
          : "";

      // observe.ts only triggers this function when assistantResponse is
      // already known non-empty (the gate lives there so the Void()
      // trigger itself is skipped entirely for empty reports). Defended
      // again here in case mem::exec-self-report is ever invoked directly
      // (e.g. a retry/replay path) with a stale or malformed payload.
      if (!assistantResponse.trim()) {
        return { success: false, error: "extract_failed" as const };
      }

      const baseRecord = {
        id: recordId,
        sessionId: data.sessionId,
        timestamp: data.raw.timestamp,
        type: "subagent" as const,
        concepts: [] as string[],
        files: [] as string[],
        subject: "execution" as const,
        executionKind: "self_report" as const,
        ...(data.raw.agentId ? { agentId: data.raw.agentId } : {}),
        ...(data.raw.subagentId ? { subagentId: data.raw.subagentId } : {}),
      };

      // PRD FR-2 异常路径: "LLM 结构化抽取自述失败时,fallback 为把原始自述
      // 文本整段存入 narrative 字段、executionDetail 留空,不能因结构化
      // 失败丢失整条记录". Always still a kv.set — the record survives
      // even when structuring it did not.
      async function writeFallback(
        reason: string,
      ): Promise<{ success: true; fallback: true }> {
        const fallback: CompressedObservation = {
          ...baseRecord,
          title: truncate(`Subagent self-report (${reason})`, 80),
          facts: [],
          narrative: assistantResponse,
          importance: 5,
        };
        await kv.set(KV.observations(data.sessionId), recordId, fallback);
        logger.warn(
          "Self-report structured extraction failed, stored raw fallback",
          {
            observationId: data.observationId,
            sessionId: data.sessionId,
            reason,
          },
        );
        return { success: true, fallback: true };
      }

      try {
        const validator = (response: string) => {
          const parsed = parseSelfReportXml(response);
          return parsed
            ? { valid: true }
            : { valid: false, errors: ["xml_parse_failed"] };
        };

        // Same retry-then-fail shape as mem::compress (design.md ADR-4:
        // "复用 compressWithRetry 既有 retry-then-fail").
        const { response, retried } = await compressWithRetry(
          provider,
          SELF_REPORT_SYSTEM,
          buildSelfReportPrompt(assistantResponse),
          validator,
          1,
        );

        const parsed = parseSelfReportXml(response);
        if (!parsed) {
          if (metricsStore) {
            await metricsStore.record(
              "mem::exec-self-report",
              Date.now() - startMs,
              false,
            );
          }
          return await writeFallback("parse_failed");
        }

        const confidence =
          scoreCompression({
            title: parsed.executionDetail.task,
            facts: parsed.executionDetail.keyDecisions.map((d) => d.decision),
            narrative: parsed.executionDetail.selfAssessment,
            concepts: [],
            importance: parsed.importance,
          }) / 100;

        const record: CompressedObservation = {
          ...baseRecord,
          title: truncate(parsed.executionDetail.task, 80),
          facts: parsed.executionDetail.keyDecisions.map((d) =>
            d.tool ? `${d.decision} (tool: ${d.tool})` : d.decision,
          ),
          narrative: parsed.executionDetail.selfAssessment,
          importance: parsed.importance,
          confidence,
          executionDetail: parsed.executionDetail,
        };

        await kv.set(KV.observations(data.sessionId), recordId, record);

        if (metricsStore) {
          await metricsStore.record(
            "mem::exec-self-report",
            Date.now() - startMs,
            true,
            confidence * 100,
          );
        }

        logger.info("Self-report extracted", {
          observationId: data.observationId,
          sessionId: data.sessionId,
          retried,
        });

        return { success: true, executionDetail: parsed.executionDetail };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Self-report extraction threw", {
          observationId: data.observationId,
          sessionId: data.sessionId,
          error: msg,
        });
        try {
          return await writeFallback("exception");
        } catch (writeErr) {
          // Only reachable if the fallback kv.set itself fails (KV write
          // infra failure) — the one case where the record genuinely
          // cannot be saved. This is the only path that returns the
          // A-3-documented `{success:false, error:"extract_failed"}`
          // shape; every recoverable extraction failure above goes
          // through writeFallback() and still returns success:true.
          logger.error("Self-report fallback write failed — record lost", {
            observationId: data.observationId,
            sessionId: data.sessionId,
            error:
              writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
          if (metricsStore) {
            await metricsStore.record(
              "mem::exec-self-report",
              Date.now() - startMs,
              false,
            );
          }
          return { success: false, error: "extract_failed" as const };
        }
      }
    },
  );
}

function byTimestamp(a: CompressedObservation, b: CompressedObservation): number {
  return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
}

// FR-2 / design.md ADR-5: "anomaly:'unpaired' 仅按 subagent_start ↔
// subagent_stop 配对...决定放在 event::session::stopped 做一次会话内扫描".
// Called once from events.ts's event::session::stopped handler.
//
// Pairing key is `subagentId` (the payload's `data.agent_id`, carried via
// RawObservation.subagentId -> CompressedObservation.subagentId — see
// types.ts and observe.ts). Records missing a subagentId (2026-08-19
// front-loaded SDK-type check: SubagentStartHookInput/SubagentStopHookInput
// both declare `agent_id` as a required string, so this should be rare in
// practice — degrade path kept per this task's dispatch instruction, not
// as the expected primary path) fall into a shared bucket paired
// chronologically across the whole session instead of by key.
//
// task_completed flow records are structurally excluded — they're never
// tagged with execHookType (only subagent_start/subagent_stop get that
// field, see observe.ts), so they're invisible to the filter below and
// never enter pairing (PRD appendix D-4: "task_completed 的 payload 不带
// agent_id,数据上无法配对").
export async function scanUnpairedSubagentEvents(
  kv: StateKV,
  sessionId: string,
): Promise<void> {
  let observations: CompressedObservation[];
  try {
    observations = await kv.list<CompressedObservation>(
      KV.observations(sessionId),
    );
  } catch (err) {
    logger.warn("Failed to list observations for unpaired-subagent scan", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const flowRecords = observations.filter(
    (o) =>
      o.executionKind === "flow" &&
      (o.execHookType === "subagent_start" ||
        o.execHookType === "subagent_stop"),
  );
  if (flowRecords.length === 0) return;

  const UNKEYED = " unkeyed";
  const startsByKey = new Map<string, CompressedObservation[]>();
  const stopsByKey = new Map<string, CompressedObservation[]>();

  for (const rec of flowRecords) {
    const key = rec.subagentId || UNKEYED;
    const bucket = rec.execHookType === "subagent_start" ? startsByKey : stopsByKey;
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key)!.push(rec);
  }

  const unpaired: CompressedObservation[] = [];
  const allKeys = new Set([...startsByKey.keys(), ...stopsByKey.keys()]);
  for (const key of allKeys) {
    const keyStarts = (startsByKey.get(key) || []).slice().sort(byTimestamp);
    const keyStops = (stopsByKey.get(key) || []).slice().sort(byTimestamp);
    const pairCount = Math.min(keyStarts.length, keyStops.length);
    unpaired.push(...keyStarts.slice(pairCount), ...keyStops.slice(pairCount));
  }

  for (const rec of unpaired) {
    try {
      await kv.update(KV.observations(sessionId), rec.id, [
        { type: "set", path: "anomaly", value: "unpaired" },
      ]);
    } catch (err) {
      logger.warn("Failed to write anomaly:unpaired", {
        obsId: rec.id,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (unpaired.length > 0) {
    logger.info("Marked unpaired subagent lifecycle events", {
      sessionId,
      count: unpaired.length,
    });
  }
}
