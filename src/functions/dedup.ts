import { createHash } from "node:crypto";
import { getDedupTtlMs } from "../config.js";

const CLEANUP_INTERVAL_MS = 60_000;

interface DedupEntry {
  hash: string;
  expiresAt: number;
  // FR-6 / design.md ADR-7: identifies the record a duplicate hit should
  // increment repeatCount on.
  obsId: string;
  sessionId: string;
}

export class DedupMap {
  private entries = new Map<string, DedupEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private ttlMs: number;

  // ttlMs defaults to the env-configured value (AGENTMEMORY_DEDUP_TTL_MS,
  // 30min default) so the existing no-arg call site (`new DedupMap()` in
  // index.ts) picks up the configurable TTL without index.ts needing to
  // change.
  constructor(ttlMs: number = getDedupTtlMs()) {
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  // FR-6 / design.md ADR-6, amended by qa-tester P0 (pipeline/
  // agentmemory-data-reform, post-deploy): this is now ONLY called for
  // observations with a real tool_name. Lifecycle events (subagent_start/
  // subagent_stop/task_completed/session_start/notification — anything
  // where observe.ts falls back to hookType as the "tool name") never
  // reach this method at all anymore; observe.ts skips the DedupMap
  // entirely for them (see the caller). That amendment replaced the
  // original ADR-6 fix (keep sessionId in the hash for those events) —
  // real payloads never populate tool_input/tool_output for subagent
  // start/stop, and agent_id/last_message don't participate in the hash,
  // so two *different* agents' subagent_stop events in the same session
  // still collided under the sessionId-in-hash approach. There is no
  // remaining caller that needs sessionId in the hash, so it's dropped
  // from the signature rather than left as unreachable dead branching.
  computeHash(toolName: string, toolInput: unknown, toolOutput: unknown): string {
    const input =
      typeof toolInput === "string"
        ? toolInput.slice(0, 500)
        : JSON.stringify(toolInput ?? "").slice(0, 500);
    const output =
      typeof toolOutput === "string"
        ? toolOutput.slice(0, 500)
        : JSON.stringify(toolOutput ?? "").slice(0, 500);
    const raw = `${toolName}:${input}:${output}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  // Returns the live (non-expired) entry for a hash, or undefined. Lazily
  // evicts expired entries on lookup (same behavior as the old
  // isDuplicate()).
  getEntry(hash: string): DedupEntry | undefined {
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(hash);
      return undefined;
    }
    return entry;
  }

  isDuplicate(hash: string): boolean {
    return this.getEntry(hash) !== undefined;
  }

  record(hash: string, obsId: string, sessionId: string): void {
    this.entries.set(hash, {
      hash,
      expiresAt: Date.now() + this.ttlMs,
      obsId,
      sessionId,
    });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  get size(): number {
    return this.entries.size;
  }
}
