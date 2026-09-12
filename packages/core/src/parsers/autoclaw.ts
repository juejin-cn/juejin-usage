/**
 * AutoClaw passive reader (source `autoclaw`, collector `autoclaw`).
 *
 * AutoClaw is an OpenClaw-family product whose state root defaults to
 * ~/.openclaw-autoclaw (OpenClaw agent profile "autoclaw"); ~/.autoclaw is
 * accepted as an alternate layout. Session JSONL matches OpenClaw's format:
 * agents/<agentId>/sessions/*.jsonl with OpenClaw-style wrapped usage, so the
 * normalization is shared with the OpenClaw parser.
 *
 * Project attribution: session cwd points at the agent's internal workspace,
 * so projects are derived from the absolute paths in each message's tool
 * calls — walking up to the nearest repo marker (.git, pom.xml, …). Messages
 * without paths carry forward the session's last project; the final fallback
 * is the agent's display name from workspace/IDENTITY.md (`agent.name`).
 */
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket } from '../types.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  type BucketAccumulator,
} from './shared.js';
import { normalizeOpenclawUsage } from './openclaw.js';

export const AUTOCLAW_COLLECTOR = 'autoclaw';

interface AutoclawFileCursor {
  inode: number;
  offset: number;
  /** Last project seen in this session; carry-forward seed for the next read. */
  project?: string;
}

function coerceTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** Directories owned by this parser; the OpenClaw scanner must skip them. */
export const AUTOCLAW_PROFILE_DIR = /^\.openclaw-autoclaw(?:-.+)?$/;

/** All AutoClaw state roots (AUTOCLAW_STATE_DIR overrides to a single root). */
export function autoclawRoots(): string[] {
  const env = process.env.AUTOCLAW_STATE_DIR?.trim();
  if (env) {
    const root = env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
    return [root];
  }

  const home = homedir();
  const roots: string[] = [join(home, '.autoclaw'), join(home, '.openclaw-autoclaw')];
  const seen = new Set(roots);

  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (/^\.autoclaw-.+/.test(entry.name) || AUTOCLAW_PROFILE_DIR.test(entry.name)) {
        const full = join(home, entry.name);
        if (!seen.has(full)) {
          seen.add(full);
          roots.push(full);
        }
      }
    }
  } catch {
    // ignore unreadable home
  }

  return roots;
}

/** Discover session JSONL files under agents/<id>/sessions/. */
export function findAutoclawSessionFiles(roots = autoclawRoots()): string[] {
  const results: string[] = [];
  for (const root of roots) {
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) continue;

    let agentDirs;
    try {
      agentDirs = readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }

    for (const agentDir of agentDirs) {
      const sessionsDir = join(agentsDir, agentDir.name, 'sessions');
      if (!existsSync(sessionsDir)) continue;

      let files: string[];
      try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        results.push(join(sessionsDir, file));
      }
    }
  }
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

/** Agent display name from workspace/IDENTITY.md frontmatter (`agent.name`). */
const agentNameCache = new Map<string, string>();

export function autoclawAgentDisplayName(agentDir: string): string {
  const cached = agentNameCache.get(agentDir);
  if (cached !== undefined) return cached;

  let name = '';
  try {
    const raw = readFileSync(join(agentDir, 'workspace', 'IDENTITY.md'), 'utf-8');
    const head = raw.slice(0, 4_000);
    const m = head.match(/^agent\.name:\s*["']?(.+?)["']?\s*$/m);
    if (m?.[1]?.trim()) name = m[1].trim();
  } catch {
    // missing or unreadable identity
  }
  const resolved = name || basename(agentDir);
  if (agentNameCache.size > 500) agentNameCache.clear();
  agentNameCache.set(agentDir, resolved);
  return resolved;
}

const REPO_MARKERS = [
  '.git',
  '.hg',
  '.svn',
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'composer.json',
  'Gemfile',
];

/** dir → resolved repo-root basename (or null); bounded so hot loops stay cheap. */
const dirProjectCache = new Map<string, string | null>();

function isRepoRoot(dir: string): boolean {
  for (const marker of REPO_MARKERS) {
    if (existsSync(join(dir, marker))) return true;
  }
  return false;
}

/** Memoized exclusion roots — autoclawRoots() rescans home, too hot per path. */
let exclusionRootsKey: string | undefined;
let exclusionRootsList: string[] | undefined;

function stateRootsForExclusion(): string[] {
  const key = process.env.AUTOCLAW_STATE_DIR ?? '';
  if (key !== exclusionRootsKey || !exclusionRootsList) {
    exclusionRootsKey = key;
    exclusionRootsList = autoclawRoots();
  }
  return exclusionRootsList;
}

/** Nearest enclosing repo root's basename for an absolute path, else null. */
export function autoclawProjectForPath(rawPath: string): string | null {
  // partialArgs carries JSON-escaped paths (double backslashes); collapse them
  // so root-exclusion prefix checks and walk-ups see the real separators.
  const normalized = rawPath.replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/[\\/]+$/, '');
  // Drive path (C:\a\b), UNC (\\server\share\…), or unix absolute with at
  // least one directory. Bogus matches (URL fragments, ids) die on the
  // existence checks below, so the guard only has to reject relative paths.
  const isAbsolute =
    /^[A-Za-z]:\\./.test(normalized) ||
    /^\\\\.+\\.+/.test(normalized) ||
    /^\\[^\\]+\\.+/.test(normalized);
  if (!isAbsolute) return null;

  const forStateRoots = stateRootsForExclusion().map((r) => r.replace(/\//g, '\\').toLowerCase());
  const lower = normalized.toLowerCase();
  if (forStateRoots.some((root) => lower === root || lower.startsWith(root + '\\'))) return null;

  const cacheKey = dirname(lower);
  if (dirProjectCache.has(cacheKey)) return dirProjectCache.get(cacheKey) ?? null;

  let current = normalized;
  let resolved: string | null = null;
  while (true) {
    if (isRepoRoot(current)) {
      resolved = basename(current) || null;
      break;
    }
    const parent = dirname(current);
    if (!parent || parent === current || !/[\\/]/.test(parent.slice(1))) break;
    current = parent;
  }

  if (dirProjectCache.size > 4_000) dirProjectCache.clear();
  dirProjectCache.set(cacheKey, resolved);
  return resolved;
}

const WIN_PATH = /[A-Za-z]:[\\/][^\s"'`|<>]+/g;
const UNIX_PATH = /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@-]+)+/g;

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 4) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
}

/**
 * Dominant repo project referenced by a message's tool calls, or null when the
 * message carries no usable absolute path.
 */
export function autoclawProjectFromMessage(message: unknown): string | null {
  const msg = message as { content?: unknown } | null;
  if (!msg || !Array.isArray(msg.content)) return null;

  const strings: string[] = [];
  for (const item of msg.content) {
    const call = item as { type?: string; arguments?: unknown; partialArgs?: unknown } | null;
    if (!call || call.type !== 'toolCall') continue;
    collectStrings(call.arguments, strings);
    collectStrings(call.partialArgs, strings);
  }
  if (strings.length === 0) return null;

  const counts = new Map<string, number>();
  for (const s of strings) {
    for (const m of s.match(WIN_PATH) ?? []) {
      const project = autoclawProjectForPath(m);
      if (project) counts.set(project, (counts.get(project) ?? 0) + 1);
    }
    for (const m of s.match(UNIX_PATH) ?? []) {
      const project = autoclawProjectForPath(m);
      if (project) counts.set(project, (counts.get(project) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  let best: string | null = null;
  let bestCount = 0;
  for (const [project, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && project < best)) {
      best = project;
      bestCount = count;
    }
  }
  return best;
}

export interface ParseAutoclawResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
  /** True when legacy cursor state was reset so the whole window was re-read. */
  fullRescan?: boolean;
}

export async function parseAutoclawIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseAutoclawResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  type AutoclawCursor = {
    files: Record<string, AutoclawFileCursor>;
    /** Marker for cursor state written after tool-path project attribution. */
    repoProjects?: boolean;
  };
  const ext = cursors as CursorsFile & { autoclaw?: AutoclawCursor };
  if (!ext.autoclaw) {
    ext.autoclaw = { files: {} };
  }

  // Cursor state older than tool-path attribution bucketed everything under
  // the agent id. Drop it once so this pass re-reads the full window and the
  // sync layer can replace/zero the stale rows.
  const fullRescan = ext.autoclaw.repoProjects !== true;
  if (fullRescan) {
    ext.autoclaw.files = {};
  }

  const fileCursors = ext.autoclaw.files;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of findAutoclawSessionFiles()) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileCursors[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;
    if (sameInode && !truncated && startOffset >= st.size) continue;

    const agentName = autoclawAgentDisplayName(join(dirname(filePath), '..'));
    let lastProject = prev?.project ?? null;
    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      if (!line.includes('"usage"')) continue;

      let obj: {
        type?: string;
        timestamp?: unknown;
        model?: string;
        message?: {
          role?: string;
          model?: string;
          timestamp?: unknown;
          usage?: Record<string, unknown>;
        };
      };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type !== 'message') continue;
      const msg = obj.message;
      if (!msg || msg.role !== 'assistant') continue;

      const delta = normalizeOpenclawUsage(msg.usage);
      if (!delta) continue;

      const stamp =
        coerceTimestamp(obj.timestamp) ??
        coerceTimestamp(msg.timestamp);
      if (!stamp) continue;

      const hourStart = toUtcHalfHourStart(stamp);
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const fromTools = autoclawProjectFromMessage(msg);
      if (fromTools) lastProject = fromTools;
      const project = fromTools ?? lastProject ?? agentName;

      const model = msg.model || obj.model || 'unknown';
      accumulateBucket(
        bucketState,
        'autoclaw',
        model,
        project,
        hourStart,
        { ...delta, conversation_count: 1 },
        AUTOCLAW_COLLECTOR,
      );
      eventsParsed += 1;
    }

    fileCursors[filePath] = { inode, offset: st.size, ...(lastProject ? { project: lastProject } : {}) };
    filesProcessed += 1;
  }

  ext.autoclaw.repoProjects = true;

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'autoclaw'),
      eventsParsed,
      filesProcessed,
      ...(fullRescan ? { fullRescan: true } : {}),
    },
    cursors,
  };
}
