import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { syncVersion } from './sync-version.mjs';
import { stageIcons } from './stage-icons.mjs';
import { stagePet } from './stage-pet.mjs';
import { stageNodeApp } from './stage-node-app.mjs';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const app = fileURLToPath(new URL('..', import.meta.url));
const version=syncVersion(app);
stageIcons();
// pnpm may be installed as a JS CLI or a standalone native executable.
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run this script with pnpm prepare:app');
for (const name of ['@juejin-opensource/jusage-core', '@juejin-opensource/jusage-desktop-tauri', '@juejin-opensource/jusage-dashboard']) {
  execFileSync(/\.[cm]?js$/.test(pnpmCli) ? process.execPath : pnpmCli, [...(/\.[cm]?js$/.test(pnpmCli) ? [pnpmCli] : []), '--filter', name, 'build'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, PUBLIC_PATH: '/', VITE_BASE: '/', VITE_ROUTER_BASE: '/', VITE_API_TARGET: 'cli', VITE_TAURI_VERSION: version },
  });
}
const ui = join(app, 'dist/ui');
rmSync(ui, { recursive: true, force: true });
cpSync(join(root, 'packages/dashboard/dist'), ui, { recursive: true });
// Root-relative assets resolve against the custom-protocol origin. Router uses
// /dashboard; the bridge normalizes /index.html before React starts.
const html = join(ui, 'index.html');
writeFileSync(html, readFileSync(html, 'utf8').replace('<title>AI Usage Dashboard</title>', '<title>Juejin Usage Tauri</title>'));
stagePet(ui);
stageNodeApp();
