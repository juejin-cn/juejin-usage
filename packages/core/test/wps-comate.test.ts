import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  findWpsComateSessionFiles,
  parseWpsComateIncremental,
  wpsComateModelName,
} from '../src/parsers/wps-comate.js';
import { isolateAgentHome } from './platform-fixtures.js';
import type { CursorsFile } from '../src/types.js';

const SINCE = '2020-01-01T00:00:00.000Z';

interface SeedEntry {
  id: string;
  type: string;
  timestamp?: string;
  message?: {
    role: string;
    model?: string;
    responseModel?: string;
    timestamp?: string;
    usage?: Record<string, number>;
  };
  cwd?: string;
}

function sessionEntry(cwd: string): SeedEntry {
  return { id: 'session-1', type: 'session', cwd };
}

function assistantEntry(overrides: Partial<SeedEntry> = {}): SeedEntry {
  return {
    id: 'msg-1',
    type: 'message',
    timestamp: '2026-06-09T20:46:30.000Z',
    message: {
      role: 'assistant',
      model: '670468124/zhipu/glm-5.3//public',
      responseModel: 'glm-5.3',
      timestamp: '2026-06-09T20:46:30.000Z',
      usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, reasoning: 0 },
    },
    ...overrides,
  };
}

async function seedSessionFile(
  home: string,
  fileName: string,
  entries: SeedEntry[],
): Promise<string> {
  const dir = join(home, '.wpscomate', 'agent', 'task-sessions');
  await mkdir(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e));
  const filePath = join(dir, fileName);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

test('wpsComateModelName prefers the responseModel short name', () => {
  assert.equal(
    wpsComateModelName('glm-5.3', '670468124/zhipu/glm-5.3//public'),
    'glm-5.3',
  );
});

test('wpsComateModelName extracts the model segment from a qualified id', () => {
  assert.equal(wpsComateModelName(undefined, '670468124/zhipu/glm-5.3//public'), 'glm-5.3');
});

test('wpsComateModelName falls back to the raw qualified value', () => {
  assert.equal(wpsComateModelName(undefined, 'glm-5.3'), 'glm-5.3');
});

test('wpsComateModelName returns a placeholder when both are missing', () => {
  assert.equal(wpsComateModelName(undefined, undefined), 'wps-comate-unknown');
});

test('parseWpsComateIncremental collects assistant usage with project attribution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    await seedSessionFile(home, 'session-a.jsonl', [
      sessionEntry('/Users/dev/my-app'),
      assistantEntry(),
    ]);

    const cursors: CursorsFile = {};
    const { result } = await parseWpsComateIncremental(cursors, SINCE);

    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets.length, 1);
    const bucket = result.buckets[0]!;
    assert.equal(bucket.source, 'wps-comate');
    assert.equal(bucket.model, 'glm-5.3');
    assert.equal(bucket.project, 'my-app');
    assert.equal(bucket.input_tokens, 100);
    assert.equal(bucket.output_tokens, 20);
    assert.equal(bucket.cached_input_tokens, 10);
    assert.equal(bucket.cache_creation_input_tokens, 5);
    assert.equal(bucket.total_tokens, 135);
    assert.equal(bucket.hour_start, '2026-06-09T20:30:00.000Z');
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('parseWpsComateIncremental is incremental across runs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    await seedSessionFile(home, 'session-a.jsonl', [
      sessionEntry('/Users/dev/my-app'),
      assistantEntry(),
    ]);

    const cursors: CursorsFile = {};
    const first = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 1);

    const second = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(second.result.eventsParsed, 0);
    assert.equal(second.result.buckets.length, 0);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('parseWpsComateIncremental counts appended entries in the same file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    const filePath = await seedSessionFile(home, 'session-a.jsonl', [
      sessionEntry('/Users/dev/my-app'),
      assistantEntry(),
    ]);

    const cursors: CursorsFile = {};
    await parseWpsComateIncremental(cursors, SINCE);

    const appended: SeedEntry = {
      id: 'msg-2',
      type: 'message',
      timestamp: '2026-06-09T21:10:00.000Z',
      message: {
        role: 'assistant',
        model: '670468124/zhipu/glm-5.3//public',
        responseModel: 'glm-5.3',
        timestamp: '2026-06-09T21:10:00.000Z',
        usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      },
    };
    assert.ok((await readFile(filePath, 'utf8')).length > 0);
    await appendFile(filePath, `${JSON.stringify(appended)}\n`, 'utf8');

    const second = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets[0]!.input_tokens, 50);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('parseWpsComateIncremental ignores user messages and usage-less entries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    await seedSessionFile(home, 'session-a.jsonl', [
      sessionEntry('/Users/dev/my-app'),
      {
        id: 'user-1',
        type: 'message',
        timestamp: '2026-06-09T20:46:00.000Z',
        message: { role: 'user' },
      },
      {
        id: 'assistant-no-usage',
        type: 'message',
        timestamp: '2026-06-09T20:46:10.000Z',
        message: { role: 'assistant' },
      },
      {
        id: 'assistant-zero',
        type: 'message',
        timestamp: '2026-06-09T20:46:20.000Z',
        message: {
          role: 'assistant',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        },
      },
    ]);

    const cursors: CursorsFile = {};
    const { result } = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(result.eventsParsed, 0);
    assert.equal(result.buckets.length, 0);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('parseWpsComateIncremental skips entries older than statsSince', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    await seedSessionFile(home, 'session-a.jsonl', [
      sessionEntry('/Users/dev/my-app'),
      assistantEntry(), // 2026-06-09
    ]);

    const cursors: CursorsFile = {};
    const { result } = await parseWpsComateIncremental(
      cursors,
      '2026-06-10T00:00:00.000Z',
    );
    assert.equal(result.eventsParsed, 0);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('parseWpsComateIncremental falls back to the qualified model segment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    await seedSessionFile(home, 'session-a.jsonl', [
      sessionEntry('/Users/dev/my-app'),
      {
        ...assistantEntry(),
        message: { ...assistantEntry().message!, responseModel: undefined },
      },
    ]);

    const cursors: CursorsFile = {};
    const { result } = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(result.buckets[0]!.model, 'glm-5.3');
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('parseWpsComateIncremental handles truncated files without double counting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    await seedSessionFile(home, 'session-a.jsonl', [
      sessionEntry('/Users/dev/my-app'),
      assistantEntry(),
    ]);

    const cursors: CursorsFile = {};
    const first = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 1);

    // Simulate log rotation: rewrite the file shorter (same path).
    await seedSessionFile(home, 'session-a.jsonl', [sessionEntry('/Users/dev/my-app')]);

    const second = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(second.result.eventsParsed, 0);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('parseWpsComateIncremental respects the WPS_COMATE_HOME override', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    assert.equal(findWpsComateSessionFiles().length, 0);

    await seedSessionFile(home, 'session-a.jsonl', [
      sessionEntry('/Users/dev/my-app'),
      assistantEntry(),
    ]);
    assert.equal(findWpsComateSessionFiles().length, 1);

    const cursors: CursorsFile = {};
    const { result } = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(result.eventsParsed, 1);
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

test('parseWpsComateIncremental attributes unknown project when the header is missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wps-comate-'));
  const restore = isolateAgentHome(home);
  try {
    await seedSessionFile(home, 'session-a.jsonl', [assistantEntry()]);

    const cursors: CursorsFile = {};
    const { result } = await parseWpsComateIncremental(cursors, SINCE);
    assert.equal(result.buckets[0]!.project, 'unknown');
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});
