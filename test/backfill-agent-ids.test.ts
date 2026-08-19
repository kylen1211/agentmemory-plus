import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { backfillAgentIds, registerMigrateFunction } from "../src/functions/migrate.js";
import { KV } from "../src/state/schema.js";
import type { Memory } from "../src/types.js";

function makeMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
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

function makeMemory(
  id: string,
  concepts: string[],
  opts: { agentId?: string; content?: string } = {},
): Memory {
  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "bug",
    title: `Memory ${id}`,
    content: opts.content ?? `Content for ${id}`.repeat(10),
    concepts,
    files: [],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    ...(opts.agentId !== undefined && { agentId: opts.agentId }),
  };
}

describe("backfillAgentIds", () => {
  it("matches memories whose concepts[0] is in the allowlist and have no agentId", async () => {
    const kv = makeMockKV();
    await kv.set(KV.memories, "mem_a", makeMemory("mem_a", ["backend-dev", "api"]));

    const result = await backfillAgentIds(kv, ["backend-dev", "frontend-dev"], true);

    expect(result.matched).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.matches[0]).toMatchObject({ id: "mem_a", agentId: "backend-dev" });
  });

  it("skips memories that already have an agentId", async () => {
    const kv = makeMockKV();
    await kv.set(
      KV.memories,
      "mem_a",
      makeMemory("mem_a", ["backend-dev"], { agentId: "existing" }),
    );

    const result = await backfillAgentIds(kv, ["backend-dev"], true);

    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips memories whose concepts[0] is not in the allowlist", async () => {
    const kv = makeMockKV();
    await kv.set(KV.memories, "mem_a", makeMemory("mem_a", ["unknown-thing", "api"]));

    const result = await backfillAgentIds(kv, ["backend-dev"], true);

    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips memories with empty concepts", async () => {
    const kv = makeMockKV();
    await kv.set(KV.memories, "mem_a", makeMemory("mem_a", []));

    const result = await backfillAgentIds(kv, ["backend-dev"], true);

    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("does not write to KV in dry-run mode (default)", async () => {
    const kv = makeMockKV();
    await kv.set(KV.memories, "mem_a", makeMemory("mem_a", ["backend-dev"]));

    const result = await backfillAgentIds(kv, ["backend-dev"]);

    expect(result.matched).toBe(1);
    expect(result.updated).toBe(0);
    const stored = await kv.get<Memory>(KV.memories, "mem_a");
    expect(stored?.agentId).toBeUndefined();
  });

  it("writes agentId in place when dryRun is false, leaving other fields untouched", async () => {
    const kv = makeMockKV();
    const original = makeMemory("mem_a", ["backend-dev", "api"], {
      content: "some specific content",
    });
    await kv.set(KV.memories, "mem_a", original);

    const result = await backfillAgentIds(kv, ["backend-dev"], false);

    expect(result.updated).toBe(1);
    const stored = await kv.get<Memory>(KV.memories, "mem_a");
    expect(stored?.agentId).toBe("backend-dev");
    expect(stored?.content).toBe("some specific content");
    expect(stored?.id).toBe("mem_a");
    expect(stored?.concepts).toEqual(["backend-dev", "api"]);
  });

  it("truncates content preview to 80 chars in match list", async () => {
    const kv = makeMockKV();
    const longContent = "x".repeat(200);
    await kv.set(KV.memories, "mem_a", makeMemory("mem_a", ["backend-dev"], { content: longContent }));

    const result = await backfillAgentIds(kv, ["backend-dev"], true);

    expect(result.matches[0].content.length).toBe(80);
  });

  it("is idempotent when run twice in succession", async () => {
    const kv = makeMockKV();
    await kv.set(KV.memories, "mem_a", makeMemory("mem_a", ["backend-dev"]));

    const first = await backfillAgentIds(kv, ["backend-dev"], false);
    expect(first.updated).toBe(1);

    const second = await backfillAgentIds(kv, ["backend-dev"], false);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

describe("mem::migrate step=backfill-agent-ids", () => {
  function mockSdk() {
    const functions = new Map<string, Function>();
    return {
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
      registerTrigger: () => {},
      trigger: async (input: { function_id: string; payload: unknown }) => {
        const fn = functions.get(input.function_id);
        if (!fn) throw new Error(`No function: ${input.function_id}`);
        return fn(input.payload);
      },
    };
  }

  it("defaults to dryRun=true and reports matches without writing", async () => {
    const kv = makeMockKV();
    await kv.set(KV.memories, "mem_a", makeMemory("mem_a", ["backend-dev"]));
    const sdk = mockSdk();
    registerMigrateFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "backfill-agent-ids", agentAllowlist: ["backend-dev"] },
    })) as { success: boolean; dryRun: boolean; matched: number; updated: number };

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.updated).toBe(0);

    const stored = await kv.get<Memory>(KV.memories, "mem_a");
    expect(stored?.agentId).toBeUndefined();
  });

  it("rejects when agentAllowlist is missing or empty", async () => {
    const kv = makeMockKV();
    const sdk = mockSdk();
    registerMigrateFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "backfill-agent-ids" },
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("agentAllowlist");
  });
});
