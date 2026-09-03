import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { parseCodexIncremental } from '../src/parsers/codex.js';
import { modelFromRolloutEvent } from '../src/parsers/rollout-model.js';
import { codexHomeCandidates } from '../src/paths.js';
import type { CursorsFile } from '../src/types.js';

const SOURCE_FILE = [
  '{"type":"session_meta","timestamp":"2026-06-09T20:46:00.000Z","payload":{"id":"source-session-1","cwd":"/Users/dev/my-app"}}',
  '{"type":"event_msg","timestamp":"2026-06-09T20:46:30.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":60},"model":"gpt-5.4"}}}',
].join('\n');

const FORK_FILE = [
  '{"type":"session_meta","timestamp":"2026-06-09T21:00:00.000Z","payload":{"id":"fork-session-1","forked_from_id":"source-session-1","cwd":"/Users/dev/my-app"}}',
  '{"type":"event_msg","timestamp":"2026-06-09T21:00:01.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":60},"model":"gpt-5.4"}}}',
  '{"type":"event_msg","timestamp":"2026-06-09T21:00:05.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"cached_input_tokens":5,"output_tokens":8,"reasoning_output_tokens":2,"total_tokens":28},"model":"gpt-5.4"}}}',
].join('\n');

test('parseCodexIncremental normalizes input and skips fork replay', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-codex-'));
  const sessionsDir = join(tempHome, '.codex', 'sessions', '2026', '06', '09');
  await mkdir(sessionsDir, { recursive: true });

  await writeFile(join(sessionsDir, 'rollout-source.jsonl'), `${SOURCE_FILE}\n`, 'utf8');
  await writeFile(join(sessionsDir, 'rollout-fork.jsonl'), `${FORK_FILE}\n`, 'utf8');

  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempHome, '.codex');

  try {
    const { result } = await parseCodexIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 2);

    const totalInput = result.buckets.reduce((sum, b) => sum + b.input_tokens, 0);
    const totalOutput = result.buckets.reduce((sum, b) => sum + b.output_tokens, 0);

    assert.equal(totalInput, 50 + 15);
    assert.equal(totalOutput, 10 + 6);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});

test('codexHomeCandidates includes CC Switch directory override and deduplicates roots', () => {
  const previous = {
    codex: process.env.CODEX_HOME,
    usage: process.env.AI_USAGE_CODEX_HOME,
  };
  process.env.CODEX_HOME = '/tmp/codex-primary:/tmp/codex-shared';
  process.env.AI_USAGE_CODEX_HOME = '/tmp/codex-shared:/tmp/codex-extra';
  try {
    const roots = codexHomeCandidates();
    assert.ok(roots.includes('/tmp/codex-shared'));
    assert.ok(roots.includes('/tmp/codex-extra'));
    assert.ok(roots.includes('/tmp/codex-primary'));
    assert.equal(new Set(roots).size, roots.length);
  } finally {
    if (previous.codex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codex;
    if (previous.usage === undefined) delete process.env.AI_USAGE_CODEX_HOME;
    else process.env.AI_USAGE_CODEX_HOME = previous.usage;
  }
});

const EXTRA_TOKEN_LINE =
  '{"type":"event_msg","timestamp":"2026-06-09T20:47:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":30,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":35},"model":"gpt-5.4"}}}';

test('parseCodexIncremental reuses cached session meta for unchanged files', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-codex-'));
  const sessionsDir = join(tempHome, '.codex', 'sessions', '2026', '06', '12');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, 'rollout-meta-cache.jsonl');
  await writeFile(filePath, `${SOURCE_FILE}\n`, 'utf8');

  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempHome, '.codex');

  try {
    const cursors: CursorsFile = {};
    await parseCodexIncremental(cursors, '2026-01-01T00:00:00.000Z');
    const fileCursor = cursors.codex!.files[filePath]!;
    assert.equal(fileCursor.meta?.sessionId, 'source-session-1');
    assert.equal(fileCursor.meta?.tokenCountRecords, 1);

    // Rewrite in place with the same byte length but a different session id:
    // same inode + size must hit the cached meta instead of re-indexing.
    await writeFile(
      filePath,
      `${SOURCE_FILE.replace('source-session-1', 'source-session-9')}\n`,
      'utf8',
    );
    const second = await parseCodexIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(second.result.eventsParsed, 0);
    assert.equal(cursors.codex!.files[filePath]!.meta?.sessionId, 'source-session-1');
    assert.equal(cursors.codex!.sessionIndex!['source-session-9'], undefined);

    // Growing the file invalidates the cached meta and re-indexes it.
    await writeFile(filePath, `${SOURCE_FILE}\n${EXTRA_TOKEN_LINE}\n`, 'utf8');
    const third = await parseCodexIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(third.result.eventsParsed, 1);
    assert.equal(cursors.codex!.files[filePath]!.meta?.tokenCountRecords, 2);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});

test('parseCodexIncremental uses the model from thread settings', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-codex-'));
  const sessionsDir = join(tempHome, '.codex', 'sessions', '2026', '06', '10');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, 'rollout-settings.jsonl'),
    [
      '{"type":"session_meta","payload":{"id":"settings-session","cwd":"/Users/dev/my-app"}}',
      '{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.6-sol"}}',
      '{"timestamp":"2026-06-10T10:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"output_tokens":10,"total_tokens":60}}}}',
    ].join('\n'),
    'utf8',
  );

  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempHome, '.codex');

  try {
    const { result } = await parseCodexIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0]?.model, 'gpt-5.6-sol');
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});

const CONTEXT_ONLY = [
  '{"type":"session_meta","payload":{"id":"desktop-session","cwd":"/Users/dev/alipay-service"}}',
  '{"type":"turn_context","payload":{"model":"deepseek-v4-flash"}}',
].join('\n');

const TOKEN_WITHOUT_MODEL =
  '{"timestamp":"2026-08-21T02:26:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"output_tokens":10,"total_tokens":60}}}}';

test('modelFromRolloutEvent reads turn_context, thread settings, and world_state', () => {
  assert.equal(
    modelFromRolloutEvent({
      type: 'turn_context',
      payload: { model: 'deepseek-v4-flash' },
    }),
    'deepseek-v4-flash',
  );
  assert.equal(
    modelFromRolloutEvent({
      type: 'thread_settings_applied',
      thread_settings: { model: 'gpt-5.6-sol' },
    }),
    'gpt-5.6-sol',
  );
  assert.equal(
    modelFromRolloutEvent({
      type: 'world_state',
      payload: {
        state: { model: 'deepseek-v4-flash' },
        collaboration_mode: { model: 'other' },
      },
    }),
    'deepseek-v4-flash',
  );
  assert.equal(
    modelFromRolloutEvent({
      type: 'world_state',
      payload: { collaboration_mode: { model: 'gpt-5.4' } },
    }),
    'gpt-5.4',
  );
  assert.equal(modelFromRolloutEvent({ type: 'event_msg', payload: {} }), null);
});

test('parseCodexIncremental persists lastModel across tail scans without info.model', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-codex-'));
  const sessionsDir = join(tempHome, '.codex', 'sessions', '2026', '08', '21');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, 'rollout-last-model.jsonl');
  await writeFile(filePath, `${CONTEXT_ONLY}\n`, 'utf8');

  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempHome, '.codex');

  try {
    const cursors: CursorsFile = {};
    const first = await parseCodexIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(first.result.eventsParsed, 0);
    assert.equal(cursors.codex!.files[filePath]!.lastModel, 'deepseek-v4-flash');

    await writeFile(filePath, `${CONTEXT_ONLY}\n${TOKEN_WITHOUT_MODEL}\n`, 'utf8');
    const second = await parseCodexIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets.length, 1);
    assert.equal(second.result.buckets[0]?.model, 'deepseek-v4-flash');
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});

test('parseCodexIncremental recovers lastModel from the skipped prefix', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-codex-'));
  const sessionsDir = join(tempHome, '.codex', 'sessions', '2026', '08', '21');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, 'rollout-prefix-recover.jsonl');
  await writeFile(filePath, `${CONTEXT_ONLY}\n`, 'utf8');

  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempHome, '.codex');

  try {
    const cursors: CursorsFile = {};
    await parseCodexIncremental(cursors, '2026-01-01T00:00:00.000Z');
    delete cursors.codex!.files[filePath]!.lastModel;

    await writeFile(filePath, `${CONTEXT_ONLY}\n${TOKEN_WITHOUT_MODEL}\n`, 'utf8');
    const { result } = await parseCodexIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]?.model, 'deepseek-v4-flash');
    assert.equal(cursors.codex!.files[filePath]!.lastModel, 'deepseek-v4-flash');
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});

test('parseCodexIncremental uses the model from world_state', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-codex-'));
  const sessionsDir = join(tempHome, '.codex', 'sessions', '2026', '08', '21');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, 'rollout-world-state.jsonl'),
    [
      '{"type":"session_meta","payload":{"id":"world-session","cwd":"/Users/dev/my-app"}}',
      '{"type":"world_state","payload":{"state":{"model":"deepseek-v4-flash"}}}',
      TOKEN_WITHOUT_MODEL,
    ].join('\n'),
    'utf8',
  );

  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempHome, '.codex');

  try {
    const { result } = await parseCodexIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0]?.model, 'deepseek-v4-flash');
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});

test('parseCodexIncremental folds early unknown token_count into the later model', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-codex-'));
  const sessionsDir = join(tempHome, '.codex', 'sessions', '2026', '08', '21');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, 'rollout-unknown-fold.jsonl'),
    [
      '{"type":"session_meta","payload":{"id":"fold-session","cwd":"/Users/dev/alipay-service"}}',
      '{"timestamp":"2026-08-21T02:26:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"output_tokens":5,"total_tokens":25}}}}',
      '{"type":"turn_context","payload":{"model":"deepseek-v4-flash"}}',
      '{"timestamp":"2026-08-21T02:26:30.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":30,"output_tokens":10,"total_tokens":40}}}}',
    ].join('\n'),
    'utf8',
  );

  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempHome, '.codex');

  try {
    const { result } = await parseCodexIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0]?.model, 'deepseek-v4-flash');
    assert.equal(result.buckets[0]?.input_tokens, 50);
    assert.equal(result.buckets[0]?.output_tokens, 15);
    assert.equal(result.buckets[0]?.total_tokens, 65);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});
