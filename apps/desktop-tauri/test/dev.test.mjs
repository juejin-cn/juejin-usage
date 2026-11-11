import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDevInput, needsTauriRestart } from '../scripts/dev.mjs';

test('watch inputs include shared sources and exclude generated outputs', () => {
  for (const path of ['packages/dashboard/src/page.tsx', 'packages/core/src/config.ts', 'apps/desktop-tauri/src/host/index.ts', 'apps/desktop-tauri/src-tauri/src/main.rs', 'apps/desktop-tauri/src-tauri/tauri.conf.json', 'apps/desktop/src/shared/desktop-pet-layout.ts', 'apps/desktop/src/renderer/pet.css', 'apps/desktop/src/renderer/pets.ts', 'apps/desktop/src/renderer/assets/pets/hawking.webp', 'pnpm-lock.yaml']) assert.ok(isDevInput(path), path);
  for (const path of ['packages/dashboard/src/routeTree.gen.ts', 'packages/core/dist/index.js', 'apps/desktop-tauri/src-tauri/node-app/runtime.json', 'apps/desktop-tauri/src-tauri/target/debug/app', 'apps/desktop-tauri/src-tauri/binaries/jusage-node', 'apps/desktop-tauri/src-tauri/icons/icon.png', 'apps/desktop-tauri/node_modules/a/package.json']) assert.ok(!isDevInput(path), path);
});

test('dashboard changes use Vite HMR while native inputs restart Tauri', () => {
  assert.equal(needsTauriRestart('packages/dashboard/src/page.tsx', true), false);
  assert.equal(needsTauriRestart('packages/dashboard/public/logo.svg', true), false);
  assert.equal(needsTauriRestart('apps/desktop-tauri/src-tauri/src/main.rs', true), true);
  assert.equal(needsTauriRestart('packages/dashboard/src/page.tsx', false), true);
});

test('staged pet numeric modules restart Tauri even when dashboard HMR is enabled', () => {
  for (const path of [
    'packages/dashboard/src/pet/number-renderer.tsx',
    'packages/dashboard/src/components/AnimatedNumber.tsx',
    'packages/dashboard/src/hooks/useAnimatedNumber.ts',
    'packages/dashboard/src/lib/format.ts',
  ]) {
    assert.ok(isDevInput(path), path);
    assert.ok(needsTauriRestart(path, true), path);
  }
  assert.equal(needsTauriRestart('packages/dashboard/src/components/AIGatewayCard.tsx', true), false);
});

test('dev survives build failure, debounces edits, ignores outputs and stops its child', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jusage-dev-'));
  const app = join(root, 'apps/desktop-tauri');
  await mkdir(join(app, 'scripts'), { recursive: true });
  await mkdir(join(app, 'src'), { recursive: true });
  await mkdir(join(app, 'dist'), { recursive: true });
  await copyFile(new URL('../scripts/dev.mjs', import.meta.url), join(app, 'scripts/dev.mjs'));
  await copyFile(new URL('../scripts/dev-signing.mjs', import.meta.url), join(app, 'scripts/dev-signing.mjs'));
  const fake = join(root, 'pnpm.mjs');
  await writeFile(fake, `import { existsSync, writeFileSync } from 'node:fs';
    console.log('CHILD_START');
    if (!existsSync('first-run')) { writeFileSync('first-run', ''); process.exit(1); }
    const stop = () => { console.log('CHILD_STOP'); process.exit(0); };
    process.on('SIGTERM', stop);
    process.stdin.resume(); process.stdin.on('end', stop);
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [join(app, 'scripts/dev.mjs')], { env: { ...process.env, npm_execpath: fake, TUD_DEV_SIGNING_IDENTITY: '-' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.on('error', () => {}); // keep a dead child from masking the real failure
  // 'close' waits for stdout to drain; 'exit' can fire before the last CHILD_STOP is read.
  const exited = new Promise(resolve => child.once('close', resolve));
  async function until(predicate) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(50); }
    assert.fail(output);
  }
  const starts = () => output.match(/CHILD_START/g)?.length ?? 0;
  try {
    await until(() => output.includes('Waiting for source changes'));
    await writeFile(join(app, 'src/probe.ts'), 'one');
    await writeFile(join(app, 'src/probe.ts'), 'two');
    await until(() => starts() === 2);
    await writeFile(join(app, 'dist/probe.js'), 'generated');
    await delay(800);
    assert.equal(starts(), 2, output);
    await writeFile(join(app, 'src/probe.ts'), 'three');
    await until(() => starts() === 3);
    assert.ok(output.includes('CHILD_STOP'), output);
    child.stdin.end(); // SIGTERM is TerminateProcess on Windows; stdin EOF reaches every platform
    assert.equal(await exited, 0, output);
    assert.equal(output.match(/CHILD_STOP/g)?.length, 2, output);
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});

test('one-shot dev exits with the application instead of waiting for edits', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jusage-dev-once-'));
  const app = join(root, 'apps/desktop-tauri'); await mkdir(join(app, 'scripts'), { recursive: true });
  await copyFile(new URL('../scripts/dev.mjs', import.meta.url), join(app, 'scripts/dev.mjs'));
  await copyFile(new URL('../scripts/dev-signing.mjs', import.meta.url), join(app, 'scripts/dev-signing.mjs'));
  const fake = join(root, 'pnpm.mjs'); await writeFile(fake, "console.log('ONE_SHOT_APP'); process.exit(0);");
  const child = spawn(process.execPath, [join(app, 'scripts/dev.mjs'), '--once'], { env: { ...process.env, npm_execpath: fake, TUD_DEV_SIGNING_IDENTITY: '-' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 0, output); assert.ok(output.includes('ONE_SHOT_APP'), output);
    assert.equal(output.includes('Waiting for source changes'), false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    child.stdin.end(); await rm(root, { recursive: true, force: true });
  }
});


test('HMR startup waits for staged sidecar resources even when Vite is already listening', async () => {
  const base = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const dev = JSON.parse(await readFile(new URL('../src-tauri/tauri.dev.conf.json', import.meta.url), 'utf8'));
  const hook = { ...base.build, ...dev.build }.beforeDevCommand;
  assert.equal(typeof hook, 'object', 'a string hook defaults to asynchronous execution');
  assert.equal(hook.wait, true, 'the sidecar must not start against files from a previous branch');
  assert.equal(hook.script, 'pnpm prepare:app');
});
