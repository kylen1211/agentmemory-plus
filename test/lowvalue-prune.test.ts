import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CompressedObservation, MemoryProvider } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

function xmlFor(importance: number, opts: { subtitle?: string } = {}) {
  return `<type>file_read</type>
<title>Read src/foo.ts</title>
<subtitle>${opts.subtitle ?? "reading a file"}</subtitle>
<facts><fact>Read the file</fact></facts>
<narrative>The agent read a file to look something up during the task.</narrative>
<concepts><concept>reading</concept></concepts>
<files></files>
<importance>${importance}</importance>`;
}

function clearLowValueEnv() {
  delete process.env["AGENTMEMORY_LOWVALUE_PRUNE_ENABLED"];
  delete process.env["AGENTMEMORY_LOWVALUE_PRUNE_DRY_RUN"];
  delete process.env["AGENTMEMORY_LOWVALUE_MIN_IMPORTANCE"];
  delete process.env["AGENTMEMORY_LOWVALUE_MIN_CONFIDENCE"];
  delete process.env["AGENTMEMORY_DROP_EMPTY_OUTPUT"];
  delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
}

describe("shouldPruneLowValue (FR-4 bullet 2, OR semantics + strict <)", () => {
  beforeEach(() => {
    vi.resetModules();
    clearLowValueEnv();
    process.env["AGENTMEMORY_LOWVALUE_PRUNE_ENABLED"] = "true";
  });
  afterEach(() => clearLowValueEnv());

  function obs(importance: number, confidence: number, subject?: "user" | "agent" | "execution"): CompressedObservation {
    return {
      id: "obs_x",
      sessionId: "ses_x",
      timestamp: new Date().toISOString(),
      type: "file_read",
      title: "t",
      facts: [],
      narrative: "n",
      concepts: [],
      files: [],
      importance,
      confidence,
      ...(subject ? { subject } : {}),
    };
  }

  it("importance=1(10pt), confidence=0.1(10pt) -> both dimensions below 30pt line -> prune", async () => {
    const { shouldPruneLowValue } = await import("../src/functions/prune.js");
    expect(shouldPruneLowValue(obs(1, 0.1, "user"))).toBe(true);
  });

  it("importance=5(50pt), confidence=0.2(20pt) -> OR semantics, confidence alone triggers -> prune", async () => {
    const { shouldPruneLowValue } = await import("../src/functions/prune.js");
    expect(shouldPruneLowValue(obs(5, 0.2, "user"))).toBe(true);
  });

  it("importance=8(80pt), confidence=0.6(60pt) -> both above line -> keep", async () => {
    const { shouldPruneLowValue } = await import("../src/functions/prune.js");
    expect(shouldPruneLowValue(obs(8, 0.6, "user"))).toBe(false);
  });

  it("subject=agent(hook-origin) follows the same delete line as user", async () => {
    const { shouldPruneLowValue } = await import("../src/functions/prune.js");
    expect(shouldPruneLowValue(obs(1, 0.1, "agent"))).toBe(true);
  });

  it("subject=execution is never pruned regardless of scores", async () => {
    const { shouldPruneLowValue } = await import("../src/functions/prune.js");
    expect(shouldPruneLowValue(obs(1, 0.1, "execution"))).toBe(false);
  });

  it("boundary is strict `<`, not `<=`: confidence exactly at the default 0.3 line is NOT pruned", async () => {
    const { shouldPruneLowValue } = await import("../src/functions/prune.js");
    // Guards the synthetic-compression fallback (hardcoded confidence:0.3):
    // if this were `<=`, turning AGENTMEMORY_AUTO_COMPRESS off would wipe
    // every observation the moment low-value pruning is enabled.
    expect(shouldPruneLowValue(obs(8, 0.3, "user"))).toBe(false);
    expect(shouldPruneLowValue(obs(3, 0.6, "user"))).toBe(false);
  });

  it("disabled by default (AGENTMEMORY_LOWVALUE_PRUNE_ENABLED unset): never prunes", async () => {
    delete process.env["AGENTMEMORY_LOWVALUE_PRUNE_ENABLED"];
    const { shouldPruneLowValue } = await import("../src/functions/prune.js");
    expect(shouldPruneLowValue(obs(1, 0.1, "user"))).toBe(false);
  });
});

describe("mem::observe empty-output gate (FR-4 bullet 1)", () => {
  beforeEach(() => {
    vi.resetModules();
    clearLowValueEnv();
    mocks.indexedIds.clear();
    mocks.addSpy.mockClear();
    mocks.vectorAddSpy.mockClear();
  });
  afterEach(() => clearLowValueEnv());

  it("empty toolOutput: not persisted, mem::compress never fires, no index entry", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_empty",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Bash",
        tool_input: { command: "true" },
        tool_output: "   ",
      },
    })) as { success: boolean; dropped?: boolean };

    expect(result.success).toBe(true);
    expect(result.dropped).toBe(true);
    expect(await kv.list("mem:obs:ses_empty")).toHaveLength(0);
    expect(sdk.triggered.filter((t) => t.id === "mem::compress")).toHaveLength(0);
    expect(mocks.addSpy).not.toHaveBeenCalled();
    expect(mocks.vectorAddSpy).not.toHaveBeenCalled();
  });

  // Gap B (pipeline/agentmemory-data-reform dispatch): the test above uses
  // tool_output: "   " (whitespace, a *truthy* string) which already
  // worked before this fix — `raw.toolOutput = d["tool_output"] ||
  // d["error"]` never touches a truthy value. The real payload shape this
  // gate exists to catch is an exact empty string (`tool_output: ""`,
  // falsy) with no error, which the `||` collapses to `undefined` before
  // observe.ts's old single-argument call to shouldDropEmptyObservation
  // could ever see it — so this exact case never actually dropped on the
  // real hook-payload shape, only in isolated unit tests of
  // shouldPruneLowValue() that constructed `raw.toolOutput` directly.
  it("real payload shape (tool_output: '', no error): drops via the untouched-field fallback, not just in isolated unit tests", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_realempty",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Bash",
        tool_input: { command: "true" },
        tool_output: "",
      },
    })) as { success: boolean; dropped?: boolean };

    expect(result.success).toBe(true);
    expect(result.dropped).toBe(true);
    expect(await kv.list("mem:obs:ses_realempty")).toHaveLength(0);
    expect(sdk.triggered.filter((t) => t.id === "mem::compress")).toHaveLength(0);
  });

  it("empty tool_output WITH an error present is NOT dropped — the existing `|| error` merge semantics are unchanged (a failure with a real error is not zero-information)", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_realerror",
      hookType: "post_tool_failure",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Bash",
        tool_input: { command: "false" },
        tool_output: "",
        error: "command exited with status 1",
      },
    })) as { success: boolean; dropped?: boolean };

    expect(result.dropped).toBeUndefined();
    const stored = await kv.list<{ toolOutput?: unknown }>("mem:obs:ses_realerror");
    expect(stored).toHaveLength(1);
    expect(stored[0].toolOutput).toBe("command exited with status 1");
  });
});

describe("mem::compress low-value delete integration (ADR-3: no index entry ever produced)", () => {
  beforeEach(() => {
    vi.resetModules();
    clearLowValueEnv();
    process.env["AGENTMEMORY_LOWVALUE_PRUNE_ENABLED"] = "true";
    process.env["AGENTMEMORY_LOWVALUE_PRUNE_DRY_RUN"] = "false";
    mocks.indexedIds.clear();
    mocks.addSpy.mockClear();
    mocks.vectorAddSpy.mockClear();
  });
  afterEach(() => clearLowValueEnv());

  function provider(xml: string): MemoryProvider {
    return {
      name: "mock",
      compress: async () => xml,
      summarize: async () => "",
    };
  }

  it("low importance (below default line 3): raw is deleted from KV, never indexed", async () => {
    const { registerCompressFunction } = await import("../src/functions/compress.js");
    const { recordAudit } = await import("../src/functions/audit.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:obs:ses_low", "obs_low", {
      id: "obs_low",
      sessionId: "ses_low",
      raw: {},
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      subject: "user",
    });

    registerCompressFunction(sdk as never, kv as never, provider(xmlFor(1)));

    const result = (await sdk.trigger("mem::compress", {
      observationId: "obs_low",
      sessionId: "ses_low",
      raw: {
        id: "obs_low",
        sessionId: "ses_low",
        timestamp: new Date().toISOString(),
        hookType: "post_tool_use",
        toolName: "Read",
        raw: {},
        subject: "user",
      },
    })) as { success: boolean; pruned?: boolean };

    expect(result.success).toBe(true);
    expect(result.pruned).toBe(true);
    expect(await kv.get("mem:obs:ses_low", "obs_low")).toBeNull();
    expect(mocks.addSpy).not.toHaveBeenCalled();
    expect(mocks.vectorAddSpy).not.toHaveBeenCalled();

    const audit = await kv.list("mem:audit");
    const pruneEntry = (audit as Array<{ operation: string; targetIds: string[] }>).find(
      (a) => a.operation === "delete" && a.targetIds.includes("obs_low"),
    );
    expect(pruneEntry).toBeDefined();
    void recordAudit; // silence unused-import warning if tree-shaken
  });

  it("high importance/confidence: kept, and does get indexed normally", async () => {
    const { registerCompressFunction } = await import("../src/functions/compress.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:obs:ses_keep", "obs_keep", {
      id: "obs_keep",
      sessionId: "ses_keep",
      raw: {},
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      subject: "user",
    });

    registerCompressFunction(sdk as never, kv as never, provider(xmlFor(9)));

    const result = (await sdk.trigger("mem::compress", {
      observationId: "obs_keep",
      sessionId: "ses_keep",
      raw: {
        id: "obs_keep",
        sessionId: "ses_keep",
        timestamp: new Date().toISOString(),
        hookType: "post_tool_use",
        toolName: "Read",
        raw: {},
        subject: "user",
      },
    })) as { success: boolean; pruned?: boolean };

    expect(result.success).toBe(true);
    expect(result.pruned).toBeUndefined();
    expect(await kv.get("mem:obs:ses_keep", "obs_keep")).not.toBeNull();
    expect(mocks.addSpy).toHaveBeenCalledTimes(1);
    expect(mocks.indexedIds.has("obs_keep")).toBe(true);
  });

  it("subject=agent follows the same low-value line as user (deleted, never indexed)", async () => {
    const { registerCompressFunction } = await import("../src/functions/compress.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:obs:ses_agent", "obs_agent", {
      id: "obs_agent",
      sessionId: "ses_agent",
      raw: {},
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      subject: "agent",
    });

    registerCompressFunction(sdk as never, kv as never, provider(xmlFor(1)));

    const result = (await sdk.trigger("mem::compress", {
      observationId: "obs_agent",
      sessionId: "ses_agent",
      raw: {
        id: "obs_agent",
        sessionId: "ses_agent",
        timestamp: new Date().toISOString(),
        hookType: "post_tool_use",
        toolName: "Edit",
        raw: {},
        subject: "agent",
      },
    })) as { success: boolean; pruned?: boolean };

    expect(result.pruned).toBe(true);
    expect(await kv.get("mem:obs:ses_agent", "obs_agent")).toBeNull();
    expect(mocks.addSpy).not.toHaveBeenCalled();
  });
});
