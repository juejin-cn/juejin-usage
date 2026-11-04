#!/usr/bin/env node
/**
 * Generate releases/tauri/latest.json from collected release artifacts.
 *
 * Usage:
 *   node apps/desktop-tauri/scripts/write-stable-feed.mjs \
 *     /path/to/artifacts-root \
 *     https://github.com/juejin-cn/juejin-usage/releases/download/v1.0.0 \
 *     1.0.0
 *
 * Writes apps/../../releases/tauri/latest.json (repo releases/tauri/latest.json).
 * Publish/push separately after verifying URLs are public (not draft untagged).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateManifest } from './update-manifest.mjs';

const [root, baseUrl, version] = process.argv.slice(2);
if (!root || !baseUrl || !version) {
  throw new Error(
    'Usage: write-stable-feed.mjs <artifact-directory> <HTTPS-release-base-URL> <version>',
  );
}
const manifest = updateManifest(resolve(root), baseUrl, version, 'macos-windows');
const out = resolve(
  fileURLToPath(new URL('../../../releases/tauri/latest.json', import.meta.url)),
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out} for ${version}; review URLs then push to sync Gitee`);
