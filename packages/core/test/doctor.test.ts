import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { runDoctorDiagnostics } from '../src/doctor.js';
import type { TudConfig } from '../src/types.js';

test('runDoctorDiagnostics returns structured diagnostic report', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'jusage-doctor-test-'));
  const mockConfig: TudConfig = {
    deviceId: 'test-device-uuid',
    hostname: 'test-host',
    dataDir: tempDir,
    statsSince: '2026-01-01T00:00:00.000Z',
    juejin: {
      enabled: false,
      apiUrl: 'https://juejin.cn',
      authMode: 'manual',
      token: null,
    },
  };

  const report = await runDoctorDiagnostics({
    dataDir: tempDir,
    config: mockConfig,
    port: 65432,
    skipNetworkProbe: true,
  });

  assert.ok(report.timestamp);
  assert.equal(report.categories.length, 4);

  const runtimeCat = report.categories.find((c) => c.id === 'runtime');
  assert.ok(runtimeCat);
  const nodeItem = runtimeCat.items.find((i) => i.id === 'runtime-node');
  assert.ok(nodeItem);
  assert.equal(nodeItem.status, 'ok');

  const storageCat = report.categories.find((c) => c.id === 'storage');
  assert.ok(storageCat);
  const dataDirItem = storageCat.items.find((i) => i.id === 'storage-datadir');
  assert.ok(dataDirItem);
  assert.equal(dataDirItem.status, 'ok');

  const collectorsCat = report.categories.find((c) => c.id === 'collectors');
  assert.ok(collectorsCat);
  assert.ok(report.collectors.total > 0);

  const networkCat = report.categories.find((c) => c.id === 'network');
  assert.ok(networkCat);

  assert.ok(report.summary.okCount > 0);
  assert.equal(typeof report.summary.errorCount, 'number');
  assert.equal(typeof report.summary.warnCount, 'number');
});

test('runDoctorDiagnostics detects stale tud.pid lock', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'jusage-doctor-pid-test-'));
  // Write a non-existent PID (e.g. 9999999)
  const deadPid = 9999999;
  await writeFile(
    join(tempDir, 'tud.pid'),
    JSON.stringify({ pid: deadPid, kind: 'cli' }),
  );

  const mockConfig: TudConfig = {
    deviceId: 'test-device-uuid',
    hostname: 'test-host',
    dataDir: tempDir,
    statsSince: '2026-01-01T00:00:00.000Z',
    juejin: {
      enabled: false,
      apiUrl: 'https://juejin.cn',
      authMode: 'manual',
      token: null,
    },
  };

  const report = await runDoctorDiagnostics({
    dataDir: tempDir,
    config: mockConfig,
    skipNetworkProbe: true,
  });

  const runtimeCat = report.categories.find((c) => c.id === 'runtime');
  assert.ok(runtimeCat);
  const pidItem = runtimeCat.items.find((i) => i.id === 'runtime-pid');
  assert.ok(pidItem);
  assert.equal(pidItem.status, 'warn');
  assert.match(pidItem.message, /失效的锁文件/);
  assert.ok(report.summary.suggestions.some((s) => s.includes('rm')));
});
