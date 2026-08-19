import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CompressedObservation, MemoryProvider } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// FR-2 hard constraint (design.md ADR-5): "两类记录都绝不进检索面". Spying on
// the module compress.ts actually imports (rather than asserting an
// absence of imports) is the strongest test we can write for a negative
// requirement like this.
const mocks = vi.hoisted(() => {
  const indexedIds = new Set<string>();
  const addSpy = vi.fn((obs: { id: string }) => {
    indexedIds.add(obs.id);
  });
  const vectorAddSpy = vi.fn().mockResolvedValue(false);
  return { indexedIds, addSpy, vectorAddSpy };
});

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({
    add: mocks.addSpy,
    has: (id: string) => mocks.indexedIds.has(id),
  }),
  vectorIndexAddGuarded: mocks.vectorAddSpy,
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const op of ops) v[op.path] = op.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggered: Array<{ id: string; data: unknown }> = [];
  return {
    fns,
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
      _options?: Record<string, unknown>,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, data: payload });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

const FLOW_XML = `<type>subagent</type>
<title>Subagent dispatched</title>
<facts><fact>Dispatched a subagent to investigate the bug</fact></facts>
<narrative>Dispatched a subagent to investigate the reported bug</narrative>
<importance>4</importance>`;

const SELF_REPORT_XML = `<task>Investigate and fix the auth bug</task>
<key_decisions>
  <decision>
    <what>Used grep to find all call sites</what>
    <tool>Grep</tool>
    <reason>Needed to find every usage quickly before editing</reason>
  </decision>
</key_decisions>
<deviations>
  <deviation>Skipped writing a regression test due to time constraints</deviation>
</deviations>
<self_assessment>Task completed successfully; fix verified manually</self_assessment>
<importance>6</importance>`;

function provider(
  opts: { flowXml?: string; selfReportXml?: string } = {},
): MemoryProvider {
  return {
    name: "mock",
    compress: async (systemPrompt: string) => {
      // execution-record.ts's SELF_REPORT_SYSTEM and compress.ts's
      // EXECUTION_FLOW_COMPRESSION_SYSTEM are distinguishable by content
      // — route the canned fixture by which one the caller used, so one
      // fake provider can serve both mem::compress and
      // mem::exec-self-report in the same integration test.
      if (systemPrompt.includes("supervisory extraction engine")) {
        return opts.selfReportXml ?? SELF_REPORT_XML;
      }
      return opts.flowXml ?? FLOW_XML;
    },
    summarize: async () => "",
  };
}

function clearExecEnv() {
  delete process.env["AGENTMEMORY_EXEC_SELF_REPORT_ENABLED"];
  delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  delete process.env["AGENTMEMORY_DROP_EMPTY_OUTPUT"];
  delete process.env["AGENTMEMORY_SUBJECT_EXECUTION_TOOL_KEYWORDS"];
}

describe("FR-2 execution records: self_report + flow (design.md ADR-4/ADR-5)", () => {
  beforeEach(() => {
    vi.resetModules();
    clearExecEnv();
    mocks.indexedIds.clear();
    mocks.addSpy.mockClear();
    mocks.vectorAddSpy.mockClear();
  });
  afterEach(() => clearExecEnv());

  it("one SubagentStop trigger produces exactly one self_report + one flow record, both queryable by sessionId, neither indexed", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { registerCompressFunction } = await import("../src/functions/compress.js");
    const { registerExecutionRecordFunction } = await import(
      "../src/functions/execution-record.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();

    registerObserveFunction(sdk as never, kv as never);
    registerCompressFunction(sdk as never, kv as never, provider());
    registerExecutionRecordFunction(sdk as never, kv as never, provider());

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_sr",
      hookType: "subagent_stop",
      timestamp: new Date().toISOString(),
      data: {
        agent_id: "agent-42",
        agent_type: "code-scout",
        last_message:
          "I investigated the bug using Grep. No deviations. Task succeeded.",
      },
    })) as { observationId: string };

    expect(result.observationId).toBeTruthy();

    const records = await kv.list<CompressedObservation>("mem:obs:ses_sr");
    const selfReports = records.filter((r) => r.executionKind === "self_report");
    const flows = records.filter((r) => r.executionKind === "flow");

    // "该次触发产生且仅产生一条 self_report" — not "each sessionId has one",
    // but this test only fires SubagentStop once so both collapse to the
    // same assertion here.
    expect(selfReports.length).toBe(1);
    expect(flows.length).toBe(1);

    const sr = selfReports[0];
    expect(sr.subject).toBe("execution");
    expect(sr.sessionId).toBe("ses_sr");
    // All four ExecutionDetail fields parseable.
    expect(sr.executionDetail?.task).toBeTruthy();
    expect(sr.executionDetail?.keyDecisions).toEqual([
      { decision: "Used grep to find all call sites", tool: "Grep", reason: "Needed to find every usage quickly before editing" },
    ]);
    expect(sr.executionDetail?.deviations).toEqual([
      "Skipped writing a regression test due to time constraints",
    ]);
    expect(sr.executionDetail?.selfAssessment).toBeTruthy();

    expect(flows[0].sessionId).toBe("ses_sr");
    expect(flows[0].subject).toBe("execution");

    // FR-2 hard constraint: index entry count does not increase for
    // either record kind.
    expect(mocks.addSpy).not.toHaveBeenCalled();
    expect(mocks.vectorAddSpy).not.toHaveBeenCalled();
  });

  it("post_tool_failure flow record gets violation:true via rule-level hookType match, not LLM output parsing", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { registerCompressFunction } = await import("../src/functions/compress.js");
    const sdk = mockSdk();
    const kv = mockKV();

    registerObserveFunction(sdk as never, kv as never);
    // FLOW_XML never mentions "violation" anywhere — if this test passes,
    // violation:true could only have come from the hookType string
    // comparison in compress.ts, not from parsing the LLM's response.
    expect(FLOW_XML.toLowerCase()).not.toContain("violation");
    registerCompressFunction(sdk as never, kv as never, provider());

    // toolName "Task" + hookType post_tool_failure: inferType() itself
    // returns "error" for post_tool_failure hookType before it even looks
    // at toolName, so this record only classifies as execution via the
    // env-keyword branch (subject.ts Gap A fix) — incidentally exercises
    // that fix too.
    await sdk.trigger("mem::observe", {
      sessionId: "ses_viol",
      hookType: "post_tool_failure",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Task",
        tool_input: { description: "dispatch subagent" },
        error: "subagent crashed",
      },
    });

    const records = await kv.list<CompressedObservation>("mem:obs:ses_viol");
    const flow = records.find((r) => r.executionKind === "flow");
    expect(flow?.subject).toBe("execution");
    expect(flow?.violation).toBe(true);
    expect(mocks.addSpy).not.toHaveBeenCalled();
    expect(mocks.vectorAddSpy).not.toHaveBeenCalled();
  });

  it("self-report structured extraction failure falls back to raw narrative — record is not lost (success:true, fallback:true)", async () => {
    const { registerExecutionRecordFunction } = await import(
      "../src/functions/execution-record.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    const badProvider: MemoryProvider = {
      name: "bad",
      compress: async () => "I did some stuff. Not XML at all.",
      summarize: async () => "",
    };
    registerExecutionRecordFunction(sdk as never, kv as never, badProvider);

    const raw = {
      id: "obs_bad",
      sessionId: "ses_fb",
      timestamp: new Date().toISOString(),
      hookType: "subagent_stop" as const,
      raw: {},
      subject: "execution" as const,
      assistantResponse: "I did some stuff. Not XML at all.",
    };

    const result = (await sdk.trigger("mem::exec-self-report", {
      observationId: "obs_bad",
      sessionId: "ses_fb",
      raw,
    })) as { success: boolean; fallback?: boolean };

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(true);

    const records = await kv.list<CompressedObservation>("mem:obs:ses_fb");
    expect(records.length).toBe(1);
    expect(records[0].executionKind).toBe("self_report");
    expect(records[0].narrative).toBe(raw.assistantResponse);
    expect(records[0].executionDetail).toBeUndefined();
    expect(mocks.addSpy).not.toHaveBeenCalled();
    expect(mocks.vectorAddSpy).not.toHaveBeenCalled();
  });

  it("returns success:false, error:'extract_failed' only when even the fallback write fails", async () => {
    const { registerExecutionRecordFunction } = await import(
      "../src/functions/execution-record.js"
    );
    const sdk = mockSdk();
    const kv = {
      get: async () => null,
      set: async () => {
        throw new Error("kv unavailable");
      },
      update: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const badProvider: MemoryProvider = {
      name: "bad",
      compress: async () => "not xml",
      summarize: async () => "",
    };
    registerExecutionRecordFunction(sdk as never, kv as never, badProvider);

    const raw = {
      id: "obs_kvfail",
      sessionId: "ses_kvfail",
      timestamp: new Date().toISOString(),
      hookType: "subagent_stop" as const,
      raw: {},
      subject: "execution" as const,
      assistantResponse: "some self-report text",
    };

    const result = await sdk.trigger("mem::exec-self-report", {
      observationId: "obs_kvfail",
      sessionId: "ses_kvfail",
      raw,
    });

    expect(result).toEqual({ success: false, error: "extract_failed" });
  });

  it("re-triggering the same observationId overwrites in place, never produces a second record (idempotent)", async () => {
    const { registerExecutionRecordFunction } = await import(
      "../src/functions/execution-record.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerExecutionRecordFunction(sdk as never, kv as never, provider());

    const raw = {
      id: "obs_idem",
      sessionId: "ses_idem",
      timestamp: new Date().toISOString(),
      hookType: "subagent_stop" as const,
      raw: {},
      subject: "execution" as const,
      assistantResponse: "report text",
    };

    await sdk.trigger("mem::exec-self-report", {
      observationId: "obs_idem",
      sessionId: "ses_idem",
      raw,
    });
    await sdk.trigger("mem::exec-self-report", {
      observationId: "obs_idem",
      sessionId: "ses_idem",
      raw,
    });

    const records = await kv.list<CompressedObservation>("mem:obs:ses_idem");
    const selfReports = records.filter((r) => r.executionKind === "self_report");
    expect(selfReports.length).toBe(1);
  });

  it("AUTO_COMPRESS=false does not let execution records reach the index via the synthetic path", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { registerCompressFunction } = await import("../src/functions/compress.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerCompressFunction(sdk as never, kv as never, provider());

    await sdk.trigger("mem::observe", {
      sessionId: "ses_noauto",
      hookType: "subagent_start",
      timestamp: new Date().toISOString(),
      data: { agent_id: "agent-9", agent_type: "worker" },
    });

    const records = await kv.list<CompressedObservation>("mem:obs:ses_noauto");
    expect(records.some((r) => r.executionKind === "flow")).toBe(true);
    expect(mocks.addSpy).not.toHaveBeenCalled();
    expect(mocks.vectorAddSpy).not.toHaveBeenCalled();
  });
});

function flowObs(overrides: Partial<CompressedObservation>): CompressedObservation {
  return {
    id: "obs_x",
    sessionId: "ses_pair",
    timestamp: new Date().toISOString(),
    type: "subagent",
    title: "t",
    facts: [],
    narrative: "n",
    concepts: [],
    files: [],
    importance: 4,
    subject: "execution",
    executionKind: "flow",
    ...overrides,
  };
}

describe("scanUnpairedSubagentEvents (design.md ADR-5, session-stop scan)", () => {
  it("matched subagent_start/subagent_stop pair (same subagentId): neither gets anomaly", async () => {
    const { scanUnpairedSubagentEvents } = await import(
      "../src/functions/execution-record.js"
    );
    const kv = mockKV();
    await kv.set(
      "mem:obs:ses_pair",
      "obs_start",
      flowObs({
        id: "obs_start",
        execHookType: "subagent_start",
        subagentId: "agent-1",
        timestamp: "2026-08-19T00:00:00.000Z",
      }),
    );
    await kv.set(
      "mem:obs:ses_pair",
      "obs_stop",
      flowObs({
        id: "obs_stop",
        execHookType: "subagent_stop",
        subagentId: "agent-1",
        timestamp: "2026-08-19T00:01:00.000Z",
      }),
    );

    await scanUnpairedSubagentEvents(kv as never, "ses_pair");

    const records = await kv.list<CompressedObservation>("mem:obs:ses_pair");
    expect(records.every((r) => r.anomaly === undefined)).toBe(true);
  });

  it("lone subagent_start with no matching stop within the session gets anomaly:'unpaired'", async () => {
    const { scanUnpairedSubagentEvents } = await import(
      "../src/functions/execution-record.js"
    );
    const kv = mockKV();
    await kv.set(
      "mem:obs:ses_lone",
      "obs_start",
      flowObs({
        id: "obs_start",
        sessionId: "ses_lone",
        execHookType: "subagent_start",
        subagentId: "agent-2",
      }),
    );

    await scanUnpairedSubagentEvents(kv as never, "ses_lone");

    const rec = await kv.get<CompressedObservation>("mem:obs:ses_lone", "obs_start");
    expect(rec?.anomaly).toBe("unpaired");
  });

  it("task_completed flow records never participate in pairing (no execHookType is ever set for them)", async () => {
    const { scanUnpairedSubagentEvents } = await import(
      "../src/functions/execution-record.js"
    );
    const kv = mockKV();
    // task_completed flow records carry no execHookType (only
    // subagent_start/subagent_stop get that field — see observe.ts).
    await kv.set(
      "mem:obs:ses_tc",
      "obs_tc",
      flowObs({ id: "obs_tc", sessionId: "ses_tc", execHookType: undefined }),
    );

    await expect(
      scanUnpairedSubagentEvents(kv as never, "ses_tc"),
    ).resolves.not.toThrow();

    const rec = await kv.get<CompressedObservation>("mem:obs:ses_tc", "obs_tc");
    expect(rec?.anomaly).toBeUndefined();
  });

  it("degrades to chronological pairing across the whole session when subagentId is absent on both sides", async () => {
    const { scanUnpairedSubagentEvents } = await import(
      "../src/functions/execution-record.js"
    );
    const kv = mockKV();
    await kv.set(
      "mem:obs:ses_deg",
      "s1",
      flowObs({
        id: "s1",
        sessionId: "ses_deg",
        execHookType: "subagent_start",
        subagentId: undefined,
        timestamp: "2026-08-19T00:00:00.000Z",
      }),
    );
    await kv.set(
      "mem:obs:ses_deg",
      "p1",
      flowObs({
        id: "p1",
        sessionId: "ses_deg",
        execHookType: "subagent_stop",
        subagentId: undefined,
        timestamp: "2026-08-19T00:01:00.000Z",
      }),
    );

    await scanUnpairedSubagentEvents(kv as never, "ses_deg");

    const records = await kv.list<CompressedObservation>("mem:obs:ses_deg");
    expect(records.every((r) => r.anomaly === undefined)).toBe(true);
  });
});
