#!/usr/bin/env node
/**
 * Build releases/electron-to-tauri.json for turning on Electron → Tauri handoff.
 *
 * Usage:
 *   node apps/desktop/scripts/enable-tauri-migration.mjs \
 *     --version 1.0.0 \
 *     --arm64-dmg 'https://…/Juejin%20Usage-1.0.0-arm64.dmg' --arm64-sha512 '…' \
 *     --intel-dmg 'https://…/Juejin%20Usage-1.0.0.dmg' --intel-sha512 '…' \
 *     --win-exe 'https://…/Juejin%20Usage%20Setup%201.0.0.exe' --win-sha512 '…' \
 *     [--message '升级到新版客户端'] [--dry-run]
 *
 * Default writes releases/electron-to-tauri.json with enabled:true.
 * Ship Electron 0.1.16+ first; only flip this after Tauri v1.0.0 installers are public.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const version = arg('version');
const arm64Url = arg('arm64-dmg');
const arm64Sha = arg('arm64-sha512');
const intelUrl = arg('intel-dmg');
const intelSha = arg('intel-sha512');
const winUrl = arg('win-exe');
const winSha = arg('win-sha512');
const message = arg('message') || '升级到新版客户端';
const dryRun = process.argv.includes('--dry-run');

if (!version || !arm64Url || !arm64Sha || !intelUrl || !intelSha || !winUrl || !winSha) {
  throw new Error('Missing required --version / platform url+sha512 flags (see script header)');
}

const feed = {
  enabled: true,
  version,
  message,
  files: [
    { target: 'darwin-arm64', url: arm64Url, sha512: arm64Sha },
    { target: 'darwin-x64', url: intelUrl, sha512: intelSha },
    { target: 'win32-x64', url: winUrl, sha512: winSha },
  ],
};

const out = resolve(
  fileURLToPath(new URL('../../../releases/electron-to-tauri.json', import.meta.url)),
);
const body = `${JSON.stringify(feed, null, 2)}\n`;
if (dryRun) {
  process.stdout.write(body);
} else {
  writeFileSync(out, body);
  // Touch read-back so typos fail before commit.
  JSON.parse(readFileSync(out, 'utf8'));
  console.log(`Wrote ${out} (enabled=true, version=${version})`);
}
