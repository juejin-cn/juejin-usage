import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyRuntimePackage, copyHostRuntime, desktopNodeVersion, validateNodeRuntime } from '../scripts/stage-node-app.mjs';

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

test('host staging excludes the embedded UI and stale build outputs but keeps host imports', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jusage-host-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist/host'), { recursive: true });
  mkdirSync(join(root, 'dist/ui/assets'), { recursive: true });
  writeFileSync(join(root, 'dist/host/index.js'), 'export { value } from "./runtime.js";');
  writeFileSync(join(root, 'dist/host/runtime.js'), 'export const value = 42;');
  writeFileSync(join(root, 'dist/host/index.d.ts'), 'export declare const value: number;');
  writeFileSync(join(root, 'dist/ui/assets/app.js'), 'unexpected duplicate UI');
  writeFileSync(join(root, 'dist/stale.js'), 'stale build output');
  const out = join(root, 'out');
  copyHostRuntime(root, out);
  writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }));
  const { pathToFileURL } = await import('node:url');
  assert.equal((await import(pathToFileURL(join(out, 'dist/host/index.js')).href)).value, 42);
  assert.equal(existsSync(join(out, 'dist/ui')), false);
  assert.equal(existsSync(join(out, 'dist/stale.js')), false);
  assert.equal(existsSync(join(out, 'dist/host/index.d.ts')), false);
});

test('runtime pruning keeps Node entry points, CJS dependencies, JSON and licenses', t => {
  const root = mkdtempSync(join(tmpdir(), 'jusage-prune-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{}');
  for (const name of ['hono', 'yaml', 'commonjs-runtime']) {
    const source = join(root, 'node_modules', name);
    for (const file of ['index.js', 'index.d.ts', 'index.js.map', 'LICENSE', 'dist/cjs/index.js', 'dist/index.js', 'dist/types/index.d.ts', 'browser/index.js', 'data.json']) {
      mkdirSync(join(source, file, '..'), { recursive: true });
      writeFileSync(join(source, file), 'fixture');
    }
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    const out = join(root, 'out', name);
    copyRuntimePackage(name, root, out);
    for (const file of ['index.js', 'dist/index.js', 'package.json', 'LICENSE', 'data.json']) assert.ok(existsSync(join(out, file)));
    assert.equal(existsSync(join(out, 'index.d.ts')), false);
    assert.equal(existsSync(join(out, 'index.js.map')), false);
    assert.equal(existsSync(join(out, 'dist/cjs/index.js')), name !== 'hono');
    assert.equal(existsSync(join(out, 'browser/index.js')), name !== 'yaml');
  }
});
