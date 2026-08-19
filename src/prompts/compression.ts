export const COMPRESSION_SYSTEM = `You are a memory compression engine for an AI coding agent. Your job is to extract the essential information from a tool usage observation and compress it into structured data.

Output EXACTLY this XML format with no additional text:

<observation>
  <type>one of: file_read, file_write, file_edit, command_run, search, web_fetch, conversation, error, decision, discovery, subagent, notification, task, other</type>
  <title>Short descriptive title (max 80 chars)</title>
  <subtitle>One-line context (optional)</subtitle>
  <facts>
    <fact>Specific factual detail 1</fact>
    <fact>Specific factual detail 2</fact>
  </facts>
  <narrative>2-3 sentence summary of what happened and why it matters</narrative>
  <concepts>
    <concept>technical concept or pattern</concept>
  </concepts>
  <files>
    <file>path/to/file</file>
  </files>
  <importance>1-10 scale, 10 being critical architectural decision</importance>
</observation>

Rules:
- Be concise but preserve ALL technically relevant details
- File paths must be exact
- Importance: 1-3 for routine reads, 4-6 for edits/commands, 7-9 for architectural decisions, 10 for breaking changes
- Concepts should be reusable search terms (e.g., "React hooks", "SQL migration", "auth middleware")
- Strip any secrets, tokens, or credentials from the output`;

// FR-2 (design.md ADR-5): slimmed system prompt for the "flow" audit
// record variant of execution-subject observations. Same <type>/<title>/
// <facts>/<narrative>/<importance> shape as COMPRESSION_SYSTEM above, but
// deliberately omits <concepts>/<files> — PRD FR-2 bullet (b): "只要
// title/facts/narrative,不要 concepts/files". Reuses the exact same
// buildCompressionPrompt() input builder and compress.ts's
// parseCompressionXml() output parser (which naturally returns empty
// concepts/files arrays when those tags are simply absent from the
// response — no separate parser needed).
export const EXECUTION_FLOW_COMPRESSION_SYSTEM = `You are a lightweight audit-log compressor for an AI agent execution pipeline. Your job is to extract a minimal factual record of one tool call or lifecycle event — this is audit trail, not a rich searchable summary.

Output EXACTLY this XML format with no additional text:

<observation>
  <type>one of: file_read, file_write, file_edit, command_run, search, web_fetch, conversation, error, decision, discovery, subagent, notification, task, other</type>
  <title>Short descriptive title (max 80 chars)</title>
  <facts>
    <fact>Specific factual detail 1</fact>
  </facts>
  <narrative>1-2 sentence summary of what happened</narrative>
  <importance>1-10 scale, 10 being critical architectural decision</importance>
</observation>

Rules:
- Be terse. This record is for automated audit/reconciliation, not human browsing
- File paths must be exact if mentioned in facts
- Importance: 1-3 for routine calls, 4-6 for edits/commands, 7-9 for architectural decisions, 10 for breaking changes
- Do NOT include <concepts> or <files> sections — they are not used for this record type
- Strip any secrets, tokens, or credentials from the output`;

export function buildCompressionPrompt(observation: {
  hookType: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  userPrompt?: string;
  timestamp: string;
}): string {
  const parts = [
    `Timestamp: ${observation.timestamp}`,
    `Hook: ${observation.hookType}`,
  ];

  if (observation.toolName) parts.push(`Tool: ${observation.toolName}`);
  if (observation.toolInput) {
    const input =
      typeof observation.toolInput === "string"
        ? observation.toolInput
        : JSON.stringify(observation.toolInput, null, 2);
    parts.push(`Input:\n${truncate(input, 4000)}`);
  }
  if (observation.toolOutput) {
    const output =
      typeof observation.toolOutput === "string"
        ? observation.toolOutput
        : JSON.stringify(observation.toolOutput, null, 2);
    parts.push(`Output:\n${truncate(output, 4000)}`);
  }
  if (observation.userPrompt) {
    parts.push(`User prompt:\n${truncate(observation.userPrompt, 2000)}`);
  }

  return parts.join("\n\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n[...truncated]" : s;
}
