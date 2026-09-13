import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDataDir, loadConfig } from '../src/config.js';
import { petsDir } from '../src/paths.js';

test('shared data initialization creates pets and preserves existing packages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jusage-pets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'custom-data');
  const loaded = await loadConfig(dataDir);
  assert.equal(loaded.dir, dataDir);
  assert.ok((await stat(petsDir(dataDir))).isDirectory());

  const petDirectory = join(petsDir(dataDir), 'my-pet');
  await mkdir(petDirectory);
  const manifest = '{"id":"my-pet"}';
  await writeFile(join(petDirectory, 'pet.json'), manifest);
  await ensureDataDir(dataDir);
  const reloaded = await loadConfig(dataDir);
  assert.equal(await readFile(join(petDirectory, 'pet.json'), 'utf8'), manifest);
  assert.equal(reloaded.config.deviceId, loaded.config.deviceId);
});
