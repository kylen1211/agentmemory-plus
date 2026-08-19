import type { ISdk } from "iii-sdk";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import type {
  Memory,
  Session,
  CompressedObservation,
  SessionSummary,
  Lesson,
} from "../types.js";
import { logger } from "../logger.js";
import {
  rebuildIndex,
  getSearchIndex,
  getVectorIndex,
  getEmbeddingProvider,
  setEmbeddingProvider,
  flushIndexSave,
} from "./search.js";

const ALLOWED_DIRS = [resolve(homedir(), ".agentmemory")];

function isAllowedPath(dbPath: string): boolean {
  const resolved = resolve(dbPath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + "/"));
}

// Infer memory project from the majority project of its associated sessions.
// Returns { updated, skipped } — safe to run repeatedly (idempotent).
export async function inferMemoryProjects(
  kv: StateKV,
  dryRun = false,
): Promise<{ updated: number; skipped: number; ambiguous: number }> {
  const memories = await kv.list<Memory>(KV.memories);
  const sessionCache = new Map<string, Session | null>();

  const loadSession = async (sid: string): Promise<Session | null> => {
    if (sessionCache.has(sid)) return sessionCache.get(sid)!;
    const s = await kv.get<Session>(KV.sessions, sid).catch(() => null);
    sessionCache.set(sid, s);
    return s;
  };

  let updated = 0;
  let skipped = 0;
  let ambiguous = 0;

  for (const memory of memories) {
    if (memory.project) {
      skipped++;
      continue;
    }

    const sessionIds = memory.sessionIds ?? [];
    if (sessionIds.length === 0) {
      ambiguous++;
      continue;
    }

    const projects: string[] = [];
    for (const sid of sessionIds) {
      const session = await loadSession(sid);
      if (session?.project) projects.push(session.project);
    }

    if (projects.length === 0) {
      ambiguous++;
      continue;
    }

    // Majority-vote: count frequency of each project value.
    const freq = new Map<string, number>();
    for (const p of projects) freq.set(p, (freq.get(p) ?? 0) + 1);
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const [topProject, topCount] = sorted[0];

    // Require a strict majority (> 50%) to avoid misattributing a memory
    // that was genuinely built from sessions across multiple projects.
    if (topCount <= projects.length / 2 && sorted.length > 1) {
      ambiguous++;
      continue;
    }

    if (!dryRun) {
      memory.project = topProject;
      await kv.set(KV.memories, memory.id, memory);
    }
    updated++;
  }

  logger.info("inferMemoryProjects complete", { updated, skipped, ambiguous, dryRun });
  return { updated, skipped, ambiguous };
}

export interface BackfillAgentIdMatch {
  id: string;
  concepts: string[];
  content: string;
  agentId: string;
}

// Backfill Memory.agentId from concepts[0] when it matches a caller-supplied
// allowlist of known agent names. Only touches memories with no agentId set
// and whose first concept is an exact allowlist match — never guesses.
// Returns { matched, updated, skipped } — safe to run repeatedly (idempotent).
export async function backfillAgentIds(
  kv: StateKV,
  allowlist: string[],
  dryRun = true,
): Promise<{
  matched: number;
  updated: number;
  skipped: number;
  matches: BackfillAgentIdMatch[];
}> {
  const allowedSet = new Set(allowlist);
  const memories = await kv.list<Memory>(KV.memories);

  let matched = 0;
  let updated = 0;
  let skipped = 0;
  const matches: BackfillAgentIdMatch[] = [];

  for (const memory of memories) {
    if (memory.agentId) {
      skipped++;
      continue;
    }

    const candidate = memory.concepts?.[0];
    if (!candidate || !allowedSet.has(candidate)) {
      skipped++;
      continue;
    }

    matched++;
    matches.push({
      id: memory.id,
      concepts: memory.concepts,
      content: (memory.content || "").slice(0, 80),
      agentId: candidate,
    });

    if (!dryRun) {
      memory.agentId = candidate;
      await kv.set(KV.memories, memory.id, memory);
      updated++;
    }
  }

  logger.info("backfillAgentIds complete", {
    matched,
    updated,
    skipped,
    dryRun,
    allowlistSize: allowlist.length,
  });
  return { matched, updated, skipped, matches };
}

export interface BackfillLessonAgentIdMatch {
  id: string;
  tags: string[];
  content: string;
  agentId: string;
}

export interface AmbiguousLessonAgentIdMatch {
  id: string;
  tags: string[];
  content: string;
}

// Backfill Lesson.agentId from tags when exactly one tag matches the
// caller-supplied allowlist of known agent names. Lesson tags are a
// concatenation of an agent_tag prefix and free-form extra_tags with no
// guaranteed order (CLI-side), so we can't rely on position (unlike
// backfillAgentIds' concepts[0]) — an exact single-match intersection is
// the only unambiguous signal. Zero matches => skip; more than one match
// => leave for human triage via `ambiguousMatches`.
// Returns { matched, updated, skipped, ambiguous } — safe to run repeatedly
// (idempotent).
export async function backfillLessonAgentIds(
  kv: StateKV,
  allowlist: string[],
  dryRun = true,
): Promise<{
  matched: number;
  updated: number;
  skipped: number;
  ambiguous: number;
  matches: BackfillLessonAgentIdMatch[];
  ambiguousMatches: AmbiguousLessonAgentIdMatch[];
}> {
  const allowedSet = new Set(allowlist);
  const lessons = await kv.list<Lesson>(KV.lessons);

  let matched = 0;
  let updated = 0;
  let skipped = 0;
  let ambiguous = 0;
  const matches: BackfillLessonAgentIdMatch[] = [];
  const ambiguousMatches: AmbiguousLessonAgentIdMatch[] = [];

  for (const lesson of lessons) {
    if (lesson.agentId) {
      skipped++;
      continue;
    }

    const tags = lesson.tags ?? [];
    const intersection = [...new Set(tags.filter((t) => allowedSet.has(t)))];

    if (intersection.length === 0) {
      skipped++;
      continue;
    }

    if (intersection.length > 1) {
      ambiguous++;
      ambiguousMatches.push({
        id: lesson.id,
        tags,
        content: (lesson.content || "").slice(0, 80),
      });
      continue;
    }

    const candidate = intersection[0];
    matched++;
    matches.push({
      id: lesson.id,
      tags,
      content: (lesson.content || "").slice(0, 80),
      agentId: candidate,
    });

    if (!dryRun) {
      lesson.agentId = candidate;
      await kv.set(KV.lessons, lesson.id, lesson);
      updated++;
    }
  }

  logger.info("backfillLessonAgentIds complete", {
    matched,
    updated,
    skipped,
    ambiguous,
    dryRun,
    allowlistSize: allowlist.length,
  });
  return { matched, updated, skipped, ambiguous, matches, ambiguousMatches };
}

export function registerMigrateFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::migrate",
    async (data: {
      dbPath?: string;
      step?: string;
      dryRun?: boolean;
      agentAllowlist?: string[];
      skipVector?: boolean;
    }) => {
      // In-place KV migration steps (no SQLite dependency).
      if (data.step === "infer-memory-projects") {
        const dryRun = data.dryRun ?? false;
        logger.info("Migration step: infer-memory-projects", { dryRun });
        const result = await inferMemoryProjects(kv, dryRun);
        return { success: true, step: "infer-memory-projects", ...result };
      }

      if (data.step === "backfill-agent-ids") {
        const dryRun = data.dryRun ?? true;
        const allowlist = Array.isArray(data.agentAllowlist)
          ? data.agentAllowlist.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
          : [];
        if (allowlist.length === 0) {
          return {
            success: false,
            error: "agentAllowlist (non-empty string array) is required for backfill-agent-ids",
          };
        }
        logger.info("Migration step: backfill-agent-ids", { dryRun, allowlistSize: allowlist.length });
        const result = await backfillAgentIds(kv, allowlist, dryRun);
        return { success: true, step: "backfill-agent-ids", dryRun, ...result };
      }

      if (data.step === "backfill-lesson-agent-ids") {
        const dryRun = data.dryRun ?? true;
        const allowlist = Array.isArray(data.agentAllowlist)
          ? data.agentAllowlist.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
          : [];
        if (allowlist.length === 0) {
          return {
            success: false,
            error: "agentAllowlist (non-empty string array) is required for backfill-lesson-agent-ids",
          };
        }
        logger.info("Migration step: backfill-lesson-agent-ids", { dryRun, allowlistSize: allowlist.length });
        const result = await backfillLessonAgentIds(kv, allowlist, dryRun);
        return { success: true, step: "backfill-lesson-agent-ids", dryRun, ...result };
      }

      if (data.step === "rebuild-search-index") {
        // 2026-08-19 incident: there was no admin-triggerable entry point
        // to force a full BM25/vector rebuild from source data — only an
        // automatic boot-time trigger (index.ts `needsRebuild`) and a
        // lazy cold-start trigger inside mem::search, both gated on the
        // in-memory index already being empty. A partially-recovered
        // index (non-zero size, but stale/incomplete relative to KV —
        // e.g. left over from an interrupted prior rebuild) never
        // re-triggers either path, so it stays silently stale forever.
        // This step reuses the exact same `rebuildIndex` used by both
        // automatic paths and persists the result immediately (not on
        // the 5s debounce) so an operator gets a synchronous, verifiable
        // recovery action instead of having to restart-and-hope.
        //
        // skipVector: same incident — the embedding backend itself can
        // be down (confirmed: a stale SSH tunnel to a local Ollama
        // instance) while BM25 recovery is still perfectly possible.
        // Without this escape hatch, the ~60s-per-batch embed timeout
        // multiplied across the full corpus turns a fast, purely local
        // BM25 rebuild into an hours-long one gated on a dependency
        // that's confirmed unavailable. Temporarily clearing the
        // embedding provider makes `indexRecords`' `vectorEnabled` check
        // false for the duration of this call only; the live provider
        // (if any) is restored in `finally` regardless of outcome so
        // normal mem::observe/mem::remember vector writes resume
        // immediately after.
        const skipVector = data.skipVector === true;
        logger.info("Migration step: rebuild-search-index", { skipVector });
        const savedProvider = getEmbeddingProvider();
        if (skipVector) setEmbeddingProvider(null);
        let indexed: number;
        try {
          indexed = await rebuildIndex(kv);
        } finally {
          if (skipVector) setEmbeddingProvider(savedProvider);
        }
        await flushIndexSave();
        return {
          success: true,
          step: "rebuild-search-index",
          skipVector,
          indexed,
          bm25Size: getSearchIndex().size,
          vectorSize: getVectorIndex()?.size ?? null,
        };
      }

      if (!data.dbPath) {
        return {
          success: false,
          error: "Either step or dbPath is required",
        };
      }

      logger.info("Migration started", { dbPath: data.dbPath });

      if (!isAllowedPath(data.dbPath)) {
        return {
          success: false,
          error: `Path not allowed. Must be under: ${ALLOWED_DIRS.join(", ")}`,
        };
      }

      let Database: any;
      try {
        // @ts-expect-error optional dependency
        Database = (await import("better-sqlite3")).default;
      } catch {
        return {
          success: false,
          error:
            "better-sqlite3 not installed. Run: npm install better-sqlite3",
        };
      }

      const fs = await import("node:fs");
      if (!fs.existsSync(data.dbPath)) {
        return { success: false, error: `Database not found: ${data.dbPath}` };
      }

      let db: any;
      try {
        db = Database(data.dbPath, { readonly: true });
        let sessionCount = 0;
        let obsCount = 0;
        let summaryCount = 0;

        const sessions = db
          .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
          .all() as any[];
        for (const row of sessions) {
          const session: Session = {
            id: row.session_id || row.id,
            project: row.project_path || row.project || "unknown",
            cwd: row.cwd || row.project_path || "",
            startedAt:
              row.created_at || row.started_at || new Date().toISOString(),
            endedAt: row.ended_at || row.updated_at,
            status: "completed",
            observationCount: 0,
          };
          await kv.set(KV.sessions, session.id, session);
          sessionCount++;
        }

        let observations: any[] = [];
        try {
          observations = db
            .prepare("SELECT * FROM observations ORDER BY created_at ASC")
            .all() as any[];
        } catch {
          try {
            observations = db
              .prepare(
                "SELECT * FROM compressed_observations ORDER BY created_at ASC",
              )
              .all() as any[];
          } catch {
            logger.warn("No observation tables found");
          }
        }

        for (const row of observations) {
          const sessionId = row.session_id || "migrated";
          const obs: CompressedObservation = {
            id: row.id || generateId("mig"),
            sessionId,
            timestamp: row.created_at || new Date().toISOString(),
            type: row.type || "other",
            title: row.title || row.summary || "Migrated observation",
            subtitle: row.subtitle,
            facts: safeJsonParse(row.facts, []),
            narrative: row.narrative || row.content || "",
            concepts: safeJsonParse(row.concepts, []),
            files: safeJsonParse(row.files, []),
            importance: row.importance || 5,
          };
          await kv.set(KV.observations(sessionId), obs.id, obs);
          obsCount++;
        }

        let summaries: any[] = [];
        try {
          summaries = db
            .prepare("SELECT * FROM session_summaries")
            .all() as any[];
        } catch {
          logger.warn("No summaries table found");
        }

        for (const row of summaries) {
          const summary: SessionSummary = {
            sessionId: row.session_id,
            project: row.project || "unknown",
            createdAt: row.created_at || new Date().toISOString(),
            title: row.title || "Migrated session",
            narrative: row.narrative || row.summary || "",
            keyDecisions: safeJsonParse(row.key_decisions, []),
            filesModified: safeJsonParse(row.files_modified, []),
            concepts: safeJsonParse(row.concepts, []),
            observationCount: row.observation_count || 0,
          };
          await kv.set(KV.summaries, row.session_id, summary);
          summaryCount++;
        }

        logger.info("Migration complete", {
          sessionCount,
          obsCount,
          summaryCount,
        });
        return { success: true, sessionCount, obsCount, summaryCount };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Migration failed", { error: msg });
        return { success: false, error: "Migration failed" };
      } finally {
        try {
          if (db) db.close();
        } catch {}
      }
    },
  );
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value)) return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}
