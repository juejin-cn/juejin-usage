import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanDesktopPetDirectory } from './desktop-pet-scanner.js';

const atlasFixture = resolve('src/renderer/assets/pets/hawking/hawking-spritesheet.webp');

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jusage pet 素材-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writePet(directory: string, id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'pet.json'), JSON.stringify({
    id,
    displayName: `Pet ${id}`,
    spriteVersionNumber: 2,
    spritesheetPath: 'spritesheet.webp',
    ...overrides,
  }));
  await copyFile(atlasFixture, join(directory, 'spritesheet.webp'));
}

test('scan creates a missing pets directory and returns an empty catalog', async (t) => {
  const directory = join(await temporaryDirectory(t), 'pets');
  const result = await scanDesktopPetDirectory(directory);
  assert.deepEqual(result.catalog, { pets: [], invalidPets: [], directory });
  assert.equal(result.spritesheets.size, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('scan loads real WebP packages in directory order using native paths', async (t) => {
  const directory = await temporaryDirectory(t);
  await writePet(join(directory, 'z-last'), 'first-id');
  await writePet(join(directory, 'a-first'), 'last-id', {
    description: 'My custom pet',
    glow: { primary: '#123abc', accent: '#abcdef' },
  });
  await writeFile(join(directory, 'ignored.json'), '{}');

  const result = await scanDesktopPetDirectory(directory);
  assert.deepEqual(result.catalog.pets.map((pet) => pet.id), ['last-id', 'first-id']);
  assert.deepEqual(result.catalog.invalidPets, []);
  assert.deepEqual(result.catalog.pets[0], {
    id: 'last-id',
    displayName: 'Pet last-id',
    description: 'My custom pet',
    glow: { primary: '#123abc', accent: '#abcdef' },
    source: 'local',
  });
  assert.equal(result.spritesheets.get('first-id'), join(directory, 'z-last', 'spritesheet.webp'));
});

test('scan isolates invalid packages and keeps the first duplicate id', async (t) => {
  const directory = await temporaryDirectory(t);
  await writePet(join(directory, 'a-valid'), 'custom-pet');
  await writePet(join(directory, 'b-duplicate'), 'custom-pet');
  await writePet(join(directory, 'c-builtin'), 'hawking');
  await writePet(join(directory, 'd-json'), 'broken-json');
  await writeFile(join(directory, 'd-json', 'pet.json'), '{broken');
  await writePet(join(directory, 'e-version'), 'old-pet', { spriteVersionNumber: 1 });
  await writePet(join(directory, 'f-path'), 'escaped-pet', { spritesheetPath: '../spritesheet.webp' });
  await writePet(join(directory, 'g-missing'), 'missing-pet');
  await rm(join(directory, 'g-missing', 'spritesheet.webp'));
  await writePet(join(directory, 'h-image'), 'broken-image');
  await writeFile(join(directory, 'h-image', 'spritesheet.webp'), 'not a WebP');

  const result = await scanDesktopPetDirectory(directory);
  assert.deepEqual(result.catalog.pets.map((pet) => pet.id), ['custom-pet']);
  assert.equal(result.spritesheets.get('custom-pet'), join(directory, 'a-valid', 'spritesheet.webp'));
  assert.deepEqual(result.catalog.invalidPets.map((pet) => pet.directory), [
    'b-duplicate', 'c-builtin', 'd-json', 'e-version', 'f-path', 'g-missing', 'h-image',
  ]);
  assert.match(result.catalog.invalidPets[0]!.reason, /重复/);
  assert.match(result.catalog.invalidPets[1]!.reason, /内置宠物冲突/);
});

test('scan rejects symlinked assets and skips directory links', async (t) => {
  const directory = await temporaryDirectory(t);
  await writePet(join(directory, 'valid'), 'valid-pet');
  await writePet(join(directory, 'linked-image'), 'linked-pet');
  await rm(join(directory, 'linked-image', 'spritesheet.webp'));
  try {
    await symlink(join(directory, 'valid', 'spritesheet.webp'), join(directory, 'linked-image', 'spritesheet.webp'));
    await symlink(join(directory, 'valid'), join(directory, 'linked-directory'), 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Creating symlinks requires permission on this host');
      return;
    }
    throw error;
  }
  const result = await scanDesktopPetDirectory(directory);
  assert.deepEqual(result.catalog.pets.map((pet) => pet.id), ['valid-pet']);
  assert.deepEqual(result.catalog.invalidPets.map((pet) => pet.directory), ['linked-image']);
});

test('a fresh scan reflects additions and removals without retaining stale asset paths', async (t) => {
  const directory = await temporaryDirectory(t);
  await writePet(join(directory, 'old'), 'old-pet');
  const initial = await scanDesktopPetDirectory(directory);
  assert.equal(initial.spritesheets.has('old-pet'), true);
  await rm(join(directory, 'old'), { recursive: true });
  await writePet(join(directory, 'new'), 'new-pet');
  const refreshed = await scanDesktopPetDirectory(directory);
  assert.deepEqual(refreshed.catalog.pets.map((pet) => pet.id), ['new-pet']);
  assert.equal(refreshed.spritesheets.has('old-pet'), false);
});

test('a directory-level error rejects instead of returning an empty catalog', async (t) => {
  const directory = join(await temporaryDirectory(t), 'pets');
  await writeFile(directory, 'existing file');
  await assert.rejects(scanDesktopPetDirectory(directory));
  assert.equal(await readFile(directory, 'utf8'), 'existing file');
});
