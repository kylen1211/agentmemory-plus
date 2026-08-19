import type { ISdk } from "iii-sdk";
import type { Insight } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";

// FR-8 (pipeline/agentmemory-data-reform, ADR-10): KV.insights has never
// been added to the BM25 or vector index (full-repo audit: reflect.ts /
// export-import.ts / diagnostics.ts are the only readers/writers), so
// deletion here is a plain kv.delete — no getSearchIndex().remove() /
// vectorIndexRemove() / flushIndexSave() call, unlike mem::governance-delete
// which does clean up those indexes for KV.memories.
export function registerInsightGovernanceFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::insight-delete",
    async (data: { insightIds: string[]; reason?: string }) => {
      if (
        !data?.insightIds ||
        !Array.isArray(data.insightIds) ||
        data.insightIds.length === 0
      ) {
        return { success: false, error: "insightIds array is required" };
      }

      const results: Array<{ id: string; status: "deleted" | "not_found" }> = [];
      let deleted = 0;
      for (const id of data.insightIds) {
        const insight = await kv.get<Insight>(KV.insights, id);
        if (insight) {
          await kv.delete(KV.insights, id);
          results.push({ id, status: "deleted" });
          deleted++;
        } else {
          results.push({ id, status: "not_found" });
        }
      }
      const skipped = data.insightIds.length - deleted;

      await recordAudit(kv, "delete", "mem::insight-delete", data.insightIds, {
        reason: data.reason || "manual deletion",
        deleted,
        skipped,
      });

      logger.info("Insight governance delete", {
        requested: data.insightIds.length,
        deleted,
        skipped,
      });

      return {
        success: true,
        deleted,
        skipped,
        total: data.insightIds.length,
        results,
      };
    },
  );
}
