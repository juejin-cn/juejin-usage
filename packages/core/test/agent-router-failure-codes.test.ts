import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { googleErrorStatus, googleFailure } from '../src/agent-router/channels/google-errors.js';
import { qoderChannel } from '../src/agent-router/channels/qoder.js';
import { FAILURE_HEADER, verifiedFailureCode } from '../src/agent-router/failure-codes.js';
import { responseFailure } from '../src/agent-router/routing.js';
import { AgentGateway, RouterCredentials, RouterCredentialStore, RouterSubscriptions, makeRouterPreset } from '../src/agent-router/index.js';

test('Google RPC diagnostics classify fixed reasons without leaking messages, metadata or quota subjects', async () => {
  const cases = [
    ['RATE_LIMIT_EXCEEDED', 'UPSTREAM_RATE_LIMITED'],
    ['QUOTA_EXCEEDED', 'UPSTREAM_QUOTA_EXHAUSTED'],
    ['MODEL_CAPACITY_EXHAUSTED', 'UPSTREAM_CAPACITY_EXHAUSTED'],
    ['PRIVATE_ACCESS_TOKEN_FAKE', 'UPSTREAM_RESOURCE_EXHAUSTED'],
  ];
  for (const [reason, expected] of cases) {
    const response = await googleFailure(Response.json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'private account and prompt', details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, metadata: { access_token: 'private-token' } },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.250s' },
    ] } }, { status: 429 }));
    assert.equal(response.headers.get(FAILURE_HEADER), expected);
    assert.equal(response.headers.get('retry-after'), '1.25');
    assert.ok(!(await response.text()).includes('private'));
  }
  const quota = await googleFailure(Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ subject: 'private-project', description: 'private-details' }] }] } }, { status: 429 }));
  assert.equal(quota.headers.get(FAILURE_HEADER), 'UPSTREAM_QUOTA_EXHAUSTED'); assert.ok(!(await quota.text()).includes('private'));
  const capacity = await googleFailure(Response.json({ error: { message: 'No capacity available for private-model' } }, { status: 503, headers: { 'retry-after': '45' } }));
  assert.equal(capacity.headers.get(FAILURE_HEADER), 'UPSTREAM_CAPACITY_EXHAUSTED'); assert.equal(capacity.headers.get('retry-after'), '45');
});

test('embedded Google error status accepts only canonical codes and own enum keys', () => {
  for (const [code, expected] of [[3, 400], [8, 429], [14, 503], [429, 429], [100, 502]]) assert.equal(googleErrorStatus({ code }), expected);
  for (const status of ['__proto__', 'constructor', 'private-status']) assert.equal(googleErrorStatus({ status }), 502);
  assert.equal(googleErrorStatus({ status: 'RESOURCE_EXHAUSTED' }), 429);
});

test('unknown Google errors preserve HTTP status and do not invent quota, permissions or invalid-argument reasons', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const response = await googleFailure(new Response('not JSON private-data', { status }));
    assert.equal(response.status, status); assert.equal(response.headers.get(FAILURE_HEADER), null);
    assert.ok(!(await response.text()).includes('private'));
  }
  assert.equal((await googleFailure(Response.json({ error: { status: 'INVALID_ARGUMENT' } }, { status: 400 }))).headers.get(FAILURE_HEADER), 'UPSTREAM_INVALID_ARGUMENT');
  assert.equal((await googleFailure(Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 }))).headers.get(FAILURE_HEADER), 'UPSTREAM_PERMISSION_DENIED');
});

test('diagnostics are finite and status-bound; routing preserves retryability and cooldown policy', () => {
  for (const value of ['UPSTREAM_PRIVATE_KEY_FAKE', '__proto__', 'UPSTREAM_QUOTA_EXHAUSTED\nsecret']) assert.equal(verifiedFailureCode(value, 429), undefined);
  assert.equal(verifiedFailureCode('UPSTREAM_QUOTA_EXHAUSTED', 400), undefined);
  const quota = responseFailure(429, '2', 1000, 'UPSTREAM_QUOTA_EXHAUSTED');
  assert.equal(quota.code, 'UPSTREAM_QUOTA_EXHAUSTED'); assert.equal(quota.kind, 'rate-limit'); assert.equal(quota.retryable, true); assert.equal(quota.retryAfterMs, 2000);
  assert.equal(responseFailure(400, null, 1000, 'UPSTREAM_QUOTA_EXHAUSTED').code, 'UPSTREAM_HTTP_400');
});

test('Qoder missing live-catalog model is distinguished from remote HTTP 404 without sending generation', async () => {
  let generations = 0;
  const channel = qoderChannel('qoder-cn', async url => {
    if (String(url).includes('/model/list')) return Response.json({ app: [{ key: 'available', enable: true }] });
    generations++; return Response.json({});
  });
  const transport = await channel.auth.transport(async () => ({ type: 'oauth', access: 'fake', uid: 'u', machineId: 'm' }));
  const response = await transport.fetch!('https://unused.example/chat/completions', { body: '{"model":"stale","messages":[]}' });
  assert.equal(response.status, 404); assert.equal(response.headers.get(FAILURE_HEADER), 'UPSTREAM_MODEL_NOT_IN_CATALOG'); assert.equal(generations, 0);
});

test('safe diagnostics cross real subscription IPC into gateway errors and traces; unsafe headers do not', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-diagnostics-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RouterCredentialStore(join(dir, 'vault.enc'), Buffer.alloc(32, 19)); await store.init();
  const provider = { ...makeRouterPreset('github-copilot', 'chat'), models: ['quota-diagnostic', 'unsafe-diagnostic', 'wrong-status-diagnostic'] };
  await store.set(provider, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: Date.now() + 3600000 } });
  const subscriptions = new RouterSubscriptions({}, new URL('./fixtures/agent-router-worker.js', import.meta.url), store); t.after(() => subscriptions.close());
  const gateway = new AgentGateway(new RouterCredentials({}, Date.now, subscriptions, store)); t.after(() => gateway.stop());
  await gateway.start({ version: 1, port: 0, groups: [], providers: [provider] });
  for (const [model, status, code] of [['quota-diagnostic', 429, 'UPSTREAM_QUOTA_EXHAUSTED'], ['unsafe-diagnostic', 429, 'UPSTREAM_HTTP_429'], ['wrong-status-diagnostic', 400, 'UPSTREAM_HTTP_400']] as const) {
    const response = await fetch(gateway.status().baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: `${provider.id}/${model}`, messages: [{ role: 'user', content: 'private-user-prompt' }] }) });
    assert.equal(response.status, status); const result = await response.text(); assert.ok(result.includes(code)); assert.ok(!result.includes('private'));
    if (model === 'quota-diagnostic') assert.equal(response.headers.get('retry-after'), '2');
    const trace = gateway.status().requests[0]; assert.equal(trace.reason, code); assert.ok(!JSON.stringify(trace).includes('private'));
  }
});
