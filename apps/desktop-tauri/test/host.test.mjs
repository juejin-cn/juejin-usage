import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeUrl = process.env.TUD_TEST_HOST_PATH ? pathToFileURL(resolve(process.env.TUD_TEST_HOST_PATH)).href : new URL('../dist/host/runtime.js', import.meta.url).href;
const fixture = `
import {boot, shutdown} from ${JSON.stringify(runtimeUrl)};
const stop = async (code = 0) => { await shutdown(); process.exit(code); };
process.on('SIGTERM', () => void stop());
process.stdin.resume(); process.stdin.on('end', () => void stop());
boot({dataDir: process.env.TUD_DATA_DIR, sync:false, pricing:false, registerHooks:false, evictAutostart:false}).catch(async error => {console.error(error.message); await stop(1);});
`;
async function start(t, dir, extraEnv = {}) {
  const child = spawn(process.env.TUD_TEST_NODE_BIN || process.execPath, ['--input-type=module', '-e', fixture], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, TUD_DATA_DIR: dir, JUSAGE_CONFIG_HOME: join(dir, 'identity'), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sidecar timeout: ${stderr}`)), 20_000);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      const match = /^PORT=(\d+)$/m.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Sidecar exit ${code}: ${stderr}`)); });
  });
  return { child, ready };
}

test('desktop owner serves the existing local API and releases ownership on EOF', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jusage-tauri-'));
  const { child, ready } = await start(t, dir);
  const port = await ready;
  assert.ok(port > 0 && port !== 8452);
  const origin = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { ok: true });
  const config = await (await fetch(`${origin}/functions/tud-config`)).json();
  assert.equal(config.success, true);
  const saved = await (await fetch(`${origin}/functions/tud-config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ juejin: { enabled: false } }),
  })).json();
  assert.equal(saved.success, true); assert.equal(saved.data.juejin.enabled, false);
  const summary = await (await fetch(`${origin}/functions/tud-account-usage-summary`)).json();
  assert.equal(summary.success, true);
  // Native proxy requests carry no browser Origin; existing subscription
  // protection still rejects a cross-site request before reading credentials.
  const subscription = await fetch(`${origin}/functions/tud-subscription/unknown`);
  assert.equal(subscription.status, 404);
  const forbidden = await fetch(`${origin}/functions/tud-subscription/codex`, {headers:{origin:'https://example.com'}});
  assert.equal(forbidden.status, 403);
  const owner = JSON.parse(await readFile(join(dir, 'tud.pid'), 'utf8'));
  assert.equal(owner.kind, 'desktop'); assert.equal(owner.pid, child.pid);
  // A second client cannot kill the healthy desktop owner.
  const second = await start(t, dir);
  await assert.rejects(second.ready, /已有桌面客户端/);
  assert.equal(JSON.parse(await readFile(join(dir, 'tud.pid'), 'utf8')).pid, child.pid);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  const exited = once(child, 'exit');
  child.stdin.end();
  assert.equal((await exited)[0], 0);
  await assert.rejects(access(join(dir, 'tud.pid')));
});

test('startup failure after claiming owner cleans up the pid file', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jusage-tauri-fail-'));
  // Existing server options reject an out-of-range port after runtime setup.
  const { ready } = await start(t, dir, { TUD_SIDECAR_PORT: '99999' });
  await assert.rejects(ready, /port|range/i);
  await assert.rejects(access(join(dir, 'tud.pid')));
});

test('desktop host takes over a CLI owner without binding the CLI panel port', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jusage-tauri-cli-'));
  const cli = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeRuntimeOwner } from '@juejin-opensource/jusage-core';
    await writeRuntimeOwner({pid:process.pid,kind:'cli'}, process.env.TUD_DATA_DIR);
    process.stdout.write('READY\\n'); process.stdin.resume();
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, TUD_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL'); });
  await once(cli.stdout, 'data');
  const cliExited = once(cli, 'exit');
  const { child, ready } = await start(t, dir);
  const port = await ready;
  await cliExited;
  assert.notEqual(port, 8452);
  const owner = JSON.parse(await readFile(join(dir, 'tud.pid'), 'utf8'));
  assert.equal(owner.kind, 'desktop'); assert.equal(owner.pid, child.pid);
  const heartbeat = JSON.parse(await readFile(join(dir, 'tud.heartbeat'), 'utf8'));
  assert.equal(heartbeat.pid, child.pid); assert.equal(heartbeat.kind, 'desktop');
  const exit = once(child, 'exit'); child.stdin.end();
  assert.equal((await exit)[0], 0);
  await assert.rejects(access(join(dir, 'tud.pid')));
});

test('browser callback persists association and emits a credential-free host event', {timeout:30_000}, async t => {
  const dir=await mkdtemp(join(tmpdir(),'jusage-tauri-login-'));
  const {child,ready}=await start(t,dir,{TUD_HOST_KEY:'integration-native-key'});
  const port=await ready, origin=`http://127.0.0.1:${port}`;
  // Keep the API's automatic post-association upload inside this isolated host.
  await fetch(`${origin}/functions/tud-config`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({juejin:{enabled:false,apiUrl:origin}})});
  let output=''; child.stdout.on('data',data=>{output+=data;});
  const created=await fetch(`${origin}/functions/tud-desktop-login?target=${encodeURIComponent('https://juejin.cn/aiusage/dashboard?login_from_client=desktop')}`,{method:'POST',headers:{'x-tud-host-key':'integration-native-key'}});
  assert.equal(created.status,200);
  const {url}=await created.json();
  const browser=await fetch(url,{redirect:'manual'});
  const cookie=browser.headers.get('set-cookie').split(';')[0];
  const callback=await fetch(`${origin}/?user_id=jau.synthetic-integration&origin_user_id=123&user_name=Tester`,{headers:{cookie}});
  assert.equal(callback.status,200);
  const config=await (await fetch(`${origin}/functions/tud-config`)).json();
  assert.equal(config.data.juejin.userId,'jau.synthetic-integration');
  assert.equal(config.data.juejin.originUserId,'123');
  // stdout notification is sent before the callback response completes.
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.match(output,/JUEJIN_LINKED/); assert.equal(output.includes('jau.synthetic-integration'),false);
  const exit=once(child,'exit');child.stdin.end();assert.equal((await exit)[0],0);
});

test('a fresh sidecar reclaims stale ownership after its predecessor crashes', {timeout:30_000}, async t => {
  const dir=await mkdtemp(join(tmpdir(),'jusage-tauri-crash-'));
  const first=await start(t,dir);await first.ready;
  const old=once(first.child,'exit');first.child.kill('SIGKILL');await old;
  const second=await start(t,dir);const port=await second.ready;
  const owner=JSON.parse(await readFile(join(dir,'tud.pid'),'utf8'));
  assert.equal(owner.pid,second.child.pid);assert.equal(owner.kind,'desktop');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
  const exit=once(second.child,'exit');second.child.stdin.end();assert.equal((await exit)[0],0);
  await assert.rejects(access(join(dir,'tud.pid')));
});
