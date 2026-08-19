import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CompressedObservation } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const dedupSkippedAdd = vi.fn();
vi.mock("../src/telemetry/setup.js", () => ({
  getCounters: () => ({ dedupSkipped: { add: dedupSkippedAdd } }),
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

function toolUsePayload(sessionId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId,
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Read",
      tool_input: { file_path: "src/shared.ts" },
      tool_output: "shared file contents",
    },
    ...overrides,
  };
}

function subagentStopPayload(
  sessionId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    sessionId,
    hookType: "subagent_stop",
    timestamp: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

function subagentStartPayload(
  sessionId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    sessionId,
    hookType: "subagent_start",
    timestamp: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

describe("dedup + repeatCount (FR-6)", () => {
  beforeEach(() => {
    vi.resetModules();
    dedupSkippedAdd.mockClear();
    // Force the zero-LLM synthetic path regardless of the real
    // ~/.agentmemory/.env on this box (it has AUTO_COMPRESS=true in this
    // deployment) — process.env explicitly set here wins over the file
    // default per config.ts's {...fileEnv, ...process.env} precedence.
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
  });
  afterEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("cross-session duplicate (real tool_name) within TTL: repeatCount=2, confidence unchanged, dedup.skipped+1, no new record, no compress trigger", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedupMap = new DedupMap(30 * 60 * 1000);
    registerObserveFunction(sdk as never, kv as never, dedupMap as never);

    const first = (await sdk.trigger("mem::observe", toolUsePayload("ses_A"))) as {
      observationId: string;
    };
    expect(first.observationId).toBeTruthy();

    const firstRecord = (await kv.get(
      "mem:obs:ses_A",
      first.observationId,
    )) as CompressedObservation;
    expect(firstRecord.confidence).toBe(0.3);
    expect(firstRecord.repeatCount).toBeUndefined();

    sdk.triggered.length = 0;

    const second = (await sdk.trigger("mem::observe", toolUsePayload("ses_B"))) as {
      deduplicated: boolean;
      obsId: string;
      repeatCount: number;
      sessionId: string;
    };

    expect(second.deduplicated).toBe(true);
    expect(second.obsId).toBe(first.observationId);
    expect(second.repeatCount).toBe(2);
    expect(dedupSkippedAdd).toHaveBeenCalledTimes(1);
    expect(dedupSkippedAdd).toHaveBeenCalledWith(1);

    // No new record created anywhere — ses_B never got a row at all.
    expect(await kv.list("mem:obs:ses_B")).toHaveLength(0);
    expect(await kv.list("mem:obs:ses_A")).toHaveLength(1);

    const updated = (await kv.get(
      "mem:obs:ses_A",
      first.observationId,
    )) as CompressedObservation;
    expect(updated.repeatCount).toBe(2);
    expect(updated.confidence).toBe(0.3); // unchanged by the dedup hit

    // mem::compress must never fire for a deduplicated hit.
    expect(sdk.triggered.filter((t) => t.id === "mem::compress")).toHaveLength(0);
  });

  it("duplicate outside the TTL window: treated as a brand-new record, repeatCount starts at 1 (unset)", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedupMap = new DedupMap(30); // 30ms TTL — window expires fast
    registerObserveFunction(sdk as never, kv as never, dedupMap as never);

    const first = (await sdk.trigger("mem::observe", toolUsePayload("ses_C"))) as {
      observationId: string;
    };
    expect(first.observationId).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 60));

    const second = (await sdk.trigger("mem::observe", toolUsePayload("ses_D"))) as {
      observationId?: string;
      deduplicated?: boolean;
    };

    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
    expect(second.observationId).not.toBe(first.observationId);

    const secondRecord = (await kv.get(
      "mem:obs:ses_D",
      second.observationId!,
    )) as CompressedObservation;
    expect(secondRecord.repeatCount).toBeUndefined(); // reads as 1
  });

  it("ADR-6 regression: two different-session subagent_stop events (no toolName, empty input) are NOT deduplicated", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedupMap = new DedupMap(30 * 60 * 1000);
    registerObserveFunction(sdk as never, kv as never, dedupMap as never);

    const first = (await sdk.trigger(
      "mem::observe",
      subagentStopPayload("ses_X"),
    )) as { observationId?: string; deduplicated?: boolean };
    const second = (await sdk.trigger(
      "mem::observe",
      subagentStopPayload("ses_Y"),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(first.deduplicated).toBeUndefined();
    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
    expect(second.observationId).not.toBe(first.observationId);

    expect(await kv.list("mem:obs:ses_X")).toHaveLength(1);
    expect(await kv.list("mem:obs:ses_Y")).toHaveLength(1);
    expect(dedupSkippedAdd).not.toHaveBeenCalled();
  });

  it("qa-tester P0 regression: two DIFFERENT agents' subagent_stop in the SAME session (within TTL) both land, neither deduplicated", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedupMap = new DedupMap(30 * 60 * 1000);
    registerObserveFunction(sdk as never, kv as never, dedupMap as never);

    const a1 = (await sdk.trigger(
      "mem::observe",
      subagentStopPayload("ses_shared", {
        data: { agent_id: "agent-A1", agent_type: "researcher", last_message: "A1 finished the research task." },
      }),
    )) as { observationId?: string; deduplicated?: boolean };

    const b2 = (await sdk.trigger(
      "mem::observe",
      subagentStopPayload("ses_shared", {
        data: { agent_id: "agent-B2", agent_type: "coder", last_message: "B2 finished writing the patch." },
      }),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(a1.deduplicated).toBeUndefined();
    expect(a1.observationId).toBeTruthy();
    expect(b2.deduplicated).toBeUndefined();
    expect(b2.observationId).toBeTruthy();
    expect(b2.observationId).not.toBe(a1.observationId);

    // Both must be persisted as independent rows in the same session scope.
    const records = await kv.list("mem:obs:ses_shared");
    expect(records).toHaveLength(2);
    expect(dedupSkippedAdd).not.toHaveBeenCalled();
  });

  it("qa-tester P0 regression: two subagent_start events in the SAME session both land, neither deduplicated", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedupMap = new DedupMap(30 * 60 * 1000);
    registerObserveFunction(sdk as never, kv as never, dedupMap as never);

    const start1 = (await sdk.trigger(
      "mem::observe",
      subagentStartPayload("ses_shared2", { data: { agent_id: "agent-A1" } }),
    )) as { observationId?: string; deduplicated?: boolean };
    const start2 = (await sdk.trigger(
      "mem::observe",
      subagentStartPayload("ses_shared2", { data: { agent_id: "agent-B2" } }),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(start1.deduplicated).toBeUndefined();
    expect(start1.observationId).toBeTruthy();
    expect(start2.deduplicated).toBeUndefined();
    expect(start2.observationId).toBeTruthy();
    expect(start2.observationId).not.toBe(start1.observationId);

    expect(await kv.list("mem:obs:ses_shared2")).toHaveLength(2);
    expect(dedupSkippedAdd).not.toHaveBeenCalled();
  });

  it("real tool_name observations still dedup across sessions exactly as before (unaffected by the lifecycle-event skip)", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedupMap = new DedupMap(30 * 60 * 1000);
    registerObserveFunction(sdk as never, kv as never, dedupMap as never);

    const first = (await sdk.trigger("mem::observe", toolUsePayload("ses_E"))) as {
      observationId: string;
    };
    const second = (await sdk.trigger("mem::observe", toolUsePayload("ses_F"))) as {
      deduplicated?: boolean;
      obsId?: string;
      repeatCount?: number;
    };

    expect(second.deduplicated).toBe(true);
    expect(second.obsId).toBe(first.observationId);
    expect(second.repeatCount).toBe(2);
    expect(await kv.list("mem:obs:ses_F")).toHaveLength(0);
  });
});
