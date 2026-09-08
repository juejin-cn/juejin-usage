import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { aggregateLocalMetrics } from '../src/local-metrics.js';
import { parseClaudeIncremental } from '../src/parsers/claude.js';
import { parseCodexIncremental } from '../src/parsers/codex.js';
import { parseOpencodeIncremental } from '../src/parsers/opencode.js';
import { parseCursorCsv, recordsToBuckets } from '../src/parsers/cursor.js';
import { resetJsonlWalkCache } from '../src/parsers/shared.js';
import { syncAll } from '../src/sync/index.js';
import { clearCursors, loadRecentBuckets } from '../src/queue/index.js';
import { loadConfig } from '../src/config.js';
import type { CursorsFile } from '../src/types.js';

async function pikaHome(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pika-requests-'));
  const overrides = {
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: join(dir, '.codex'),
    CLAUDE_CONFIG_DIR: join(dir, '.claude'),
    OPENCODE_HOME: join(dir, 'opencode'),
  };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, overrides);
  resetJsonlWalkCache();
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetJsonlWalkCache();
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const pikaSince = '2020-01-01T00:00:00.000Z';
const pikaTimestamp = new Date().toISOString();
function pikaClaude(id: string | undefined, output = 20) {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: pikaTimestamp,
      message: {
        id,
        model: 'pika-model',
        usage: {
          input_tokens: 100,
          output_tokens: output,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 300,
        },
      },
    }) + '\n'
  );
}

test('pika Claude streaming, restart and truncation preserve one request per identity', async (t) => {
  const dir = await pikaHome(t);
  const folder = join(dir, '.claude/projects/pika-project');
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'pika-session.jsonl');
  await writeFile(
    file,
    pikaClaude('pika-one') +
      pikaClaude('pika-one', 40) +
      pikaClaude('pika-two', 40),
  );
  let cursors: CursorsFile = {};
  const first = await parseClaudeIncremental(cursors, pikaSince);
  assert.equal(aggregateLocalMetrics(first.result.buckets).requestCount, 2);
  assert.equal(aggregateLocalMetrics(first.result.buckets).outputTokens, 80);
  cursors = JSON.parse(JSON.stringify(cursors)) as CursorsFile;
  await appendFile(file, pikaClaude('pika-one', 60));
  const stream = await parseClaudeIncremental(cursors, pikaSince);
  assert.equal(aggregateLocalMetrics(stream.result.buckets).requestCount, 0);
  assert.equal(aggregateLocalMetrics(stream.result.buckets).outputTokens, 20);
  await writeFile(file, pikaClaude('pika-one', 40));
  assert.equal(
    (await parseClaudeIncremental(cursors, pikaSince)).result.eventsParsed,
    0,
  );
  await appendFile(file, pikaClaude('pika-one', 60));
  assert.equal(
    (await parseClaudeIncremental(cursors, pikaSince)).result.eventsParsed,
    0,
  );
  await appendFile(file, pikaClaude(undefined));
  assert.equal(
    aggregateLocalMetrics(
      (await parseClaudeIncremental(cursors, pikaSince)).result.buckets,
    ).requestCount,
    null,
  );
});

test('pika Codex duplicate cumulative notifications differ from equal-size real calls', async (t) => {
  const dir = await pikaHome(t);
  const folder = join(dir, '.codex/sessions');
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'pika-rollout.jsonl');
  const pikaEvent = (total: number, withLast = true, model = 'pika-model') =>
    JSON.stringify({
      type: 'event_msg',
      timestamp: pikaTimestamp,
      payload: {
        type: 'token_count',
        info: {
          model,
          total_token_usage: {
            input_tokens: total,
            output_tokens: 0,
            cached_input_tokens: 0,
          },
          ...(withLast
            ? {
                last_token_usage: {
                  input_tokens: 100,
                  output_tokens: 0,
                  cached_input_tokens: 0,
                },
              }
            : {}),
        },
      },
    }) + '\n';
  const meta =
    JSON.stringify({ type: 'session_meta', payload: { id: 'pika-session' } }) +
    '\n';
  await writeFile(
    file,
    meta + pikaEvent(100) + pikaEvent(100) + pikaEvent(200),
  );
  let cursors: CursorsFile = {};
  const first = await parseCodexIncremental(cursors, pikaSince);
  assert.equal(aggregateLocalMetrics(first.result.buckets).requestCount, 2);
  assert.equal(
    aggregateLocalMetrics(first.result.buckets).uncachedInputTokens,
    200,
  );
  cursors = JSON.parse(JSON.stringify(cursors)) as CursorsFile;
  await appendFile(file, pikaEvent(200));
  assert.equal(
    (await parseCodexIncremental(cursors, pikaSince)).result.eventsParsed,
    0,
  );
  await appendFile(file, pikaEvent(300, false));
  assert.equal(
    aggregateLocalMetrics(
      (await parseCodexIncremental(cursors, pikaSince)).result.buckets,
    ).requestCount,
    null,
  );
  await writeFile(file, meta + pikaEvent(100));
  assert.equal(
    (await parseCodexIncremental(cursors, pikaSince)).result.eventsParsed,
    0,
  );
});

test('pika OpenCode message edits count once and independent identical CSV rows count twice', async (t) => {
  const dir = await pikaHome(t);
  const folder = join(dir, 'opencode/storage/message/pika-session');
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'pika-message.json');
  const pikaWrite = (output: number) =>
    writeFile(
      file,
      JSON.stringify({
        id: 'pika-message',
        sessionID: 'pika-session',
        role: 'assistant',
        modelID: 'pika-model',
        time: { created: Date.now() },
        tokens: {
          input: 10,
          output,
          reasoning: 0,
          cache: { read: 60, write: 30 },
        },
      }),
    );
  const cursors: CursorsFile = {};
  await pikaWrite(2);
  assert.equal(
    aggregateLocalMetrics(
      (await parseOpencodeIncremental(cursors, pikaSince)).result.buckets,
    ).requestCount,
    1,
  );
  await pikaWrite(4);
  const update = aggregateLocalMetrics(
    (await parseOpencodeIncremental(cursors, pikaSince)).result.buckets,
  );
  assert.equal(update.requestCount, 0);
  assert.equal(update.outputTokens, 2);
  assert.equal(
    (await parseOpencodeIncremental(cursors, pikaSince)).result.eventsParsed,
    0,
  );
  const csv =
    'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost\n';
  const row = `${pikaTimestamp},pika-model,40,10,60,2,102,0\n`;
  const buckets = recordsToBuckets(parseCursorCsv(csv + row + row), pikaSince);
  const metrics = aggregateLocalMetrics(buckets);
  assert.equal(metrics.requestCount, 2);
  assert.equal(metrics.cacheHitRate, 0.6);
  assert.deepEqual(
    recordsToBuckets(parseCursorCsv(csv + row + row), pikaSince),
    buckets,
  );
});

test('pika range rescans replace request totals and subsequent incremental sync adds once', async (t) => {
  const dir = await pikaHome(t);
  const folder = join(dir, '.claude/projects/pika-project');
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'pika-session.jsonl');
  await writeFile(file, pikaClaude('pika-one'));
  const dataDir = join(dir, 'pika-data');
  const { config } = await loadConfig(dataDir);
  config.statsSince = pikaSince;
  config.localCollectSince = pikaSince;
  await syncAll(dataDir, config, 'claude');
  const pikaRead = async () =>
    aggregateLocalMetrics(await loadRecentBuckets(dataDir, pikaSince));
  assert.equal((await pikaRead()).requestCount, 1);
  await clearCursors(dataDir);
  await syncAll(dataDir, config, 'claude');
  assert.equal((await pikaRead()).requestCount, 1);
  await appendFile(file, pikaClaude('pika-two'));
  await syncAll(dataDir, config, 'claude');
  assert.equal((await pikaRead()).requestCount, 2);
  await syncAll(dataDir, config, 'claude');
  assert.equal((await pikaRead()).requestCount, 2);
});
