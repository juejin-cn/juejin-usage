import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  decodeEncodedProjectPath,
  normalizeProjectName,
  resetProjectNameCache,
  resolveProjectName,
} from '../src/project-name.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], {
      stdio: 'ignore',
      timeout: 2_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Temp dirs under OS tmp so they are not nested inside this monorepo's .git. */
function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('resolveProjectName returns unknown for empty input', () => {
  resetProjectNameCache();
  assert.equal(resolveProjectName(''), 'unknown');
  assert.equal(resolveProjectName('   '), 'unknown');
  assert.equal(resolveProjectName('unknown'), 'unknown');
});

test('resolveProjectName falls back to basename for non-git directory', () => {
  resetProjectNameCache();
  const root = makeTempDir('tud-proj-nongit-');
  try {
    const dir = join(root, 'my-app');
    mkdirSync(dir);
    assert.equal(resolveProjectName(dir), 'my-app');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'resolveProjectName uses git toplevel basename for nested cwd',
  { skip: !hasGit() },
  () => {
    resetProjectNameCache();
    const root = makeTempDir('tud-proj-git-');
    const repo = join(root, 'ai-usage');
    const nested = join(repo, 'packages', 'core');
    try {
      mkdirSync(nested, { recursive: true });
      execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--template='], {
        cwd: repo,
        encoding: 'utf-8',
        timeout: 5_000,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      });
      writeFileSync(join(repo, 'README.md'), 'x\n');
      assert.equal(resolveProjectName(nested), 'ai-usage');
      assert.equal(resolveProjectName(repo), 'ai-usage');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('decodeEncodedProjectPath unwraps encodings to a filesystem path', () => {
  assert.equal(
    decodeEncodedProjectPath('%2FUsers%2Fyipan%2Fcode%2Fdemo%2Fjuejin-usage'),
    '/Users/yipan/code/demo/juejin-usage',
  );
  assert.equal(
    decodeEncodedProjectPath('%252FUsers%252Fme%252Fapp'),
    '/Users/me/app',
  );
  assert.equal(decodeEncodedProjectPath('peeple-app'), 'peeple-app');
  assert.equal(decodeEncodedProjectPath('%'), '%');
  assert.equal(decodeEncodedProjectPath('100%'), '100%');
});

test('normalizeProjectName uses the last folder of any path-like value', () => {
  assert.equal(
    normalizeProjectName('%2FUsers%2Fyipan%2Fcode%2Fdemo%2Fjuejin-usage'),
    'juejin-usage',
  );
  assert.equal(normalizeProjectName('%5CUsers%5Cme%5Capp'), 'app');
  assert.equal(normalizeProjectName('%252FUsers%252Fme%252Fapp'), 'app');
  assert.equal(normalizeProjectName('file:///Users/me/apps/demo-app'), 'demo-app');
  assert.equal(normalizeProjectName('peeple-app'), 'peeple-app');
  assert.equal(normalizeProjectName('juejin-usage'), 'juejin-usage');
  assert.equal(normalizeProjectName('/Users/me/apps/demo-app'), 'demo-app');
  assert.equal(normalizeProjectName('C:\\\\Users\\\\me\\\\app'), 'app');
  assert.equal(normalizeProjectName('unknown'), 'unknown');
  assert.equal(normalizeProjectName(''), 'unknown');
});

test('resolveProjectName decodes encoded cwd then uses basename fallback', () => {
  resetProjectNameCache();
  assert.equal(
    resolveProjectName('%2Ftmp%2Ftud-missing-proj-dir%2Fdemo-app'),
    'demo-app',
  );
});

test('resolveProjectName caches by path', () => {
  resetProjectNameCache();
  const root = makeTempDir('tud-proj-cache-');
  try {
    const dir = join(root, 'cached-app');
    mkdirSync(dir);
    const first = resolveProjectName(dir);
    const second = resolveProjectName(dir);
    assert.equal(first, 'cached-app');
    assert.equal(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
