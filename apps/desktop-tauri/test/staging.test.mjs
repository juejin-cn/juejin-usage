import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyRuntimePackage, desktopNodeVersion, validateNodeRuntime } from '../scripts/stage-node-app.mjs';

test('staging preserves each consumer dependency version without workspace symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'jusage-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function pkg(path, name, version, dependencies = {}) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, main: 'index.js', dependencies }));
    writeFileSync(join(path, 'index.js'), 'module.exports = 1;');
  }
  pkg(root, 'app', '1');
  const source = join(root, 'node_modules/consumer');
  pkg(source, 'consumer', '1', { common: '1', nested: '1' });
  pkg(join(source, 'node_modules/common'), 'common', '1');
  pkg(join(source, 'node_modules/nested'), 'nested', '1', { common: '2' });
  pkg(join(source, 'node_modules/nested/node_modules/common'), 'common', '2');
  const output = join(root, 'out/consumer');
  copyRuntimePackage('consumer', root, output);
  const version = path => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version;
  assert.equal(version(join(output, 'node_modules/common')), '1');
  assert.equal(version(join(output, 'node_modules/nested/node_modules/common')), '2');
  rmSync(join(root, 'node_modules'), { recursive: true });
  assert.ok(existsSync(join(output, 'node_modules/common/index.js')));
});

test('staging requires the Electron-aligned Node version and matching native host', () => {
  const runtime = { version: desktopNodeVersion, platform: 'darwin', arch: 'arm64' };
  assert.doesNotThrow(() => validateNodeRuntime(runtime, 'darwin', 'arm64'));
  assert.throws(() => validateNodeRuntime({ ...runtime, version: '26.1.0' }, 'darwin', 'arm64'), /Electron parity/);
  assert.throws(() => validateNodeRuntime({ ...runtime, version: '22.16.0' }, 'darwin', 'arm64'), /Electron parity/);
  assert.throws(() => validateNodeRuntime(runtime, 'darwin', 'x64'), /matching binary/);
  assert.throws(() => validateNodeRuntime(runtime, 'win32', 'arm64'), /matching binary/);
});
