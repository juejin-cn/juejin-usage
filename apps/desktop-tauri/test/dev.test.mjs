import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDevInput } from '../scripts/dev.mjs';

test('watch inputs include shared sources and exclude generated outputs', () => {
  for (const path of ['packages/dashboard/src/page.tsx', 'packages/core/src/config.ts', 'apps/desktop-tauri/src/host/index.ts', 'apps/desktop-tauri/src-tauri/src/main.rs', 'apps/desktop-tauri/src-tauri/tauri.conf.json', 'apps/desktop/src/shared/desktop-pet-layout.ts', 'pnpm-lock.yaml']) assert.ok(isDevInput(path), path);
  for (const path of ['packages/dashboard/src/routeTree.gen.ts', 'packages/core/dist/index.js', 'apps/desktop-tauri/src-tauri/node-app/runtime.json', 'apps/desktop-tauri/src-tauri/target/debug/app', 'apps/desktop-tauri/src-tauri/binaries/jusage-node', 'apps/desktop-tauri/src-tauri/icons/icon.png', 'apps/desktop-tauri/node_modules/a/package.json']) assert.ok(!isDevInput(path), path);
});

test('dev survives build failure, debounces edits, ignores outputs and stops its child', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jusage-dev-'));
  const app = join(root, 'apps/desktop-tauri');
  await mkdir(join(app, 'scripts'), { recursive: true });
  await mkdir(join(app, 'src'), { recursive: true });
  await mkdir(join(app, 'dist'), { recursive: true });
  await copyFile(new URL('../scripts/dev.mjs', import.meta.url), join(app, 'scripts/dev.mjs'));
  const fake = join(root, 'pnpm.mjs');
  await writeFile(fake, `import { existsSync, writeFileSync } from 'node:fs';
    console.log('CHILD_START');
    if (!existsSync('first-run')) { writeFileSync('first-run', ''); process.exit(1); }
    const stop = () => { console.log('CHILD_STOP'); process.exit(0); };
    process.on('SIGTERM', stop);
    process.stdin.resume(); process.stdin.on('end', stop);
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [join(app, 'scripts/dev.mjs')], { env: { ...process.env, npm_execpath: fake }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.on('error', () => {}); // keep a dead child from masking the real failure
  const exited = new Promise(resolve => child.once('exit', resolve));
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
