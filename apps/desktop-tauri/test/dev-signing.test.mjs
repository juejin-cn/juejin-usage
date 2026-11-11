import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { developmentSigning, selectDevelopmentIdentity, signDevelopmentBinary } from '../scripts/dev-signing.mjs';

const development = 'D'.repeat(40), distribution = 'A'.repeat(40);
const identities = `1) ${distribution} "Developer ID Application: Example (TEAM1)"\n2) ${development} "Apple Development: Example (TEAM2)"\n3) ${distribution} "Developer ID Application: Example (TEAM1)"`;
test('identity selection prefers a stable local development certificate regardless of keychain enumeration order', () => {
  assert.equal(selectDevelopmentIdentity(identities), development);
  assert.equal(selectDevelopmentIdentity(identities.split('\n').reverse().join('\n')), development);
  assert.equal(selectDevelopmentIdentity('0 valid identities found'), undefined);
});

test('Cargo runner is configured for both Mac architectures and preserves paths containing spaces', () => {
  const source = { KEEP: 'value' };
  const configured = developmentSigning(source, 'darwin', () => identities, '/path with spaces/node', '/project with spaces/dev-signing.mjs');
  assert.equal(source.TUD_DEV_SIGNING_IDENTITY, undefined);
  assert.equal(configured.env.TUD_DEV_SIGNING_IDENTITY, development);
  assert.equal(configured.env.KEEP, 'value');
  assert.equal(configured.args[0], '--');
  for (const index of [2, 4]) {
    assert.deepEqual(JSON.parse(configured.args[index].slice(configured.args[index].indexOf('=') + 1)), ['/path with spaces/node', '/project with spaces/dev-signing.mjs']);
  }
});

test('explicit signing choice, custom runners and non-Mac environments take precedence', () => {
  const noRead = () => { throw new Error('Keychain identity discovery must not run'); };
  assert.deepEqual(developmentSigning({ TUD_DEV_SIGNING_IDENTITY: '-' }, 'darwin', noRead).args, []);
  assert.deepEqual(developmentSigning({}, 'linux', noRead).args, []);
  assert.deepEqual(developmentSigning({}, 'darwin', () => '').args, []);
  const configured = developmentSigning({ TUD_DEV_SIGNING_IDENTITY: 'My Certificate', CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER: 'custom-debugger' }, 'darwin', noRead);
  assert.equal(configured.env.TUD_DEV_SIGNING_IDENTITY, 'My Certificate');
  assert.equal(configured.args.some(a => a.startsWith('target.aarch64-apple-darwin.runner=')), false);
});

test('signing failure stops launch instead of falling back to a new ad-hoc identity', () => {
  let calls = 0;
  assert.throws(() => signDevelopmentBinary('/tmp/app', development, () => { calls++; throw new Error('signing failed'); }), /signing failed/);
  assert.equal(calls, 1);
  assert.throws(() => signDevelopmentBinary('/tmp/app', '-', () => {}), /stable/);
});

test('runner signs and verifies before executing the app, preserving arguments and its exit code', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jusage-dev-signing-')); t.after(() => rm(root, { recursive: true, force: true }));
  const trace = join(root, 'trace');
  await writeFile(join(root, 'codesign'), '#!/usr/bin/env node\n'+`require('node:fs').appendFileSync(process.env.TEST_SIGN_TRACE, process.argv.slice(2).join(' ')+'\\n');`, { mode: 0o755 });
  const binary = join(root, 'sample-app');
  await writeFile(binary, '#!/usr/bin/env node\n'+`const fs=require('node:fs');const trace=fs.readFileSync(process.env.TEST_SIGN_TRACE,'utf8');if(!trace.includes('--sign')||!trace.includes('--verify'))process.exit(99);console.log(JSON.stringify(process.argv.slice(2)));process.exit(17);`, { mode: 0o755 });
  const runner = new URL('../scripts/dev-signing.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [runner.pathname, binary, 'argument with spaces', '--flag'], { encoding: 'utf8', env: { ...process.env, PATH: root + delimiter + process.env.PATH, TEST_SIGN_TRACE: trace, TUD_DEV_SIGNING_IDENTITY: development } });
  assert.equal(result.status, 17, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['argument with spaces', '--flag']);
  const log = await readFile(trace, 'utf8'); assert.match(log, /--identifier com.juejin.jusage.desktop-tauri/);
});
