import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { measureCpuPhase } from '../src/debug-log.js';

test('measureCpuPhase writes cpu_phase with wall and cpu ms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-cpu-phase-'));
  const logPath = join(dir, 'logs', 'sync.log');
  try {
    await measureCpuPhase(logPath, 'busy', { source: 'test' }, async () => {
      const end = Date.now() + 25;
      let n = 0;
      while (Date.now() < end) n += Math.sqrt(n + 1);
      return n;
    });
    const raw = await readFile(logPath, 'utf8');
    const entry = JSON.parse(raw.trim().split('\n').at(-1)!);
    assert.equal(entry.event, 'cpu_phase');
    assert.equal(entry.phase, 'busy');
    assert.equal(entry.source, 'test');
    assert.ok(entry.wallMs >= 2);
    assert.equal(typeof entry.cpuMs, 'number');
    assert.equal(typeof entry.pid, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('memory profiling records before/after/delta even when the phase throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-memory-phase-'));
  const logPath = join(dir, 'sync.log');
  const previous = process.env.TUD_PROFILE_MEMORY;
  process.env.TUD_PROFILE_MEMORY = '1';
  try {
    await assert.rejects(measureCpuPhase(logPath, 'failure', {}, async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error('phase failed');
    }), /phase failed/);
    const entry = JSON.parse((await readFile(logPath, 'utf8')).trim());
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) {
      assert.equal(typeof entry.memoryBefore[key], 'number');
      assert.equal(entry.memoryDelta[key], entry.memoryAfter[key] - entry.memoryBefore[key]);
    }
  } finally {
    if (previous === undefined) delete process.env.TUD_PROFILE_MEMORY;
    else process.env.TUD_PROFILE_MEMORY = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
