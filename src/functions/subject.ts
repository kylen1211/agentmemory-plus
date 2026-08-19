import type { RawObservation, ObservationSubject } from "../types.js";
import { inferType } from "./compress-synthetic.js";
import {
  getSubjectExecutionHookTypes,
  getSubjectExecutionToolKeywords,
  getSubjectUserHookTypes,
} from "../config.js";

// Word-boundary match against the env keyword table (config.ts
// AGENTMEMORY_SUBJECT_EXECUTION_TOOL_KEYWORDS). Deliberately the *same*
// normalize-then-boundary-match shape inferType() itself uses (camelCase/
// kebab-case -> underscore chunks, `(^|_)word(_|$)` test) so a plain
// substring `includes` doesn't false-positive on tools like
// "AgentMemoryExport" matching keyword "agent" mid-word in a way
// inferType wouldn't. This is intentionally a single narrow helper for
// one keyword table, not a second category-classification regex bank —
// classifySubject still delegates all actual type inference to
// inferType().
function matchesExecutionKeyword(toolName: string, keywords: string[]): boolean {
  const n = toolName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return keywords.some((word) => {
    const w = word.trim().toLowerCase();
    if (!w) return false;
    return (
      new RegExp(`(^|_)${w}(_|$)`).test(n) ||
      n === w ||
      n.endsWith(w) ||
      n.startsWith(w)
    );
  });
}

// FR-1 / design.md ADR-2. Rule-based subject classifier — four ordered
// steps, first match wins. Reuses inferType() (compress-synthetic.ts) as
// the sole pattern-matching kernel; this module adds no new regex/keyword
// matching of its own.
//
// Called once at write time (observe.ts, before kv.set), the result is
// carried on RawObservation.subject and passed through verbatim by
// compress.ts / compress-synthetic.ts onto CompressedObservation.subject
// — the same passthrough shape as the existing agentId field.
//
// Misclassification is an accepted, documented limitation (PRD FR-1
// "异常路径"): worst case is a record taking the wrong FR-2/FR-4 branch,
// never data loss or a thrown error.
export function classifySubject(raw: RawObservation): ObservationSubject {
  const hookType = raw.hookType;
  const toolName = raw.toolName ?? raw.hookType;

  // Step 1: hookType is on the execution whitelist (lifecycle events).
  if (getSubjectExecutionHookTypes().includes(hookType)) {
    return "execution";
  }

  // Step 2: toolName matches inferType's orchestration-tool keywords
  // (["task", "agent"] baked into inferType — see compress-synthetic.ts)
  // OR the env-tunable keyword table (AGENTMEMORY_SUBJECT_EXECUTION_
  // TOOL_KEYWORDS). The two are same-sourced by default but the env
  // table is the actual live knob per PRD FR-1's "规则集本身用 env 白名单
  // 表达,误判可通过调参修正不需要改代码重新部署" — without this branch
  // that env var was read/defaulted (config.ts) but never consulted by
  // any branch here, so changing it had zero effect (design gap, fixed
  // per this task's dispatch).
  if (
    inferType(toolName, hookType) === "subagent" ||
    matchesExecutionKeyword(toolName, getSubjectExecutionToolKeywords())
  ) {
    return "execution";
  }

  // Step 3: user-authored input.
  if (
    getSubjectUserHookTypes().includes(hookType) ||
    inferType(toolName, hookType) === "conversation"
  ) {
    return "user";
  }

  // Step 4: fallback — everything else is agent-originated (hook
  // observations of tool use, errors, discoveries, etc).
  return "agent";
}
