import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAllTools } from "../src/mcp/tools-registry.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
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
