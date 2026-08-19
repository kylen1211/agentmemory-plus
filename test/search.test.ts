import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSearchFunction, getSearchIndex, rebuildIndex, setVectorIndex, setEmbeddingProvider, getVectorIndex } from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";

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
  };
}

describe("mem::search", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);

    const session: Session = {
      id: "ses_1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set(KV.sessions, session.id, session);

    const obsA: CompressedObservation = {
      id: "obs_a",
      sessionId: "ses_1",
      timestamp: "2026-01-01T00:00:00Z",
      type: "decision",
      title: "Auth middleware decision",
      subtitle: "JWT strategy",
      facts: ["Use rotating refresh tokens"],
      narrative: "Implemented auth middleware with JWT refresh rotation.",
      concepts: ["auth", "jwt"],
      files: ["src/auth.ts"],
      importance: 8,
    };
    const obsB: CompressedObservation = {
      id: "obs_b",
      sessionId: "ses_1",
      timestamp: "2026-01-02T00:00:00Z",
      type: "file_edit",
      title: "UI button styling",
      facts: ["Updated primary button color"],
      narrative: "Adjusted button styles in the settings page.",
      concepts: ["ui", "css"],
      files: ["src/ui/button.tsx"],
      importance: 4,
    };

    await kv.set(KV.observations("ses_1"), obsA.id, obsA);
    await kv.set(KV.observations("ses_1"), obsB.id, obsB);

    // Module-level SearchIndex singleton would leak across tests; reset.
    getSearchIndex().clear();
    // mem::search awaits a shared rebuild on a cold index; the explicit call
    // here pre-populates the index deterministically so the query assertions
    // below never depend on that cold-start path.
    await rebuildIndex(kv as never);
  });

  it("returns full format by default", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth middleware",
    })) as { format: string; results: Array<{ observation: CompressedObservation }> };

    expect(result.format).toBe("full");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.observation.id).toBe("obs_a");
  });

  it("returns compact format when requested", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth",
      format: "compact",
    })) as {
      format: string;
      results: Array<{ obsId: string; title: string; concepts?: string[] }>;
    };

    expect(result.format).toBe("compact");
    expect(result.results[0]?.obsId).toBe("obs_a");
    expect(result.results[0]?.title).toBe("Auth middleware decision");
    // review Important-1: concepts is functionally required (ADR-3) —
    // CLI recall level 2 / tags filter client-side on this field. Pin
    // the transplant so dropping it fails loudly instead of silently
    // degrading CLI recall to topic-fallback.
    expect(result.results[0]?.concepts).toEqual(["auth", "jwt"]);
  });

  it("returns narrative text and respects token budget", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth ui",
      format: "narrative",
      token_budget: 20,
    })) as {
      format: string;
      results: Array<{ obsId: string }>;
      text: string;
      tokens_used: number;
      tokens_budget: number;
      truncated: boolean;
    };

    expect(result.format).toBe("narrative");
    expect(result.tokens_budget).toBe(20);
    expect(result.tokens_used).toBeLessThanOrEqual(20);
    expect(typeof result.text).toBe("string");
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects invalid format values", async () => {
    await expect(
      sdk.trigger("mem::search", { query: "auth", format: "verbose" }),
    ).rejects.toThrow("format must be one of");
  });

  it("surfaces saved memories from KV.memories (#265)", async () => {
    // mem::remember persists to KV.memories under a synthetic sessionId
    // ("memory") that has no corresponding KV.observations entry. mem::search
    // must fall back to KV.memories or memory_recall returns empty.
    await kv.set(KV.memories, "mem_x1", {
      id: "mem_x1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "fact",
      title: "Pineapple belongs on pizza",
      content: "Pineapple belongs on pizza for testing fallback path.",
      concepts: ["pineapple", "pizza"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    });
    // Force the rebuild to pick up the new memory (mem::search only
    // rebuilds on first call when idx.size === 0).
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "pineapple pizza",
      format: "compact",
    })) as { results: Array<{ obsId: string; title: string }> };

    const hit = result.results.find((r) => r.obsId === "mem_x1");
    expect(hit).toBeDefined();
    expect(hit?.title).toBe("Pineapple belongs on pizza");
  });

  it("rebuildIndex populates the vector index", async () => {
    const mockEmbedder = {
      name: "test",
      dimensions: 3,
      embed: async (_text: string) => new Float32Array([0.1, 0.2, 0.3]),
      embedBatch: async (_texts: string[]) =>
        _texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    };
    setEmbeddingProvider(mockEmbedder);
    setVectorIndex(new VectorIndex());

    await rebuildIndex(kv as never);

    const vi = getVectorIndex();
    expect(vi).not.toBeNull();
    expect(vi!.size).toBeGreaterThan(0);

    // Cleanup
    setVectorIndex(null);
    setEmbeddingProvider(null);
  });
});

describe("rebuildIndex hardening (2026-08-19 stuck-rebuild incident)", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    kv = mockKV();

    const session: Session = {
      id: "ses_1",
      project: "demo",
      cwd: "/tmp/demo",
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
      title: "Auth middleware decision",
      subtitle: "JWT strategy",
      facts: ["Use rotating refresh tokens"],
      narrative: "Implemented auth middleware with JWT refresh rotation.",
      concepts: ["auth", "jwt"],
      files: ["src/auth.ts"],
      importance: 8,
    };
    await kv.set(KV.observations("ses_1"), obs.id, obs);

    await kv.set(KV.memories, "mem_a", {
      id: "mem_a",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "fact",
      title: "Runbook LVM merge notes",
      content: "runbook-lvm-merge steps for vps migration.",
      concepts: ["lvm"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: true,
    });

    getSearchIndex().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not hang forever when one session's observation read never resolves — other sessions and memories still get indexed", async () => {
    vi.useFakeTimers();

    const stuckSession: Session = {
      id: "ses_stuck",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 0,
    };
    await kv.set(KV.sessions, stuckSession.id, stuckSession);

    const hangingKv = {
      ...kv,
      list: (async (scope: string) => {
        if (scope === KV.observations("ses_stuck")) {
          return new Promise(() => {
            /* never resolves — simulates a wedged iii read */
          });
        }
        return kv.list(scope as never);
      }) as typeof kv.list,
    };

    const rebuildPromise = rebuildIndex(hangingKv as never);
    // Advance past the 15s per-call budget so the stuck session's read
    // times out instead of blocking the whole rebuild forever.
    await vi.advanceTimersByTimeAsync(20_000);
    const count = await rebuildPromise;

    // mem_a (memory) + obs_a (from the healthy ses_1) both made it in;
    // only ses_stuck's read was abandoned.
    expect(count).toBe(2);
    expect(getSearchIndex().search("runbook-lvm-merge").length).toBe(1);
    expect(getSearchIndex().search("auth middleware").length).toBe(1);
  });

  it("indexes memories even when the sessions list itself fails, and returns early without hanging", async () => {
    const failingKv = {
      ...kv,
      list: (async (scope: string) => {
        if (scope === KV.sessions) {
          throw new Error("sessions scope unavailable");
        }
        return kv.list(scope as never);
      }) as typeof kv.list,
    };

    const count = await rebuildIndex(failingKv as never);

    expect(count).toBe(1); // mem_a only — session/observation walk never ran
    expect(getSearchIndex().search("runbook-lvm-merge").length).toBe(1);
    expect(getSearchIndex().search("auth middleware").length).toBe(0);
  });

  it("logs at error level (not warn) when a session's observations fail to load, and still finishes", async () => {
    const { logger } = await import("../src/logger.js");
    const failingKv = {
      ...kv,
      list: (async (scope: string) => {
        if (scope === KV.observations("ses_1")) {
          throw new Error("observations scope unavailable");
        }
        return kv.list(scope as never);
      }) as typeof kv.list,
    };

    const count = await rebuildIndex(failingKv as never);

    expect(count).toBe(1); // mem_a only
    expect(logger.error).toHaveBeenCalledWith(
      "rebuildIndex: failed to load observations for session",
      expect.objectContaining({ sessionId: "ses_1" }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "rebuildIndex: failed to load observations for sessions",
      expect.objectContaining({ failedSessions: ["ses_1"] }),
    );
  });

  it("logs at error level when memories fail to load, but still indexes observations", async () => {
    const { logger } = await import("../src/logger.js");
    const failingKv = {
      ...kv,
      list: (async (scope: string) => {
        if (scope === KV.memories) {
          throw new Error("memories scope unavailable");
        }
        return kv.list(scope as never);
      }) as typeof kv.list,
    };

    const count = await rebuildIndex(failingKv as never);

    expect(count).toBe(1); // obs_a only
    expect(logger.error).toHaveBeenCalledWith(
      "rebuildIndex: failed to load memories",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("indexes memories before the (potentially much larger) session/observation walk", async () => {
    // Regression guard for ordering: memories must be indexed first so a
    // slow observation walk can't keep mem::remember-created records
    // unsearchable for the whole rebuild's duration.
    const order: string[] = [];
    const trackedKv = {
      ...kv,
      list: (async (scope: string) => {
        order.push(scope);
        return kv.list(scope as never);
      }) as typeof kv.list,
    };

    await rebuildIndex(trackedKv as never);

    expect(order[0]).toBe(KV.memories);
  });
});
