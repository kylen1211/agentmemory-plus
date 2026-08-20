import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { registerReplayFunctions } from "../src/functions/replay.js";
import { KV } from "../src/state/schema.js";
import type { Lesson } from "../src/types.js";

// insight-dedup-guard's sibling bug: lessons.ts's mem::lesson-save and
// replay.ts's JSONL auto-import used to each call fingerprintId() with a
// different literal prefix ("lsn" vs "lesson") for the exact same
// normalized content, producing two distinct KV keys for what should be
// one content-addressed record. Both now go through the single
// lessonFingerprint() entry point in src/state/schema.ts. This test pins
// that the two creation paths converge on one record for the same
// content — it fails (creates a second "lesson_..." row) if either call
// site regresses back to its own inline prefix.

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk(kv: ReturnType<typeof mockKV>) {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : (idOrInput as any).payload;
      const fn = fns.get(id);
      if (!fn) return { success: true };
      return fn(payload);
    },
    _kv: kv,
  } as any;
}

describe("Lesson id/dedup-key convergence across creation paths (2026-08-20 fix)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "lesson-id-unify-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFixture(sessionId: string, assistantText: string) {
    const dir = join(tmpRoot, "proj");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const ts = "2026-04-17T10:00:00.000Z";
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId,
        timestamp: ts,
        cwd: tmpRoot,
        message: { role: "user", content: [{ type: "text", text: "how do I validate input?" }] },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        sessionId,
        timestamp: ts,
        message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
      }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  it("mem::lesson-save then replay-import of the same content produce exactly one lesson record, reinforced not duplicated", async () => {
    const kv = mockKV();
    const sdk = mockSdk(kv);
    registerLessonsFunctions(sdk, kv as never);
    registerReplayFunctions(sdk, kv as never);

    const content = "Always validate user input before processing requests.";

    const saveResult = (await sdk.trigger("mem::lesson-save", {
      content,
      project: "proj",
    })) as { success: boolean; action: string; lesson: Lesson };
    expect(saveResult.success).toBe(true);
    expect(saveResult.action).toBe("created");
    expect(saveResult.lesson.id).toMatch(/^lsn_/);
    expect(saveResult.lesson.reinforcements).toBe(0);

    writeFixture("sess-dup-lesson", content);
    const importResult = (await sdk.trigger("mem::replay::import-jsonl", {
      path: tmpRoot,
    })) as { success: boolean; imported?: number };
    expect(importResult.success).toBe(true);
    expect(importResult.imported).toBe(1);

    const allLessons = await kv.list<Lesson>(KV.lessons);
    // The bug: replay.ts used fingerprintId("lesson", ...) while lessons.ts
    // used fingerprintId("lsn", ...) for the same normalized content, so
    // this would be 2 records (one "lsn_...", one "lesson_...") pre-fix.
    expect(allLessons.length).toBe(1);
    expect(allLessons[0].id).toBe(saveResult.lesson.id);
    expect(allLessons[0].id).toMatch(/^lsn_/);

    const merged = await kv.get<Lesson>(KV.lessons, saveResult.lesson.id);
    expect(merged!.sourceIds).toContain("sess-dup-lesson");
  });

  it("replay-import then mem::lesson-save of the same content converge the other direction too", async () => {
    const kv = mockKV();
    const sdk = mockSdk(kv);
    registerLessonsFunctions(sdk, kv as never);
    registerReplayFunctions(sdk, kv as never);

    const content = "Never skip error handling in async callbacks.";

    writeFixture("sess-first-lesson", content);
    await sdk.trigger("mem::replay::import-jsonl", { path: tmpRoot });

    const fromImport = await kv.list<Lesson>(KV.lessons);
    expect(fromImport.length).toBe(1);
    expect(fromImport[0].id).toMatch(/^lsn_/);

    const saveResult = (await sdk.trigger("mem::lesson-save", {
      content,
    })) as { success: boolean; action: string; lesson: Lesson };

    expect(saveResult.success).toBe(true);
    expect(saveResult.action).toBe("strengthened");
    expect(saveResult.lesson.id).toBe(fromImport[0].id);

    const allLessons = await kv.list<Lesson>(KV.lessons);
    expect(allLessons.length).toBe(1);
  });
});
