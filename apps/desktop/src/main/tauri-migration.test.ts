import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  downloadMigrationInstaller,
  installerFileName,
  migrationTargetFor,
  parseMigrationFeed,
  resolveMigration,
  verifySha512,
} from './tauri-migration.js';

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

test('migration target maps common desktop platforms', () => {
  assert.equal(migrationTargetFor('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(migrationTargetFor('darwin', 'x64'), 'darwin-x64');
  assert.equal(migrationTargetFor('win32', 'x64'), 'win32-x64');
  assert.equal(migrationTargetFor('linux', 'x64'), null);
});

test('parse and resolve only enabled feeds with a matching installer', () => {
  const feed = parseMigrationFeed({
    enabled: true,
    version: '1.0.0',
    message: '升级到新版客户端',
    files: [
      {
        url: 'https://example.test/Juejin%20Usage-1.0.0-arm64.dmg',
        sha512: 'abc',
        target: 'darwin-arm64',
      },
      {
        url: 'https://example.test/Juejin%20Usage%20Setup%201.0.0.exe',
        sha512: 'def',
        target: 'win32-x64',
      },
    ],
  });
  assert.ok(feed);
  assert.equal(resolveMigration(feed!, 'darwin', 'arm64')?.file.target, 'darwin-arm64');
  assert.equal(resolveMigration({ ...feed!, enabled: false }, 'darwin', 'arm64'), null);
  assert.equal(parseMigrationFeed({ enabled: true, version: '1.0.0' }), null);
});

test('sha512 accepts base64 or hex digests', () => {
  const bytes = Buffer.from('installer-bytes');
  const digest = createHash('sha512').update(bytes).digest();
  assert.equal(verifySha512(bytes, digest.toString('base64')), true);
  assert.equal(verifySha512(bytes, digest.toString('hex')), true);
  assert.equal(verifySha512(bytes, 'nope'), false);
});

test('downloadMigrationInstaller verifies checksum and writes the file', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'jusage-migration-'));
  const body = Buffer.from('tauri-installer-body');
  const sha512 = createHash('sha512').update(body).digest('base64');
  const path = await downloadMigrationInstaller({
    destinationDir: tempDir,
    file: {
      url: 'https://example.test/Juejin%20Usage-1.0.0-arm64.dmg',
      sha512,
      target: 'darwin-arm64',
      size: body.byteLength,
    },
    fetchImpl: async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-length': String(body.byteLength) },
      }),
  });
  assert.equal(installerFileName('https://example.test/Juejin%20Usage-1.0.0-arm64.dmg'), 'Juejin Usage-1.0.0-arm64.dmg');
  assert.equal(await readFile(path, 'utf8'), 'tauri-installer-body');
});
