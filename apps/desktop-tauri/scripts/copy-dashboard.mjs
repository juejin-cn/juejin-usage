#!/usr/bin/env node
/**
 * Copy the Tauri-variant dashboard dist into the Tauri renderer's `public/`
 * dir so the main window loads it as a bundled static resource (like the
 * tray-popover and desktop-pet views) instead of the Node sidecar's loopback
 * HTTP server.
 *
 * The dashboard package is a standalone build with its own TanStack router and
 * `main.tsx`, so it is not imported as a component library — we ship its
 * compiled output under `public/dashboard/`. Vite copies `public/` into the
 * dev server root and into `dist/` on build, so `WebviewUrl::App("dashboard/index.html")`
 * resolves in both dev and release.
 *
 * Source is the `build:tauri` variant (relative asset base `./assets/...`,
 * empty router basepath) so the HTML resolves correctly from a sub-path.
 *
 * Run with: node apps/desktop-tauri/scripts/copy-dashboard.mjs
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
// `build:tauri` writes the dashboard's default `dist/` with relative asset
// base (`./assets/...`) so it nests cleanly under the Tauri renderer's
// `public/dashboard/`. Vite serves `public/` at the dev-server root (dev) and
// copies it into `dist/` on build (release), so `WebviewUrl::App("dashboard/index.html")`
// resolves in both. The Tauri renderer's vite `root` is `src/renderer`, so the
// public dir lives there.
const source = join(repoRoot, 'packages/dashboard/dist');
const target = join(here, '..', 'src/renderer/public/dashboard');


if (!existsSync(join(source, 'index.html'))) {
  console.error(
    'Dashboard dist not built. Run: pnpm --filter @juejin-opensource/jusage-dashboard build:tauri',
  );
  process.exit(1);
}

mkdirSync(target, { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`[copy-dashboard] dashboard dist → ${target}`);
