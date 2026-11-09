import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { createSubscriptionTransport, parseMacProxySettings, resolveProxySettings } from '../dist/host/subscription-fetch.js';

const mac = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7897
  HTTPSEnable : 1
  HTTPSProxy : ::1
  HTTPSPort : 7898
  ExceptionsList : <array> {
    0 : localhost
    1 : *.local
  }
}`;

test('macOS static system proxies, IPv6 and exceptions; env overrides system without mutation', () => {
  const system = parseMacProxySettings(mac);
  assert.deepEqual(system, { httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://[::1]:7898', noProxy: 'localhost,*.local' });
  assert.equal(parseMacProxySettings(mac.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')).httpsProxy, undefined);
  assert.equal(parseMacProxySettings(mac.replace('HTTPPort : 7897', 'HTTPPort : -1')).httpProxy, undefined);
  const env = { https_proxy: 'http://explicit:8080', NO_PROXY: 'example.invalid' };
  assert.equal(resolveProxySettings(system, env).httpsProxy, env.https_proxy);
  assert.equal(resolveProxySettings(system, env).noProxy, env.NO_PROXY);
  assert.deepEqual(env, { https_proxy: 'http://explicit:8080', NO_PROXY: 'example.invalid' });
});

async function fixture(t, systemProxy = true) {
  const seen = [];
  const origin = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, account: req.headers['chatgpt-account-id'] });
    if (req.url === '/slow') return;
    if (req.url === '/redirect') { res.writeHead(302, { location: '/leak' }); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ weekly: { used_percent: 23 } }));
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  let tunnels = 0;
  const sockets = new Set();
  const proxy = createServer();
  proxy.on('connect', (req, client, head) => {
    tunnels++;
    const upstream = connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(client); sockets.add(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const logs = [];
  const transport = createSubscriptionTransport({
    env: {}, log: message => logs.push(message),
    readProxy: async () => systemProxy ? { httpProxy: `http://127.0.0.1:${proxy.address().port}`, noProxy: '' } : {},
  });
  t.after(async () => {
    // Destroy the deliberately unanswered /slow response too.
    origin.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await transport.close();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => origin.close(resolve))]);
  });
  return { transport, seen, logs, tunnels: () => tunnels,
    base: systemProxy ? 'http://codex-proxy-test.invalid' : `http://127.0.0.1:${origin.address().port}` };
}

test('host transport reaches a DNS-invalid target through system proxy and preserves auth', async t => {
  const f = await fixture(t);
  const response = await f.transport.fetch(`${f.base}/usage`, {
    headers: { Authorization: 'Bearer test-secret', 'ChatGPT-Account-Id': 'test-account' },
    redirect: 'error', signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).weekly.used_percent, 23);
  assert.equal(f.tunnels(), 1);
  assert.equal(f.seen[0].authorization, 'Bearer test-secret');
  assert.equal(f.seen[0].account, 'test-account');
  assert.deepEqual(f.logs, []);
});

test('redirect rejection and timeout survive the proxy transport without leaking credentials into logs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.transport.fetch(`${f.base}/redirect`, { redirect: 'error', headers: { Authorization: 'Bearer test-secret' } }));
  assert.equal(f.seen.some(req => req.url === '/leak'), false);
  await assert.rejects(f.transport.fetch(`${f.base}/slow`, { signal: AbortSignal.timeout(50) }));
  assert.ok(f.logs.length >= 2);
  assert.doesNotMatch(f.logs.join('\n'), /test-secret|test-account|http:/);
});

test('no proxy settings retain working direct connections', async t => {
  const f = await fixture(t, false);
  const response = await f.transport.fetch(`${f.base}/usage`);
  await response.json();
  assert.equal(response.status, 200);
  assert.equal(f.tunnels(), 0);
});
