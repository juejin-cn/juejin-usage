import { request as httpRequest } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { antigravityLogin, antigravityProject } from '../src/agent-router/native/antigravity-oauth.js';

function callbackUrl(flow: { url: string }, extra: Record<string, string>) {
  const auth = new URL(flow.url); const callback = new URL(auth.searchParams.get('redirect_uri')!);
  callback.hostname = '127.0.0.1';
  callback.search = new URLSearchParams({ state: auth.searchParams.get('state')!, ...extra }).toString();
  return callback;
}

test('Antigravity browser OAuth uses PKCE, validates state/host/origin and resolves account/project', async t => {
  let exchanged = 0; let authorization: URL;
  const flow = await antigravityLogin(async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      exchanged++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('code'), 'test-code');
      assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorization.searchParams.get('code_challenge'));
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-access');
    if (String(url).includes('/userinfo')) return Response.json({ id: 'account-id', email: 'test@example.com' });
    assert.equal(String(url), 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    return Response.json({ cloudaicompanionProject: { id: 'project-id' } });
  }, { port: 0 });
  t.after(flow.cancel);
  authorization = new URL(flow.url);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!flow.url.includes('test-refresh'));
  assert.equal((await fetch(callbackUrl(flow, { code: 'test-code', state: 'wrong' }))).status, 400);
  assert.equal((await fetch(callbackUrl(flow, { code: 'test-code' }), { headers: { origin: 'https://evil.example' } })).status, 403);
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(callbackUrl(flow, { code: 'test-code' }), { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal(exchanged, 0);
  const done = flow.callback();
  const response = await fetch(callbackUrl(flow, { code: 'test-code' }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!(await response.text()).includes('test-access'));
  const auth = await done;
  assert.equal(auth.refresh, 'test-refresh'); assert.equal(auth.project, 'project-id');
  assert.equal(auth.uid, 'account-id'); assert.equal(auth.accountName, 'test@example.com');
  assert.equal(exchanged, 1);
});

test('Antigravity OAuth refusal is final and releases its callback listener', async t => {
  let requests = 0;
  const flow = await antigravityLogin(async () => { requests++; throw new Error('should not call'); }, { port: 0 });
  t.after(flow.cancel);
  const rejected = assert.rejects(flow.callback(), /LOGIN_DECLINED/);
  const response = await fetch(callbackUrl(flow, { error: 'access_denied' }));
  assert.equal(response.status, 400); await response.text(); await rejected;
  assert.equal(requests, 0);
});

test('Antigravity OAuth cancellation and timeout reject the pending flow', async () => {
  const flow = await antigravityLogin(fetch, { port: 0 });
  flow.cancel(); await assert.rejects(flow.callback(), /CANCELLED/);
  const expiring = await antigravityLogin(fetch, { port: 0, timeoutMs: 30 });
  await assert.rejects(expiring.callback(), /LOGIN_TIMEOUT/);
});

test('Antigravity OAuth reports a busy port without disturbing the existing flow', async t => {
  const first = await antigravityLogin(fetch, { port: 0 }); t.after(first.cancel);
  const port = Number(new URL(new URL(first.url).searchParams.get('redirect_uri')!).port);
  await assert.rejects(antigravityLogin(fetch, { port }), /ANTIGRAVITY_PORT_BUSY/);
});

test('Antigravity project setup chooses the default tier and reads onboarding result', async () => {
  const project = await antigravityProject('access', async (url, init) => {
    if (String(url).endsWith('loadCodeAssist')) return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] });
    assert.equal(String(url), 'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser');
    assert.equal(JSON.parse(String(init?.body)).tier_id, 'free-tier');
    return Response.json({ done: true, response: { cloudaicompanionProject: 'onboarded-project' } });
  });
  assert.equal(project, 'onboarded-project');
  await assert.rejects(antigravityProject('access', async () => Response.json({ ineligibleTiers: [{ reasonCode: 'AGE' }] })), /ACCOUNT_UNAVAILABLE/);
});
