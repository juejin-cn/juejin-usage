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
