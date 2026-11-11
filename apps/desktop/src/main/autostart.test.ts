import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

let userData: string;
let autostart: typeof import('./autostart.js');
const originalArgv = [...process.argv];
const electronId = require.resolve('electron');

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'jusage-autostart-test-'));
  process.argv = [...originalArgv, '--hidden'];
  // Stub Electron without loading its install path — CI may skip the binary download.
  require.cache[electronId] = {
    id: electronId, filename: electronId, loaded: true,
    exports: {
      app: {
        isPackaged: true,
        getPath: () => userData,
        setLoginItemSettings: () => { throw new Error('login registration failed'); },
      },
    },
  } as NodeModule;
  delete require.cache[require.resolve('./autostart.js')];
  autostart = require('./autostart.js') as typeof import('./autostart.js');
  delete require.cache[electronId];
});

afterEach(async () => {
  process.argv = originalArgv;
  delete require.cache[electronId];
  await rm(userData, { recursive: true, force: true });
});

test('first hidden launch stays hidden if login registration fails', async () => {
  await assert.rejects(autostart.initAutostartOnLaunch(), /login registration failed/);
  assert.equal(autostart.shouldStartHidden(), true);
});

test('existing hidden launch stays hidden if login registration fails', async () => {
  await writeFile(join(userData, 'desktop-prefs.json'), JSON.stringify({
    openAtLogin: true,
    launchHidden: true,
  }));
  await assert.rejects(autostart.initAutostartOnLaunch(), /login registration failed/);
  assert.equal(autostart.shouldStartHidden(), true);
});
