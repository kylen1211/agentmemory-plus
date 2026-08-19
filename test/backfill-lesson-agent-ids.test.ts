import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { backfillLessonAgentIds, registerMigrateFunction } from "../src/functions/migrate.js";
import { KV } from "../src/state/schema.js";
import type { Lesson } from "../src/types.js";

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

function makeLesson(
  id: string,
  tags: string[],
  opts: { agentId?: string; content?: string } = {},
): Lesson {
  return {
    id,
    content: opts.content ?? `Content for ${id}`.repeat(10),
    context: "",
    confidence: 0.5,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    tags,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    decayRate: 0.05,
    ...(opts.agentId !== undefined && { agentId: opts.agentId }),
  };
}

describe("backfillLessonAgentIds", () => {
  it("matches lessons whose tags intersect the allowlist in exactly one place", async () => {
    const kv = makeMockKV();
    await kv.set(KV.lessons, "lsn_a", makeLesson("lsn_a", ["backend-dev", "pitfall"]));

    const result = await backfillLessonAgentIds(kv, ["backend-dev", "frontend-dev"], true);

    expect(result.matched).toBe(1);
    expect(result.ambiguous).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.matches[0]).toMatchObject({ id: "lsn_a", agentId: "backend-dev" });
  });

  it("skips lessons that already have an agentId", async () => {
    const kv = makeMockKV();
    await kv.set(
      KV.lessons,
      "lsn_a",
      makeLesson("lsn_a", ["backend-dev"], { agentId: "existing" }),
    );

    const result = await backfillLessonAgentIds(kv, ["backend-dev"], true);

    expect(result.matched).toBe(0);
    expect(result.ambiguous).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips lessons with zero tags in the allowlist", async () => {
    const kv = makeMockKV();
    await kv.set(KV.lessons, "lsn_a", makeLesson("lsn_a", ["pitfall", "security"]));

    const result = await backfillLessonAgentIds(kv, ["backend-dev"], true);

    expect(result.matched).toBe(0);
    expect(result.ambiguous).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("marks lessons ambiguous (not matched, not skipped) when more than one tag is in the allowlist", async () => {
    const kv = makeMockKV();
    await kv.set(
      KV.lessons,
      "lsn_a",
      makeLesson("lsn_a", ["backend-dev", "frontend-dev", "pitfall"]),
    );

    const result = await backfillLessonAgentIds(kv, ["backend-dev", "frontend-dev"], true);

    expect(result.matched).toBe(0);
    expect(result.ambiguous).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.ambiguousMatches[0]).toMatchObject({
      id: "lsn_a",
      tags: ["backend-dev", "frontend-dev", "pitfall"],
    });
    // ambiguous matches carry no agentId — left for human triage.
    expect((result.ambiguousMatches[0] as unknown as Record<string, unknown>).agentId).toBeUndefined();
  });

  it("does not depend on tag order (unlike concepts[0] for memories)", async () => {
    const kv = makeMockKV();
    // agent tag is NOT first here — CLI does not guarantee order.
    await kv.set(KV.lessons, "lsn_a", makeLesson("lsn_a", ["pitfall", "security", "backend-dev"]));

    const result = await backfillLessonAgentIds(kv, ["backend-dev"], true);

    expect(result.matched).toBe(1);
    expect(result.matches[0].agentId).toBe("backend-dev");
  });

  it("does not write to KV in dry-run mode (default)", async () => {
    const kv = makeMockKV();
    await kv.set(KV.lessons, "lsn_a", makeLesson("lsn_a", ["backend-dev"]));

    const result = await backfillLessonAgentIds(kv, ["backend-dev"]);

    expect(result.matched).toBe(1);
    expect(result.updated).toBe(0);
    const stored = await kv.get<Lesson>(KV.lessons, "lsn_a");
    expect(stored?.agentId).toBeUndefined();
  });

  it("writes agentId in place when dryRun is false, leaving other fields untouched", async () => {
    const kv = makeMockKV();
    const original = makeLesson("lsn_a", ["backend-dev", "pitfall"], {
      content: "some specific lesson content",
    });
    await kv.set(KV.lessons, "lsn_a", original);

    const result = await backfillLessonAgentIds(kv, ["backend-dev"], false);

    expect(result.updated).toBe(1);
    const stored = await kv.get<Lesson>(KV.lessons, "lsn_a");
    expect(stored?.agentId).toBe("backend-dev");
    expect(stored?.content).toBe("some specific lesson content");
    expect(stored?.id).toBe("lsn_a");
    expect(stored?.tags).toEqual(["backend-dev", "pitfall"]);
  });

  it("does not write ambiguous lessons even when dryRun is false", async () => {
    const kv = makeMockKV();
    await kv.set(
      KV.lessons,
      "lsn_a",
      makeLesson("lsn_a", ["backend-dev", "frontend-dev"]),
    );

    const result = await backfillLessonAgentIds(kv, ["backend-dev", "frontend-dev"], false);

    expect(result.updated).toBe(0);
    expect(result.ambiguous).toBe(1);
    const stored = await kv.get<Lesson>(KV.lessons, "lsn_a");
    expect(stored?.agentId).toBeUndefined();
  });

  it("truncates content preview to 80 chars in both match lists", async () => {
    const kv = makeMockKV();
    const longContent = "x".repeat(200);
    await kv.set(KV.lessons, "lsn_a", makeLesson("lsn_a", ["backend-dev"], { content: longContent }));
    await kv.set(
      KV.lessons,
      "lsn_b",
      makeLesson("lsn_b", ["backend-dev", "frontend-dev"], { content: longContent }),
    );

    const result = await backfillLessonAgentIds(kv, ["backend-dev", "frontend-dev"], true);

    expect(result.matches[0].content.length).toBe(80);
    expect(result.ambiguousMatches[0].content.length).toBe(80);
  });

  it("is idempotent when run twice in succession", async () => {
    const kv = makeMockKV();
    await kv.set(KV.lessons, "lsn_a", makeLesson("lsn_a", ["backend-dev"]));

    const first = await backfillLessonAgentIds(kv, ["backend-dev"], false);
    expect(first.updated).toBe(1);

    const second = await backfillLessonAgentIds(kv, ["backend-dev"], false);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

describe("mem::migrate step=backfill-lesson-agent-ids", () => {
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
    await kv.set(KV.lessons, "lsn_a", makeLesson("lsn_a", ["backend-dev"]));
    const sdk = mockSdk();
    registerMigrateFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "backfill-lesson-agent-ids", agentAllowlist: ["backend-dev"] },
    })) as { success: boolean; dryRun: boolean; matched: number; updated: number; ambiguous: number };

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.ambiguous).toBe(0);

    const stored = await kv.get<Lesson>(KV.lessons, "lsn_a");
    expect(stored?.agentId).toBeUndefined();
  });

  it("rejects when agentAllowlist is missing or empty", async () => {
    const kv = makeMockKV();
    const sdk = mockSdk();
    registerMigrateFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "backfill-lesson-agent-ids" },
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("agentAllowlist");
  });
});
