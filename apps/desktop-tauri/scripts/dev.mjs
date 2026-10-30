import { spawn } from 'node:child_process';
import { watch, readFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const app = resolve(root, 'apps/desktop-tauri');

export function isDevInput(path) {
  path = path.replaceAll('\\', '/');
  if (path.split('/').some(part => ['node_modules', 'dist', 'target', '.git', 'node-app', 'binaries', 'icons'].includes(part))) return false;
  if (path.endsWith('/routeTree.gen.ts') || path.endsWith('/tauri.release.generated.json')) return false;
  return /^(packages\/(core|dashboard)\/(src\/|public\/|[^/]+\.(json|ts|html)$|\.env)|apps\/desktop-tauri\/(src\/|scripts\/|src-tauri\/|[^/]+\.json$|\.node-version$)|apps\/desktop\/(src\/(main|shared|renderer\/assets\/pets)\/|resources\/))/.test(path)
    || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path);
}

export function runDev() {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run with pnpm dev:desktop');
  const command = /\.[cm]?js$/.test(pnpm) ? process.execPath : pnpm;
  const prefix = command === process.execPath ? [pnpm] : [];
  let child, timer, stopping = false, restarting = false, pending = false;
  const hashes = new Map();
  const watchers = [];

  function start() {
    console.log('[desktop:dev] Preparing resources and starting Tauri…');
    child = spawn(command, [...prefix, 'exec', 'tauri', 'dev', '--no-dev-server', '--features', 'custom-protocol', '--no-watch'], {
      // stdin is a pipe so stop() can request a graceful exit by closing it —
      // the only shutdown that reaches a child on Windows, where SIGTERM cannot.
      cwd: app, stdio: ['pipe', 'inherit', 'inherit'], detached: process.platform !== 'win32',
      env: { ...process.env, TAURI_ENV_DEBUG: 'true' },
    });
    child.stdin?.on('error', () => {});
    child.on('error', error => console.error('[desktop:dev]', error.message));
    child.on('exit', code => {
      child = undefined;
      if (!stopping && !restarting) console.log(`[desktop:dev] Tauri exited (${code}). Waiting for source changes…`);
    });
  }

  async function stop() {
    const current = child;
    if (!current?.pid) return;
    const exited = new Promise(resolve => current.once('exit', resolve));
    current.stdin?.end(); // graceful on every platform; the kill ladder below only handles children that ignore it
    function kill(force) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(current.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore' }).on('error', () => {});
      } else {
        try { process.kill(-current.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
    kill(false);
    const timeout = setTimeout(() => kill(true), 8000);
    await exited;
    clearTimeout(timeout);
  }

  async function restart() {
    if (stopping) return;
    if (restarting) { pending = true; return; }
    restarting = true;
    await stop();
    restarting = false;
    if (!stopping) start();
    if (pending) { pending = false; schedule(); }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => restart().catch(error => { console.error(error); shutdown(1); }), 500);
  }

  // Watch source trees only: resource preparation writes dist/node-app/binaries.
  // Watching those outputs would continuously restart the application.
  const directories = [
    '.', 'packages/core', 'packages/dashboard', 'apps/desktop-tauri', 'apps/desktop-tauri/src-tauri',
    'packages/core/src', 'packages/dashboard/src', 'packages/dashboard/public',
    'apps/desktop-tauri/src', 'apps/desktop-tauri/scripts', 'apps/desktop-tauri/src-tauri/src',
    'apps/desktop-tauri/src-tauri/capabilities', 'apps/desktop/src/main', 'apps/desktop/src/shared',
    'apps/desktop/src/renderer/assets/pets', 'apps/desktop/resources',
  ];
  for (const directory of directories) {
    const base = resolve(root, directory);
    if (!existsSync(base)) continue;
    const recursive = !['.', 'packages/core', 'packages/dashboard', 'apps/desktop-tauri', 'apps/desktop-tauri/src-tauri'].includes(directory);
    watchers.push(watch(base, { recursive }, (_, filename) => {
      if (!filename) return;
      const path = relative(root, resolve(base, String(filename))).replaceAll('\\', '/');
      if (!isDevInput(path)) return;
      let hash;
      try { hash = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'); }
      catch (error) { if (error.code !== 'ENOENT') return; hash = 'deleted'; }
      if (hashes.get(path) === hash) return;
      hashes.set(path, hash);
      console.log(`[desktop:dev] Changed: ${path}`);
      schedule();
    }));
  }

  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    watchers.forEach(watcher => watcher.close());
    await stop();
    process.exitCode = code;
  }
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  // A closed pipe means the launcher went away; TTY sessions keep Ctrl+C.
  if (!process.stdin.isTTY) { process.stdin.resume(); process.stdin.on('end', () => shutdown()); }
  start();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) runDev();
