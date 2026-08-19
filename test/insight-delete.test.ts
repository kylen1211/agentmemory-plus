import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerInsightGovernanceFunction } from "../src/functions/insight-governance.js";
import type { Insight, AuditEntry } from "../src/types.js";

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
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeInsight(id: string, overrides: Partial<Insight> = {}): Insight {
  const now = "2026-08-01T00:00:00Z";
  return {
    id,
    title: `Insight ${id}`,
    content: `Content for ${id}`,
    confidence: 0.8,
    reinforcements: 1,
    sourceConceptCluster: ["security"],
    sourceMemoryIds: [],
    sourceLessonIds: [],
    sourceCrystalIds: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    decayRate: 0.05,
    ...overrides,
  };
}

// FR-8 (pipeline/agentmemory-data-reform, ADR-10): mem::insight-delete
// mirrors mem::governance-delete but for KV.insights, which has never been
// added to the BM25/vector index — so this must be a pure kv.delete +
// recordAudit, with no getSearchIndex()/vectorIndexRemove()/flushIndexSave()
// calls at all.
describe("mem::insight-delete", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerInsightGovernanceFunction(sdk as never, kv as never);

    await kv.set("mem:insights", "ins_1", makeInsight("ins_1"));
    await kv.set("mem:insights", "ins_2", makeInsight("ins_2"));
    await kv.set("mem:insights", "ins_3", makeInsight("ins_3"));
  });

  it("deletes an existing insight and records an audit entry", async () => {
    const result = (await sdk.trigger("mem::insight-delete", {
      insightIds: ["ins_1"],
      reason: "duplicate",
    })) as {
      success: boolean;
      deleted: number;
      skipped: number;
      total: number;
      results: Array<{ id: string; status: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(1);
    expect(result.results).toEqual([{ id: "ins_1", status: "deleted" }]);

    expect(await kv.get<Insight>("mem:insights", "ins_1")).toBeNull();

    const audits = await kv.list<AuditEntry>("mem:audit");
    expect(audits.length).toBe(1);
    expect(audits[0].operation).toBe("delete");
    expect(audits[0].functionId).toBe("mem::insight-delete");
    expect(audits[0].targetIds).toEqual(["ins_1"]);
    expect(audits[0].details).toMatchObject({ reason: "duplicate", deleted: 1, skipped: 0 });
  });

  it("does not touch the other insights", async () => {
    await sdk.trigger("mem::insight-delete", { insightIds: ["ins_1"] });

    expect(await kv.get<Insight>("mem:insights", "ins_2")).not.toBeNull();
    expect(await kv.get<Insight>("mem:insights", "ins_3")).not.toBeNull();
  });

  it("batch delete: non-existent ids are skipped, not fatal, and the batch is not interrupted", async () => {
    const result = (await sdk.trigger("mem::insight-delete", {
      insightIds: ["ins_1", "ins_missing", "ins_2"],
    })) as {
      success: boolean;
      deleted: number;
      skipped: number;
      total: number;
      results: Array<{ id: string; status: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.total).toBe(3);
    expect(result.results).toEqual([
      { id: "ins_1", status: "deleted" },
      { id: "ins_missing", status: "not_found" },
      { id: "ins_2", status: "deleted" },
    ]);

    expect(await kv.get<Insight>("mem:insights", "ins_1")).toBeNull();
    expect(await kv.get<Insight>("mem:insights", "ins_2")).toBeNull();
    expect(await kv.get<Insight>("mem:insights", "ins_3")).not.toBeNull();
  });

  it("deleting only non-existent ids succeeds with deleted:0 and one audit entry", async () => {
    const result = (await sdk.trigger("mem::insight-delete", {
      insightIds: ["ghost_1", "ghost_2"],
    })) as { success: boolean; deleted: number; skipped: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(2);

    const audits = await kv.list<AuditEntry>("mem:audit");
    expect(audits.length).toBe(1);
  });

  it("rejects a missing insightIds field", async () => {
    const result = (await sdk.trigger("mem::insight-delete", {})) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("insightIds array is required");

    const audits = await kv.list<AuditEntry>("mem:audit");
    expect(audits.length).toBe(0);
  });

  it("rejects an empty insightIds array", async () => {
    const result = (await sdk.trigger("mem::insight-delete", {
      insightIds: [],
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe("insightIds array is required");
  });

  it("is idempotent: deleting the same id twice returns not_found the second time without erroring", async () => {
    await sdk.trigger("mem::insight-delete", { insightIds: ["ins_1"] });
    const second = (await sdk.trigger("mem::insight-delete", {
      insightIds: ["ins_1"],
    })) as { success: boolean; deleted: number; skipped: number };

    expect(second.success).toBe(true);
    expect(second.deleted).toBe(0);
    expect(second.skipped).toBe(1);
  });
});
