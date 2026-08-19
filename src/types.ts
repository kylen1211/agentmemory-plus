export interface Session {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "abandoned";
  observationCount: number;
  model?: string;
  tags?: string[];
  firstPrompt?: string;
  summary?: string;
  commitShas?: string[];
  agentId?: string;
}

export interface CommitLink {
  sha: string;
  shortSha: string;
  branch?: string;
  repo?: string;
  message?: string;
  author?: string;
  authoredAt?: string;
  files?: string[];
  sessionIds: string[];
  linkedAt: string;
}

// Write-time data subject classification (FR-1). `undefined` on a record
// means "unclassified" — either legacy data written before this field
// existed, or a record whose write path doesn't call classifySubject().
// Downstream readers must treat undefined as "unclassified", not as any
// one of the three concrete values (see subject.ts).
export type ObservationSubject = "user" | "agent" | "execution";

export interface RawObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  hookType: HookType;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  userPrompt?: string;
  assistantResponse?: string;
  raw: unknown;
  modality?: "text" | "image" | "mixed";
  imageData?: string;
  agentId?: string;
  subject?: ObservationSubject;
  // Per-record duplicate hit counter (FR-6). Absent/undefined reads as 1
  // (the record itself, no repeats observed yet). Only ever incremented
  // by the dedup-hit path in observe.ts / carried forward by compress.ts.
  repeatCount?: number;
  // FR-2 (design.md ADR-5 / PRD appendix D-4): the *dispatched subagent's
  // own* identifier, lifted from the hook payload's `data.agent_id` for
  // hookType ∈ {subagent_start, subagent_stop}. Deliberately NOT the same
  // field as `agentId` above — `agentId` is the env/session-scoped owner
  // used for team/scope isolation (memory-scope-isolation feature) and is
  // constant for every record in a session, while `subagentId` identifies
  // one specific Task dispatch and varies per subagent_start/stop pair.
  // Reusing `agentId` for this would silently break isolation filtering
  // for these two record kinds in team-scoped deployments — see this
  // task's delivery RISKS for the design.md data-model note this deviates
  // from. Used only to pair subagent_start/subagent_stop for the
  // anomaly:"unpaired" scan (events.ts); undefined falls back to
  // chronological pairing.
  subagentId?: string;
  // Which lifecycle hookType produced this record. CompressedObservation
  // has no hookType field of its own, so without this the session-stop
  // pairing scan (events.ts) can't tell a subagent_start flow record from
  // a subagent_stop one once compress.ts has overwritten the raw record.
  execHookType?: "subagent_start" | "subagent_stop";
}

export interface CompressedObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  type: ObservationType;
  title: string;
  subtitle?: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files: string[];
  importance: number;
  confidence?: number;
  imageRef?: string;
  imageData?: string;
  imageDescription?: string;
  modality?: "text" | "image" | "mixed";
  agentId?: string;
  project?: string;
  subject?: ObservationSubject;
  repeatCount?: number;
  // FR-2 (design.md ADR-5/A-3, data model): execution-record fields.
  // executionKind distinguishes the two record shapes described in PRD
  // FR-2 — "self_report" (one per SubagentStop trigger, LLM-structured
  // self-narrative) vs "flow" (one per execution-subject tool call, a
  // slimmed compression of the raw event). Both are only ever present
  // when subject === "execution"; neither is ever passed to
  // getSearchIndex().add() / vectorIndexAddGuarded() (FR-2 hard
  // constraint — see execution-record.ts / compress.ts).
  executionKind?: "self_report" | "flow";
  // Only present when executionKind === "self_report"; absent (not an
  // empty object) when LLM structured extraction failed and the record
  // fell back to storing the raw self-report text in `narrative` instead
  // (PRD FR-2 异常路径 — "记录不许丢").
  executionDetail?: ExecutionDetail;
  // Only present when executionKind === "flow". Rule-level signal only —
  // set by a plain `hookType === "post_tool_failure"` string comparison
  // in compress.ts, never derived from LLM output (PRD FR-2 判据: "产生
  // 路径是规则匹配,不经 LLM 输出解析").
  violation?: boolean;
  // Only present when executionKind === "flow". Written back by the
  // session-stop pairing scan (events.ts) onto whichever side of a
  // subagent_start/subagent_stop pair has no match within the session
  // (design.md ADR-5). task_completed records never participate in this
  // scan (payload carries no agent_id to pair on — PRD appendix D-4).
  anomaly?: "unpaired";
  // See RawObservation.subagentId — carried through unchanged by
  // compress.ts / execution-record.ts, same passthrough shape as
  // agentId/subject above.
  subagentId?: string;
  execHookType?: "subagent_start" | "subagent_stop";
}

// FR-2 (design.md appendix A-4): structured extraction of a subagent's
// SubagentStop self-report. `deviations` is the agent's own claimed
// deviations as transcribed by the LLM — a self-report, not a
// system-judged violation (that's the separate rule-level `violation`
// field on flow records).
export interface ExecutionDetail {
  task: string;
  keyDecisions: Array<{ decision: string; tool: string; reason: string }>;
  deviations: string[];
  selfAssessment: string;
}

export type ObservationType =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "command_run"
  | "search"
  | "web_fetch"
  | "conversation"
  | "error"
  | "decision"
  | "discovery"
  | "subagent"
  | "notification"
  | "task"
  | "image"
  | "other";

export interface Memory {
  id: string;
  createdAt: string;
  updatedAt: string;
  type: "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact";
  title: string;
  content: string;
  concepts: string[];
  files: string[];
  sessionIds: string[];
  strength: number;
  version: number;
  parentId?: string;
  supersedes?: string[];
  relatedIds?: string[];
  sourceObservationIds?: string[];
  isLatest: boolean;
  forgetAfter?: string;
  imageRef?: string;
  imageData?: string;
  agentId?: string;
  project?: string;
}

export interface SessionSummary {
  sessionId: string;
  project: string;
  createdAt: string;
  title: string;
  narrative: string;
  keyDecisions: string[];
  filesModified: string[];
  concepts: string[];
  observationCount: number;
}

export type HookType =
  | "session_start"
  | "prompt_submit"
  | "pre_tool_use"
  | "post_tool_use"
  | "post_tool_failure"
  | "pre_compact"
  | "subagent_start"
  | "subagent_stop"
  | "notification"
  | "task_completed"
  | "stop"
  | "session_end";

export interface HookPayload {
  hookType: HookType;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: unknown;
}

export interface ProviderConfig {
  provider: ProviderType;
  model: string;
  maxTokens: number;
  /** Optional base URL override (e.g. for Anthropic-compatible APIs or local proxies) */
  baseURL?: string;
}

export type ProviderType = "agent-sdk" | "anthropic" | "gemini" | "openrouter" | "minimax" | "openai" | "noop";

export interface MemoryProvider {
  name: string;
  compress(systemPrompt: string, userPrompt: string): Promise<string>;
  summarize(systemPrompt: string, userPrompt: string): Promise<string>;
  describeImage?(imageData: string, mimeType: string, prompt: string): Promise<string>;
}

export interface AgentMemoryConfig {
  engineUrl: string;
  restPort: number;
  streamsPort: number;
  provider: ProviderConfig;
  tokenBudget: number;
  maxObservationsPerSession: number;
  compressionModel: string;
  dataDir: string;
}

export interface SearchResult {
  observation: CompressedObservation;
  score: number;
  sessionId: string;
}

export interface ContextBlock {
  type: "summary" | "observation" | "memory";
  content: string;
  tokens: number;
  recency: number;
  sourceIds?: string[];
}

export interface EvalResult {
  valid: boolean;
  errors: string[];
  qualityScore: number;
  latencyMs: number;
  functionId: string;
}

export interface FunctionMetrics {
  functionId: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  avgQualityScore: number;
}

export interface HealthSnapshot {
  connectionState: string;
  workers: Array<{ id: string; name: string; status: string }>;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  cpu: { userMicros: number; systemMicros: number; percent: number };
  eventLoopLagMs: number;
  uptimeSeconds: number;
  kvConnectivity?: { status: string; latencyMs?: number; error?: string };
  status: "healthy" | "degraded" | "critical";
  alerts: string[];
  notes?: string[];
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailureAt: number | null;
  openedAt: number | null;
}

export interface MemorySlot {
  label: string;
  content: string;
  sizeLimit: number;
  description: string;
  pinned: boolean;
  readOnly: boolean;
  scope: "project" | "global";
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  embedImage?(src: string): Promise<Float32Array>;
}

export interface MemoryRelation {
  type: "supersedes" | "extends" | "derives" | "contradicts" | "related";
  sourceId: string;
  targetId: string;
  createdAt: string;
  confidence?: number;
}

export interface HybridSearchResult {
  observation: CompressedObservation;
  bm25Score: number;
  vectorScore: number;
  graphScore: number;
  combinedScore: number;
  sessionId: string;
  graphContext?: string;
}

export interface CompactSearchResult {
  obsId: string;
  sessionId: string;
  title: string;
  type: ObservationType;
  score: number;
  timestamp: string;
}

export interface CompactLessonResult {
  lessonId: string;
  content: string;
  confidence: number;
  score: number;
  createdAt: string;
  project?: string;
  tags: string[];
}

export interface TimelineEntry {
  observation: CompressedObservation;
  sessionId: string;
  relativePosition: number;
}

export interface ProjectProfile {
  project: string;
  updatedAt: string;
  topConcepts: Array<{ concept: string; frequency: number }>;
  topFiles: Array<{ file: string; frequency: number }>;
  conventions: string[];
  commonErrors: string[];
  recentActivity: string[];
  sessionCount: number;
  totalObservations: number;
  summary?: string;
}

export interface ExportPagination {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface ExportData {
  version: "0.3.0" | "0.4.0" | "0.5.0" | "0.6.0" | "0.6.1" | "0.7.0" | "0.7.2" | "0.7.3" | "0.7.4" | "0.7.5" | "0.7.6" | "0.7.7" | "0.7.9" | "0.8.0" | "0.8.1" | "0.8.2" | "0.8.3" | "0.8.4" | "0.8.5" | "0.8.6" | "0.8.7" | "0.8.8" | "0.8.9" | "0.8.10" | "0.8.11" | "0.8.12" | "0.8.13" | "0.9.0" | "0.9.1" | "0.9.2" | "0.9.3" | "0.9.4" | "0.9.5" | "0.9.6" | "0.9.7" | "0.9.8" | "0.9.9" | "0.9.10" | "0.9.11" | "0.9.12" | "0.9.13" | "0.9.14" | "0.9.15" | "0.9.16" | "0.9.17" | "0.9.18" | "0.9.19" | "0.9.20" | "0.9.21" | "0.9.22" | "0.9.23" | "0.9.24" | "0.9.25" | "0.9.26" | "0.9.27" | "0.9.28";
  exportedAt: string;
  sessions: Session[];
  observations: Record<string, CompressedObservation[]>;
  memories: Memory[];
  summaries: SessionSummary[];
  profiles?: ProjectProfile[];
  graphNodes?: GraphNode[];
  graphEdges?: GraphEdge[];
  semanticMemories?: SemanticMemory[];
  proceduralMemories?: ProceduralMemory[];
  actions?: Action[];
  actionEdges?: ActionEdge[];
  routines?: Routine[];
  signals?: Signal[];
  checkpoints?: Checkpoint[];
  sentinels?: Sentinel[];
  sketches?: Sketch[];
  crystals?: Crystal[];
  facets?: Facet[];
  lessons?: Lesson[];
  insights?: Insight[];
  accessLogs?: AccessLogExport[];
  pagination?: ExportPagination;
}

export interface AccessLogExport {
  memoryId: string;
  count: number;
  lastAt: string;
  recent: number[];
}

export interface EmbeddingConfig {
  provider?: string;
  bm25Weight: number;
  vectorWeight: number;
}

export interface FallbackConfig {
  providers: ProviderType[];
}

export interface ClaudeBridgeConfig {
  enabled: boolean;
  projectPath: string;
  memoryFilePath: string;
  lineBudget: number;
}

export interface StandaloneConfig {
  dataDir: string;
  persistPath: string;
  agentType?: string;
}

export type GraphNodeType =
  | "file"
  | "function"
  | "concept"
  | "error"
  | "decision"
  | "pattern"
  | "library"
  | "person"
  | "project"
  | "preference"
  | "location"
  | "organization"
  | "event";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  properties: Record<string, unknown>;
  sourceObservationIds: string[];
  createdAt: string;
  updatedAt?: string;
  aliases?: string[];
  stale?: boolean;
}

export type GraphEdgeType =
  | "uses"
  | "imports"
  | "modifies"
  | "causes"
  | "fixes"
  | "depends_on"
  | "related_to"
  | "works_at"
  | "prefers"
  | "blocked_by"
  | "caused_by"
  | "optimizes_for"
  | "rejected"
  | "avoids"
  | "located_in"
  | "succeeded_by";

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  sourceNodeId: string;
  targetNodeId: string;
  weight: number;
  sourceObservationIds: string[];
  createdAt: string;
  tcommit?: string;
  tvalid?: string;
  tvalidEnd?: string;
  context?: EdgeContext;
  version?: number;
  supersededBy?: string;
  isLatest?: boolean;
  stale?: boolean;
}

export interface EdgeContext {
  reasoning?: string;
  sentiment?: string;
  alternatives?: string[];
  situationalFactors?: string[];
  confidence?: number;
}

export interface GraphQueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: number;
  // #753: pagination + truncation signals for large graphs. `total*`
  // counts reflect the full unbounded result for the given filter so
  // the viewer can show "showing N of M" without re-querying. `truncated`
  // is true when the default cap kicked in (operator may have wanted
  // the full set but didn't ask for one).
  totalNodes?: number;
  totalEdges?: number;
  truncated?: boolean;
  // Echoes back the cap that produced this page so a paged client can
  // detect when the default was applied vs an explicit `limit`.
  limit?: number;
  offset?: number;
  // #814: indicates the response came from the precomputed top-degree
  // snapshot rather than a live kv.list enumeration. Set only on the
  // empty-body / nodeType-only branch on large corpora where the
  // unbounded enumeration would exceed the iii invocation timeout.
  fromSnapshot?: boolean;
  // #814: when the snapshot is stale or absent and the live fallback
  // also failed, expose an explanatory note so the viewer can surface
  // an actionable banner instead of a blank graph.
  warning?: string;
}

// #814: persisted top-degree subgraph + aggregate counts. Stored under
// KV.graphSnapshot with a single key "current". `dirty` is set true by
// mem::graph-extract after writes and flipped false when the snapshot
// rebuild completes.
export interface GraphSnapshot {
  version: 1;
  topNodes: GraphNode[];
  topEdges: GraphEdge[];
  // Synchronous degree lookup keyed by nodeId. Maintained alongside
  // topNodes so re-ranking after an edge write doesn't require an
  // async kv.get for every top-N entry inside the sort comparator.
  // Keys are limited to the top-N set; non-top nodes track their
  // degree in KV.graphNodeDegree only.
  topDegrees: Record<string, number>;
  stats: {
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
  };
  updatedAt: string;
  dirty: boolean;
  // #825 follow-up: ISO timestamp set by mem::graph-reset. After
  // reset, mem::graph-extract treats any pre-resetAt node as an
  // orphan (skip merge, write fresh) so future extracts don't
  // silently reconnect to legacy rows via stale name-index entries.
  // Absent / 1970 epoch = no reset has run.
  resetAt?: string;
}

export type ConsolidationTier =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural";

export interface SemanticMemory {
  id: string;
  fact: string;
  confidence: number;
  sourceSessionIds: string[];
  sourceMemoryIds: string[];
  accessCount: number;
  lastAccessedAt: string;
  strength: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProceduralMemory {
  id: string;
  name: string;
  steps: string[];
  triggerCondition: string;
  expectedOutcome?: string;
  frequency: number;
  sourceSessionIds: string[];
  sourceObservationIds?: string[];
  tags?: string[];
  concepts?: string[];
  strength: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamConfig {
  teamId: string;
  userId: string;
  mode: "shared" | "private";
}

export type AgentScopeMode = "shared" | "isolated";
export interface AgentScope {
  agentId: string;
  mode: AgentScopeMode;
}

export interface TeamSharedItem {
  id: string;
  sharedBy: string;
  sharedAt: string;
  type: "observation" | "memory" | "pattern";
  content: unknown;
  project: string;
  visibility: "shared" | "private";
}

export interface TeamProfile {
  teamId: string;
  members: string[];
  topConcepts: Array<{ concept: string; frequency: number }>;
  topFiles: Array<{ file: string; frequency: number }>;
  sharedPatterns: string[];
  totalSharedItems: number;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  operation:
    | "observe"
    | "compress"
    | "remember"
    | "forget"
    | "evolve"
    | "consolidate"
    | "share"
    | "delete"
    | "import"
    | "export"
    | "action_create"
    | "action_update"
    | "lease_acquire"
    | "lease_release"
    | "routine_run"
    | "signal_send"
    | "checkpoint_resolve"
    | "mesh_sync"
    | "relation_create"
    | "relation_update"
    | "sentinel_create"
    | "sentinel_trigger"
    | "sketch_create"
    | "sketch_promote"
    | "retention_score"
    | "sketch_discard"
    | "crystallize"
    | "diagnose"
    | "heal"
    | "index_persist"
    | "facet_tag"
    | "lesson_save"
    | "lesson_recall"
    | "lesson_strengthen"
    | "lesson_delete"
    | "obsidian_export"
    | "reflect"
    | "insight_search"
    | "skill_extract"
    | "core_add"
    | "core_remove"
    | "auto_page"
    | "vision_embed"
    | "slot_append"
    | "slot_replace"
    | "slot_create"
    | "slot_delete"
    | "slot_reflect";
  userId?: string;
  functionId: string;
  targetIds: string[];
  details: Record<string, unknown>;
  qualityScore?: number;
}

export interface GovernanceFilter {
  type?: string[];
  dateFrom?: string;
  dateTo?: string;
  project?: string;
  qualityBelow?: number;
}

export interface SnapshotMeta {
  id: string;
  commitHash: string;
  createdAt: string;
  message: string;
  stats: {
    sessions: number;
    observations: number;
    memories: number;
    graphNodes: number;
  };
}

export interface SnapshotDiff {
  fromCommit: string;
  toCommit: string;
  added: { memories: number; observations: number; graphNodes: number };
  removed: { memories: number; observations: number; graphNodes: number };
}

export interface Action {
  id: string;
  title: string;
  description: string;
  status: "pending" | "active" | "done" | "blocked" | "cancelled";
  priority: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  assignedTo?: string;
  project?: string;
  tags: string[];
  sourceObservationIds: string[];
  sourceMemoryIds: string[];
  result?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
  sketchId?: string;
  crystallizedInto?: string;
}

export type ActionEdgeType =
  | "requires"
  | "unlocks"
  | "spawned_by"
  | "gated_by"
  | "conflicts_with";

export interface ActionEdge {
  id: string;
  type: ActionEdgeType;
  sourceActionId: string;
  targetActionId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Lease {
  id: string;
  actionId: string;
  agentId: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
  status: "active" | "expired" | "released";
}

export interface Routine {
  id: string;
  name: string;
  description: string;
  steps: RoutineStep[];
  createdAt: string;
  updatedAt: string;
  frozen: boolean;
  tags: string[];
  sourceProceduralIds: string[];
}

export interface RoutineStep {
  order: number;
  title: string;
  description: string;
  actionTemplate: Partial<Action>;
  dependsOn: number[];
}

export interface RoutineRun {
  id: string;
  routineId: string;
  status: "running" | "completed" | "failed" | "paused";
  startedAt: string;
  completedAt?: string;
  actionIds: string[];
  stepStatus: Record<number, "pending" | "active" | "done" | "failed">;
  initiatedBy: string;
}

export interface Signal {
  id: string;
  from: string;
  to?: string;
  threadId?: string;
  replyTo?: string;
  type: "info" | "request" | "response" | "alert" | "handoff";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  readAt?: string;
  expiresAt?: string;
}

export interface Checkpoint {
  id: string;
  name: string;
  description: string;
  status: "pending" | "passed" | "failed" | "expired";
  type: "ci" | "approval" | "deploy" | "external" | "timer";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  result?: unknown;
  expiresAt?: string;
  linkedActionIds: string[];
}

export interface Sketch {
  id: string;
  title: string;
  description: string;
  status: "active" | "promoted" | "discarded";
  actionIds: string[];
  project?: string;
  createdAt: string;
  expiresAt: string;
  promotedAt?: string;
  discardedAt?: string;
}

export interface Facet {
  id: string;
  targetId: string;
  targetType: "action" | "memory" | "observation";
  dimension: string;
  value: string;
  createdAt: string;
}

export interface Sentinel {
  id: string;
  name: string;
  type: "webhook" | "timer" | "threshold" | "pattern" | "approval" | "custom";
  status: "watching" | "triggered" | "cancelled" | "expired";
  config: Record<string, unknown>;
  result?: unknown;
  createdAt: string;
  triggeredAt?: string;
  expiresAt?: string;
  linkedActionIds: string[];
  escalatedAt?: string;
}

export interface Crystal {
  id: string;
  narrative: string;
  keyOutcomes: string[];
  filesAffected: string[];
  lessons: string[];
  sourceActionIds: string[];
  sessionId?: string;
  project?: string;
  createdAt: string;
}

export interface Lesson {
  id: string;
  content: string;
  context: string;
  confidence: number;
  reinforcements: number;
  source: "crystal" | "manual" | "consolidation";
  sourceIds: string[];
  project?: string;
  agentId?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt?: string;
  lastDecayedAt?: string;
  decayRate: number;
  deleted?: boolean;
}

export interface Insight {
  id: string;
  title: string;
  content: string;
  confidence: number;
  reinforcements: number;
  sourceConceptCluster: string[];
  sourceMemoryIds: string[];
  sourceLessonIds: string[];
  sourceCrystalIds: string[];
  project?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt?: string;
  lastDecayedAt?: string;
  decayRate: number;
  deleted?: boolean;
}

export interface DiagnosticCheck {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixable: boolean;
}

export interface MeshPeer {
  id: string;
  url: string;
  name: string;
  lastSyncAt?: string;
  status: "connected" | "disconnected" | "syncing" | "error";
  sharedScopes: string[];
  syncFilter?: { project?: string };
}


export interface EnrichedChunk {
  id: string;
  originalObsId: string;
  sessionId: string;
  content: string;
  resolvedEntities: Record<string, string>;
  preferences: string[];
  contextBridges: string[];
  windowStart: number;
  windowEnd: number;
  createdAt: string;
}

export interface LatentEmbedding {
  obsId: string;
  contentEmbedding: string;
  latentEmbedding: string;
  sessionId: string;
}

export interface QueryExpansion {
  original: string;
  reformulations: string[];
  temporalConcretizations: string[];
  entityExtractions: string[];
}

export interface TripleStreamResult {
  observation: CompressedObservation;
  vectorScore: number;
  bm25Score: number;
  graphScore: number;
  combinedScore: number;
  sessionId: string;
  graphContext?: string;
}

export interface TemporalQuery {
  entityName: string;
  asOf?: string;
  from?: string;
  to?: string;
  includeHistory?: boolean;
}

export interface TemporalState {
  entity: GraphNode;
  currentEdges: GraphEdge[];
  historicalEdges: GraphEdge[];
  timeline: Array<{
    edge: GraphEdge;
    validFrom: string;
    validTo?: string;
    context?: EdgeContext;
  }>;
}

export interface RetentionScore {
  memoryId: string;
  // Which KV scope this row came from. Needed by mem::retention-evict
  // so the delete loop routes to KV.memories or KV.semantic correctly.
  // Missing on pre-0.8.10 rows — callers must treat `undefined` as
  // "unknown" and probe both scopes for backwards-compat. See #124.
  source?: "episodic" | "semantic";
  score: number;
  salience: number;
  temporalDecay: number;
  reinforcementBoost: number;
  lastAccessed: string;
  accessCount: number;
}

export interface DecayConfig {
  lambda: number;
  sigma: number;
  tierThresholds: {
    hot: number;
    warm: number;
    cold: number;
  };
}

/**
 * KV.state scope — long-lived system counters + flags keyed by string.
 * Keep keys/types in sync with the state-scope callers (e.g.,
 * disk-size-manager) so TypeScript enforces consistent value shapes
 * instead of every caller using ad-hoc `<number>` generics.
 */
export interface StateScope {
  "system:currentDiskSize": number;
}

export type StateScopeKey = keyof StateScope;
