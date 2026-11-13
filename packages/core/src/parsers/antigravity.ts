import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import type { AntigravityNativeStep, CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { geminiHome } from '../paths.js';
import { monthFromHourStart, toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  type BucketAccumulator,
} from './shared.js';

/** Legacy / standalone Antigravity app under `~/.gemini/antigravity`. */
export const ANTIGRAVITY_COLLECTOR_APP = 'antigravity-app';
/** Desktop / IDE under `~/.gemini/antigravity-ide`. */
export const ANTIGRAVITY_COLLECTOR_IDE = 'antigravity-ide';
/** CLI (`agy`) under `~/.gemini/antigravity-cli`. */
export const ANTIGRAVITY_COLLECTOR_CLI = 'antigravity-cli';

const VARIANT_DIRS = [
  { dir: 'antigravity-cli', collector: ANTIGRAVITY_COLLECTOR_CLI },
  { dir: 'antigravity-ide', collector: ANTIGRAVITY_COLLECTOR_IDE },
  { dir: 'antigravity', collector: ANTIGRAVITY_COLLECTOR_APP },
] as const;

export function resolveAntigravityBrainDirs(home = geminiHome()): string[] {
  return VARIANT_DIRS.map((v) => join(home, v.dir, 'brain'));
}

/** Infer collector from absolute transcript path (cli/ide before bare antigravity). */
export function antigravityCollectorForPath(filePath: string): string {
  const normalized = filePath.split(/[/\\]/).join('/');
  if (normalized.includes('/antigravity-cli/')) return ANTIGRAVITY_COLLECTOR_CLI;
  if (normalized.includes('/antigravity-ide/')) return ANTIGRAVITY_COLLECTOR_IDE;
  return ANTIGRAVITY_COLLECTOR_APP;
}

/** Session uuid folder under brain/<uuid>/.system_generated/logs/transcript.jsonl */
export function antigravityProjectFromPath(filePath: string): string {
  // …/brain/<session>/.system_generated/logs/transcript.jsonl → 3 parents up from file
  let dir = dirname(filePath); // logs
  dir = dirname(dir); // .system_generated
  dir = dirname(dir); // session uuid
  const name = basename(dir);
  return name && name !== 'brain' ? name : 'unknown';
}

export function listAntigravitySessionFiles(brainDir: string): string[] {
  const out: string[] = [];
  if (!brainDir || !existsSync(brainDir)) return out;
  let entries;
  try {
    entries = readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const logsDir = join(
      brainDir,
      entry.name,
      '.system_generated',
      'logs',
    );
    // The full export contains native usage counters; never count both exports.
    const full = join(logsDir, 'transcript_full.jsonl');
    const legacy = join(logsDir, 'transcript.jsonl');
    if (existsSync(full)) out.push(full);
    else if (existsSync(legacy)) out.push(legacy);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export function listAntigravityTranscripts(home = geminiHome()): string[] {
  return resolveAntigravityBrainDirs(home).flatMap((dir) => listAntigravitySessionFiles(dir));
}

export function isCjkCodePoint(code: number | undefined): boolean {
  if (code == null) return false;
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff)
  );
}

/** CJK ≈ 1 token/char; other ≈ ceil(len/4). Upper-bound estimate (no cache discount). */
export function estimateAntigravityTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0))) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function antigravityValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateAntigravityTokens(value);
  if (value == null) return 0;
  try {
    return estimateAntigravityTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export function antigravityContextTokens(event: {
  type?: string;
  content?: unknown;
  tool_calls?: unknown;
}): number {
  if (!event || typeof event !== 'object') return 0;
  let tokens = antigravityValueTokens(event.content);
  if (event.type === 'PLANNER_RESPONSE' && event.tool_calls) {
    tokens += antigravityValueTokens(event.tool_calls);
  }
  return tokens;
}

export function normalizeAntigravityTranscriptModel(modelName: string | null | undefined): string | null {
  if (!modelName || typeof modelName !== 'string') return null;
  let slug = modelName
    .trim()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(thinking|xhigh|high|medium|low|fast)\b/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!slug) return null;

  for (const marker of ['gemini', 'claude', 'gpt']) {
    const idx = slug.indexOf(marker);
    if (idx >= 0) {
      slug = slug.slice(idx);
      break;
    }
  }
  if (/^(gemini|claude|gpt)-/.test(slug)) return slug;
  return `antigravity-${slug}`;
}

export function parseAntigravityModelSelection(content: string): string | null {
  if (!content) return null;
  const match = content.match(
    /changed setting `Model Selection` from .*? to ([^`\n]+?)(?:\s*\([^)]*\))?\.(?:\s+|$)/i,
  );
  if (!match?.[1]) return null;
  return normalizeAntigravityTranscriptModel(match[1]);
}

async function readAntigravityDefaultModel(filePath: string): Promise<string | null> {
  try {
    // …/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl → 5 up
    let dir = filePath;
    for (let i = 0; i < 5; i++) dir = dirname(dir);
    const raw = await readFile(join(dir, 'settings.json'), 'utf8');
    const settings = JSON.parse(raw) as { model?: string };
    if (settings.model && typeof settings.model === 'string') {
      return normalizeAntigravityTranscriptModel(settings.model);
    }
  } catch {
    // ignore
  }
  return null;
}

interface FileParseResult {
  lastLine: number;
  eventsAggregated: number;
  contextTokens: number;
  previousContextTokens: number;
  currentModel: string | null;
}

async function parseAntigravityFile(opts: {
  filePath: string;
  raw: string;
  sinceMs: number;
  collector: string;
  project: string;
  bucketState: BucketAccumulator;
}): Promise<FileParseResult> {
  const {
    filePath,
    raw,
    sinceMs,
    collector,
    project,
    bucketState,
  } = opts;

  if (!raw.trim()) {
    return {
      lastLine: 0,
      eventsAggregated: 0,
      contextTokens: 0,
      previousContextTokens: 0,
      currentModel: null,
    };
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let currentModel = await readAntigravityDefaultModel(filePath);
  let contextTokens = 0;
  let previousContextTokens = 0;
  let lastCompletedLine = 0;
  let eventsAggregated = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let parsed: {
      type?: string;
      created_at?: string;
      content?: unknown;
      thinking?: unknown;
      tool_calls?: unknown;
    };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      // The caller rejects incomplete tails; skip damaged middle records.
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    if (parsed.type === 'USER_INPUT' || parsed.type === 'USER_SETTINGS_CHANGE') {
      const content = typeof parsed.content === 'string' ? parsed.content : '';
      const model = parseAntigravityModelSelection(content);
      if (model) currentModel = model;
    }

    const eventContextTokens = antigravityContextTokens(parsed);

    const timestamp = parsed.created_at;
    if (!timestamp) {
      contextTokens += eventContextTokens;
      lastCompletedLine = i + 1;
      continue;
    }

    const hourStart = toUtcHalfHourStart(timestamp);
    if (!hourStart) {
      contextTokens += eventContextTokens;
      lastCompletedLine = i + 1;
      continue;
    }

    if (parsed.type !== 'PLANNER_RESPONSE') {
      contextTokens += eventContextTokens;
      lastCompletedLine = i + 1;
      continue;
    }

    const content = typeof parsed.content === 'string' ? parsed.content : '';
    const thinking = typeof parsed.thinking === 'string' ? parsed.thinking : '';
    const inputDelta = Math.max(0, contextTokens - previousContextTokens);
    const outputTokens =
      antigravityValueTokens(content) + antigravityValueTokens(parsed.tool_calls);
    const reasoningTokens = antigravityValueTokens(thinking);
    const total = inputDelta + outputTokens + reasoningTokens;

    if (total > 0 && new Date(hourStart).getTime() >= sinceMs) {
      const delta: TokenTotals = {
        input_tokens: inputDelta,
        output_tokens: outputTokens,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: reasoningTokens,
        total_tokens: total,
        conversation_count: 1,
      };
      accumulateBucket(
        bucketState,
        'antigravity',
        currentModel || 'antigravity-unknown',
        project,
        hourStart,
        delta,
        collector,
      );
      eventsAggregated += 1;
    }

    previousContextTokens = contextTokens;
    contextTokens += eventContextTokens;
    lastCompletedLine = i + 1;
  }

  return {
    lastLine: lastCompletedLine,
    eventsAggregated,
    contextTokens,
    previousContextTokens,
    currentModel,
  };
}

export interface ParseAntigravityResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
  /** Complete replacements for these session/collector pairs, including empty sessions. */
  replacedSessions: Array<{ project: string; collector: string; months?: string[] }>;
}

/** Also compacts full QueueBuckets saved by earlier versions of the parser. */
function retainNativeSteps(
  steps: Record<string, AntigravityNativeStep>,
  sinceMs: number,
): Record<string, AntigravityNativeStep> {
  const retained: Record<string, AntigravityNativeStep> = {};
  for (const [step, row] of Object.entries(steps)) {
    if (Date.parse(row.hour_start) < sinceMs) continue;
    retained[step] = {
      model: row.model,
      hour_start: row.hour_start,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cached_input_tokens: row.cached_input_tokens,
      cache_creation_input_tokens: row.cache_creation_input_tokens,
    };
  }
  return retained;
}

/** Native exports can rewrite completed steps, so read the latest record per step. */
async function parseNativeAntigravityFile(
  raw: string,
  sinceMs: number,
  collector: string,
  project: string,
  bucketState: BucketAccumulator,
  previousSteps: Record<string, AntigravityNativeStep> = {},
): Promise<{ eventsParsed: number; nativeSteps: Record<string, AntigravityNativeStep> }> {
  const steps = new Map<number, Record<string, unknown>>();
  for (const line of raw.split(/\r?\n/)) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      if (record.type === 'PLANNER_RESPONSE' && record.status !== 'DONE') continue;
      if (Number.isSafeInteger(record.step_index) && Number(record.step_index) >= 0) {
        steps.set(Number(record.step_index), record);
      }
    } catch {
      // The caller rejects incomplete tails; skip damaged middle records.
    }
  }

  let currentModel: string | null = null;
  const nativeSteps = { ...previousSteps };
  for (const [step, row] of [...steps].sort(([left], [right]) => left - right)) {
    if (row.type === 'USER_INPUT' || row.type === 'USER_SETTINGS_CHANGE') {
      const selected = typeof row.content === 'string'
        ? parseAntigravityModelSelection(row.content)
        : null;
      currentModel = selected ?? currentModel;
    }
    if (row.type !== 'PLANNER_RESPONSE' || row.status !== 'DONE') continue;
    const hourStart = typeof row.created_at === 'string'
      ? toUtcHalfHourStart(row.created_at)
      : null;
    if (!hourStart) continue;
    const token = (key: string): number | null => {
      const value = row[key];
      if (value == null) return 0;
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
    };
    const input = token('input_tokens');
    const output = token('output_tokens');
    const cacheRead = token('cache_read_tokens');
    const cacheWrite = token('cache_write_tokens');
    if (input === null || output === null || cacheRead === null || cacheWrite === null) continue;
    // Native input excludes cache; native output already includes reasoning.
    const total = input + output + cacheRead + cacheWrite;
    if (!Number.isSafeInteger(total) || total <= 0) continue;
    if (Date.parse(hourStart) < sinceMs) {
      delete nativeSteps[step];
      continue;
    }
    const explicitModel = typeof row.model === 'string' ? row.model.trim() : '';
    const model = explicitModel && explicitModel.toLowerCase() !== 'unknown'
      ? normalizeAntigravityTranscriptModel(explicitModel)
      : currentModel ?? previousSteps[step]?.model;
    nativeSteps[step] = {
      model: model || 'antigravity-unknown',
      hour_start: hourStart,
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    };
  }

  let eventsParsed = 0;
  // An export rewrite may temporarily omit older completed steps. Retain their
  // last counters; only another completed record can correct a billed step.
  for (const row of Object.values(nativeSteps)) {
    const totals: TokenTotals = {
      ...row,
      reasoning_output_tokens: 0,
      total_tokens: row.input_tokens + row.output_tokens
        + row.cached_input_tokens + row.cache_creation_input_tokens,
      conversation_count: 1,
    };
    accumulateBucket(bucketState, 'antigravity', row.model, project, row.hour_start, totals, collector);
    eventsParsed += 1;
  }
  return { eventsParsed, nativeSteps };
}

export async function parseAntigravityIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseAntigravityResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  if (!cursors.antigravity) {
    cursors.antigravity = { files: {} };
  }
  const fileCursors = cursors.antigravity.files;
  // Prune retained counters even when a session is temporarily off disk.
  for (const cursor of Object.values(fileCursors)) {
    if (cursor.nativeSteps) {
      cursor.nativeSteps = retainNativeSteps(cursor.nativeSteps, sinceMs);
    }
  }
  const bucketState: BucketAccumulator = new Map();
  const files = listAntigravityTranscripts();

  let eventsParsed = 0;
  let filesProcessed = 0;
  const replacedSessions: ParseAntigravityResult['replacedSessions'] = [];

  for (const filePath of files) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileCursors[filePath];
    const native = basename(filePath) === 'transcript_full.jsonl';
    const legacyPath = join(dirname(filePath), 'transcript.jsonl');
    const nativePath = join(dirname(filePath), 'transcript_full.jsonl');
    // Once native counters are accepted, a temporarily missing export must not
    // let the simplified transcript replace exact usage with estimates.
    if (!native && fileCursors[nativePath]?.snapshotVersion === 1) {
      filesProcessed += 1;
      continue;
    }
    const inode = st.ino || 0;
    const size = Number.isFinite(st.size) ? st.size : 0;
    const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;

    const unchanged =
      prev?.snapshotVersion === 1 && prev.inode === inode && prev.size === size && prev.mtimeMs === mtimeMs;
    if (unchanged) {
      if (native) delete fileCursors[legacyPath];
      filesProcessed += 1;
      continue;
    }

    const collector = antigravityCollectorForPath(filePath);
    const project = antigravityProjectFromPath(filePath);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    // A rewrite can briefly expose an empty file or partial JSON. Keep the
    // previous snapshot and fingerprint until a complete export is readable.
    if (!raw.trim()) continue;
    try {
      const lastLine = raw.trimEnd().split(/\r?\n/).at(-1)!;
      JSON.parse(lastLine);
    } catch {
      continue;
    }
    // Both formats return a whole-session replacement. This also upgrades old
    // estimate cursors without adding native counters on top of their history.
    const sessionState: BucketAccumulator = new Map();
    const nativeResult = native
      ? await parseNativeAntigravityFile(raw, sinceMs, collector, project, sessionState, prev?.nativeSteps)
      : null;
    const parsed = nativeResult ? {
      eventsAggregated: nativeResult.eventsParsed,
      lastLine: 0,
      contextTokens: 0,
      previousContextTokens: 0,
      currentModel: null,
    } : await parseAntigravityFile({
      filePath,
      raw,
      sinceMs,
      collector,
      project,
      bucketState: sessionState,
    });
    const sessionBuckets = bucketsFromState(sessionState, 'antigravity');
    const snapshotMonths = [...new Set(sessionBuckets.map((row) => monthFromHourStart(row.hour_start)))];
    for (const row of sessionBuckets) {
      accumulateBucket(bucketState, 'antigravity', row.model, row.project, row.hour_start, row, collector);
    }

    fileCursors[filePath] = {
      snapshotVersion: 1,
      snapshotMonths,
      ...(nativeResult ? { nativeSteps: nativeResult.nativeSteps } : {}),
      inode,
      size,
      mtimeMs,
      lastLine: parsed.lastLine,
      contextTokens: parsed.contextTokens,
      previousContextTokens: parsed.previousContextTokens,
      currentModel: parsed.currentModel,
    };
    replacedSessions.push({
      project,
      collector,
      ...(prev?.snapshotMonths
        ? { months: [...new Set([...prev.snapshotMonths, ...snapshotMonths])] }
        : {}),
    });
    // Keep the legacy cursor until the native snapshot has been accepted.
    if (native) delete fileCursors[legacyPath];

    eventsParsed += parsed.eventsAggregated;
    filesProcessed += 1;
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'antigravity'),
      eventsParsed,
      filesProcessed,
      replacedSessions,
    },
    cursors,
  };
}
