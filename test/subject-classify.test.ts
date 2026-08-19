import { describe, it, expect, afterEach } from "vitest";
import type { RawObservation, CompressedObservation } from "../src/types.js";
import { classifySubject } from "../src/functions/subject.js";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";

function baseRaw(overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    hookType: "post_tool_use",
    raw: {},
    ...overrides,
  };
}

describe("classifySubject (FR-1)", () => {
  it("subagent_stop -> execution (hookType whitelist, ADR-2 step 1)", () => {
    const raw = baseRaw({ hookType: "subagent_stop" });
    expect(classifySubject(raw)).toBe("execution");
  });

  it("prompt_submit -> user", () => {
    const raw = baseRaw({ hookType: "prompt_submit", userPrompt: "do the thing" });
    expect(classifySubject(raw)).toBe("user");
  });

  it("post_tool_use(Edit) -> agent (fallback branch)", () => {
    const raw = baseRaw({ hookType: "post_tool_use", toolName: "Edit" });
    expect(classifySubject(raw)).toBe("agent");
  });

  it("subagent_start -> execution (lifecycle hookType, no toolName)", () => {
    const raw = baseRaw({ hookType: "subagent_start" });
    expect(classifySubject(raw)).toBe("execution");
  });

  it("task_completed -> execution", () => {
    const raw = baseRaw({ hookType: "task_completed" });
    expect(classifySubject(raw)).toBe("execution");
  });

  it("post_tool_use with a Task-orchestration tool name -> execution (inferType 'subagent')", () => {
    const raw = baseRaw({ hookType: "post_tool_use", toolName: "Task" });
    expect(classifySubject(raw)).toBe("execution");
  });

  it("post_tool_failure -> agent (regular hook error, not user/execution)", () => {
    const raw = baseRaw({ hookType: "post_tool_failure", toolName: "Bash" });
    expect(classifySubject(raw)).toBe("agent");
  });
});

describe("classifySubject env keyword table (subject.ts Gap A fix)", () => {
  const ENV_KEY = "AGENTMEMORY_SUBJECT_EXECUTION_TOOL_KEYWORDS";
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  // Before this fix, AGENTMEMORY_SUBJECT_EXECUTION_TOOL_KEYWORDS was
  // read/defaulted in config.ts but never consulted by classifySubject —
  // changing it had zero effect on classification (PRD FR-1 explicitly
  // requires the opposite: "误判可通过调参修正不需要改代码重新部署").
  //
  // hookType=post_tool_failure deliberately used here: inferType() itself
  // returns "error" for that hookType before it even looks at toolName
  // (compress-synthetic.ts:18), so inferType(...)==="subagent" can never
  // fire for this case — only the env-keyword branch can classify it as
  // execution, isolating the fix from the pre-existing inferType path.
  it("a toolName matching a custom env keyword classifies as execution, even though inferType's baked-in list would say no", () => {
    process.env[ENV_KEY] = "orchestrator";
    const raw = baseRaw({ hookType: "post_tool_failure", toolName: "OrchestratorDispatch" });
    expect(classifySubject(raw)).toBe("execution");
  });

  it("the same toolName does NOT classify as execution once the custom keyword is removed (env is a live knob, not a decorative default)", () => {
    delete process.env[ENV_KEY];
    const raw = baseRaw({ hookType: "post_tool_failure", toolName: "OrchestratorDispatch" });
    expect(classifySubject(raw)).toBe("agent");
  });

  it("word-boundary match: 'agent' as a raw substring (e.g. 'MagentaTool') does not false-positive against the default keyword list", () => {
    // Regression guard for a naive `.includes("agent")` implementation:
    // "MagentaTool" normalizes to "magenta_tool", which contains "agent"
    // as a raw substring ("m-AGENT-a") but not as a boundary-delimited
    // token — inferType's own built-in ["task","agent"] list already
    // gets this right (same hasWord() shape), and the env-keyword
    // matcher added by this fix must not regress it with a looser check.
    const raw = baseRaw({ hookType: "post_tool_use", toolName: "MagentaTool" });
    expect(classifySubject(raw)).toBe("agent");
  });
});

describe("subject passthrough into CompressedObservation (ADR-1)", () => {
  it("buildSyntheticCompression carries raw.subject through unchanged", () => {
    const raw = baseRaw({ hookType: "subagent_stop", subject: "execution" });
    const compressed = buildSyntheticCompression(raw);
    expect(compressed.subject).toBe("execution");
  });

  it("buildSyntheticCompression omits subject entirely when raw.subject is unset", () => {
    const raw = baseRaw({ hookType: "post_tool_use", toolName: "Read" });
    const compressed = buildSyntheticCompression(raw);
    expect(compressed.subject).toBeUndefined();
  });
});

describe("legacy records without `subject` (undefined = unclassified)", () => {
  it("a subject-filtering query does not throw and treats undefined as unclassified, not any concrete subject", () => {
    const legacy: CompressedObservation = {
      id: "obs_legacy",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      type: "file_read",
      title: "Read",
      facts: [],
      narrative: "",
      concepts: [],
      files: [],
      importance: 5,
      // no `subject` field at all — simulates pre-FR-1 stored data.
    };

    const records = [legacy];

    // Governance-style filter for "only execution-subject records" must not
    // throw on legacy rows and must not match them.
    expect(() =>
      records.filter((r) => r.subject === "execution"),
    ).not.toThrow();
    expect(records.filter((r) => r.subject === "execution")).toHaveLength(0);
    expect(records.filter((r) => r.subject === "user")).toHaveLength(0);
    expect(records.filter((r) => r.subject === "agent")).toHaveLength(0);

    // Explicit "unclassified" bucket read: `?? "unclassified"` is the
    // documented read-side compatibility shape (design.md 迁移策略).
    expect(legacy.subject ?? "unclassified").toBe("unclassified");
  });
});
