// FR-2 (design.md ADR-4, appendix A-3/A-4). Structured extraction prompt
// for a subagent's SubagentStop self-report (`raw.assistantResponse` —
// the agent's own closing message, already captured by
// src/hooks/subagent-stop.ts as `data.last_message`, no transcript read).
//
// `deviations` is a transcription of what the agent itself claims, not a
// system-judged violation — PRD FR-2: "deviations 是‘结构化转述 agent 自己
// 怎么说’,不是系统独立判定的违规". The separate rule-level `violation`
// field (compress.ts, on "flow" records) is the system-judged signal.
export const SELF_REPORT_SYSTEM = `You are a supervisory extraction engine for an AI coding agent execution pipeline. Your job is to structure an agent's own closing self-report into a reviewable record — this is what the agent CLAIMS about its own task, not an independent judgment.

Output EXACTLY this XML format with no additional text:

<self_report>
  <task>What task was this agent given? (1-2 sentences)</task>
  <key_decisions>
    <decision>
      <what>The decision made</what>
      <tool>Tool used for it, if mentioned (empty if not applicable)</tool>
      <reason>Why the agent says it chose this</reason>
    </decision>
  </key_decisions>
  <deviations>
    <deviation>A specific deviation from expected behavior the agent itself mentions, verbatim intent preserved</deviation>
  </deviations>
  <self_assessment>The agent's own concluding assessment of whether it succeeded (1-2 sentences)</self_assessment>
  <importance>1-10 scale: how consequential this task looks, 10 being a critical/high-risk change</importance>
</self_report>

Rules:
- Be faithful to what the self-report text actually says — do not invent decisions, tools, or deviations it doesn't mention
- <key_decisions> may be empty if the report describes no distinct decision points
- <deviations> may be empty if the agent reports no deviations — an empty <deviations></deviations> is a valid, common output, not a failure
- <task> and <self_assessment> must always be non-empty — if the report text doesn't clearly state a task, summarize the report's overall subject instead
- Strip any secrets, tokens, or credentials from the output`;

export function buildSelfReportPrompt(assistantResponse: string): string {
  return `Agent's self-report (its own closing message, verbatim):\n\n${assistantResponse}`;
}
