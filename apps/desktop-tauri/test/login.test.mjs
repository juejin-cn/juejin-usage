import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createDesktopLoginHandler, parseLoginPayload } from '../dist/host/login.js';

async function fixture(t) {
  let time = 1000;
  const writes = [], notices = [];
  const handler = createDesktopLoginHandler({ hostKey: 'native-only-key', now: () => time,
    apply: async payload => { writes.push(payload); }, linked: () => notices.push('linked') });
  const server = createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) {res.statusCode=404;res.end();} }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const start = async (target = 'https://juejin.cn/aiusage/dashboard?login_from_client=desktop', key = 'native-only-key') => fetch(`${origin}/functions/tud-desktop-login?target=${encodeURIComponent(target)}`, { method: 'POST', headers: {'x-tud-host-key':key} });
  const browser = async () => {
    const created = await start(); const {url} = await created.json();
    const response = await fetch(url, {redirect:'manual'});
    return { url, response, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  return { origin, writes, notices, start, browser, expire: () => {time += 600_001;} };
}

test('native login uses one-time browser ticket and writes config before notifying host', async t => {
  const f = await fixture(t);
  const {url, response, cookie} = await f.browser();
  assert.equal(response.status,302);
  const target = new URL(response.headers.get('location'));
  assert.equal(target.searchParams.get('login_from_client'),'cli');
  assert.equal(target.searchParams.get('port'),new URL(f.origin).port);
  assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  assert.equal((await fetch(url,{redirect:'manual'})).status,403);
  const callback = `${f.origin}/?user_id=jau.synthetic-only&origin_user_id=123&user_name=Tester`;
  assert.equal((await fetch(callback)).status,403);
  assert.equal(f.writes.length,0);
  const success = await fetch(callback,{headers:{cookie}});
  assert.equal(success.status,200);
  assert.equal(success.headers.get('cache-control'),'no-store');
  assert.equal((await success.text()).includes('jau.synthetic-only'),false);
  assert.equal(f.writes[0].juejin.token,'jau.synthetic-only');
  assert.equal(f.writes[0].juejin.originUserId,'123');
  assert.deepEqual(f.notices,['linked']);
  assert.equal((await fetch(callback,{headers:{cookie}})).status,410);
});

test('websites cannot start a flow; expired sessions and invalid targets are rejected', async t => {
  const f=await fixture(t);
  assert.equal((await f.start(undefined,'wrong')).status,403);
  assert.equal((await f.start('https://evil.test/aiusage/?login_from_client=desktop')).status,400);
  assert.equal((await f.start('not a URL')).status,400);
  assert.equal((await f.start('http://juejin.cn/aiusage/?login_from_client=desktop')).status,400);
  const {cookie}=await f.browser(); f.expire();
  assert.equal((await fetch(`${f.origin}/?user_id=jau.synthetic`,{headers:{cookie}})).status,410);
  assert.equal(f.writes.length,0);
});

test('login payload rejects invalid credentials and unsafe avatar URLs', () => {
  for (const query of ['user_id=', 'user_id=bad%20token', `user_id=${'a'.repeat(513)}`, 'user_id=jau.test&avatar_large=javascript:alert(1)', 'user_id=jau.test&origin_user_id=bad%20id']) {
    assert.throws(()=>parseLoginPayload(new URLSearchParams(query)));
  }
});
