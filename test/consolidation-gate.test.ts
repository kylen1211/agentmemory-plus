import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationCooldownMs: vi.fn(() => 300000),
  isConsolidationEnabled: vi.fn(() => true),
  getConsolidationDecayDays: () => 30,
}));

import { consolidationDue } from "../src/state/consolidation-gate.js";
import { getConsolidationCooldownMs, isConsolidationEnabled } from "../src/config.js";
import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import { registerCrystallizeFunction } from "../src/functions/crystallize.js";
import type { MemoryProvider } from "../src/types.js";

// FR-7 (pipeline/agentmemory-data-reform, ADR-9): the cooldown gate that used
// to live only at the events.ts session::stopped call site is now extracted
// into src/state/consolidation-gate.ts and called from inside
// mem::consolidate-pipeline, mem::reflect, and mem::auto-crystallize
// themselves, so all four trigger sources (2h timer -> mem::consolidate-pipeline
// directly, session-stop -> both via events.ts, evict -> both with force:true,
// crontab POST /reflect -> api::reflect -> mem::reflect) share one marker.

function persistentKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    }),
    set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    }),
    delete: vi.fn(async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    }),
    update: vi.fn(async () => {}),
    list: vi.fn(async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    }),
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

function mockProvider(): MemoryProvider {
  return {
    name: "test",
    compress: vi.fn(),
    summarize: vi.fn().mockResolvedValue(""),
  };
}

describe("consolidationDue (src/state/consolidation-gate.ts)", () => {
  beforeEach(() => {
    vi.mocked(getConsolidationCooldownMs).mockReturnValue(300000);
  });

  it("is due on a fresh KV (no marker) and writes the marker", async () => {
    const kv = persistentKV();
    const due = await consolidationDue(kv as never);
    expect(due).toBe(true);
    const marker = await kv.get<{ at: number }>("mem:config", "consolidation:lastRun");
    expect(marker?.at).toBeTypeOf("number");
  });

  it("is not due again within the cooldown window", async () => {
    const kv = persistentKV();
    expect(await consolidationDue(kv as never)).toBe(true);
    expect(await consolidationDue(kv as never)).toBe(false);
  });

  it("is due again once the marker is older than the cooldown", async () => {
    const kv = persistentKV();
    await kv.set("mem:config", "consolidation:lastRun", { at: Date.now() - 400000 });
    expect(await consolidationDue(kv as never)).toBe(true);
  });

  it("is always due when the cooldown is disabled (<= 0)", async () => {
    vi.mocked(getConsolidationCooldownMs).mockReturnValue(0);
    const kv = persistentKV();
    expect(await consolidationDue(kv as never)).toBe(true);
    expect(await consolidationDue(kv as never)).toBe(true);
  });

  it("serializes concurrent callers so only one wins the same window", async () => {
    const kv = persistentKV();
    const results = await Promise.all([
      consolidationDue(kv as never),
      consolidationDue(kv as never),
      consolidationDue(kv as never),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
  });
});

describe("FR-7 gate coverage: mem::consolidate-pipeline", () => {
  beforeEach(() => {
    vi.mocked(getConsolidationCooldownMs).mockReturnValue(300000);
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("runs normally on a fresh cooldown window", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    registerConsolidationPipelineFunction(sdk as never, kv as never, mockProvider());

    const result = (await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" })) as {
      success: boolean;
      skipped?: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("returns {skipped:true, reason:'cooldown'} on a second call within the window, without executing semantic/reflect/procedural/decay", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    const provider = mockProvider();
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider);

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all" });
    const second = (await sdk.trigger("mem::consolidate-pipeline", { tier: "all" })) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
      results?: unknown;
    };

    expect(second).toEqual({ success: true, skipped: true, reason: "cooldown" });
    expect(second.results).toBeUndefined();
  });

  it("[FR-7 ADR-9 regression, code-review fix 3] force:true must NOT bypass the cooldown gate on a second call within the window", async () => {
    // ADR-9: "冷却闸门本身不受 force 影响,否则 events 的 force:true 又把闸门顶穿".
    // force is only allowed to bypass the isConsolidationEnabled() check.
    // This pins the disabled-check-before-gate reorder (review fix 2b) to
    // the *correct* location: force must still not reach past the gate.
    const sdk = mockSdk();
    const kv = persistentKV();
    registerConsolidationPipelineFunction(sdk as never, kv as never, mockProvider());

    await sdk.trigger("mem::consolidate-pipeline", { tier: "all", force: true });
    const second = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
      force: true,
    })) as { success: boolean; skipped?: boolean; reason?: string };

    expect(second).toEqual({ success: true, skipped: true, reason: "cooldown" });
  });

  it("[code-review fix 2b] a disabled, unforced call does not consume the cooldown window", async () => {
    // Before the fix: the gate ran before the disabled check, so an unforced
    // call under CONSOLIDATION_ENABLED=false would still write the marker
    // and burn the next 5-minute window for zero work done.
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const sdk = mockSdk();
    const kv = persistentKV();
    registerConsolidationPipelineFunction(sdk as never, kv as never, mockProvider());

    const disabledResult = (await sdk.trigger("mem::consolidate-pipeline", {})) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
    };
    expect(disabledResult.success).toBe(false);
    expect(disabledResult.reason).toContain("Consolidation disabled");

    const marker = await kv.get<{ at: number }>("mem:config", "consolidation:lastRun");
    expect(marker).toBeNull();

    // A real caller right after (e.g. re-enabled, or force:true) must still
    // find the window fresh.
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
    const realResult = (await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" })) as {
      success: boolean;
      skipped?: boolean;
    };
    expect(realResult.skipped).toBeUndefined();
    expect(realResult.success).toBe(true);
  });

  it("updates consolidation:lastRun and runs again once the window has passed", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    registerConsolidationPipelineFunction(sdk as never, kv as never, mockProvider());

    await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" });
    const firstMarker = await kv.get<{ at: number }>("mem:config", "consolidation:lastRun");
    expect(firstMarker?.at).toBeTypeOf("number");

    // Simulate the window having elapsed.
    await kv.set("mem:config", "consolidation:lastRun", { at: Date.now() - 400000 });

    const result = (await sdk.trigger("mem::consolidate-pipeline", { tier: "decay" })) as {
      success: boolean;
      skipped?: boolean;
    };
    expect(result.skipped).toBeUndefined();
    expect(result.success).toBe(true);

    const secondMarker = await kv.get<{ at: number }>("mem:config", "consolidation:lastRun");
    expect(secondMarker!.at).toBeGreaterThan(Date.now() - 400000);
  });

  it("[FR-7 ADR-9 regression ②] the pipeline's own internal mem::reflect call bypasses the cooldown its own gate check just consumed", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    // Real reflect handler wired up alongside the pipeline so the internal
    // sdk.trigger({function_id:"mem::reflect", ...}) call resolves for real
    // instead of throwing "No function".
    registerReflectFunctions(sdk as never, kv as never, mockProvider());
    registerConsolidationPipelineFunction(sdk as never, kv as never, mockProvider());

    // Fresh window: the outer mem::consolidate-pipeline call's own top-level
    // consolidationDue(kv) check passes and writes the marker. Moments later
    // (same tick) it internally triggers mem::reflect against that identical
    // marker. Without bypassCooldown:true in that internal call, reflect
    // would immediately see 0ms elapsed and self-skip every single time.
    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "reflect",
    })) as {
      success: boolean;
      skipped?: boolean;
      results?: { reflect?: { success?: boolean; skipped?: boolean } };
    };

    expect(result.skipped).toBeUndefined();
    expect(result.results?.reflect?.skipped).toBeUndefined();
    expect(result.results?.reflect?.success).toBe(true);

    // Without bypassCooldown, the same now-consumed window still blocks an
    // independent direct call (e.g. crontab POST /reflect via api::reflect,
    // which never forwards bypassCooldown from the request body).
    const gatedResult = (await sdk.trigger("mem::reflect", { maxClusters: 5 })) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
    };
    expect(gatedResult).toEqual({ success: true, skipped: true, reason: "cooldown" });
  });
});

describe("FR-7 gate coverage: mem::reflect", () => {
  beforeEach(() => {
    vi.mocked(getConsolidationCooldownMs).mockReturnValue(300000);
  });

  it("runs normally on a fresh cooldown window", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    registerReflectFunctions(sdk as never, kv as never, mockProvider());

    const result = (await sdk.trigger("mem::reflect", {})) as { success: boolean; skipped?: boolean };
    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("skips with {skipped:true, reason:'cooldown'} on a second call within the window", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    const provider = mockProvider();
    registerReflectFunctions(sdk as never, kv as never, provider);

    await sdk.trigger("mem::reflect", {});
    const second = (await sdk.trigger("mem::reflect", {})) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
    };
    expect(second).toEqual({ success: true, skipped: true, reason: "cooldown" });
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("bypassCooldown:true proceeds even within the window (internal-only escape hatch)", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    registerReflectFunctions(sdk as never, kv as never, mockProvider());

    await sdk.trigger("mem::reflect", {});
    const second = (await sdk.trigger("mem::reflect", { bypassCooldown: true })) as {
      success: boolean;
      skipped?: boolean;
    };
    expect(second.skipped).toBeUndefined();
    expect(second.success).toBe(true);
  });
});

describe("FR-7 gate coverage: mem::auto-crystallize [FR-7 ADR-9 regression ③]", () => {
  beforeEach(() => {
    vi.mocked(getConsolidationCooldownMs).mockReturnValue(300000);
  });

  it("runs normally on a fresh cooldown window", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    registerCrystallizeFunction(sdk as never, kv as never, mockProvider());

    const result = (await sdk.trigger("mem::auto-crystallize", {})) as {
      success: boolean;
      skipped?: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("returns {skipped:true, reason:'cooldown'} on a second call within the window (D-5: shares the gate with consolidate-pipeline, doesn't fire every agent turn)", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    registerCrystallizeFunction(sdk as never, kv as never, mockProvider());

    await sdk.trigger("mem::auto-crystallize", {});
    const second = (await sdk.trigger("mem::auto-crystallize", {})) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
      groupCount?: number;
    };
    expect(second).toEqual({ success: true, skipped: true, reason: "cooldown" });
    expect(second.groupCount).toBeUndefined();
  });

  it("runs again once the window has passed", async () => {
    const sdk = mockSdk();
    const kv = persistentKV();
    registerCrystallizeFunction(sdk as never, kv as never, mockProvider());

    await sdk.trigger("mem::auto-crystallize", {});
    await kv.set("mem:config", "consolidation:lastRun", { at: Date.now() - 400000 });

    const result = (await sdk.trigger("mem::auto-crystallize", {})) as {
      success: boolean;
      skipped?: boolean;
    };
    expect(result.skipped).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("[code-review fix 1] dryRun:true does not consume the cooldown window and still returns preview data", async () => {
    // Before the fix: dryRun ran through the same top-of-function gate as a
    // real run, so a single read-only preview burned the next 5-minute
    // window for the real consolidation pass behind it.
    const sdk = mockSdk();
    const kv = persistentKV();
    registerCrystallizeFunction(sdk as never, kv as never, mockProvider());
    await kv.set("mem:actions", "act_dry", {
      id: "act_dry",
      title: "Test action",
      description: "A test action",
      status: "done",
      priority: 5,
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "agent-1",
      tags: [],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });

    const preview = (await sdk.trigger("mem::auto-crystallize", { dryRun: true })) as {
      success: boolean;
      skipped?: boolean;
      dryRun?: boolean;
      groupCount?: number;
    };
    expect(preview.skipped).toBeUndefined();
    expect(preview.dryRun).toBe(true);
    expect(preview.groupCount).toBe(1);

    // The window must still be fresh for a real call right after.
    const marker = await kv.get<{ at: number }>("mem:config", "consolidation:lastRun");
    expect(marker).toBeNull();

    const real = (await sdk.trigger("mem::auto-crystallize", {})) as {
      success: boolean;
      skipped?: boolean;
    };
    expect(real.skipped).toBeUndefined();
    expect(real.success).toBe(true);
  });

  it("[code-review fix 1] evict.ts sequence: force:true consolidate-pipeline immediately followed by bypassCooldown:true auto-crystallize both execute in the same pass", async () => {
    // Regression for the exact starvation the reviewer reproduced:
    // runRecoveredSessionConsolidation (src/functions/evict.ts) awaits
    // mem::consolidate-pipeline(force:true) then mem::auto-crystallize
    // back-to-back against the same shared marker. Without
    // bypassCooldown:true on the second call it always returned
    // {skipped:true, reason:"cooldown"}.
    const sdk = mockSdk();
    const kv = persistentKV();
    registerConsolidationPipelineFunction(sdk as never, kv as never, mockProvider());
    registerCrystallizeFunction(sdk as never, kv as never, mockProvider());

    const pipelineResult = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "all",
      force: true,
    })) as { success: boolean; skipped?: boolean };
    expect(pipelineResult.skipped).toBeUndefined();

    const crystallizeResult = (await sdk.trigger("mem::auto-crystallize", {
      olderThanDays: 0,
      bypassCooldown: true,
    })) as { success: boolean; skipped?: boolean };
    expect(crystallizeResult.skipped).toBeUndefined();
    expect(crystallizeResult.success).toBe(true);
  });
});

describe("[FR-7 ADR-9 regression ①] CONSOLIDATION_ENABLED=false + force:true must not run consolidation", () => {
  // The gate itself is unconditional (ADR-9: "冷却闸门本身不受 force 影响"), so a
  // fresh cooldown window always passes the gate. The thing force:true is
  // allowed to bypass is ONLY the isConsolidationEnabled() check inside
  // mem::consolidate-pipeline -- so at the events.ts call site (the actual
  // caller that sends force:true) the isConsolidationEnabled() guard must
  // still gate whether consolidate-pipeline is invoked at all. That call-site
  // guard is asserted in test/events-consolidation.test.ts
  // ("skips consolidate-pipeline and auto-crystallize when consolidation
  // disabled but still summarizes"); this test pins down the complementary
  // fact that mem::consolidate-pipeline itself, called directly with
  // force:true, legitimately DOES bypass its own disabled check (that is not
  // a regression -- it's existing, desired behavior for evict's forced pass)
  // so the events.ts-level guard is the only thing standing between
  // CONSOLIDATION_ENABLED=false and consolidation running.
  beforeEach(() => {
    vi.mocked(getConsolidationCooldownMs).mockReturnValue(300000);
  });

  it("mem::consolidate-pipeline with force:true still runs when disabled (expected -- proves the events.ts enabled-guard is load-bearing)", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const sdk = mockSdk();
    const kv = persistentKV();
    registerConsolidationPipelineFunction(sdk as never, kv as never, mockProvider());

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "decay",
      force: true,
    })) as { success: boolean; skipped?: boolean };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });
});
