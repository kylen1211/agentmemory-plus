import type { RawObservation, CompressedObservation } from "../types.js";
import {
  isDropEmptyOutputEnabled,
  isLowValuePruneEnabled,
  getLowValueMinImportance,
  getLowValueMinConfidence,
} from "../config.js";

// FR-4 bullet 1 (design.md ADR-3 / PRD FR-4): zero-information observations
// never get written to KV at all — observe.ts calls this before kv.set,
// so a hit here means the record was never persisted, never triggered
// compression, and never touched an index (there's nothing to clean up).
//
// subject === "execution" is exempt (PRD FR-4: "不分 subject,execution
// 除外") — flow/self-report records legitimately have empty tool output
// (e.g. a SubagentStop carries no tool_output field at all).
//
// Deliberately narrow to "field present AND is an empty/whitespace-only
// string" (PRD FR-1 literal wording: "toolOutput 字段存在且为空串/纯空白").
// A *missing* toolOutput field (undefined) is NOT treated as empty here —
// many legitimate post_tool_use payloads simply don't carry a tool_output
// key (e.g. hook payloads that only report tool_name), and treating that
// as "zero information" silently drops perfectly ordinary observations
// (caught by test/observe-implicit-session.test.ts during implementation:
// a Read call with no tool_output field regressed session bookkeeping).
//
// `originalToolOutput` (design.md pipeline/agentmemory-data-reform dispatch
// gap fix): observe.ts's `raw.toolOutput = d["tool_output"] || d["error"]`
// collapses a genuine empty string ("" with no error) to `undefined`
// before this function ever sees `raw.toolOutput` — "" is falsy in JS, so
// the `||` silently discards it, and the check above (which only matches
// `typeof out === "string"`) never fires on the real "empty output" case
// this gate exists to catch. Callers pass the untouched `d["tool_output"]`
// payload field here so we can detect that exact collapse. This can never
// mask a genuine failure's error text: if `raw.toolOutput` came out
// `undefined`, `d["error"]` must have also been falsy (a truthy error
// would have won the `||` and been assigned instead), so there's nothing
// being overridden by checking the raw field directly.
export function shouldDropEmptyObservation(
  raw: RawObservation,
  originalToolOutput?: unknown,
): boolean {
  if (raw.subject === "execution") return false;
  if (!isDropEmptyOutputEnabled()) return false;

  const isToolOutcomeHook =
    raw.hookType === "post_tool_use" || raw.hookType === "post_tool_failure";
  if (isToolOutcomeHook) {
    const out = raw.toolOutput;
    if (typeof out === "string" && out.trim().length === 0) return true;
    if (
      out === undefined &&
      typeof originalToolOutput === "string" &&
      originalToolOutput.trim().length === 0
    ) {
      return true;
    }
  }

  // Heartbeat-like notification hookType with no substantive payload.
  if (raw.hookType === "notification") {
    const payload = raw.raw;
    const hasContent =
      typeof payload === "string"
        ? payload.trim().length > 0
        : typeof payload === "object" &&
          payload !== null &&
          Object.keys(payload as Record<string, unknown>).length > 0;
    if (!hasContent) return true;
  }

  return false;
}

// FR-4 bullet 2 (design.md ADR-3): post-compression low-value delete gate.
// Called in compress.ts after `compressed` is assembled and BEFORE kv.set
// — a hit there means kv.delete the observe-stage raw record and return,
// with kv.set / getSearchIndex().add() / vectorIndexAddGuarded() never
// executing (see compress.ts for the actual delete + audit call).
//
// OR semantics, both thresholds env-tunable. Comparisons are strict `<`
// — design.md appendix B closing note: `<=` on confidence would sweep the
// zero-LLM synthetic path's hardcoded confidence:0.3 to zero the moment
// AGENTMEMORY_AUTO_COMPRESS gets turned off. Do not change to `<=`.
export function shouldPruneLowValue(
  compressed: Pick<CompressedObservation, "importance" | "confidence" | "subject">,
): boolean {
  if (!isLowValuePruneEnabled()) return false;
  if (compressed.subject === "execution") return false;

  const belowImportance =
    typeof compressed.importance === "number" &&
    compressed.importance < getLowValueMinImportance();
  const belowConfidence =
    typeof compressed.confidence === "number" &&
    compressed.confidence < getLowValueMinConfidence();

  return belowImportance || belowConfidence;
}
