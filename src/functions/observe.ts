import { TriggerAction, type ISdk } from "iii-sdk";
import type { RawObservation, HookPayload } from "../types.js";
import { KV, STREAM, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAutoCompressEnabled, isExecSelfReportEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import { saveImageToDisk } from "../utils/image-store.js";
import { classifySubject } from "./subject.js";
import { shouldDropEmptyObservation } from "./prune.js";
import { getCounters } from "../telemetry/setup.js";

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction("mem::observe", 
    async (payload: HookPayload) => {

      if (
        !payload?.sessionId ||
        typeof payload.sessionId !== "string" ||
        !payload.hookType ||
        typeof payload.hookType !== "string" ||
        !payload.timestamp ||
        typeof payload.timestamp !== "string"
      ) {
        return {
          success: false,
          error:
            "Invalid payload: sessionId, hookType, and timestamp are required",
        };
      }

      const obsId = generateId("obs");

      let dedupHash: string | undefined;
      if (dedupMap) {
        const d =
          typeof payload.data === "object" && payload.data !== null
            ? (payload.data as Record<string, unknown>)
            : {};
        const rawToolName = d["tool_name"] as string | undefined;
        const hasRealToolName =
          typeof rawToolName === "string" && rawToolName.length > 0;
        // qa-tester P0 fix (pipeline/agentmemory-data-reform, post-deploy):
        // lifecycle events (subagent_start/subagent_stop/task_completed/
        // session_start/notification — anything with no real tool_name,
        // where observe.ts previously fell back to hookType as the "tool
        // name") completely skip the DedupMap — no hash computed, no
        // isDuplicate check, no record() call below. Each such event
        // represents an independent fact and must never be deduplicated
        // against another one, same-session or cross-session. The prior
        // "keep sessionId in the hash" mitigation (ADR-6) only prevented
        // cross-session collisions; real subagent_start/subagent_stop
        // payloads never populate tool_input/tool_output and don't hash
        // agent_id, so two *different* agents dispatched in the SAME
        // session within the TTL window still hashed identically and the
        // second one's self_report silently never fired. Real tool-name
        // observations are unaffected: they still dedup exactly as before.
        if (hasRealToolName) {
          const toolName = rawToolName;
          dedupHash = dedupMap.computeHash(
            toolName,
            d["tool_input"],
            d["tool_output"] ?? d["error"],
          );
          const dup = dedupMap.getEntry(dedupHash);
          if (dup) {
            getCounters().dedupSkipped.add(1);
            // ADR-7: repeatCount lives on the target record, not on this
            // (never-created) duplicate. confidence is deliberately left
            // untouched — its semantics are independent of dedup hits.
            let repeatCount = 2;
            try {
              const existing = await kv.get<{ repeatCount?: number }>(
                KV.observations(dup.sessionId),
                dup.obsId,
              );
              repeatCount = (existing?.repeatCount ?? 1) + 1;
              await kv.update(KV.observations(dup.sessionId), dup.obsId, [
                { type: "set", path: "repeatCount", value: repeatCount },
              ]);
            } catch (error) {
              logger.warn("Failed to write repeatCount on dedup hit", {
                obsId: dup.obsId,
                sessionId: dup.sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return {
              deduplicated: true,
              sessionId: payload.sessionId,
              obsId: dup.obsId,
              repeatCount,
            };
          }
        }
      }

      let sanitizedRaw: unknown = payload.data;
      try {
        const jsonStr = JSON.stringify(payload.data);
        const sanitized = stripPrivateData(jsonStr);
        sanitizedRaw = JSON.parse(sanitized);
      } catch {
        sanitizedRaw = stripPrivateData(String(payload.data));
      }

      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: sanitizedRaw,
      };

      let extractedImage: string | undefined;
      // Gap B fix (pipeline/agentmemory-data-reform dispatch): the
      // untouched `d["tool_output"]` payload field, captured here where
      // `d` is in scope, so the zero-information gate below can see past
      // the `|| d["error"]` merge's "" -> undefined collapse.
      let originalToolOutputField: unknown;

      if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
        const d = sanitizedRaw as Record<string, unknown>;
        if (
          payload.hookType === "post_tool_use" ||
          payload.hookType === "post_tool_failure"
        ) {
          raw.toolName = d["tool_name"] as string | undefined;
          raw.toolInput = d["tool_input"];
          originalToolOutputField = d["tool_output"];
          raw.toolOutput = d["tool_output"] || d["error"];
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = d["prompt"] as string | undefined;
        }
        if (payload.hookType === "subagent_stop") {
          // FR-2 / design.md ADR-4: the self-report source text is
          // already on the payload (src/hooks/subagent-stop.ts posts it
          // as `data.last_message`) — plugin side needs zero changes.
          // types.ts's `assistantResponse` field existed before this task
          // but nothing wrote it; this is that missing write.
          const lastMessage = d["last_message"];
          if (typeof lastMessage === "string" && lastMessage.trim().length > 0) {
            raw.assistantResponse = lastMessage;
          }
        }
        if (
          payload.hookType === "subagent_start" ||
          payload.hookType === "subagent_stop"
        ) {
          // FR-2 / design.md ADR-5: the dispatched subagent's own id,
          // needed by the session-stop start/stop pairing scan
          // (events.ts). Deliberately not stored on `agentId` — see
          // types.ts RawObservation.subagentId for why.
          const agentIdField = d["agent_id"];
          if (typeof agentIdField === "string" && agentIdField.trim().length > 0) {
            raw.subagentId = agentIdField;
          }
          raw.execHookType = payload.hookType;
        }

        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt) ? "mixed" : "image";
        }
      } else if (typeof sanitizedRaw === "string") {
        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = "image";
        }
      }

      // FR-1 / design.md ADR-1: classify once, here, before anything is
      // persisted — compress.ts / compress-synthetic.ts just pass this
      // value through (same shape as agentId).
      raw.subject = classifySubject(raw);

      // FR-4 bullet 1 / design.md ADR-3: zero-information observations are
      // dropped before the first kv.set — nothing is written, mem::compress
      // never fires, no index entry is ever created for this obsId.
      if (shouldDropEmptyObservation(raw, originalToolOutputField)) {
        logger.info("Dropped zero-information observation", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
        });
        return { success: true, dropped: true, reason: "empty_output" };
      }

      const pendingImageData = extractedImage;

      return withKeyedLock(`obs:${payload.sessionId}`, async () => {
        if (maxObservationsPerSession && maxObservationsPerSession > 0) {
          const existing = await kv.list(KV.observations(payload.sessionId));
          if (existing.length >= maxObservationsPerSession) {
            return {
              success: false,
              error: `Session observation limit reached (${maxObservationsPerSession})`,
            };
          }
        }

        // Existing session is the source of truth for agentId (even
        // undefined). Env AGENT_ID only fires when no session row
        // exists yet — otherwise an unscoped session would get
        // retroactively scoped by a later AGENT_ID export.
        const existingSession = await kv.get<{
          agentId?: string;
          observationCount?: number;
          firstPrompt?: string;
        }>(KV.sessions, payload.sessionId);
        const inheritedAgentId = existingSession
          ? existingSession.agentId
          : getAgentId();
        if (inheritedAgentId) {
          raw.agentId = inheritedAgentId;
        }

        if (pendingImageData && (pendingImageData.startsWith("data:image/") || pendingImageData.startsWith("iVBORw0KGgo") || pendingImageData.startsWith("/9j/"))) {
          const { filePath, bytesWritten } = await saveImageToDisk(pendingImageData);
          raw.imageData = filePath;
          const { incrementImageRef } = await import("./image-refs.js");
          await incrementImageRef(kv, filePath);
          sdk.trigger({
            function_id: "mem::disk-size-delta",
            payload: { deltaBytes: bytesWritten },
            action: TriggerAction.Void(),
          });
          if (process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] === "true") {
            sdk.trigger({
              function_id: "mem::vision-embed",
              payload: {
                imageRef: filePath,
                sessionId: payload.sessionId,
                observationId: obsId,
              },
              action: TriggerAction.Void(),
            });
          }
        }

        try {

          await kv.set(KV.observations(payload.sessionId), obsId, raw);

        } catch (error) {
          if (raw.imageData) {
            // Roll back the ref taken above. decrementImageRef deletes the file
            // only when no other observation still references it (deduped images
            // survive) and emits the disk-size delta itself — deleting the file
            // directly here would orphan shared images and leave a stale ref.
            // If the rollback itself fails, log it but still surface the
            // original write error (the more useful failure to diagnose).
            try {
              const { decrementImageRef } = await import("./image-refs.js");
              await decrementImageRef(kv, sdk, raw.imageData);
            } catch (rollbackError) {
              logger.error("Failed to roll back image ref after observation write failure", {
                imageRef: raw.imageData,
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              });
            }
          }
          throw error;
        }

        if (dedupMap && dedupHash) {
          dedupMap.record(dedupHash, obsId, payload.sessionId);
        }

        await sdk.trigger({
          function_id: "stream::set",
          payload: {
          stream_name: STREAM.name,
          group_id: STREAM.group(payload.sessionId),
          item_id: obsId,
          data: { type: "raw", observation: raw },
          },
        });

        await sdk.trigger({
          function_id: "stream::send",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            id: `raw-${obsId}`,
            type: "raw_observation",
            data: { type: "raw", observation: raw, sessionId: payload.sessionId },
          },
          action: TriggerAction.Void(),
        });

        const session = existingSession;
        if (session) {
          const updates: Array<{ type: "set"; path: string; value: unknown }> = [
            { type: "set", path: "updatedAt", value: new Date().toISOString() },
            {
              type: "set",
              path: "observationCount",
              value: (session.observationCount || 0) + 1,
            },
          ];
          if (!session.firstPrompt && typeof raw.userPrompt === "string") {
            const trimmed = raw.userPrompt.replace(/\s+/g, " ").trim();
            if (trimmed.length > 0) {
              updates.push({
                type: "set",
                path: "firstPrompt",
                value: trimmed.slice(0, 200),
              });
            }
          }
          await kv.update(KV.sessions, payload.sessionId, updates);
        } else if (
          typeof payload.project === "string" &&
          payload.project.trim().length > 0 &&
          typeof payload.cwd === "string" &&
          payload.cwd.trim().length > 0
        ) {
          // OpenCode (and any plugin that skips POST /session/start)
          // can fire observations before the session record exists. Without
          // an implicit create, those observations stack up but
          // `memory_sessions` never lists them, and summarize bails with
          // "Session not found for summarize". Create the session now from
          // the observation payload — but only when project + cwd are
          // present (HookPayload contract). Older test payloads without
          // those fields keep their original no-op behaviour.
          const trimmedPrompt =
            typeof raw.userPrompt === "string"
              ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
              : undefined;
          const ts = new Date().toISOString();
          await kv.set(KV.sessions, payload.sessionId, {
            id: payload.sessionId,
            project: payload.project,
            cwd: payload.cwd,
            startedAt: payload.timestamp ?? ts,
            updatedAt: ts,
            status: "active",
            observationCount: 1,
            ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
            ...(trimmedPrompt && trimmedPrompt.length > 0
              ? { firstPrompt: trimmedPrompt }
              : {}),
          });
        }

        // FR-2 / design.md ADR-4: self-report structured extraction is its
        // own function (mem::exec-self-report), gated by its own env flag
        // (AGENTMEMORY_EXEC_SELF_REPORT_ENABLED) — it fires regardless of
        // AGENTMEMORY_AUTO_COMPRESS below because it's the PRD's primary
        // supervision record ("本条的主要监督对象"), not the general
        // LLM-cost-controlled compression path. Void() — never blocks the
        // observe response, and self-report failures fall back internally
        // (execution-record.ts) rather than surfacing here.
        if (
          payload.hookType === "subagent_stop" &&
          typeof raw.assistantResponse === "string" &&
          raw.assistantResponse.trim().length > 0 &&
          isExecSelfReportEnabled()
        ) {
          await sdk.trigger({
            function_id: "mem::exec-self-report",
            payload: {
              observationId: obsId,
              sessionId: payload.sessionId,
              raw,
            },
            action: TriggerAction.Void(),
          });
        }

        // Per-observation LLM compression is opt-in as of 0.8.8.
        // Default path: build a zero-LLM synthetic compression so recall
        // and BM25 search still work without burning the user's Claude
        // token allocation on every tool invocation.
        //
        // FR-2 hard constraint: execution-subject observations always go
        // through mem::compress (the "flow" branch there tags
        // executionKind:"flow" and skips indexing) regardless of
        // AUTO_COMPRESS — the synthetic path below unconditionally calls
        // getSearchIndex().add() / vectorIndexAddGuarded(), which would
        // put execution records into the search index the moment
        // AUTO_COMPRESS is off (design.md ADR-5 lists observe.ts as a T-4
        // file specifically for this branch).
        if (isAutoCompressEnabled() || raw.subject === "execution") {
          await sdk.trigger({
            function_id: "mem::compress",
            payload: {
              observationId: obsId,
              sessionId: payload.sessionId,
              raw,
            },
            action: TriggerAction.Void(),
          });
        } else {
          const synthetic = buildSyntheticCompression(raw);
          await kv.set(
            KV.observations(payload.sessionId),
            obsId,
            synthetic,
          );
          getSearchIndex().add(synthetic);
          await vectorIndexAddGuarded(
            synthetic.id,
            synthetic.sessionId,
            synthetic.title + " " + (synthetic.narrative || ""),
            { kind: "synthetic", logId: synthetic.id },
          );
          await sdk.trigger({
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.group(payload.sessionId),
              item_id: obsId,
              data: { type: "compressed", observation: synthetic },
            },
          });
          await sdk.trigger({
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.viewerGroup,
              item_id: obsId,
              data: {
                type: "compressed",
                observation: synthetic,
                sessionId: payload.sessionId,
              },
            },
          });
        }

        logger.info("Observation captured", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
          compress:
            isAutoCompressEnabled() || raw.subject === "execution"
              ? "llm"
              : "synthetic",
        });
        return { observationId: obsId };
      });
    },
  );
}
