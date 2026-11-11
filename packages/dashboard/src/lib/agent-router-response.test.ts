import assert from 'node:assert/strict';
import test from 'node:test';
import { readRouterResponse } from './agent-router.ts';

test('plain-text 404 from an older sidecar explains that the gateway service needs restarting', async () => {
  await assert.rejects(readRouterResponse(new Response('404 Not Found', { status: 404 })), /本地网关服务尚未更新.*重启客户端/);
});

test('non-JSON failures do not expose WebView parser messages or upstream response bodies', async () => {
  await assert.rejects(readRouterResponse(new Response('private upstream diagnostic', { status: 502 })), error => {
    assert.match(String(error), /HTTP 502/);
    assert.ok(!String(error).includes('private upstream diagnostic'));
    return true;
  });
});

test('gateway envelopes preserve successful data and translated error codes', async () => {
  const data = { phase: 'stopped', providers: [] };
  assert.deepEqual(await readRouterResponse(Response.json({ success: true, data })), data);
  await assert.rejects(readRouterResponse(Response.json({ success: false, message: 'FORBIDDEN' }, { status: 403 })), /管理连接不可用/);
  for (const value of [null, [], 'invalid', { success: true }]) {
    await assert.rejects(readRouterResponse(Response.json(value)), /本地网关响应/);
  }
});
