import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMigrateFunction } from "../src/functions/migrate.js";
import {
  getSearchIndex,
  setVectorIndex,
  setIndexPersistence,
  setEmbeddingProvider,
  getEmbeddingProvider,
} from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, EmbeddingProvider, Memory, Session } from "../src/types.js";

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

// 2026-08-19 incident: there was no admin-triggerable full-rebuild entry
// point at all — this step closes that gap by wrapping the same
// rebuildIndex() the automatic boot/cold-start paths use.
describe("mem::migrate step=rebuild-search-index", () => {
  afterEach(() => {
    getSearchIndex().clear();
    setVectorIndex(null);
    // Undo the persistence hook wired by the "persists immediately" test
    // so later files' index.ts-adjacent tests don't inherit a stub.
    setIndexPersistence(null);
  });

  it("repopulates the in-memory BM25 index from KV memories and observations", async () => {
    const kv = makeMockKV();
    const session: Session = {
      id: "ses_1",
      project: "demo",
      cwd: "/tmp",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set(KV.sessions, session.id, session);
    const obs: CompressedObservation = {
      id: "obs_a",
      sessionId: "ses_1",
      timestamp: "2026-01-01T00:00:00Z",
      type: "decision",
      title: "Rebuild step coverage",
      facts: ["fact"],
      narrative: "Narrative for rebuild-search-index step test.",
      concepts: ["test"],
      files: [],
      importance: 5,
    };
    await kv.set(KV.observations("ses_1"), obs.id, obs);
    const mem: Memory = {
      id: "mem_a",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "fact",
      title: "Rebuild target memory",
      content: "runbook-lvm-merge content for rebuild step test.",
      concepts: ["lvm"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: true,
    };
    await kv.set(KV.memories, mem.id, mem);

    getSearchIndex().clear();
    const sdk = mockSdk();
    registerMigrateFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "rebuild-search-index" },
    })) as { success: boolean; indexed: number; bm25Size: number; vectorSize: number | null };

    expect(result.success).toBe(true);
    expect(result.indexed).toBe(2);
    expect(result.bm25Size).toBe(2);
    expect(result.vectorSize).toBeNull(); // no embedding provider configured
    expect(getSearchIndex().search("runbook-lvm-merge").length).toBe(1);
    expect(getSearchIndex().search("narrative").length).toBe(1);
  });

  it("persists the rebuilt index immediately instead of relying on the debounce timer", async () => {
    const kv = makeMockKV();
    await kv.set(KV.memories, "mem_a", {
      id: "mem_a",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "fact",
      title: "Persist check",
      content: "content for persistence flush check",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: true,
    });

    getSearchIndex().clear();
    const save = vi.fn(async () => {});
    setIndexPersistence({ scheduleSave: vi.fn(), save });

    const sdk = mockSdk();
    registerMigrateFunction(sdk as never, kv as never);
    await sdk.trigger({
      function_id: "mem::migrate",
      payload: { step: "rebuild-search-index" },
    });

    expect(save).toHaveBeenCalledTimes(1);
  });

  // 2026-08-19 incident, part 2: the embedding backend itself (a local
  // Ollama instance reached over a stale SSH tunnel) was confirmed down —
  // every embed call burned its full ~60s timeout before giving up,
  // turning a fast local-only BM25 rebuild into an hours-long one.
  // skipVector lets an operator bypass the doomed embedding path.
  describe("skipVector", () => {
    const hangingProvider: EmbeddingProvider = {
      name: "hanging-test-provider",
      dimensions: 3,
      embed: () => new Promise(() => {}),
      embedBatch: () => new Promise(() => {}),
    };

    afterEach(() => {
      setEmbeddingProvider(null);
    });

    it("skips embedding entirely (and restores the provider afterward) when skipVector is true", async () => {
      const kv = makeMockKV();
      await kv.set(KV.memories, "mem_a", {
        id: "mem_a",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        type: "fact",
        title: "Vector skip check",
        content: "content for skipVector test",
        concepts: [],
        files: [],
        sessionIds: [],
        strength: 5,
        version: 1,
        isLatest: true,
      });

      getSearchIndex().clear();
      setVectorIndex(new VectorIndex());
      setEmbeddingProvider(hangingProvider);

      const sdk = mockSdk();
      registerMigrateFunction(sdk as never, kv as never);

      const result = (await sdk.trigger({
        function_id: "mem::migrate",
        payload: { step: "rebuild-search-index", skipVector: true },
      })) as { success: boolean; skipVector: boolean; indexed: number; vectorSize: number | null };

      // Would hang forever awaiting hangingProvider.embedBatch if
      // skipVector didn't actually suppress the vector path.
      expect(result.success).toBe(true);
      expect(result.skipVector).toBe(true);
      expect(result.indexed).toBe(1);
      expect(result.vectorSize).toBe(0);
      // Provider restored for normal live traffic after this call.
      expect(getEmbeddingProvider()).toBe(hangingProvider);
    });

    it("still embeds when skipVector is omitted/false", async () => {
      const kv = makeMockKV();
      await kv.set(KV.memories, "mem_a", {
        id: "mem_a",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        type: "fact",
        title: "Vector active check",
        content: "content for active-vector test",
        concepts: [],
        files: [],
        sessionIds: [],
        strength: 5,
        version: 1,
        isLatest: true,
      });

      getSearchIndex().clear();
      setVectorIndex(new VectorIndex());
      const workingProvider: EmbeddingProvider = {
        name: "test",
        dimensions: 3,
        embed: async () => new Float32Array([0.1, 0.2, 0.3]),
        embedBatch: async (texts) => texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
      };
      setEmbeddingProvider(workingProvider);

      const sdk = mockSdk();
      registerMigrateFunction(sdk as never, kv as never);

      const result = (await sdk.trigger({
        function_id: "mem::migrate",
        payload: { step: "rebuild-search-index" },
      })) as { skipVector: boolean; vectorSize: number | null };

      expect(result.skipVector).toBe(false);
      expect(result.vectorSize).toBe(1);
    });
  });
});
