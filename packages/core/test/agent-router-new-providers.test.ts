import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyChannel } from '../src/agent-router/channels/api-key.js';
import { antigravityChannel, antigravityRequest } from '../src/agent-router/channels/antigravity.js';
import type { SubscriptionAuth } from '../src/agent-router/subscription-types.js';

for (const id of ['opencode-go', 'volcengine'] as const) test(`${id} stores API credentials and uses only its paid endpoint`, async () => {
  const channel = apiKeyChannel(id, async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [
      { id: 'chat-model', api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } } },
      { id: 'responses-only', api: { responses: {} } },
    ] });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
    assert.ok(String(url).startsWith(id === 'opencode-go' ? 'https://opencode.ai/inference/go/openai/v1/' : 'https://ark.cn-beijing.volces.com/api/coding/v3/'));
    return Response.json({ choices: [] });
  });
  const auth = await channel.auth.methods[0].authorize!({ key: 'test-key', models: 'doubao-seed-code' }) as SubscriptionAuth;
  assert.equal(auth.type, 'api');
  assert.deepEqual(Object.keys(await channel.models(auth)), [id === 'opencode-go' ? 'chat-model' : 'doubao-seed-code']);
  const transport = await channel.auth.transport(async () => auth);
  assert.equal((await transport.fetch!(transport.baseURL + '/chat/completions', { method: 'POST', body: '{}' })).status, 200);
});

test('Antigravity converts system, tool arguments, results and thought signatures', () => {
  const converted = antigravityRequest({ messages: [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', tool_calls: [{ id: 'call1', function: { name: 'read', arguments: '{"path":"a"}' }, extra_content: { google: { thought_signature: 'signature' } } }] },
    { role: 'tool', tool_call_id: 'call1', content: '{"result":"ok"}' },
  ], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], tool_choice: 'required' });
  assert.equal(converted.systemInstruction.parts[0].text, 'system');
  assert.equal(converted.contents[1].role, 'model');
  assert.equal(converted.contents[1].parts[0].thoughtSignature, 'signature');
  assert.equal(converted.contents[2].parts[0].functionResponse.name, 'read');
  assert.equal(converted.toolConfig.functionCallingConfig.mode, 'ANY');
});

test('Antigravity imports credentials, discovers models and forwards streaming tools with usage', async () => {
  const channel = antigravityChannel(async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-access');
    if (String(url).endsWith('fetchAvailableModels')) return Response.json({ models: { 'gemini-test': { displayName: 'Gemini Test' } } });
    assert.equal(String(url), 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    const body = JSON.parse(String(init?.body)); assert.equal(body.project, 'project'); assert.equal(body.model, 'gemini-test');
    return new Response([
      { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'sig' }] } }] } },
      { response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 } } },
    ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const auth = await channel.auth.methods[1].authorize!({ credentials: JSON.stringify({ type: 'antigravity', access_token: 'fake-access', project_id: 'project', email: 'fake@example.com' }) }) as SubscriptionAuth;
  assert.equal(auth.accountName, 'fake@example.com');
  assert.deepEqual(Object.keys(await channel.models(auth)), ['gemini-test']);
  const transport = await channel.auth.transport(async () => auth);
  const response = await transport.fetch!('https://unused.example', { method: 'POST', body: JSON.stringify({ model: 'gemini-test', stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
  const text = await response.text();
  assert.match(text, /thought_signature/); assert.match(text, /"finish_reason":"tool_calls"/); assert.match(text, /"total_tokens":7/); assert.match(text, /\[DONE\]/);
  assert.ok(!text.includes('fake-access'));
});

test('Antigravity refresh rotates credentials and retains account project', async () => {
  const channel = antigravityChannel(async (url, init) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'old-refresh');
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
  });
  const auth = await channel.auth.refresh!({ type: 'oauth', refresh: 'old-refresh', project: 'project' });
  assert.equal(auth?.access, 'new-access'); assert.equal(auth?.refresh, 'new-refresh'); assert.equal(auth?.project, 'project');
});

test('Volcengine pay-as-you-go is an explicit choice, separate from Coding Plan', async () => {
  const channel = apiKeyChannel('volcengine');
  const auth = await channel.auth.methods[1].authorize!({ key: 'test-api-key', models: 'ep-test' }) as SubscriptionAuth;
  const transport = await channel.auth.transport(async () => auth);
  assert.equal(transport.baseURL, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.deepEqual(Object.keys(await channel.models(auth)), ['ep-test']);
  await assert.rejects(async () => channel.auth.methods[0].authorize!({ key: 'test-key', models: '' }), /INPUT_INVALID/);
});
