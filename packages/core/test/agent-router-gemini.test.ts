import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { AgentGateway, RouterCredentials, type Protocol } from '../src/agent-router/index.js';
import { convertRequest, convertReply } from '../src/agent-router/protocol/index.js';
import { NativeStateStore } from '../src/agent-router/protocol/native-state.js';
import { featureHeaders } from '../src/agent-router/protocol/features.js';
import { parseGeminiRoute, geminiDestination } from '../src/agent-router/gemini-route.js';
import type { Wire } from '../src/agent-router/protocol/request.js';
import { pullProviderModelCatalog } from '../src/agent-router/models.js';

const history: Wire = { model: 'p/m', systemInstruction: { parts: [{ text: 'system' }] }, contents: [
  { role: 'user', parts: [{ text: 'read' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
  { role: 'model', parts: [{ functionCall: { id: 'native', name: 'read', args: { path: 'a' } } }] },
  { role: 'user', parts: [{ functionResponse: { id: 'native', name: 'read', response: { output: 'A' } } }] },
], tools: [{ functionDeclarations: [{ name: 'read', parametersJsonSchema: { type: 'object', properties: { path: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['path'] } }] }], generationConfig: { maxOutputTokens: 100, temperature: 0.2 } };
const geminiReply: Wire = { candidates: [{ content: { role: 'model', parts: [{ text: '你好' }, { functionCall: { id: 'native', name: 'read', args: { path: 'a' } }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 3 } };
async function reply(value: Wire | string, source: Protocol, target: Protocol, stream = false, store?: NativeStateStore): Promise<Wire | string> {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const input = Readable.from(Array.from(Buffer.from(raw), n => Buffer.from([n])));
  const converted = convertReply({ status: 200, headers: { 'content-type': typeof value === 'string' ? 'text/event-stream' : 'application/json' }, body: input, dispose() { input.destroy(); } }, source, target, 'p/m', stream, new AbortController().signal, store?.exchange('origin', source));
  let out = ''; for await (const chunk of converted.body) out += chunk.toString();
  return stream ? out : JSON.parse(out);
}
for (const protocol of ['chat', 'messages', 'responses'] as const) {
  test(`Gemini ↔ ${protocol}: ordered tool history, image, schema and generation controls`, () => {
    const original = structuredClone(history);
    const converted = convertRequest(history, 'gemini', protocol);
    const back = convertRequest(converted, protocol, 'gemini');
    assert.deepEqual(history, original);
    assert.equal(back.systemInstruction.parts[0].text, 'system');
    assert.equal(back.contents[1].parts[0].functionCall.id, 'native');
    assert.equal(back.contents[2].parts[0].functionResponse.name, 'read');
    assert.deepEqual(back.tools[0].functionDeclarations[0].parametersJsonSchema, history.tools[0].functionDeclarations[0].parametersJsonSchema);
    assert.equal(back.generationConfig.maxOutputTokens, 100);
    assert.equal(back.contents[0].parts[1].inlineData.mimeType, 'image/png');
  });
  test(`Gemini → ${protocol}: JSON and fragmented SSE with native state round trip`, async () => {
    for (const stream of [false, true]) {
      const store = new NativeStateStore();
      const raw = stream ? `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '你好' }] } }] })}\r\n\r\ndata: ${JSON.stringify({ ...geminiReply, candidates: [{ ...geminiReply.candidates[0], content: { parts: geminiReply.candidates[0].content.parts.slice(1) } }] })}\r\n\r\n` : geminiReply;
      const result = await reply(raw, 'gemini', protocol, stream, store);
      const values = stream ? String(result).split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6))) : [];
      const json = stream ? protocol === 'responses' ? values.at(-1).response : null : result as Wire;
      const call = protocol === 'chat' ? stream ? values.find(v => v.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0] : json!.choices[0].message.tool_calls[0]
        : protocol === 'messages' ? stream ? values.find(v => v.content_block?.type === 'tool_use').content_block : json!.content.find((b: Wire) => b.type === 'tool_use')
          : json!.output.find((b: Wire) => b.type === 'function_call');
      const id = call.id ?? call.call_id; const clientId = protocol === 'responses' ? call.call_id : id;
      assert.match(clientId, /^call_jusage_[a-f0-9]{32}$/); assert.ok(!JSON.stringify(result).includes('opaque-signature'));
      const chat = { model: 'm', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: clientId, type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: clientId, content: 'A' }] };
      const restored = convertRequest(chat, 'chat', 'gemini', store.exchange('origin', 'gemini'));
      assert.equal(restored.contents[0].parts[0].thoughtSignature, 'opaque-signature');
      assert.equal(restored.contents[1].parts[0].functionResponse.id, 'native');
      assert.equal(chat.messages[0].tool_calls?.[0].id, clientId, 'restoration must not mutate client history');
    }
  });
  test(`${protocol} → Gemini JSON and SSE preserve text, tools, totals and terminal event`, async () => {
    const native = protocol === 'chat' ? { choices: [{ message: { content: 'hello', tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 2 } } }
      : protocol === 'messages' ? { type: 'message', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'a', name: 'read', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 6 } }
        : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }, { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' }], status: 'completed', usage: { input_tokens: 10, output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 } } };
    const json = await reply(native, protocol, 'gemini') as Wire;
    assert.equal(json.candidates[0].content.parts[0].text, 'hello'); assert.equal(json.candidates[0].content.parts[1].functionCall.name, 'read'); assert.equal(json.usageMetadata.totalTokenCount, 16);
    const sse = await reply(native, protocol, 'gemini', true) as string;
    assert.ok(!sse.includes('event: undefined')); assert.ok(sse.includes('"finishReason":"STOP"')); assert.ok(sse.indexOf('hello') < sse.indexOf('finishReason'));
  });
}
test('Gemini path decodes once and recognizes the last action without splitting model slashes or colons', () => {
  assert.deepEqual(parseGeminiRoute('/v1beta/models/p%2Ffamily%2Fmodel%3Atier:streamGenerateContent'), { model: 'p/family/model:tier', action: 'streamGenerateContent' });
  assert.deepEqual(parseGeminiRoute('/v1beta/models/p/family/model:tier:generateContent'), { model: 'p/family/model:tier', action: 'generateContent' });
  assert.throws(() => parseGeminiRoute('/v1beta/models/%xx:generateContent'), /INVALID_MODEL_PATH/);
  assert.equal(geminiDestination('https://api.example/v1beta', 'family/model:tier', 'streamGenerateContent').href, 'https://api.example/v1beta/models/family%2Fmodel%3Atier:streamGenerateContent?alt=sse');
});
test('native Schema enum types, nullable values and integer bounds convert without losing constraints', () => {
  const native = { ...history, tools: [{ functionDeclarations: [{ name: 'read', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', nullable: true, minLength: '2', enum: ['ab', 'cd'] } }, required: ['path'] } }] }] };
  const chat = convertRequest(native, 'gemini', 'chat');
  assert.deepEqual(chat.tools[0].function.parameters, { type: 'object', properties: { path: { anyOf: [{ type: 'string', minLength: 2, enum: ['ab', 'cd'] }, { type: 'null' }] } }, required: ['path'] });
  assert.equal(native.tools[0].functionDeclarations[0].parameters.properties.path.type, 'STRING');
  assert.throws(() => convertRequest({ ...history, tools: [{ functionDeclarations: [{ name: 'read', parameters: { type: 'OBJECT' }, parametersJsonSchema: { type: 'object' } }] }] }, 'gemini', 'chat'), /SCHEMA_CONFLICT/);
});
test('Gemini truncation, error, safety block and unsupported semantic features are explicit', async () => {
  await assert.rejects(reply('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n', 'gemini', 'messages'), /TRUNCATED_STREAM/);
  await assert.rejects(reply({ error: { status: 429 } }, 'gemini', 'chat'), /UPSTREAM_PROTOCOL_ERROR/);
  const blocked = await reply({ promptFeedback: { blockReason: 'SAFETY' } }, 'gemini', 'chat') as Wire;
  assert.equal(blocked.choices[0].finish_reason, 'content_filter');
  for (const extra of [{ cachedContent: 'private' }, { tools: [{ googleSearch: {} }] }, { generationConfig: { thinkingConfig: { thinkingBudget: 100 } } }]) assert.throws(() => convertRequest({ ...history, ...extra }, 'gemini', 'chat'), /UNSUPPORTED/);
  assert.throws(() => convertRequest({ model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'x' }, defer_loading: true }] }, 'chat', 'gemini'), /TOOL_FEATURE/);
});
test('client headers are whitelisted per protocol; client credentials never reach the provider', () => {
  const h = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'context-1', authorization: 'Bearer client', 'x-api-key': 'client', cookie: 'secret' };
  assert.deepEqual(featureHeaders(h, 'messages', 'messages'), { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'context-1' });
  assert.deepEqual(featureHeaders(h, 'messages', 'chat'), {});
  assert.throws(() => featureHeaders({ 'anthropic-version': '2099-01-01' }, 'messages', 'messages'), /UNSUPPORTED/);
});

test('Gemini tool snapshots replace arguments without repeating the tool or losing late signatures', async () => {
  const snapshots = [
    { candidates: [{ content: { parts: [{ text: 'working' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { id: 'a', name: 'read', args: { path: '' } } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { id: 'a', name: 'read', args: { path: 'complete' } }, thoughtSignature: 'late-signature' }] }, finishReason: 'STOP' }] },
  ].map(v => `data: ${JSON.stringify(v)}\n\n`).join('');
  const store = new NativeStateStore(); const out = await reply(snapshots, 'gemini', 'responses', true, store) as string;
  const frames = out.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
  const calls = frames.at(-1).response.output.filter((b: Wire) => b.type === 'function_call');
  assert.equal(calls.length, 1); assert.equal(calls[0].arguments, '{"path":"complete"}');
  const restored = convertRequest({ input: [calls[0], { type: 'function_call_output', call_id: calls[0].call_id, output: 'OK' }] }, 'responses', 'gemini', store.exchange('origin', 'gemini'));
  assert.equal(restored.contents[0].parts[0].thoughtSignature, 'late-signature');
});

test('same-protocol Gemini SSE aggregation retains signatures and optional native call IDs', async () => {
  const raw = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true, thoughtSignature: 'thought-state' }, { functionCall: { name: 'read', args: {} }, thoughtSignature: 'tool-state' }] }, finishReason: 'STOP' }] })}\n\n`;
  const json = await reply(raw, 'gemini', 'gemini') as Wire;
  assert.equal(json.candidates[0].content.parts[0].thoughtSignature, 'thought-state');
  assert.equal(json.candidates[0].content.parts[1].thoughtSignature, 'tool-state');
  assert.equal(json.candidates[0].content.parts[1].functionCall.id, undefined);
});

test('Gemini HTTP entry: native paths/auth/model catalog/counting and cross-protocol generation', async t => {
  const received: Array<{ url: string; key: string; body: Wire }> = [];
  const server = createServer((req, res) => { void (async () => {
    let raw = ''; for await (const c of req) raw += c;
    received.push({ url: req.url!, key: req.headers['x-goog-api-key'] as string, body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.endsWith(':countTokens') ? { totalTokens: 17 } : geminiReply));
  })(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { KEY: 'upstream-only' }; const gateway = new AgentGateway(new RouterCredentials(env));
  await gateway.start({ version: 1, port: 0, groups: [], providers: [{ id: 'p', name: 'Google', enabled: true, protocol: 'gemini', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta`, models: ['family/m:tier'], auth: { kind: 'env', variable: 'KEY' } }] }); t.after(() => gateway.stop());
  const base = gateway.status().baseUrl!.replace(/\/v1$/, '');
  const headers = { 'x-goog-api-key': gateway.token(), 'content-type': 'application/json' };
  const models = await (await fetch(base + '/v1beta/models', { headers })).json() as Wire;
  assert.equal(models.models[0].name, 'models/p/family/m:tier');
  assert.equal((await fetch(base + '/v1beta/models/p%2Ffamily%2Fm%3Atier', { headers })).status, 200);
  const generate = await fetch(base + '/v1beta/models/p%2Ffamily%2Fm%3Atier:generateContent', { method: 'POST', headers, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }) });
  assert.equal(generate.status, 200); await generate.text();
  assert.equal(received[0].url, '/v1beta/models/family%2Fm%3Atier:generateContent'); assert.equal(received[0].key, 'upstream-only'); assert.equal(received[0].body.model, undefined);
  const count = await fetch(base + '/v1beta/models/p%2Ffamily%2Fm%3Atier:countTokens', { method: 'POST', headers, body: '{"contents":[]}' }); assert.equal(count.status, 200); assert.equal((await count.json() as Wire).totalTokens, 17);
  assert.equal((await fetch(base + '/v1beta/models/p%2Ffamily%2Fm%3Atier:generateContent?key=upstream-only', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/v1beta/models', { headers: { 'x-goog-api-key': 'bad' } })).status, 401);
  const cross = await fetch(base + '/v1/messages?beta=true', { method: 'POST', headers: { ...headers, authorization: `Bearer ${gateway.token()}` }, body: JSON.stringify({ model: 'p/family/m:tier', messages: [{ role: 'user', content: 'hi' }], max_tokens: 30 }) });
  assert.equal(cross.status, 200); assert.match((await cross.json() as Wire).content.find((b: Wire) => b.type === 'tool_use').id, /^call_jusage_/);
  const unsupported = await fetch(base + '/v1/messages/count_tokens', { method: 'POST', headers: { ...headers, authorization: `Bearer ${gateway.token()}` }, body: '{"model":"p/family/m:tier","messages":[]}' }); assert.equal(unsupported.status, 422); assert.match(await unsupported.text(), /TOKEN_COUNT_UNSUPPORTED/);
});

test('native catalog uses Gemini pagination and supplied limits without inventing capabilities', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.headers['x-goog-api-key'], 'native-key');
    assert.ok(req.url!.startsWith('/v1beta/models'));
    const second = req.url!.includes('pageToken=next');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: second ? [{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] : [{ name: 'models/family/m:tier', displayName: 'Native model', inputTokenLimit: 1000, outputTokenLimit: 100, supportedGenerationMethods: ['generateContent'] }], ...(!second ? { nextPageToken: 'next' } : {}) }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const catalog = await pullProviderModelCatalog(new RouterCredentials({ KEY: 'native-key' }), { id: 'p', name: 'p', enabled: true, protocol: 'gemini', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, models: [], auth: { kind: 'env', variable: 'KEY' } });
  assert.deepEqual(catalog.models, ['family/m:tier']); assert.equal(catalog.metadata!['family/m:tier'].limits?.contextTokens, 1000); assert.equal(catalog.metadata!['family/m:tier'].capabilities, undefined);
});

test('Messages token counting forwards native headers and never reports an estimated zero', async t => {
  let count = 0;
  const server = createServer((req, res) => { void (async () => {
    assert.equal(req.url, '/v1/messages/count_tokens'); assert.equal(req.headers['x-api-key'], 'native-key');
    assert.equal(req.headers['anthropic-version'], '2023-06-01'); assert.equal(req.headers['anthropic-beta'], 'client-feature');
    let raw = ''; for await (const c of req) raw += c; assert.equal(JSON.parse(raw).model, 'm'); count++;
    res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":19}');
  })(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const gateway = new AgentGateway(new RouterCredentials({ KEY: 'native-key' }));
  await gateway.start({ version: 1, port: 0, groups: [], providers: [{ id: 'p', name: 'p', protocol: 'messages', enabled: true, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }] }); t.after(() => gateway.stop());
  const res = await fetch(gateway.status().baseUrl + '/messages/count_tokens?beta=true', { method: 'POST', headers: { 'x-api-key': gateway.token(), 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'client-feature' }, body: '{"model":"p/m","messages":[{"role":"user","content":"hello"}]}' });
  assert.equal(res.status, 200); assert.equal((await res.json() as Wire).input_tokens, 19); assert.equal(count, 1);
});

test('HTTP tool round trip restores native signatures and rejects account changes before sending', async t => {
  const bodies: Wire[] = [];
  const server = createServer((req, res) => { void (async () => {
    let raw = ''; for await (const c of req) raw += c; bodies.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'native-call', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' }, extra_content: { google: { thought_signature: 'provider-only-state' } } }] }, finish_reason: 'tool_calls' }] }));
  })(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { KEY: 'account-one' }; const gateway = new AgentGateway(new RouterCredentials(env));
  await gateway.start({ version: 1, port: 0, groups: [], providers: [{ id: 'p', name: 'p', protocol: 'chat', enabled: true, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }] }); t.after(() => gateway.stop());
  const post = (body: Wire) => fetch(gateway.status().baseUrl + '/messages?beta=true', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const first = await (await post({ model: 'p/m', max_tokens: 50, messages: [{ role: 'user', content: 'read' }] })).json() as Wire;
  const call = first.content.find((p: Wire) => p.type === 'tool_use'); assert.match(call.id, /^call_jusage_/);
  const next = { model: 'p/m', max_tokens: 50, messages: [{ role: 'user', content: 'read' }, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'A' }] }] };
  const second = await post(next); assert.equal(second.status, 200); await second.text();
  assert.equal(bodies[1].messages[1].tool_calls[0].extra_content.google.thought_signature, 'provider-only-state'); assert.equal(bodies[1].messages[2].tool_call_id, 'native-call');
  env.KEY = 'account-two'; const switched = await post(next); assert.equal(switched.status, 409); assert.match(await switched.text(), /NATIVE_STATE_ORIGIN_MISMATCH/); assert.equal(bodies.length, 2);
  assert.ok(!JSON.stringify(gateway.status()).includes('provider-only-state')); assert.ok(!JSON.stringify(gateway.status()).includes('account-one'));
});
