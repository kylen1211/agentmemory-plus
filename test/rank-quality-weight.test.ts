import { describe, it, expect, afterEach } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

// FR-5 / design.md ADR-8: importance/confidence become an RRF re-ranking
// factor, applied after enrichResults() and before the optional reranker.
// Judgment: "确实生效" — these tests deliberately insert the *lower*
// quality doc into the BM25 index first so it wins the natural BM25-tie
// insertion-order tiebreak (rank 1) *before* quality re-ranking is
// applied. If re-ranking is a no-op, the lower-quality doc stays first;
// only a working qualityFactor flips the order to favor the higher one —
// this rules out "the test passes regardless of whether re-ranking runs"
// as a false positive.

function makeObs(overrides: Partial<CompressedObservation> = {}): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Refactor auth middleware token validation",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative:
      "Refactored the auth middleware token validation logic for JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 5,
    ...overrides,
  };
}

function mockKV() {
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

function clearRankEnv() {
  delete process.env["AGENTMEMORY_RANK_IMPORTANCE_WEIGHT"];
  delete process.env["AGENTMEMORY_RANK_CONFIDENCE_WEIGHT"];
}

const QUERY = "auth middleware token validation";

describe("FR-5 RRF quality re-ranking (design.md ADR-8)", () => {
  afterEach(() => clearRankEnv());

  it("importance 9 outranks importance 2 despite losing the BM25 insertion-order tiebreak", async () => {
    clearRankEnv();
    const bm25 = new SearchIndex();
    const kv = mockKV();

    // Identical indexable text on both docs -> tied bm25Score. Insert the
    // LOW-importance doc first so it wins the natural tie order (rank 1)
    // before quality re-ranking runs.
    const obsLow = makeObs({ id: "obs_low", sessionId: "ses_1", importance: 2 });
    const obsHigh = makeObs({ id: "obs_high", sessionId: "ses_1", importance: 9 });
    bm25.add(obsLow);
    bm25.add(obsHigh);
    await kv.set("mem:obs:ses_1", "obs_low", obsLow);
    await kv.set("mem:obs:ses_1", "obs_high", obsHigh);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search(QUERY);

    expect(results.map((r) => r.observation.id)).toEqual(["obs_high", "obs_low"]);
  });

  it("confidence 0.9 outranks confidence 0.35 despite losing the BM25 insertion-order tiebreak", async () => {
    clearRankEnv();
    const bm25 = new SearchIndex();
    const kv = mockKV();

    const obsLow = makeObs({
      id: "obs_lowconf",
      sessionId: "ses_1",
      importance: 5,
      confidence: 0.35,
    });
    const obsHigh = makeObs({
      id: "obs_highconf",
      sessionId: "ses_1",
      importance: 5,
      confidence: 0.9,
    });
    bm25.add(obsLow);
    bm25.add(obsHigh);
    await kv.set("mem:obs:ses_1", "obs_lowconf", obsLow);
    await kv.set("mem:obs:ses_1", "obs_highconf", obsHigh);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search(QUERY);

    expect(results.map((r) => r.observation.id)).toEqual([
      "obs_highconf",
      "obs_lowconf",
    ]);
  });

  it("a low-confidence record is reordered, not dropped from the result set", async () => {
    clearRankEnv();
    const bm25 = new SearchIndex();
    const kv = mockKV();

    const obsLow = makeObs({
      id: "obs_lowconf2",
      sessionId: "ses_1",
      importance: 5,
      confidence: 0.35,
    });
    const obsHigh = makeObs({
      id: "obs_highconf2",
      sessionId: "ses_1",
      importance: 5,
      confidence: 0.9,
    });
    bm25.add(obsLow);
    bm25.add(obsHigh);
    await kv.set("mem:obs:ses_1", "obs_lowconf2", obsLow);
    await kv.set("mem:obs:ses_1", "obs_highconf2", obsHigh);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search(QUERY);

    expect(results.length).toBe(2);
    expect(results.map((r) => r.observation.id)).toContain("obs_lowconf2");
  });

  it("respects AGENTMEMORY_RANK_IMPORTANCE_WEIGHT / AGENTMEMORY_RANK_CONFIDENCE_WEIGHT overrides", async () => {
    process.env["AGENTMEMORY_RANK_IMPORTANCE_WEIGHT"] = "0";
    process.env["AGENTMEMORY_RANK_CONFIDENCE_WEIGHT"] = "0";
    const bm25 = new SearchIndex();
    const kv = mockKV();

    // With both weights zeroed, qualityFactor is always 1.0 regardless of
    // importance — the natural BM25 tiebreak order (first-inserted wins)
    // must be preserved unchanged.
    const obsLow = makeObs({ id: "obs_low3", sessionId: "ses_1", importance: 2 });
    const obsHigh = makeObs({ id: "obs_high3", sessionId: "ses_1", importance: 9 });
    bm25.add(obsLow);
    bm25.add(obsHigh);
    await kv.set("mem:obs:ses_1", "obs_low3", obsLow);
    await kv.set("mem:obs:ses_1", "obs_high3", obsHigh);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search(QUERY);

    expect(results.map((r) => r.observation.id)).toEqual(["obs_low3", "obs_high3"]);
  });
});
