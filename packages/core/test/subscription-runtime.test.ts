import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { createSubscriptionApi } from '../src/server/subscription-api.js';
import { createHttpServer, listenServer } from '../src/server/http-server.js';
import { readCursorSubscription } from '../src/subscription/readers/cursor-subscription.js';
import { readCopilotVscodeUser } from '../src/subscription/readers/copilot-subscription.js';
import type { readSubscription } from '../src/subscription/read.js';

test('SQLite subscription readers use isolated local fixtures, including Node 20 CLI fallback', async t => {
  try { execFileSync('sqlite3', ['--version'], { stdio: 'ignore' }); }
  catch { t.skip('sqlite3 is required for the Node 20 compatibility fixture'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'jusage-subscription-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, 'state.vscdb');
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'auth0|user_fixture' })).toString('base64url')}.fixture`;
  execFileSync('sqlite3', [db, `CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', '${token}');
    INSERT INTO ItemTable VALUES ('github.copilot-github', 'fixture-user');`]);
  const saved = { db: process.env.CURSOR_STATE_DB_PATH, path: process.env.PATH };
  t.after(() => {
    if (saved.db === undefined) delete process.env.CURSOR_STATE_DB_PATH;
    else process.env.CURSOR_STATE_DB_PATH = saved.db;
    process.env.PATH = saved.path;
  });
  process.env.CURSOR_STATE_DB_PATH = db;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.ok(new Headers(init?.headers).get('cookie')?.includes('user_fixture'));
    assert.equal(init?.redirect, 'error');
    return Response.json(url.includes('usage-summary')
      ? { membershipType: 'pro', individualUsage: { plan: { autoPercentUsed: 25, apiPercentUsed: 50 } } }
      : {});
  });
  if (Number(process.versions.node.split('.')[0]) === 20) {
    process.env.PATH = directory;
    assert.equal((await readCursorSubscription({ forceRefresh: true })).status, 'temporarily-unavailable');
    assert.equal(readCopilotVscodeUser(db), null);
    assert.deepEqual(calls, []);
    process.env.PATH = saved.path;
  }
  assert.equal(readCopilotVscodeUser(db), 'fixture-user');
  const snapshot = await readCursorSubscription({ forceRefresh: true });
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.cursorModels?.usedPercent, 25);
  assert.equal(snapshot.otherModels?.usedPercent, 50);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(snapshot).includes(token), false);
});

test('a real local HTTP server serves independent channels without an Electron runtime', async t => {
  const app = new Hono();
  app.route('/functions/tud-subscription', createSubscriptionApi((async channel => {
    if (channel === 'cursor') throw new Error('fixture failure');
    return { status: 'ready', planLabel: 'Plus', hasAccount: true, fiveHour: null,
      weekly: null, fetchedAt: 1800000000, stale: false, message: null };
  }) as typeof readSubscription));
  const server = createHttpServer({ honoApp: app, staticDir: '/unused', port: 0 });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const { port } = await listenServer(server, '127.0.0.1', 0);
  const [bad, good] = await Promise.all(['cursor', 'codex'].map(channel =>
    fetch(`http://127.0.0.1:${port}/functions/tud-subscription/${channel}`)));
  assert.equal(bad.status, 500);
  assert.equal(good.status, 200);
  assert.equal((await good.json() as { data: { planLabel: string } }).data.planLabel, 'Plus');
  await bad.arrayBuffer();
});
