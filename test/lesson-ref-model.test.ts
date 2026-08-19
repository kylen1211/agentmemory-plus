import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import type { Lesson } from "../src/types.js";

// FR-2 (agentmemory-ref-model T-2): REST-boundary format default flip on
// POST /agentmemory/lessons/search (api::lesson-search) and the new
// GET /agentmemory/lessons/{lessonId} (api::lesson-get). Mock scaffolding
// mirrors test/memory-ref-model.test.ts (same repo convention, same batch).

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
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
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

describe("FR-2 (agentmemory-ref-model T-2): api::lesson-search REST default", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const longContent = "z".repeat(300) + " tail text for the lesson body";

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never);
    await sdk.trigger("mem::lesson-save", {
      content: longContent,
      project: "/app",
      tags: ["reliability"],
      confidence: 0.9,
    });
  });

  it("fr2-lesson-recall-default-compact: omitting format returns compact lessons, content truncated to 240 chars + ellipsis", async () => {
    const fn = sdk.getFunction("api::lesson-search")!;
    const res = await fn(
      makeReq({ body: { query: "reliability", limit: 3 } }),
    );
    expect(res.status_code).toBe(200);
    const body = res.body as {
      format: string;
      lessons: Array<Record<string, unknown>>;
    };
    expect(body.format).toBe("compact");
    const l = body.lessons[0];
    expect(new Set(Object.keys(l))).toEqual(
      new Set(["lessonId", "content", "confidence", "score", "createdAt", "project", "tags"]),
    );
    expect((l.content as string).length).toBe(241);
    expect((l.content as string).endsWith("…")).toBe(true);
    expect(l).not.toHaveProperty("context");
    expect(l).not.toHaveProperty("sourceIds");
  });

  it("fr2-lesson-recall-explicit-full: format=full returns the untruncated whole Lesson + score", async () => {
    const fn = sdk.getFunction("api::lesson-search")!;
    const res = await fn(
      makeReq({ body: { query: "reliability", limit: 3, format: "full" } }),
    );
    expect(res.status_code).toBe(200);
    const body = res.body as { format: string; lessons: Array<Lesson & { score: number }> };
    expect(body.format).toBe("full");
    expect(body.lessons[0].content).toBe(longContent);
    expect(body.lessons[0]).toHaveProperty("context");
    expect(body.lessons[0]).toHaveProperty("sourceIds");
    expect(typeof body.lessons[0].score).toBe("number");
  });

  it("fr2-lesson-recall-bad-format-400: an unsupported format (e.g. narrative) is rejected before reaching mem::lesson-recall", async () => {
    const fn = sdk.getFunction("api::lesson-search")!;
    const res = await fn(
      makeReq({ body: { query: "x", format: "narrative" } }),
    );
    expect(res.status_code).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "format must be one of: full, compact",
    );
  });

  it("rejects a missing query with 400", async () => {
    const fn = sdk.getFunction("api::lesson-search")!;
    const res = await fn(makeReq({ body: {} }));
    expect(res.status_code).toBe(400);
    expect((res.body as { error: string }).error).toBe("query is required");
  });
});

describe("FR-2 (agentmemory-ref-model T-2): api::lesson-get", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never);
  });

  it("fr2-lesson-get-existing: returns the full lesson content and metadata for a known id", async () => {
    const saved = (await sdk.trigger("mem::lesson-save", {
      content: "Full untruncated content body",
      context: "some context",
      tags: ["x", "y"],
      confidence: 0.6,
    })) as { lesson: Lesson };

    const fn = sdk.getFunction("api::lesson-get")!;
    const res = await fn(makeReq({ path_params: { lessonId: saved.lesson.id } }));
    expect(res.status_code).toBe(200);
    const body = res.body as { success: boolean; lesson: Lesson };
    expect(body.success).toBe(true);
    expect(body.lesson.id).toBe(saved.lesson.id);
    expect(body.lesson.content).toBe("Full untruncated content body");
    expect(body.lesson.context).toBe("some context");
  });

  it("fr2-lesson-get-notfound-404: an unknown lessonId returns 404 with the exact contract error body", async () => {
    const fn = sdk.getFunction("api::lesson-get")!;
    const res = await fn(
      makeReq({ path_params: { lessonId: "lsn_definitely_not_exist" } }),
    );
    expect(res.status_code).toBe(404);
    expect((res.body as { error: string }).error).toBe(
      "lesson not found: lsn_definitely_not_exist",
    );
  });

  it("fr2-lesson-get-notfound-404 (soft-deleted): a soft-deleted lesson is also treated as not found", async () => {
    const saved = (await sdk.trigger("mem::lesson-save", {
      content: "Will be deleted",
    })) as { lesson: Lesson };
    await sdk.trigger("mem::lesson-delete", { lessonId: saved.lesson.id });

    const fn = sdk.getFunction("api::lesson-get")!;
    const res = await fn(makeReq({ path_params: { lessonId: saved.lesson.id } }));
    expect(res.status_code).toBe(404);
    expect((res.body as { error: string }).error).toBe(
      `lesson not found: ${saved.lesson.id}`,
    );
  });
});

// FR-2 hard constraint (ADR-4): the internal sdk.trigger-direct consumer
// (smart-search.ts's recallLessons) never sends format and must keep
// receiving whole Lesson objects — verified structurally, not by any
// change to smart-search.ts (that file's diff is zero lines this batch).
describe("FR-2 (agentmemory-ref-model T-2): fr2-internal-consumer-unchanged", () => {
  it("mem::lesson-recall without format still returns whole Lesson objects (function-level default stays full)", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
    await sdk.trigger("mem::lesson-save", {
      content: "y".repeat(300) + " reliability lesson body",
      tags: ["reliability"],
      confidence: 0.8,
    });

    const result = (await sdk.trigger("mem::lesson-recall", {
      query: "reliability",
    })) as { format: string; lessons: Array<Lesson & { score: number }> };

    expect(result.format).toBe("full");
    expect(result.lessons[0].content.length).toBe(300 + " reliability lesson body".length);
    expect(result.lessons[0]).toHaveProperty("context");
    expect(result.lessons[0]).toHaveProperty("sourceIds");
  });
});
