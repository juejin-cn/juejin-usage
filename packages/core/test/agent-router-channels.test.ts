import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer, connect } from 'node:http2';
import { once } from 'node:events';
import { copilotChannel } from '../src/agent-router/channels/copilot.js';
import { minimaxChannel } from '../src/agent-router/channels/minimax.js';
import { workbuddyChannel } from '../src/agent-router/channels/workbuddy.js';
import { qoderChannel, encodeQoderBody } from '../src/agent-router/channels/qoder.js';
import { kimiWorkChannel } from '../src/agent-router/channels/kimi-work.js';
import { grokChannel } from '../src/agent-router/channels/grok.js';
import { kiroChannel, kiroRequest, crc32, awsEvents } from '../src/agent-router/channels/kiro.js';
import { cursorChannel, cursorRequest } from '../src/agent-router/channels/cursor.js';
import { traeChannel } from '../src/agent-router/channels/trae.js';
import { zcodeChannel } from '../src/agent-router/channels/zcode.js';
import { zenFreeChannel } from '../src/agent-router/channels/zen-free.js';
import { TextToolDecoder } from '../src/agent-router/channels/text-tools.js';
import { convertReply } from '../src/agent-router/protocol/index.js';
import { binary, connectFrame, connectFrames, decodeValue, encodeValue, field as f, message as msg, parseProto as parse } from '../src/agent-router/channels/protobuf.js';
import type { SubscriptionAuth, SubscriptionChannel, LoginFlow } from '../src/agent-router/subscription-types.js';
const auth: SubscriptionAuth = { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', uid: 'user1', machineId: 'machine1', expires: Date.now() + 3600000 };
const tool = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
const chat = { model: 'model1', messages: [{ role: 'user', content: 'hello' }], tools: [tool], stream: true };
const sse = (...values: unknown[]) => new Response(values.map(v => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
async function send(channel: SubscriptionChannel, a: SubscriptionAuth = auth, body = chat, url = 'https://unused.example/chat/completions') {
  const transport = await channel.auth.transport(async () => a);
  return transport.fetch!(url, { method: 'POST', headers: { 'x-jusage-session': 'conversation1' }, body: JSON.stringify(body), signal: new AbortController().signal });
}
async function fixture(t: test.TestContext) { const dir = await mkdtemp(join(tmpdir(), 'jusage-channels-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

for (const global of [false, true]) test(`WorkBuddy ${global ? 'international' : 'China'} maps Codex developer instructions to system without changing content`, async () => {
  const original = { ...chat, messages: [{ role: 'system', content: 'Existing system' }, { role: 'developer', content: [{ type: 'text', text: 'Follow these developer instructions.' }] }, { role: 'user', content: 'developer is user text' }] };
  const before = structuredClone(original);
  const channel = workbuddyChannel(global, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.messages, [original.messages[0], { ...original.messages[1], role: 'system' }, original.messages[2]]);
    assert.deepEqual(body.tools, original.tools);
    return sse('[DONE]');
  });
  const transport = await channel.auth.transport(async () => auth);
  await transport.fetch!('https://unused.example/chat/completions', { method: 'POST', body: JSON.stringify(original) });
  assert.deepEqual(original, before);
});

for (const global of [false, true]) test(`WorkBuddy ${global ? 'international' : 'China'} adapts the interactive Claude identity without discarding instructions or tools`, async () => {
  const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
  const instructions = '\nFollow the repository instructions.\nPreserve all user content and tools.';
  const original = { ...chat, messages: [{ role: 'system', content: identity + instructions }, { role: 'user', content: identity }], tools: Array.from({ length: 54 }, (_, i) => ({ ...tool, function: { ...tool.function, name: 'tool_' + i } })) };
  const baseline = structuredClone(original);
  const channel = workbuddyChannel(global, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.messages[0].content, "You are an AI coding assistant running in the user's local CLI." + instructions);
    assert.equal(sent.messages[1].content, identity);
    assert.deepEqual(sent.tools, original.tools); assert.equal(sent.tools.length, 54);
    return sse({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] }, '[DONE]');
  });
  assert.equal((await send(channel, auth, original)).status, 200); assert.deepEqual(original, baseline);
  const sdkIdentity = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
  const sdk = workbuddyChannel(global, async (_url, init) => { assert.equal(JSON.parse(String(init?.body)).messages[0].content, "You are an AI coding assistant running in the user's local CLI."); return sse('[DONE]'); });
  await send(sdk, auth, { ...chat, messages: [{ role: 'system', content: sdkIdentity }] });
  for (const content of ['User instruction: ' + identity, identity + ' Keep this exact custom instruction.']) {
    const unchanged = workbuddyChannel(global, async (_url, init) => { assert.equal(JSON.parse(String(init?.body)).messages[0].content, content); return sse('[DONE]'); });
    await send(unchanged, auth, { ...chat, messages: [{ role: 'system', content }] });
  }
});

test('Copilot signs the actual protocol path, identifies tool continuations and forwards cancellation', async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.githubcopilot.com/chat/completions');
    const h = new Headers(init?.headers); assert.equal(h.get('authorization'), 'Bearer fake-access'); assert.equal(h.get('x-initiator'), 'agent'); assert.equal(h.has('x-jusage-session'), false); assert.ok(init?.signal);
    return Response.json({ choices: [] });
  };
  await send(copilotChannel(fetcher), auth, { ...chat, messages: [{ role: 'tool', content: 'ok' }] });
});

for (const global of [false, true]) test(`MiniMax ${global ? 'international' : 'China'} catalog, rotating token and messages endpoint`, async () => {
  let count = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url)); assert.ok(u.hostname.endsWith(global ? '.io' : '.cn'));
    if (u.pathname === '/oauth2/token') { count++; assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'fake-refresh'); return Response.json({ access_token: 'next', refresh_token: 'new-refresh', expires_in: 3600 }); }
    if (u.pathname.endsWith('/models')) return Response.json({ providers: [{ providerId: 'minimax', config: { models: { model1: { name: 'Model One' } } } }] });
    assert.equal(u.pathname, '/mavis/api/v1/llm/v1/messages'); assert.equal(new Headers(init?.headers).get('x-mavis-session-id'), 'conversation1'); return new Response('{"error":"quota exhausted"}', { status: 403 });
  };
  const channel = minimaxChannel(global, fetcher); assert.deepEqual(Object.keys(await channel.models(auth)), ['model1']);
  assert.equal((await channel.auth.refresh!(auth))?.refresh, 'new-refresh'); assert.equal(count, 1);
  assert.equal((await send(channel, auth, chat, `https://agent.minimax.${global ? 'io' : 'cn'}/mavis/api/v1/llm/v1/messages`)).status, 429);
});

for (const global of [false, true]) test(`WorkBuddy ${global ? 'international' : 'China'} selects CLI models and keeps one turn across tool steps`, async () => {
  const turns: string[] = [];
  const channel = workbuddyChannel(global, async (url, init) => {
    assert.equal(new URL(String(url)).hostname, global ? 'www.workbuddy.ai' : 'copilot.tencent.com');
    if (String(url).endsWith('/v3/config')) return Response.json({ code: 0, data: { agents: [{ name: 'cli', models: ['model1'] }], models: [{ id: 'model1' }, { id: 'other' }] } });
    const h = new Headers(init?.headers); assert.equal(h.get('X-Enterprise-Id'), 'team1'); assert.equal(h.get('X-Tenant-Id'), 'team1'); turns.push(h.get('X-Conversation-Request-ID')!);
    assert.equal(JSON.parse(String(init?.body)).stream, true); return sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]');
  });
  const account = { ...auth, enterpriseId: 'team1' };
  assert.deepEqual(Object.keys(await channel.models(account)), ['model1']);
  const endpoint = `https://${global ? 'www.workbuddy.ai' : 'copilot.tencent.com'}/v2/chat/completions`;
  await (await send(channel, account, chat, endpoint)).text();
  await (await send(channel, account, { ...chat, messages: [...chat.messages, { role: 'assistant', content: 'tool' }, { role: 'tool', content: 'result' }] }, endpoint)).text();
  assert.equal(turns[0], turns[1]);
});

for (const id of ['qoder', 'qoder-cn', 'qwenwork', 'qwenwork-enterprise'] as const) test(`${id} signs encoded requests, streams native tools and preserves quota fallback`, async () => {
  let reject = false; let requests = 0;
  const channel = qoderChannel(id, async (url, init) => {
    const h = new Headers(init?.headers); assert.match(h.get('authorization')!, /^Bearer COSY\./); assert.equal(h.get('Cosy-User'), 'user1');
    if (String(url).includes('/model/list')) return Response.json({ app: [{ key: 'model1', enable: true }], qwork: [{ key: 'model1' }] });
    requests++; assert.ok(String(init?.body).length); assert.equal(h.has('x-jusage-session'), false);
    if (reject) return sse({ statusCodeValue: 403, body: JSON.stringify({ code: 10605 }) });
    return sse({ statusCodeValue: 200, body: JSON.stringify({ id: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] }, finish_reason: null }] }) }, { body: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) }, { body: '[DONE]' });
  });
  const account = { ...auth, host: 'https://office.example.com' };
  assert.deepEqual(Object.keys(await channel.models(account)), ['model1']);
  const reply = await send(channel, account); const raw = await reply.text(); assert.match(raw, /tool_calls/); assert.match(raw, /call1/); assert.match(raw, /\[DONE\]/);
  reject = true; assert.equal((await send(channel, account)).status, 429); assert.equal(requests, 2);
});

test('Qoder codec roundtrips UTF-8 protocol payload without modifying tools or sessions', () => {
  const payload = { session_id: 's1', text: '你好', tools: [tool] };
  const encoded = encodeQoderBody(payload); const n = Math.floor(encoded.length / 3); const swapped = encoded.slice(-n) + encoded.slice(n, -n) + encoded.slice(0, n);
  const alphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
  const decoded = [...swapped].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='[alphabet.indexOf(c)]).join('');
  assert.deepEqual(JSON.parse(Buffer.from(decoded, 'base64').toString()), payload);
});

test('Kimi Work references local accounts, survives desktop account switches and never writes refresh credentials', async t => {
  const dir = await fixture(t); const file = join(dir, 'config.json');
  const config = (uid: string, key: string) => ({ credentials: { kimiWeb: { userId: uid, accessToken: 'web-access', refreshToken: 'desktop-owned' }, kimiCode: { apiKey: key, baseUrl: 'https://agent-gw.kimi.com/coding/v1' } } });
  await writeFile(file, JSON.stringify(config('alice', 'alice-key')));
  let expected = 'alice-key';
  const channel = kimiWorkChannel(async (_url, init) => { assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + expected); return Response.json({ data: [{ id: 'model1' }] }); }, () => dir);
  const a = await channel.auth.methods[0].authorize!() as SubscriptionAuth; assert.equal(a.access, undefined); assert.equal(a.refresh, undefined);
  await channel.models(a);
  await writeFile(file, JSON.stringify(config('bob', 'bob-key'))); await writeFile(join(dir, 'kimi-code-key.json'), JSON.stringify({ v: 2, keys: [{ userId: 'alice', apiKey: 'alice-key' }] }));
  await channel.models(a); expected = 'bob-key'; const b = await channel.auth.methods[0].authorize!() as SubscriptionAuth; await channel.models(b);
  await writeFile(join(dir, 'kimi-code-key.json'), '{}'); await assert.rejects(channel.models(a));
});

test('Grok uses current local credentials only for the authorized account', async t => {
  const dir = await fixture(t); const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({ scope: { key: 'alice-key', user_id: 'alice', expires_at: new Date(Date.now() + 60000).toISOString() } }));
  const channel = grokChannel(async (_url, init) => { assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer alice-key'); return Response.json({ data: [{ id: 'model1', api_backend: 'responses' }, { id: 'wrong', api_backend: 'chat' }] }); }, () => path);
  const a = await channel.auth.methods[0].authorize!() as SubscriptionAuth; assert.deepEqual(Object.keys(await channel.models(a)), ['model1']);
  await writeFile(path, JSON.stringify({ scope: { key: 'bob-key', user_id: 'bob' } })); await assert.rejects(channel.models(a), /LOGIN_REQUIRED/);
});

function awsFrame(type: string, value: unknown) {
  const header = (k: string, v: string) => { const len = Buffer.alloc(2); len.writeUInt16BE(Buffer.byteLength(v)); return Buffer.concat([Buffer.from([k.length]), Buffer.from(k), Buffer.from([7]), len, Buffer.from(v)]); };
  const headers = Buffer.concat([header(':message-type', 'event'), header(':event-type', type)]); const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(16 + headers.length + payload.length); result.writeUInt32BE(result.length); result.writeUInt32BE(headers.length, 4); result.writeUInt32BE(crc32(result.subarray(0, 8)), 8); headers.copy(result, 12); payload.copy(result, 12 + headers.length); result.writeUInt32BE(crc32(result.subarray(0, -4)), result.length - 4); return result;
}
test('Kiro validates checksums, carries tool history and translates binary tool streams', async t => {
  const dir = await fixture(t); const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({ accessToken: 'kiro-access', profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/a', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const wire = Buffer.concat([awsFrame('assistantResponseEvent', { content: 'hello' }), awsFrame('toolUseEvent', { toolUseId: 'tool1', name: 'read', input: '{"path":"a"}', stop: true }), awsFrame('metadataEvent', { tokenUsage: { inputTokens: 5, outputTokens: 2 } })]);
  const channel = kiroChannel(async (url, init) => {
    if (String(url).includes('List-Available-Models')) return Response.json({ models: [{ modelId: 'model1', modelName: 'Model One' }] });
    assert.equal(new URL(String(url)).pathname, '/generateAssistantResponse'); const body = JSON.parse(String(init?.body)); assert.equal(body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.name, 'read');
    return new Response(wire);
  }, () => path);
  const a = await channel.auth.methods[0].authorize!() as SubscriptionAuth; assert.deepEqual(Object.keys(await channel.models(a)), ['model1']);
  const raw = await (await send(channel, a)).text(); assert.match(raw, /hello/); assert.match(raw, /tool1/); assert.match(raw, /prompt_tokens/);
  const broken = Buffer.from(wire); broken[20] ^= 1;
  await assert.rejects(async () => { for await (const _ of awsEvents(new Response(broken).body!)) {} });
  const converted = kiroRequest({ ...chat, messages: [...chat.messages, { role: 'assistant', content: '', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call1', content: 'ok' }] }, 'profile');
  assert.equal(converted.body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].toolUseId, 'call1');
});

for (const global of [false, true]) test(`Trae ${global ? 'international' : 'China'} callback, catalog and SSE conversion`, async () => {
  const channel = traeChannel(global, async (url, init) => {
    if (String(url).includes('get_detail_param')) return Response.json({ config_info_list: [{ config_name: 'model1', usage: 'chat_completion' }] });
    assert.equal(new URL(String(url)).pathname, '/api/agent/v3/llm_utils_chat'); assert.equal(new Headers(init?.headers).get('authorization'), 'Cloud-IDE-JWT trae-access');
    const body = JSON.parse(String(init?.body)); assert.equal(body.session_id, 'conversation1'); assert.equal(body.function, 'chat_v3');
    return new Response('event: output\ndata: {"response":"hello"}\n\nevent: done\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const flow = await channel.auth.methods[0].authorize!() as LoginFlow;
  const callback = new URL(new URL(flow.url!).searchParams.get('auth_callback_url')!);
  callback.searchParams.set('userJwt', JSON.stringify({ Token: 'trae-access', RefreshToken: 'trae-refresh' })); callback.searchParams.set('userInfo', JSON.stringify({ UserID: 'user1' }));
  assert.equal((await fetch(callback)).status, 200); const a = await flow.callback(); assert.deepEqual(Object.keys(await channel.models(a)), ['model1']);
  assert.match(await (await send(channel, a)).text(), /hello/);
});

test('ZCode creates only the application key in an unambiguous personal project', async () => {
  let created = 0;
  const channel = zcodeChannel(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/client/configs')) return Response.json({ data: { configs: { builtin_provider_config_json: 'https://catalog.example/config.json' } } });
    if (path === '/config.json') return Response.json({ config: { providerConfigRules: { providerRules: [{ providerId: 'account:bigmodel-individual-coding-plan', builtinModelIds: ['model1'] }] } } });
    if (path.endsWith('/init')) return Response.json({ code: 0, data: { flow_id: 'flow1', authorize_url: 'https://bigmodel.cn/login' } });
    if (path.includes('/poll/')) return Response.json({ code: 0, data: { status: 'ready', bigmodel: { access_token: 'business-token' }, user: { user_id: 'u1' } } });
    if (path.endsWith('getCustomerInfo')) return Response.json({ data: { organizations: [{ organizationId: 'org', projects: [{ projectId: 'project', projectType: 1 }] }] } });
    if (path.endsWith('/api_keys')) { if (init?.method === 'POST') { assert.equal(JSON.parse(String(init.body)).name, 'jusage-api-key'); created++; return Response.json({ data: { apiKey: 'id1' } }); } return Response.json({ data: [] }); }
    if (path.endsWith('/copy/id1')) return Response.json({ data: { secretKey: 'secret1' } });
    assert.equal(path, '/api/anthropic/v1/messages'); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer id1.secret1'); return Response.json({ content: [] });
  });
  const flow = await channel.auth.methods[0].authorize!({ site: 'bigmodel' }) as LoginFlow; const a = await flow.callback(); assert.equal(created, 1); assert.deepEqual(Object.keys(await channel.models(a)), ['model1']); await send(channel, a);
});

test('Zen free catalog excludes paid and unsupported protocols and never invents client tools', async () => {
  let requests = 0;
  const channel = zenFreeChannel(async (url, init) => {
    if (String(url).includes('api.json')) return Response.json({ opencode: { npm: '@ai-sdk/openai-compatible', models: { model1: { cost: { input: 0, output: 0 } }, paid: { cost: { input: 1, output: 1 } } } } });
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'model1' }, { id: 'paid' }] });
    requests++; assert.deepEqual(JSON.parse(String(init?.body)).tools, [tool]); return Response.json({ choices: [] });
  });
  assert.deepEqual(Object.keys(await channel.models(auth)), ['model1']); await send(channel);
  assert.equal((await send(channel, auth, { ...chat, model: 'paid' })).status, 404); assert.equal(requests, 1);
});

test('text tool decoder handles split XML/JSON, string schemas and quoted examples without executing unknown tools', () => {
  const d = new TextToolDecoder([tool]); assert.deepEqual(d.feed('<tool_'), []);
  assert.deepEqual(d.feed('call>{"name":"read","arguments":{"path":"a"}}</tool_call>'), [{ name: 'read', arguments: '{"path":"a"}' }]);
  assert.deepEqual(d.feed('<function=read><parameter=path>[1,2]</parameter></function>'), [{ name: 'read', arguments: '{"path":"[1,2]"}' }]);
  assert.ok(d.feed('`<tool_call>{"name":"read","arguments":{}}</tool_call>`').every(p => !p.name));
  assert.throws(() => new TextToolDecoder([tool]).feed('<tool_call>{', true), /TRUNCATED_TOOL/);
});

test('protobuf values preserve nested tool arguments and reject malformed frames', async () => {
  const value = { name: '工具', active: true, count: 1.5, items: [null, 'a'] }; assert.deepEqual(JSON.parse(JSON.stringify(decodeValue(encodeValue(value)))), value);
  assert.throws(() => parse(Buffer.from([0x0a, 0xff])));
  await assert.rejects(async () => { for await (const _ of connectFrames(Readable.from([Buffer.from([0, 0, 0])])) ) {} });
  const built = cursorRequest(chat, 'session1'); assert.ok(built.blobs.size >= 2); assert.ok(binary(parse(built.first), 1).length);
});

test('Cursor owns a cancellable HTTP/2 Run and translates a complete tool batch without running tools locally', async t => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sessions = new Set<import('node:http2').ServerHttp2Session>(); server.on('session', s => { sessions.add(s); s.on('close', () => sessions.delete(s)); });
  t.after(() => { for (const s of sessions) s.destroy(); server.close(); });
  server.on('stream', stream => {
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    stream.once('data', () => {
      stream.write(connectFrame(f(1, f(27, f(1, 2)))));
      for (let i = 0; i < 2; i++) stream.write(connectFrame(f(2, msg(f(1, i), f(15, 'exec' + i), f(11, msg(f(1, 'jusage-read'), f(3, 'call' + i), f(4, 'jusage'), f(5, 'read'), f(2, msg(f(1, 'path'), f(2, encodeValue('a' + i))))))))));
    });
  });
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const channel = cursorChannel(async () => Response.json({ agentUrlConfig: { agentUrl: 'https://agentn.global.api5.cursor.sh' } }), (() => connect(local)) as typeof connect);
  const response = await send(channel); const raw = await response.text(); assert.match(raw, /call0/); assert.match(raw, /call1/); assert.match(raw, /tool_calls/); assert.match(raw, /\[DONE\]/);
});

test('stream-only upstream replies still satisfy non-streaming gateway clients', async () => {
  const upstream = sse({ id: 'one', choices: [{ delta: { content: 'hi' }, finish_reason: null }] }, { id: 'one', choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]');
  const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream); const reply = convertReply({ status: 200, headers: { 'content-type': 'text/event-stream' }, body, dispose: () => body.destroy() }, 'chat', 'chat', 'test', false, new AbortController().signal);
  let raw = ''; for await (const part of reply.body) raw += part; assert.equal(JSON.parse(raw).choices[0].message.content, 'hi');
});

test('Qwen office refresh uses the device-token target and carries rotated credentials', async () => {
  for (const id of ['qwenwork', 'qwenwork-enterprise'] as const) {
    const channel = qoderChannel(id, async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/api/v1/deviceToken/refresh');
      assert.deepEqual(JSON.parse(String(init?.body)), { refresh_token: 'fake-refresh', target: 'c' });
      return Response.json({ token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600 });
    });
    const result = await channel.auth.refresh!({ ...auth, host: 'https://office.example.com', deviceChat: true });
    assert.equal(result?.refresh, 'next-refresh'); assert.equal(result?.uid, 'user1');
  }
});

test('native agent bridges reject forced tool selection instead of silently changing it', () => {
  for (const choice of ['required', { type: 'function', function: { name: 'read' } }]) {
    assert.throws(() => cursorRequest({ ...chat, tool_choice: choice }, 's'), /TOOL_CHOICE_UNSUPPORTED/);
    assert.throws(() => kiroRequest({ ...chat, tool_choice: choice }, 'p'), /TOOL_CHOICE_UNSUPPORTED/);
  }
  assert.equal(cursorRequest({ ...chat, tool_choice: 'none' }, 's').tools.length, 0);
});

for (const global of [false, true]) test(`WorkBuddy ${global ? 'global' : 'China'} reads credits without sending chat or modifying credentials`, async () => {
  const calls: string[] = [];
  const account = { ...auth, enterpriseId: 'team1' };
  const before = JSON.stringify(account);
  let data: Record<string, unknown> = { IsPaidUser: true, Packages: [{ CycleTotalCapacity: '100', CycleUsedCapacity: '20.5' }, { CycleTotalCapacity: 50, CycleUsedCapacity: 10 }, { CycleRemainCapacity: '12.25' }] };
  const channel = workbuddyChannel(global, async (url, init) => {
    const u = new URL(String(url)); calls.push(u.pathname);
    assert.equal(u.hostname, global ? 'www.workbuddy.ai' : 'copilot.tencent.com');
    assert.equal(init?.method, 'POST'); assert.equal(init?.body, '{}');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer fake-access');
    assert.equal(headers.get('x-user-id'), 'user1'); assert.equal(headers.get('x-enterprise-id'), 'team1');
    return Response.json({ code: 0, data: u.pathname.endsWith('get-enterprise-user-usage') ? { limitNum: '800', credit: '125', cycleResetTime: '2026-12-01 00:00:00' } : data });
  });
  const { sanitizeUsage } = await import('../src/agent-router/usage.js');
  const read = async () => sanitizeUsage(await channel.auth.usage!(async () => account));
  const quota = await read();
  assert.equal(quota.plan, 'Pro'); assert.equal(quota.state, 'available');
  assert.deepEqual(quota.windows, [{ percent: 30.5 / 150 * 100, used: 30.5, limit: 150, unit: 'credits' }, { remaining: 12.25, unit: 'credits' }]);
  data = { Packages: [] };
  const enterprise = await read();
  assert.equal(enterprise.plan, 'Enterprise'); assert.equal(enterprise.windows[0].remaining, undefined);
  assert.equal(enterprise.windows[0].limit, 800); assert.equal(enterprise.windows[0].used, 125);
  assert.equal(enterprise.windows[0].resetsAt, '2026-11-30T16:00:00.000Z');
  data = { Packages: [{ CycleRemainCapacity: '0' }] };
  assert.deepEqual((await read()).windows, [{ remaining: 0, unit: 'credits' }]);
  data = { Packages: [{ CycleTotalCapacity: 'invalid' }] };
  await assert.rejects(read, /SUBSCRIPTION_INVALID_RESPONSE/);
  assert.equal(JSON.stringify(account), before);
  assert.ok(calls.every(path => path.startsWith('/billing/meter/')));
});

test('WorkBuddy quota distinguishes upstream failure, absent packages, and unsupported API keys', async () => {
  const { readSubscriptionDetails } = await import('../src/agent-router/usage.js');
  const channel = workbuddyChannel(false, async url => {
    if (String(url).includes('/accounts')) return Response.json({ code: 0, data: { accounts: [{ uid: 'user1', nickname: 'Alice' }] } });
    return Response.json({ code: 500, data: {} });
  });
  const result = await readSubscriptionDetails('workbuddy', channel, async () => auth);
  assert.equal(result.quotaError, true); assert.equal(result.accountName, 'Alice'); assert.equal(result.state, 'unknown');
  const absent = workbuddyChannel(false, async () => Response.json({ code: 0, data: { TotalCredits: 999 } }));
  assert.deepEqual((await absent.auth.usage!(async () => auth) as { windows: unknown[] }).windows, []);
  const api = workbuddyChannel(false, async () => { throw new Error('must not query billing with an API key'); });
  assert.deepEqual(await api.auth.usage!(async () => ({ type: 'api', key: 'fake-key' })), {});
});

for (const id of ['qoder', 'qoder-cn'] as const) test(`${id} queries account credit pools with device credentials and preserves chat auth`, async () => {
  const { readSubscriptionDetails } = await import('../src/agent-router/usage.js');
  const account = { ...auth, deviceToken: 'device-only' };
  const before = JSON.stringify(account);
  let status = 200;
  let payload: unknown = { displayMode: 'qoder', qoderUsage: { user_type: 'personal_professional', user_quota: { total: 100, used: 25 }, add_on_quota: { total: 50, remaining: 20 }, org_resource_package: { cap: 200, used: 10 }, dedicated_resource_packages: [{ total: 30, used: 5 }] } };
  const channel = qoderChannel(id, async (url, init) => {
    assert.equal(String(url), `https://${id === 'qoder' ? 'openapi.qoder.sh' : 'openapi.qoder.com.cn'}/sash/api/v2/me/usage`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer device-only'); assert.equal(headers.get('Cosy-ClientType'), '10');
    assert.equal(init?.body, undefined);
    return Response.json(payload, { status });
  });
  const read = () => readSubscriptionDetails(id, channel, async () => account);
  const result = await read();
  assert.equal(result.plan, 'Pro'); assert.equal(result.windows.length, 4);
  assert.deepEqual(result.windows[0], { percent: 25, used: 25, limit: 100, remaining: 75, unit: 'credits' });
  assert.equal(result.windows[1].used, 30); assert.equal(result.windows[1].remaining, 20);
  payload = { displayMode: 'qoder', qoderUsage: { userQuota: { total: 0, used: 0 }, addOnQuota: { total: 100, remaining: 80 } } };
  assert.equal((await read()).windows[1].remaining, 80);
  payload = { displayMode: 'qoder', qoderUsage: { userQuota: { total: 0 } } };
  assert.equal((await read()).windows[0].remaining, 0);
  payload = { displayMode: 'qoder', qoderUsage: {} };
  assert.equal((await read()).state, 'unknown');
  payload = { unexpected: true };
  assert.equal((await read()).quotaError, true);
  status = 401;
  const denied = await read();
  assert.equal(denied.quotaAuthRequired, true); assert.notEqual(denied.state, 'expired');
  assert.equal(JSON.stringify(account), before);
});

test('Qoder old accounts try their existing credential and device-chat uses the refreshed access token', async () => {
  for (const account of [auth, { ...auth, deviceChat: true, deviceToken: 'stale-device' }]) {
    const channel = qoderChannel('qoder-cn', async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-access');
      return Response.json({ displayMode: 'enterprise' });
    });
    assert.deepEqual(await channel.auth.usage!(async () => account), { plan: 'Enterprise', windows: [] });
  }
});

for (const id of ['qoder', 'qoder-cn'] as const) test(`${id} login saves separate device and chat credentials`, async () => {
  const channel = qoderChannel(id, async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/deviceToken/poll')) return Response.json({ token: 'device-token', refresh_token: 'device-refresh' });
    if (path.endsWith('/me/jobToken')) return Response.json({ token: 'job-token', refresh_token: 'job-refresh' });
    if (path.endsWith('/userinfo')) return Response.json({ id: 'user1', email: 'alice@example.com' });
    throw new Error('unexpected request');
  });
  const flow = await channel.auth.methods[0].authorize!() as LoginFlow;
  const saved = await flow.callback();
  assert.equal(saved.access, 'job-token'); assert.equal(saved.refresh, 'job-refresh');
  assert.equal(saved.deviceToken, 'device-token'); assert.equal(saved.deviceRefresh, 'device-refresh');
});

for (const global of [false, true]) test(`WorkBuddy ${global ? 'international' : 'China'} adapts only the stock Harness identity and preserves its working directory, history and tools`, async () => {
  const persona = 'You are an AI agent powered by DeepSeek Harness.';
  const instructions = '\nYour working directory is /tmp/fixture.\nFollow all repository instructions.\nKeep user files.';
  const original = { ...chat, messages: [{ role: 'system', content: persona + instructions }, { role: 'user', content: persona }] };
  const baseline = structuredClone(original);
  const channel = workbuddyChannel(global, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.messages[0].content, "You are an AI coding assistant running in the user's local CLI." + instructions);
    assert.equal(sent.messages[1].content, persona); assert.deepEqual(sent.tools, original.tools);
    return sse('[DONE]');
  });
  await send(channel, auth, original); assert.deepEqual(original, baseline);
  for (const content of ['Custom instruction: ' + persona, 'You are a coding agent powered by the model model. Keep this exact.']) {
    const unchanged = workbuddyChannel(global, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).messages[0].content, content); return sse('[DONE]');
    });
    await send(unchanged, auth, { ...chat, messages: [{ role: 'system', content }] });
  }
});
