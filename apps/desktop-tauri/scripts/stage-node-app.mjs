#!/usr/bin/env node
/**
 * Stage the Tauri sidecar's bundled resources into `src-tauri/node-app/`.
 *
 * The packaged `.app` has no repo on disk, so the Node sidecar must be
 * self-contained: a portable Node runtime + the compiled sidecar entry + the
 * exact runtime dependencies it imports (all of which the core/sidecar dist
 * reference as bare specifiers or `node:` builtins).
 *
 * Resulting tree (bundled by `tauri.conf.json > bundle.resources`):
 *   node-app/
 *     node/            a Node binary for the target platform (dev: host node)
 *     app/dist/        the compiled sidecar (index.js + evict-cli-autostart.js)
 *     app/node_modules/
 *       @juejin-opensource/jusage-core/   (dist + pricing.json + package.json)
 *       hono/  proper-lockfile/  graceful-fs/  retry/  signal-exit/
 *
 * This runs on the host at build time, so it always produces the host-arch
 * Node binary. On a release build you generate it per target (mac-arm64 /
 * mac-x64 / win-x64); the dev build reuses the local node.
 *
 * Run with: node apps/desktop-tauri/scripts/stage-node-app.mjs
 */
import { cpSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const outDir = path.join(here, '../src-tauri/node-app');

/** A package's real files in the pnpm store (symlinks point here). */
const pnpmPkg = (name, version) =>
  path.join(repoRoot, `node_modules/.pnpm/${name}@${version}/node_modules/${name}`);

// (a) resolve the host Node runtime to bundle.
const nodeBin = process.env.TUD_NODE_BIN || process.execPath;
if (!existsSync(nodeBin)) {
  throw new Error(`node runtime not found: ${nodeBin}`);
}

// (b) the compiled sidecar entry + its local helper.
const sidecarDist = path.join(repoRoot, 'packages/desktop-sidecar/dist');
const coreDist = path.join(repoRoot, 'packages/core/dist');
const corePkg = path.join(repoRoot, 'packages/core/package.json');
if (!existsSync(path.join(sidecarDist, 'index.js'))) {
  throw new Error('sidecar not built — run `pnpm build:sidecar` first');
}
if (!existsSync(path.join(coreDist, 'index.js'))) {
  throw new Error('core not built — run `pnpm build:packages` (or pnpm build) first');
}

// (c) wipe + recreate the staging dir (a stale tree must not leak into the bundle).
rmSync(outDir, { recursive: true, force: true });

// node-app/node
cpSync(nodeBin, path.join(outDir, 'node', 'node'));
chmodSync(path.join(outDir, 'node', 'node'), 0o755);

// node-app/app/dist  (the sidecar entry)
cpSync(sidecarDist, path.join(outDir, 'app', 'dist'), { recursive: true });

// node-app/app/node_modules/@juejin-opensource/jusage-core  (dist + pricing + pkg)
const coreMod = path.join(outDir, 'app/node_modules/@juejin-opensource/jusage-core');
cpSync(coreDist, path.join(coreMod, 'dist'), { recursive: true });
cpSync(corePkg, path.join(coreMod, 'package.json'));
// the core's `main`/`exports` point at ./dist; pricing.json ships in dist/.

// node-app/app/node_modules/<runtime deps>
const runtimeDeps = [
  ['hono', '4.12.28'],
  ['proper-lockfile', '4.1.2'],
  ['graceful-fs', '4.2.11'],
  ['retry', '0.12.0'],
  ['signal-exit', '3.0.7'],
];
for (const [name, version] of runtimeDeps) {
  const src = pnpmPkg(name, version);
  if (!existsSync(src)) {
    // Fall back to the hoisted root if the exact version is missing.
    const alt = path.join(repoRoot, 'node_modules', name);
    if (existsSync(alt)) {
      cpSync(alt, path.join(outDir, 'app/node_modules', name), { recursive: true });
      continue;
    }
    throw new Error(`missing runtime dep for sidecar bundle: ${name}@${version}`);
  }
  cpSync(src, path.join(outDir, 'app/node_modules', name), { recursive: true });
}

console.log(`[stage-node-app] staged sidecar runtime → ${path.relative(repoRoot, outDir)}`);
console.log(`[stage-node-app]   node runtime: ${nodeBin} (host arch)`);
console.log(`[stage-node-app]   sidecar:      ${sidecarDist}`);
console.log(`[stage-node-app]   deps:         ${runtimeDeps.map(([n]) => n).join(', ')}`);
