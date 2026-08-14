import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAllTools } from "../src/mcp/tools-registry.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import type { Memory } from "../src/types.js";

// Shared mock scaffolding for this file (照抄 test/mcp-resources.test.ts:10-66),
// reused by later FR-1/FR-4/FR-5 cases appended to this same file.

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

function makeReq(body?: unknown, headers?: Record<string, string>) {
  return {
    body,
    headers: headers || {},
    query_params: {},
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem_test_1",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
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

describe("FR-1", () => {
  it("FR-1 memoryToObservation transparently passes through agentId and project", () => {
    const memory = makeMemory({ agentId: "pm-agent", project: "worker-config" });
    const observation = memoryToObservation(memory);
    expect(observation.agentId).toBe("pm-agent");
    expect(observation.project).toBe("worker-config");
  });

  it("FR-1 memoryToObservation leaves agentId/project undefined without defaults or errors", () => {
    const memory = makeMemory();
    expect(() => memoryToObservation(memory)).not.toThrow();
    const observation = memoryToObservation(memory);
    expect(observation.agentId).toBeUndefined();
    expect(observation.project).toBeUndefined();
  });
});

describe("FR-3", () => {
  it("FR-3 memory_save inputSchema exposes a string agentId property", () => {
    const tool = getAllTools().find((t) => t.name === "memory_save");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties["agentId"]?.type).toBe("string");
  });

  it("FR-3 memory_save required stays [content] and total tool count is unchanged", () => {
    const tool = getAllTools().find((t) => t.name === "memory_save");
    expect(tool!.inputSchema.required).toEqual(["content"]);
    expect(getAllTools().length).toBe(54);
  });
});

describe("FR-4", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerMcpEndpoints(sdk as never, kv as never);
  });

  it("FR-4 POST /agentmemory/mcp/call memory_save forwards args.agentId into the mem::remember payload", async () => {
    let capturedPayload: unknown;
    sdk.overrideTrigger("mem::remember", (payload: unknown) => {
      capturedPayload = payload;
      return { id: "mem_1" };
    });
    const fn = sdk.getFunction("mcp::tools::call")!;
    const res = await fn(
      makeReq({
        name: "memory_save",
        arguments: { content: "hello", agentId: "a1", project: "worker-config" },
      }),
    );
    expect(res.status_code).toBe(200);
    expect((capturedPayload as { agentId?: string }).agentId).toBe("a1");
    expect((capturedPayload as { project?: string }).project).toBe(
      "worker-config",
    );
  });

  it("FR-4 POST /agentmemory/mcp/call memory_save omits agentId from the payload when not provided, leaving project transparency unaffected", async () => {
    let capturedPayload: unknown;
    sdk.overrideTrigger("mem::remember", (payload: unknown) => {
      capturedPayload = payload;
      return { id: "mem_1" };
    });
    const fn = sdk.getFunction("mcp::tools::call")!;
    const res = await fn(
      makeReq({
        name: "memory_save",
        arguments: { content: "hello", project: "worker-config" },
      }),
    );
    expect(res.status_code).toBe(200);
    expect("agentId" in (capturedPayload as object)).toBe(false);
    expect((capturedPayload as { project?: string }).project).toBe(
      "worker-config",
    );
  });
});

describe("FR-5", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
  });

  it("FR-5 api::remember passes a normal-length agentId through to mem::remember", async () => {
    let capturedPayload: unknown;
    sdk.overrideTrigger("mem::remember", async (payload: unknown) => {
      capturedPayload = payload;
      return { id: "mem_1" };
    });
    const fn = sdk.getFunction("api::remember")!;
    const res = await fn(makeReq({ content: "hello", agentId: "pm-agent" }));
    expect(res.status_code).toBe(201);
    expect((capturedPayload as { agentId?: string }).agentId).toBe("pm-agent");
  });

  it("FR-5 api::remember truncates an agentId over 128 chars to exactly 128", async () => {
    let capturedPayload: unknown;
    sdk.overrideTrigger("mem::remember", async (payload: unknown) => {
      capturedPayload = payload;
      return { id: "mem_1" };
    });
    const fn = sdk.getFunction("api::remember")!;
    const longAgentId = "a".repeat(150);
    const res = await fn(makeReq({ content: "hello", agentId: longAgentId }));
    expect(res.status_code).toBe(201);
    const sentAgentId = (capturedPayload as { agentId?: string }).agentId;
    expect(sentAgentId).toBe("a".repeat(128));
    expect(sentAgentId?.length).toBe(128);
  });

  it("FR-5 api::remember leaves agentId out of the payload when missing or empty, without erroring", async () => {
    let capturedMissing: unknown;
    let capturedEmpty: unknown;
    sdk.overrideTrigger("mem::remember", async (payload: unknown) => {
      capturedMissing = payload;
      return { id: "mem_1" };
    });
    const fn = sdk.getFunction("api::remember")!;
    const resMissing = await fn(makeReq({ content: "hello" }));
    expect(resMissing.status_code).toBe(201);
    expect((capturedMissing as { agentId?: string }).agentId).toBeUndefined();
    expect("agentId" in (capturedMissing as object)).toBe(false);

    sdk.overrideTrigger("mem::remember", async (payload: unknown) => {
      capturedEmpty = payload;
      return { id: "mem_1" };
    });
    const resEmpty = await fn(makeReq({ content: "hello", agentId: "   " }));
    expect(resEmpty.status_code).toBe(201);
    expect((capturedEmpty as { agentId?: string }).agentId).toBeUndefined();
    expect("agentId" in (capturedEmpty as object)).toBe(false);
  });
});
