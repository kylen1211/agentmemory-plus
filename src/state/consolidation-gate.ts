import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import { getConsolidationCooldownMs } from "../config.js";

// Global marker recording when corpus consolidation last ran, used to debounce
// the per-turn session-stop fan-out.
//
// FR-7 (pipeline/agentmemory-data-reform, ADR-9): this logic used to live
// solely at the event::session::stopped call site in triggers/events.ts,
// which meant the 2h timer, evict's recovered-session pass, and the crontab
// POST /reflect entry point all bypassed it. It is now the single gate,
// called from inside mem::consolidate-pipeline, mem::reflect, and
// mem::auto-crystallize themselves so every entry point is covered no matter
// how it is triggered.
const CONSOLIDATION_MARKER_KEY = "consolidation:lastRun";

async function consolidationDueUnserialized(kv: StateKV): Promise<boolean> {
  const cooldownMs = getConsolidationCooldownMs();
  if (cooldownMs <= 0) return true; // debounce disabled
  const now = Date.now();
  const marker = await kv
    .get<{ at?: number }>(KV.config, CONSOLIDATION_MARKER_KEY)
    .catch(() => null);
  const lastAt = typeof marker?.at === "number" ? marker.at : 0;
  if (now - lastAt < cooldownMs) return false;
  await kv.set(KV.config, CONSOLIDATION_MARKER_KEY, { at: now }).catch(() => {});
  return true;
}

// Concurrent callers would otherwise interleave the marker read-check-write
// above and both pass the cooldown. Serialize the whole check through an
// in-process chain so exactly one concurrent caller wins.
let consolidationCheckChain: Promise<unknown> = Promise.resolve();

export function consolidationDue(kv: StateKV): Promise<boolean> {
  const result = consolidationCheckChain.then(() =>
    consolidationDueUnserialized(kv),
  );
  consolidationCheckChain = result.catch(() => false);
  return result;
}
