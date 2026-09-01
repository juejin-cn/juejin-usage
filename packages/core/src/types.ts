export interface QueueBucket {
  hour_start: string;
  source: string;
  model: string;
  project: string;
  /**
   * Client variant within a product family (e.g. `claude-code-cli` vs
   * `claude-desktop`, `qoder-ide` vs `qoder-cn-ide`). Optional for legacy
   * rows; new parsers should always set it. Upload prefers this over the
   * integration→collector fallback map.
   */
  collector?: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  conversation_count: number;
  /** Cursor CSV Cost column aggregate (USD); used for billing-accurate cost when present */
  reported_cost_usd?: number;
}

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  conversation_count: number;
}

export interface ClaudeFileCursor {
  inode: number;
  offset: number;
  /** Resolved project name cached so unchanged files skip the cwd peek. */
  project?: string;
}

export interface CodexFileCursor {
  inode: number;
  offset: number;
  tokenCountSeen?: number;
  prevTotal?: Record<string, {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
  }>;
  /**
   * Model in effect at `offset`. Later tail scans restore this so
   * `token_count` events that omit `info.model` are not filed as `unknown`.
   */
  lastModel?: string;
  /** Session meta cached at index time so unchanged files skip a full re-read. */
  meta?: CodexSessionFileMeta;
}

export interface CodexSessionFileMeta {
  sessionId: string | null;
  forkedFromId: string | null;
  sessionProject: string;
  tokenCountRecords: number;
  /** File size when this meta was indexed; stale when the file grows. */
  size: number;
}

export interface CodexSessionIndexEntry {
  tokenCount: number;
  forkedFrom?: string | null;
}

export interface CursorsFile {
  claude?: {
    files: Record<string, ClaudeFileCursor>;
    /** Legacy first-wins keys; still honored so already-ingested rows are not double-counted. */
    seenHashes?: string[];
    /** Last-seen cumulative usage per message.id[:requestId] for streaming last-wins deltas. */
    seenUsage?: Record<string, TokenTotals>;
  };
  codex?: {
    files: Record<string, CodexFileCursor>;
    sessionIndex?: Record<string, CodexSessionIndexEntry>;
    seenHashes?: string[];
  };
  cursor?: {
    lastRecordTimestamp?: string | null;
    lastSyncAt?: string | null;
    lastError?: string | null;
  };
  qoder?: {
    /** Message / line ids already counted (IDE message id, CLI dedup key). */
    seenHashes?: string[];
    /** Per JSONL file byte cursors for CLI / Work transcripts. */
    files?: Record<string, ClaudeFileCursor>;
    /** Per IDE local.db: last gmt_create ms processed. */
    ideWatermarks?: Record<string, number>;
  };
  trae?: {
    /** chat_turn ids (or equivalent) already counted, keyed by collector. */
    seenHashes?: string[];
    /** Optional last error from decrypt / key scan. */
    lastError?: string | null;
  };
  gemini?: {
    /** Per session file: inode/size/mtime + cumulative lastIndex/lastTotals. */
    files: Record<
      string,
      {
        inode: number;
        size: number;
        mtimeMs: number;
        lastIndex: number;
        lastTotals: {
          input_tokens: number;
          output_tokens: number;
          cached_input_tokens: number;
          cache_creation_input_tokens: number;
          reasoning_output_tokens: number;
          total_tokens: number;
        } | null;
        lastModel?: string;
      }
    >;
  };
  opencode?: {
    /** Per message key (`sessionId|msgId`) last token snapshot for rewrite-safe deltas. */
    messages: Record<
      string,
      {
        lastTotals: {
          input_tokens: number;
          output_tokens: number;
          cached_input_tokens: number;
          cache_creation_input_tokens: number;
          reasoning_output_tokens: number;
          total_tokens: number;
        };
      }
    >;
  };
  copilot?: {
    /** Per events.jsonl byte cursors. */
    files?: Record<string, ClaudeFileCursor>;
    /** sessionId|shutdown|stamp|model dedup keys. */
    seenHashes?: string[];
  };
  antigravity?: {
    /** Per transcript.jsonl: inode/size/mtime + delta-billing cursor. */
    files: Record<
      string,
      {
        inode: number;
        size: number;
        mtimeMs: number;
        lastLine: number;
        contextTokens: number;
        previousContextTokens: number;
        currentModel: string | null;
      }
    >;
  };
  openclaw?: {
    files?: Record<string, ClaudeFileCursor>;
  };
  hermes?: {
    profiles?: Record<
      string,
      {
        snapshots?: Record<string, Record<string, number>>;
        unfinishedIds?: string[];
        lastCompletedStartedAt?: number;
      }
    >;
  };
  zcode?: {
    messages?: Record<
      string,
      {
        lastTotals: {
          input_tokens: number;
          output_tokens: number;
          cached_input_tokens: number;
          cache_creation_input_tokens: number;
          reasoning_output_tokens: number;
          total_tokens: number;
        };
      }
    >;
  };
  pi?: {
    files?: Record<string, ClaudeFileCursor>;
    seenIds?: string[];
  };
  omp?: {
    files?: Record<string, ClaudeFileCursor>;
    seenIds?: string[];
  };
  kiloCli?: {
    /** Per message key (`sessionId|msgId`) last token snapshot for rewrite-safe deltas. */
    messages?: Record<
      string,
      {
        lastTotals: {
          input_tokens: number;
          output_tokens: number;
          cached_input_tokens: number;
          cache_creation_input_tokens: number;
          reasoning_output_tokens: number;
          total_tokens: number;
        };
      }
    >;
  };
  kilocode?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
  };
  kimi?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; inode?: number; ino?: number; mtimeMs?: number; offset?: number; model?: string }>;
  };
  roocode?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino?: number; inode?: number }>;
  };
  cline?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
  };
  amp?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
  };
  qwen?: {
    seenIds?: string[];
    files?: Record<string, { inode: number; size: number; mtimeMs: number }>;
  };
  droid?: {
    sessionTotals?: Record<
      string,
      {
        input: number;
        output: number;
        cacheCreation: number;
        cacheRead: number;
        thinking: number;
        mtimeMs: number;
      }
    >;
  };
  kiro?: {
    files?: Record<string, ClaudeFileCursor>;
    seenHashes?: string[];
    dbWatermark?: number;
  };
  mimo?: {
    /** Per message key (`sessionId|msgId`) last token snapshot for rewrite-safe deltas. */
    messages?: Record<
      string,
      {
        lastTotals: {
          input_tokens: number;
          output_tokens: number;
          cached_input_tokens: number;
          cache_creation_input_tokens: number;
          reasoning_output_tokens: number;
          total_tokens: number;
        };
      }
    >;
  };
  everyCode?: {
    files: Record<string, CodexFileCursor>;
    sessionIndex?: Record<string, CodexSessionIndexEntry>;
    seenHashes?: string[];
  };
  codebuddy?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
    logModelsByAgent?: Record<string, string>;
    updatedAt?: string;
  };
  workbuddy?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
    sqliteSessions?: Record<
      string,
      { used: number; updatedAt?: number; model?: string }
    >;
    detailedSessions?: Record<string, boolean>;
    updatedAt?: string;
  };
  grok?: {
    version?: number;
    sessionSnapshots?: Record<
      string,
      {
        totalTokens: number;
        messageCount: number;
        model?: string | null;
        source?: string | null;
        lastEventId?: string | null;
        lastEventTimestamp?: string | null;
        updatedAt?: string | null;
        legacySeen?: boolean;
      }
    >;
    seenSessions?: string[];
    updateOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
    updatedAt?: string;
  };
  goose?: {
    /** Per session id: last-seen cumulative input/output/total. */
    sessionTotals?: Record<
      string,
      {
        input: number;
        output: number;
        total: number;
      }
    >;
    lastDbMtimeMs?: number;
    updatedAt?: string;
  };
  zed?: {
    /** Per thread id: last-seen cumulative token tuple. */
    threadTotals?: Record<
      string,
      {
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
      }
    >;
    /** ISO updated_at watermark for incremental SQL filter. */
    lastUpdatedAt?: string | null;
    lastDbMtimeMs?: number;
    updatedAt?: string;
  };
  deepseek?: {
    /** Per session file: inode/size/mtime + dedup. */
    files: Record<string, { inode: number; size: number; mtimeMs: number; offset?: number }>;
    /** Message/event dedup keys. */
    seenHashes?: string[];
  };
  warp?: {
    /** Per conversation|model: last-seen cumulative warp+byok tokens. */
    conversationTotals?: Record<string, { tokens: number }>;
    dbMtimes?: Record<string, number>;
    updatedAt?: string;
  };
}

export interface TudConfig {
  deviceId: string;
  /** Upload / reporting floor (ISO8601 UTC). */
  statsSince: string;
  /**
   * Local collect / display floor (ISO8601 UTC). May be earlier than
   * `statsSince` until lookback alignment / 90D ensure moves upload too.
   * Missing on older installs → treat as `statsSince`.
   */
  localCollectSince?: string;
  hostname: string;
  dataDir: string;
  juejin: {
    enabled: boolean;
    apiUrl: string;
    authMode: string;
    /** Opaque `jau.` upload/auth token (or deviceId placeholder when unlinked). */
    token: string | null;
    /** Plain Juejin user id for display only (optional). */
    originUserId?: string | null;
    /** Juejin display name from login association (optional). */
    userName?: string | null;
    /** Juejin avatar URL from login association (optional). */
    avatarLarge?: string | null;
  };
  /**
   * Optional remote pricing overlay. Env `TUD_PRICING_URL` / `TUD_PRICING_TTL_MS`
   * override these when set. Misses fall back to bundled pricing.json.
   */
  pricing?: {
    url?: string | null;
    ttlMs?: number | null;
  };
  serverPort?: number;
  lastSyncAt?: string | null;
  lastUploadAt?: string | null;
}

export interface ManifestFile {
  activeMonth: string;
  files: Array<{
    month: string;
    path: string;
    firstHour: string | null;
    lastHour: string | null;
  }>;
}

export interface ModelUsageRow {
  model: string;
  tokens: number;
  costUsd: number;
  pct: number;
}

export interface SourceUsageRow {
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
  models: ModelUsageRow[];
}

export interface UsageSummary {
  totalTokens: number;
  totalCostUsd: number;
  todayTokens: number;
  todayCostUsd: number;
  statsSince: string;
  bySource: SourceUsageRow[];
}

/** Per-day project slice; model keys use `dailyModelKey(source, model)`. */
export interface DailyProjectUsage {
  project: string;
  tokens: number;
  models: Record<string, number>;
}

export interface DailyUsageRow {
  date: string;
  tokens: number;
  costUsd: number;
  models: Record<string, number>;
  /** Optional for backward compatibility with older daily payloads. */
  projects?: DailyProjectUsage[];
}

export interface DailyUsageResponse {
  days: DailyUsageRow[];
}

/** One hour bucket in the stats timezone (default Asia/Shanghai). */
export interface HourlyUsageRow {
  date: string;
  hour: number;
  /** Tool / integration channel (e.g. `claude`, `cursor`). */
  source: string;
  tokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface HourlyUsageResponse {
  hours: HourlyUsageRow[];
  timeZone: string;
}

export interface ModelBreakdownRow {
  model: string;
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
}

export interface ProjectModelBreakdownRow {
  model: string;
  source: string;
  tokens: number;
  costUsd: number;
  /** Share of the parent project's Token usage. */
  pct: number;
}

export interface ProjectBreakdownRow {
  project: string;
  tokens: number;
  costUsd: number;
  pct: number;
  models: ProjectModelBreakdownRow[];
}

export interface ModelBreakdownResponse {
  models: ModelBreakdownRow[];
  projects: ProjectBreakdownRow[];
}

export type LeaderboardMetric = 'cost' | 'tokens';

export interface LeaderboardRow {
  rank: number;
  displayName: string;
  userHash: string;
  /** Plain user id for profile lookup; legacy clients may omit it. */
  uid?: string;
  tokens: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd: number;
  isCurrentUser: boolean;
}

export interface LeaderboardUserProfile {
  uid: string;
  userName: string;
  avatarUrl: string;
  profileUrl: string;
}

export interface LeaderboardResponse {
  configured: boolean;
  metric: LeaderboardMetric;
  days: number;
  limit: number;
  generatedAt: string;
  totalUsers: number;
  rows: LeaderboardRow[];
  currentUser: LeaderboardRow | null;
}

export type LeaderboardRange = 'today' | 'week' | 'month' | 'all';

export interface LeaderboardBoard {
  metric: LeaderboardMetric;
  totalUsers: number;
  rows: LeaderboardRow[];
  currentUser: LeaderboardRow | null;
}

export interface LeaderboardMetricBoards {
  cost: LeaderboardBoard;
  tokens: LeaderboardBoard;
}

export interface ToolLeaderboard {
  tool: string;
  displayName: string;
  sortOrder: number;
  costSupported: boolean;
  boards: LeaderboardMetricBoards;
}

export interface LeaderboardOverviewResponse {
  configured: boolean;
  range: LeaderboardRange;
  days: number | null;
  limit: number;
  generatedAt: string;
  global: LeaderboardMetricBoards;
  tools: ToolLeaderboard[];
  /** Profiles for users visible in the global boards, keyed by plain user id. */
  profiles?: Record<string, LeaderboardUserProfile>;
  filterOptions?: {
    tools: Array<{ key: string; displayName: string }>;
    models: Array<{ tool: string; model: string }>;
  };
}

export interface SyncStatus {
  lastSyncAt: string | null;
  lastUploadAt: string | null;
  /** Server ingest floor (env or rolling 90d); optional on local mock. */
  ingestMinOccurredAt?: string | null;
  statsSince: string;
  pollIntervalSeconds: number;
  sources: Record<
    string,
    {
      status: string;
      rows?: number;
      hook: string;
      syncMode: string;
      message?: string;
      error?: string;
    }
  >;
  juejinEnabled: boolean;
}

export interface IngestBucket {
  hour_start: string;
  source: string;
  model: string;
  collector?: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  conversation_count: number;
  /** Cursor CSV Cost aggregate (USD); omitted when unknown */
  reported_cost_usd?: number;
}

export interface IngestRequest {
  deviceId: string;
  buckets: IngestBucket[];
  syncedAt: string;
}

export interface TudConfigView {
  deviceId: string;
  statsSince: string;
  localCollectSince: string;
  lastSyncAt: string | null;
  lastUploadAt: string | null;
  juejin: {
    enabled: boolean;
    apiUrl: string;
    authMode: string;
    /** True when any upload token is set (includes deviceId unlinked placeholder). */
    hasToken: boolean;
    /**
     * Linked opaque upload token (`jau.…`). Null when unset or when token is
     * still the deviceId placeholder (not associated via 掘金登录 / scheme).
     */
    userId: string | null;
    /** Plain Juejin user id for Settings display only. */
    originUserId: string | null;
    userName: string | null;
    avatarLarge: string | null;
  };
}

export interface TudConfigUpdate {
  juejin?: {
    enabled?: boolean;
    apiUrl?: string;
    token?: string | null;
    originUserId?: string | null;
    userName?: string | null;
    avatarLarge?: string | null;
  };
}
