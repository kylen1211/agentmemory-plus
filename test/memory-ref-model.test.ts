import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// review Important-3: api::memory-by-id scope filtering needs
// isAgentScopeIsolated()/getAgentId() to be independently toggleable
// per-test, without touching the other config.js exports api.ts also
// pulls in (feature flags for unrelated endpoints). Same
// importOriginal-passthrough shape as test/agent-isolation-search.test.ts,
// scoped to just these two functions. Default state (agentId=undefined,
// isolated=false) matches "AGENTMEMORY_AGENT_SCOPE unset" — every other
// test in this file relies on that default and is unaffected.
const scopeState = vi.hoisted(() => ({
  agentId: undefined as string | undefined,
  isolated: false,
}));
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    getAgentId: () => scopeState.agentId,
    isAgentScopeIsolated: () => scopeState.isolated,
  };
});

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Memory, CompressedObservation } from "../src/types.js";

// FR-1 (agentmemory-ref-model T-1): REST-boundary format default flip
// (api.ts:api::search) and the memories/{id} two-hop fallback
// (api.ts:api::memory-by-id). Mock scaffolding mirrors
// test/memory-scope-isolation.test.ts (same repo convention).

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggerOverrides = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      if (triggerOverrides.has(id)) {
        return triggerOverrides.get(id)!(payload);
      }
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    overrideTrigger: (id: string, handler: Function) => {
      triggerOverrides.set(id, handler);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function makeReq(opts: {
  body?: unknown;
  headers?: Record<string, string>;
  path_params?: Record<string, string>;
  query_params?: Record<string, string>;
}) {
  return {
    body: opts.body,
    headers: opts.headers || {},
    path_params: opts.path_params || {},
    query_params: opts.query_params || {},
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem_test_1",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    type: "fact",
    title: "test memory",
    content: "test content",
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 1,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

function makeObservation(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_test_1",
    sessionId: "ses_1",
    timestamp: "2026-08-19T00:00:00.000Z",
    type: "fact",
    title: "test observation",
    facts: [],
    narrative: "full narrative body",
    concepts: [],
    files: [],
    importance: 5,
    ...overrides,
  };
}

describe("FR-1 (agentmemory-ref-model T-1): api::search REST default", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
  });

  it("fills format=compact into the mem::search payload when the caller omits it", async () => {
    let capturedPayload: unknown;
    sdk.overrideTrigger("mem::search", async (payload: unknown) => {
      capturedPayload = payload;
      return { format: "compact", results: [], tokens_used: 0, truncated: false };
    });
    const fn = sdk.getFunction("api::search")!;
    const res = await fn(makeReq({ body: { query: "auth middleware" } }));
    expect(res.status_code).toBe(200);
    expect((capturedPayload as { format?: string }).format).toBe("compact");
    // REST response echoes back whatever mem::search returned.
    expect((res.body as { format: string }).format).toBe("compact");
  });

  it("passes through an explicit format=full untouched", async () => {
    let capturedPayload: unknown;
    sdk.overrideTrigger("mem::search", async (payload: unknown) => {
      capturedPayload = payload;
      return { format: "full", results: [], tokens_used: 0, truncated: false };
    });
    const fn = sdk.getFunction("api::search")!;
    const res = await fn(makeReq({ body: { query: "auth middleware", format: "full" } }));
    expect(res.status_code).toBe(200);
    expect((capturedPayload as { format?: string }).format).toBe("full");
  });
});

describe("FR-1 (agentmemory-ref-model T-1): api::memory-by-id two-hop fallback", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
  });

  it("returns kind=memory when the id is in KV.memories", async () => {
    const memory = makeMemory({ id: "mem_abc" });
    await kv.set(KV.memories, "mem_abc", memory);
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(makeReq({ path_params: { id: "mem_abc" } }));
    expect(res.status_code).toBe(200);
    expect((res.body as { kind: string }).kind).toBe("memory");
    expect((res.body as { memory: Memory }).memory.id).toBe("mem_abc");
  });

  it("falls back to KV.observations(sessionId) and returns kind=observation, full narrative/facts included", async () => {
    const obs = makeObservation({ id: "obs_xyz", sessionId: "ses_9" });
    await kv.set(KV.observations("ses_9"), "obs_xyz", obs);
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(
      makeReq({ path_params: { id: "obs_xyz" }, query_params: { sessionId: "ses_9" } }),
    );
    expect(res.status_code).toBe(200);
    const body = res.body as { kind: string; memory: CompressedObservation };
    expect(body.kind).toBe("observation");
    expect(body.memory.id).toBe("obs_xyz");
    expect(body.memory.narrative).toBe("full narrative body");
    expect(body.memory.facts).toBeDefined();
  });

  it("resolves via KV.observations even for a compound sr_obs_ prefix id (no prefix-based routing)", async () => {
    const obs = makeObservation({ id: "sr_obs_compound", sessionId: "ses_9" });
    await kv.set(KV.observations("ses_9"), "sr_obs_compound", obs);
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(
      makeReq({
        path_params: { id: "sr_obs_compound" },
        query_params: { sessionId: "ses_9" },
      }),
    );
    expect(res.status_code).toBe(200);
    expect((res.body as { kind: string }).kind).toBe("observation");
  });

  it("returns 404 with a plain message when sessionId is given but both stores miss", async () => {
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(
      makeReq({
        path_params: { id: "mem_definitely_not_exist" },
        query_params: { sessionId: "nosuchsession" },
      }),
    );
    expect(res.status_code).toBe(404);
    expect((res.body as { error: string }).error).toBe(
      "memory not found: mem_definitely_not_exist",
    );
  });

  it("returns 404 with a sessionId hint when sessionId is omitted and KV.memories misses", async () => {
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(makeReq({ path_params: { id: "obs_missing_session" } }));
    expect(res.status_code).toBe(404);
    expect((res.body as { error: string }).error).toBe(
      "memory not found: obs_missing_session (observation ids need ?sessionId=<sessionId> from the search result)",
    );
  });
});

describe("review Important-3 (agentmemory-ref-model P0 fix): api::memory-by-id agent-scope filtering", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    scopeState.agentId = undefined;
    scopeState.isolated = false;
  });

  it("scope unset: a memory with a different agentId is still returned unfiltered (existing behavior unchanged)", async () => {
    const memory = makeMemory({ id: "mem_other_agent", agentId: "other-agent" });
    await kv.set(KV.memories, "mem_other_agent", memory);
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(makeReq({ path_params: { id: "mem_other_agent" } }));
    expect(res.status_code).toBe(200);
    expect((res.body as { kind: string }).kind).toBe("memory");
  });

  it("isolated scope: a KV.memories row owned by a different agentId is rejected with the same not-found shape (no sessionId given)", async () => {
    scopeState.agentId = "self-agent";
    scopeState.isolated = true;
    const memory = makeMemory({ id: "mem_other_agent", agentId: "other-agent" });
    await kv.set(KV.memories, "mem_other_agent", memory);
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(makeReq({ path_params: { id: "mem_other_agent" } }));
    expect(res.status_code).toBe(404);
    expect((res.body as { error: string }).error).toBe(
      "memory not found: mem_other_agent (observation ids need ?sessionId=<sessionId> from the search result)",
    );
  });

  it("isolated scope: an observation row owned by a different agentId is rejected with the same not-found shape (sessionId given)", async () => {
    scopeState.agentId = "self-agent";
    scopeState.isolated = true;
    const obs = makeObservation({ id: "obs_other_agent", sessionId: "ses_9", agentId: "other-agent" });
    await kv.set(KV.observations("ses_9"), "obs_other_agent", obs);
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(
      makeReq({ path_params: { id: "obs_other_agent" }, query_params: { sessionId: "ses_9" } }),
    );
    expect(res.status_code).toBe(404);
    expect((res.body as { error: string }).error).toBe("memory not found: obs_other_agent");
  });

  it("isolated scope: a row that matches the caller's own agentId is still returned", async () => {
    scopeState.agentId = "self-agent";
    scopeState.isolated = true;
    const memory = makeMemory({ id: "mem_own", agentId: "self-agent" });
    await kv.set(KV.memories, "mem_own", memory);
    const fn = sdk.getFunction("api::memory-by-id")!;
    const res = await fn(makeReq({ path_params: { id: "mem_own" } }));
    expect(res.status_code).toBe(200);
    expect((res.body as { memory: Memory }).memory.id).toBe("mem_own");
  });
});

describe("review Important-1 (agentmemory-ref-model P0 fix): api::action-update REST 400 validation", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
  });

  it("rejects appendSourceMemoryIds that is not an array of strings with 400, without reaching mem::action-update", async () => {
    let triggered = false;
    sdk.overrideTrigger("mem::action-update", async () => {
      triggered = true;
      return { id: "act_1" };
    });
    const fn = sdk.getFunction("api::action-update")!;
    const res = await fn(
      makeReq({ body: { actionId: "act_1", appendSourceMemoryIds: ["ok", 42] } }),
    );
    expect(res.status_code).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "appendSourceMemoryIds must be an array of strings",
    );
    expect(triggered).toBe(false);
  });

  it("rejects appendSourceObservationIds that is not an array with 400, without reaching mem::action-update", async () => {
    let triggered = false;
    sdk.overrideTrigger("mem::action-update", async () => {
      triggered = true;
      return { id: "act_1" };
    });
    const fn = sdk.getFunction("api::action-update")!;
    const res = await fn(
      makeReq({ body: { actionId: "act_1", appendSourceObservationIds: "not-an-array" } }),
    );
    expect(res.status_code).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "appendSourceObservationIds must be an array of strings",
    );
    expect(triggered).toBe(false);
  });

  it("accepts valid string arrays for both fields and forwards the call", async () => {
    let capturedPayload: unknown;
    sdk.overrideTrigger("mem::action-update", async (payload: unknown) => {
      capturedPayload = payload;
      return { id: "act_1" };
    });
    const fn = sdk.getFunction("api::action-update")!;
    const res = await fn(
      makeReq({
        body: {
          actionId: "act_1",
          appendSourceMemoryIds: ["mem_a"],
          appendSourceObservationIds: ["obs_a"],
        },
      }),
    );
    expect(res.status_code).toBe(200);
    expect(
      (capturedPayload as { appendSourceMemoryIds?: string[] }).appendSourceMemoryIds,
    ).toEqual(["mem_a"]);
  });
});
