import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import type { HybridSearchResult } from "../src/types.js";

// review.md Minor debt #4 (agentmemory-ref-model, 2026-08-19): lessons.ts's
// toCompactLessonResult (LESSON_CONTENT_PREVIEW_CHARS=240) and
// smart-search.ts's recallLessons (its own LESSON_CONTENT_PREVIEW_CHARS=240
// local copy — smart-search.ts must stay zero-diff per FR-2/ADR-4, so the
// two constants cannot be merged into a shared import) are two independent
// copies of the same truncation formula. Nothing pins them to the same
// value/algorithm; changing one without the other silently produces
// different preview lengths for the exact same lesson depending on which
// endpoint served it. This test exercises both REAL implementations
// end-to-end on one saved lesson and asserts the previews are byte-for-byte
// identical — it fails if either copy's cutoff or slicing drifts from the
// other.

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
  const sdk = {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
  return sdk;
}

describe("Lesson content preview truncation stays consistent across lessons.ts and smart-search.ts", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  const noopSearchFn = async (): Promise<HybridSearchResult[]> => [];

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerLessonsFunctions(sdk as never, kv as never);
    registerSmartSearchFunction(sdk as never, kv as never, noopSearchFn);
  });

  it("mem::lesson-recall(format=compact) and mem::smart-search's lesson preview truncate a long lesson identically", async () => {
    // Distinct, non-repeating content so any off-by-one slice boundary
    // difference between the two implementations is directly visible in
    // the assertion diff (a repeated character would hide it).
    const long = Array.from({ length: 60 }, (_, i) => `word${i.toString().padStart(3, "0")}`).join(" ");
    expect(long.length).toBeGreaterThan(240);

    const saveResult = (await sdk.trigger("mem::lesson-save", {
      content: long,
      project: "consistency-check",
    })) as { success: boolean; lesson: { id: string } };
    expect(saveResult.success).toBe(true);

    const viaLessonRecall = (await sdk.trigger("mem::lesson-recall", {
      query: "word001",
      project: "consistency-check",
      format: "compact",
    })) as { success: boolean; lessons: Array<{ content: string }> };
    expect(viaLessonRecall.success).toBe(true);
    expect(viaLessonRecall.lessons.length).toBe(1);

    const viaSmartSearch = (await sdk.trigger("mem::smart-search", {
      query: "word001",
      project: "consistency-check",
      includeLessons: true,
    })) as { lessons?: Array<{ content: string }> };
    expect(viaSmartSearch.lessons).toBeDefined();
    expect(viaSmartSearch.lessons!.length).toBe(1);

    const fromLessonRecall = viaLessonRecall.lessons[0].content;
    const fromSmartSearch = viaSmartSearch.lessons![0].content;

    expect(fromLessonRecall.endsWith("…")).toBe(true);
    expect(fromSmartSearch.endsWith("…")).toBe(true);
    // The actual drift-detection assertion: same cutoff, same algorithm ==
    // same string. If lessons.ts's or smart-search.ts's copy of
    // LESSON_CONTENT_PREVIEW_CHARS (or the slicing logic) diverges, these
    // two previews stop matching.
    expect(fromSmartSearch).toBe(fromLessonRecall);
    expect(fromLessonRecall.length).toBe(241); // 240 chars + the "…" suffix
  });
});
