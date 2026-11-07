import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ToolDetector, executableDirectories, isExecutable } from '../src/agent-router/integrations/detection.js';
import type { IntegrationEnvironment } from '../src/agent-router/integrations/adapters.js';

async function fixture(t: any) {
  const home = await mkdtemp(join(tmpdir(), 'tool-detection-')); t.after(() => rm(home, { recursive: true, force: true }));
  const env: IntegrationEnvironment = { home, platform: 'darwin', env: { PATH: '' }, dataDir: join(home, 'data') };
  const put = async (path: string, value: string, mode = 0o644) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value, { mode }); };
  return { home, env, put };
}

test('leftover CLI config files and directories do not prove installation', async t => {
  const f = await fixture(t); const detector = new ToolDetector(f.env);
  for (const relative of ['.claude/settings.json', '.codex/config.toml', '.config/opencode/opencode.json', '.pi/agent/models.json', '.minimax/config.yaml']) await f.put(join(f.home, relative), '{}');
  for (const id of ['claude', 'codex', 'opencode', 'pi', 'minimax-code'] as const) assert.equal(await detector.detect(id), null, id);
});

test('CLI discovery checks file type and execute permission, follows valid shims, and never invokes tools', async t => {
  const f = await fixture(t); const bin = join(f.home, '.local', 'bin'); const binary = join(bin, 'claude');
  await f.put(binary, '#!/bin/sh\ntouch "' + join(f.home, 'should-not-exist') + '"\n');
  const detector = new ToolDetector(f.env); assert.equal(await detector.detect('claude'), null);
  await chmod(binary, 0o755); assert.deepEqual(await detector.detect('claude'), { kind: 'cli', path: binary });
  await assert.rejects(stat(join(f.home, 'should-not-exist')), { code: 'ENOENT' });
  await rm(binary); await mkdir(binary); assert.equal(await detector.detect('claude'), null);
  await rm(binary, { recursive: true }); await symlink(join(f.home, 'missing'), binary); assert.equal(await detector.detect('claude'), null);
  await rm(binary); const target = join(f.home, 'target'); await f.put(target, '#!/bin/sh\nexit 0\n', 0o755); await symlink(target, binary);
  assert.equal((await detector.detect('claude'))?.path, binary);
  await rm(target); assert.equal(await detector.detect('claude'), null);
});

test('login-shell PATH is lazy, shared between missing CLIs, and invalidated by refresh', async t => {
  const f = await fixture(t); const shellBin = join(f.home, 'node-manager', 'bin');
  await f.put(join(f.home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', 0o755);
  await f.put(join(shellBin, 'pi'), '#!/bin/sh\nexit 0\n', 0o755);
  let calls = 0; const detector = new ToolDetector(f.env, async () => { calls++; return shellBin; });
  assert.ok(await detector.detect('claude')); assert.equal(calls, 0);
  assert.equal((await detector.detect('pi'))?.path, join(shellBin, 'pi')); assert.equal(calls, 1);
  assert.equal(await detector.detect('opencode'), null); assert.equal(calls, 1);
  await rm(join(shellBin, 'pi')); assert.equal(await detector.detect('pi'), null);
  await f.put(join(shellBin, 'codex'), '#!/bin/sh\nexit 0\n', 0o755); detector.reset();
  assert.equal((await detector.detect('codex'))?.path, join(shellBin, 'codex')); assert.equal(calls, 2);
});

test('a failing shell lookup does not turn discovery failures into installed tools', async t => {
  const f = await fixture(t); const detector = new ToolDetector(f.env, async () => { throw new Error('shell unavailable'); });
  assert.equal(await detector.detect('pi'), null);
});

test('npm, pnpm, native installers and GUI-launched paths can all supply tools', async t => {
  const f = await fixture(t); f.env.env.PNPM_HOME = join(f.home, 'pnpm'); f.env.env.npm_config_prefix = join(f.home, 'npm-prefix');
  for (const [id, file] of [
    ['pi', join(f.env.env.PNPM_HOME, 'pi')], ['codex', join(f.env.env.npm_config_prefix, 'bin', 'codex')],
    ['opencode', join(f.home, '.opencode', 'bin', 'opencode')], ['minimax-code', join(f.home, '.minimax-code', 'bin', 'mcode')],
  ] as const) { await f.put(file, '#!/bin/sh\nexit 0\n', 0o755); assert.equal((await new ToolDetector(f.env).detect(id))?.path, file); }
});

test('Windows discovery honors PATHEXT and per-user npm/pnpm directories, and ignores project-relative PATHs', async t => {
  const f = await fixture(t); const cmd = join(f.home, 'tool.CMD'); const data = join(f.home, 'tool.json');
  await f.put(cmd, '@echo off\r\n'); await f.put(data, '{}');
  assert.equal(await isExecutable(cmd, 'win32', '.EXE;.CMD'), true); assert.equal(await isExecutable(data, 'win32', '.EXE;.CMD'), false);
  const dirs = executableDirectories({ home: 'C:\\Users\\Test', platform: 'win32', env: { Path: 'D:\\Tools;.;;"D:\\With Space"', APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local', PNPM_HOME: 'D:\\Pnpm' }, dataDir: 'D:\\App' });
  assert.ok(dirs.includes('D:\\Tools')); assert.ok(dirs.includes('D:\\With Space')); assert.ok(dirs.includes('D:\\Roaming\\npm')); assert.ok(dirs.includes('D:\\Local\\pnpm')); assert.ok(dirs.includes('D:\\Pnpm'));
  assert.ok(!dirs.includes('.') && !dirs.includes(''));
});

test('VS Code extensions need a valid manifest and must not be marked obsolete', async t => {
  const f = await fixture(t); const detector = new ToolDetector(f.env);
  const root = join(f.home, '.vscode', 'extensions'); const name = 'anthropic.claude-code-fixture';
  await mkdir(join(root, name), { recursive: true }); assert.equal(await detector.detect('claude-vscode'), null);
  await f.put(join(root, name, 'package.json'), '{"publisher":"other","name":"claude-code"}'); assert.equal(await detector.detect('claude-vscode'), null);
  await f.put(join(root, name, 'package.json'), '{"publisher":"anthropic","name":"claude-code"}'); assert.equal((await detector.detect('claude-vscode'))?.kind, 'extension');
  await f.put(join(root, '.obsolete'), JSON.stringify({ [name]: true })); assert.equal(await detector.detect('claude-vscode'), null);
});

test('a desktop bundle needs a runnable app entrypoint, not just a settings folder', async t => {
  const f = await fixture(t); const bundle = join(f.home, 'Applications', 'ZCode.app');
  const binary = join(bundle, 'Contents', 'MacOS', 'ZCode');
  await f.put(binary, '#!/bin/sh\nexit 0\n', 0o755);
  assert.deepEqual(await new ToolDetector(f.env).detect('zcode'), { kind: 'app', path: bundle });
});


test('DeepSeek Harness discovers a runnable dsh CLI and ignores leftover config', async t => {
  const f = await fixture(t); f.env.platform = 'linux';
  await f.put(join(f.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), '- id: llm-pi-ai\n');
  const detector = new ToolDetector(f.env);
  assert.equal(await detector.detect('deepseek-harness'), null);
  const cli = join(f.home, '.local', 'bin', 'dsh');
  await f.put(cli, '#!/bin/sh\nexit 0\n', 0o755);
  assert.deepEqual(await detector.detect('deepseek-harness'), { kind: 'cli', path: cli });
  await rm(cli); assert.equal(await detector.detect('deepseek-harness'), null);
});

test('DeepSeek Harness and Claude Desktop are independently detected as desktop apps', async t => {
  const f = await fixture(t);
  for (const [id, name] of [['deepseek-harness', 'DeepSeek Harness'], ['claude-desktop', 'Claude']] as const) {
    const bundle = join(f.home, 'Applications', name + '.app');
    await f.put(join(bundle, 'Contents', 'MacOS', name), '#!/bin/sh\nexit 0\n', 0o755);
    assert.deepEqual(await new ToolDetector(f.env).detect(id), { kind: 'app', path: bundle });
  }
});
