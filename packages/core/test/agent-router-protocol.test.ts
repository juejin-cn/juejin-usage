import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { convertRequest, convertReply } from '../src/agent-router/protocol/index.js';
import { EventEncoder } from '../src/agent-router/protocol/encode.js';
import { AgentGateway, RouterCredentials, type Protocol, type RouterProvider } from '../src/agent-router/index.js';
import type { Wire } from '../src/agent-router/protocol/request.js';
const protocols: Exclude<Protocol, 'gemini'>[] = ['chat', 'messages', 'responses'];
const paths = { chat: 'chat/completions', messages: 'messages', responses: 'responses' };
const requests: Record<Exclude<Protocol, 'gemini'>, Wire> = {
  chat: { model: 'p/m', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'file' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }], max_tokens: 100 },
  messages: { model: 'p/m', system: 'system', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file' }] }], tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }], max_tokens: 100 },
  responses: { model: 'p/m', instructions: 'system', input: [{ role: 'user', content: 'hello' }, { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' }, { type: 'function_call_output', call_id: 'call_1', output: 'file' }], tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], max_output_tokens: 100 },
};
const replies: Record<Exclude<Protocol, 'gemini'>, Wire> = {
  chat: { choices: [{ message: { role: 'assistant', content: '你好', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } },
  messages: { type: 'message', content: [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 'call_2', name: 'read', input: { path: 'b' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 4 } },
  responses: { object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }, { type: 'function_call', call_id: 'call_2', name: 'read', arguments: '{"path":"b"}' }], usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } },
};
test('cross-protocol requests omit the SDK billing block while preserving user system instructions and native traffic', () => {
  const billing = 'x-anthropic-billing-header: cc_version=2.1.318.fixture; cc_entrypoint=cli;';
  const body = { ...requests.messages, system: [{ type: 'text', text: billing }, { type: 'text', text: 'Follow repository instructions.' }], messages: [{ role: 'user', content: billing }] };
  const original = structuredClone(body);
  const chat = convertRequest(body, 'messages', 'chat');
  assert.equal(chat.messages[0].content, 'Follow repository instructions.');
  assert.equal(chat.messages[1].content[0].text, billing, 'user text must remain intact');
  const responses = convertRequest(body, 'messages', 'responses');
  assert.equal(responses.input[0].content[0].text, 'Follow repository instructions.');
  assert.equal(convertRequest(body, 'messages', 'gemini').systemInstruction.parts[0].text, 'Follow repository instructions.');
  assert.equal(convertRequest(body, 'messages', 'messages'), body, 'native requests retain billing metadata');
  assert.deepEqual(body, original);
  const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
  assert.equal(convertRequest({ ...body, system: [{ type: 'text', text: identity }] }, 'messages', 'chat').messages[0].content, identity, 'provider-specific identity handling must not leak into shared protocol conversion');
  const interactiveBilling = billing + ' cc_turn_index=1; cc_gateway=custom; cc_project=project-reference; cc_project_src=local_projects; cc_prev_msg=msg_fixture; cch=abc123';
  assert.equal(convertRequest({ ...body, system: [{ type: 'text', text: interactiveBilling }, { type: 'text', text: 'Keep project instructions.' }] }, 'messages', 'chat').messages[0].content, 'Keep project instructions.');
  for (const system of [billing, [{ type: 'text', text: billing + '\nKeep this instruction.' }], [{ type: 'text', text: 'x-anthropic-billing-header: user-authored instruction' }], [{ type: 'text', text: 'User instruction.' }, { type: 'text', text: billing }]]) {
    assert.ok(JSON.stringify(convertRequest({ ...body, system }, 'messages', 'chat').messages[0]).includes('x-anthropic-billing-header:'));
  }
});
async function collect(body: Readable): Promise<string> { let out = ''; for await (const chunk of body) out += chunk.toString(); return out; }
function streamFrames(p: Protocol): string {
  // Hand-authored wire fixtures, not produced by the encoder under test.
  const frames: Wire[] = p === 'chat' ? [
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"path":' } }, { index: 1, id: 'call_3', type: 'function', function: { name: 'list', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } },
  ] : p === 'messages' ? [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_2', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"b"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
  ] : [
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"b"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"b"}' },
    { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } } },
  ];
  return frames.map(v => `event: ${v.type ?? 'chunk'}\r\ndata: ${JSON.stringify(v)}\r\n\r\n`).join('') + (p === 'chat' ? 'data: [DONE]\r\n\r\n' : '');
}
function chunks(raw: string): Buffer[] { const b = Buffer.from(raw); return Array.from({ length: Math.ceil(b.length / 7) }, (_, i) => b.subarray(i * 7, i * 7 + 7)); }
function values(raw: string): Wire[] { return raw.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6))); }
for (const source of protocols) for (const target of protocols) if (source !== target) {
  test(`${source} → ${target}: request history, tools, system and limits`, () => {
    const original = structuredClone(requests[source]); const converted = convertRequest(original, source, target);
    assert.deepEqual(original, requests[source]);
    const normalized = target === 'chat' ? converted : convertRequest(converted, target, 'chat');
    assert.ok(JSON.stringify(normalized.messages).includes('system'));
    assert.ok(normalized.messages.some((m: Wire) => m.tool_calls?.[0].id === 'call_1'));
    assert.ok(normalized.messages.some((m: Wire) => m.role === 'tool' && m.tool_call_id === 'call_1' && m.content === 'file'));
    assert.equal(normalized.tools[0].function.name, 'read'); assert.equal(normalized.max_tokens, 100);
  });
  for (const streaming of [false, true]) test(`${source} → ${target}: ${streaming ? 'fragmented SSE' : 'JSON'} response preserves calls and usage`, async () => {
    const upstream = Readable.from(streaming ? chunks(streamFrames(source)) : [JSON.stringify(replies[source])]);
    let disposed = false;
    const converted = convertReply({ status: 200, headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' }, body: upstream, dispose() { disposed = true; upstream.destroy(); } }, source, target, 'p/m', streaming, new AbortController().signal);
    const raw = await collect(converted.body); assert.ok(disposed); assert.ok(raw.includes('你好')); assert.ok(raw.includes('call_2')); assert.ok(raw.includes('read'));
    if (!streaming) {
      const v = JSON.parse(raw); assert.equal(v.model, 'p/m');
      assert.equal(v.usage.output_tokens ?? v.usage.completion_tokens, 4);
      const output = target === 'chat' ? v.choices[0].message.tool_calls[0].function.arguments : target === 'messages' ? JSON.stringify(v.content.find((b: Wire) => b.type === 'tool_use').input) : v.output.find((b: Wire) => b.type === 'function_call').arguments;
      assert.equal(output, '{"path":"b"}');
    } else {
      const frames = values(raw);
      if (target === 'responses') {
        assert.equal(frames[0].type, 'response.created');
        assert.equal(frames.at(-1)?.type, 'response.completed');
        assert.deepEqual(frames.map(f => f.sequence_number), frames.map((_, i) => i));
        const call = frames.at(-1)!.response.output.find((b: Wire) => b.type === 'function_call'); assert.equal(call.call_id, 'call_2'); assert.equal(call.arguments, '{"path":"b"}');
      } else if (target === 'messages') { assert.equal(frames[0].type, 'message_start'); assert.equal(frames.at(-1)?.type, 'message_stop'); assert.equal(frames.at(-2)?.usage.output_tokens, 4); }
      else { assert.ok(raw.endsWith('data: [DONE]\n\n')); assert.equal(frames.at(-1)?.choices[0].finish_reason, 'tool_calls'); assert.equal(frames.at(-1)?.usage.prompt_tokens, 12); }
    }
  });
}
test('same protocol remains byte-preserving and retains advanced fields', () => {
  const input = { previous_response_id: 'x', model: 'p/m' }; assert.equal(convertRequest(input, 'responses', 'responses'), input);
});
test('unsupported stateful, built-in tools, encrypted history and nontext tool results fail explicitly', () => {
  for (const extra of [{ previous_response_id: 'secret' }, { conversation: 'c' }, { tools: [{ type: 'web_search' }] }, { input: [{ type: 'reasoning', encrypted_content: 'x' }] }]) assert.throws(() => convertRequest({ ...requests.responses, ...extra }, 'responses', 'chat'), /PROTOCOL_CONVERSION_UNSUPPORTED/);
  assert.throws(() => convertRequest({ ...requests.messages, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'image', source: {} }] }] }] }, 'messages', 'chat'), /UNSUPPORTED/);
});
test('images and explicit tool choice map in both directions', () => {
  const input = { model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] }], tool_choice: { type: 'tool', name: 'read', disable_parallel_tool_use: true } };
  const chat = convertRequest(input, 'messages', 'chat'); assert.equal(chat.messages[0].content[0].image_url.url, 'data:image/png;base64,YWJj'); assert.equal(chat.tool_choice.function.name, 'read'); assert.equal(chat.parallel_tool_calls, false);
  const back = convertRequest(chat, 'chat', 'messages'); assert.deepEqual(back.messages[0].content[0].source, input.messages[0].content[0].source);
});
test('compressed JSON conversion and stream-to-JSON collection', async () => {
  for (const compressed of [true, false]) {
    const raw = compressed ? gzipSync(JSON.stringify(replies.chat)) : Buffer.from(streamFrames('chat'));
    const source = Readable.from([raw]);
    const out = convertReply({ status: 200, headers: { 'content-type': compressed ? 'application/json' : 'text/event-stream', ...(compressed ? { 'content-encoding': 'gzip' } : {}) }, body: source, dispose() { source.destroy(); } }, 'chat', 'responses', 'm', false, new AbortController().signal);
    const result = JSON.parse(await collect(out.body)); assert.equal(result.output[0].content[0].text, '你好'); assert.equal(result.usage.input_tokens, 12);
  }
});
test('truncated and malformed streams never synthesize successful completion', async () => {
  for (const raw of ['data: {invalid}\n\n', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']) {
    const source = Readable.from([raw]); const out = convertReply({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: source, dispose() { source.destroy(); } }, 'chat', 'messages', 'm', true, new AbortController().signal);
    await assert.rejects(collect(out.body), /UPSTREAM_(INVALID_SSE|TRUNCATED_STREAM)/);
  }
});
test('incomplete reason emits response.incomplete and tool JSON is validated', () => {
  const e = new EventEncoder('responses', 'm'); [...e.push({ kind: 'text', key: 't', text: 'a' }, true)]; [...e.push({ kind: 'finish', reason: 'length' }, true)]; assert.ok([...e.finish()].at(-1)?.includes('response.incomplete'));
  const bad = new EventEncoder('messages', 'm'); [...bad.push({ kind: 'tool', key: '1', id: 'call', name: 'read', args: '{bad' }, false)]; assert.throws(() => bad.json(), /INVALID_TOOL_ARGUMENTS/);
});
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const s = createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`, close: () => new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); }) };
}
for (const target of ['messages', 'responses'] as Exclude<Protocol, 'gemini'>[]) test(`gateway ${target} to Chat: real HTTP routing and tool round trip`, async t => {
  let seen: Wire | undefined; let count = 0;
  const upstream = await server((req, res) => { void (async () => { let raw = ''; for await (const c of req) raw += c; seen = JSON.parse(raw); assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer upstream'); count++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(replies.chat)); })(); }); t.after(upstream.close);
  const p: RouterProvider = { id: 'p', name: 'p', enabled: true, protocol: 'chat', baseUrl: upstream.url, models: ['m'], auth: { kind: 'env', variable: 'KEY' } };
  const gw = new AgentGateway(new RouterCredentials({ KEY: 'upstream' })); await gw.start({ version: 1, port: 0, providers: [p], groups: [] }); t.after(() => gw.stop());
  const response = await fetch(`${gw.status().baseUrl}/${paths[target]}`, { method: 'POST', headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json' }, body: JSON.stringify(requests[target]) });
  assert.equal(response.status, 200); const result = await response.json() as Wire; assert.equal(result.model, 'p/m'); assert.equal(seen!.model, 'm'); assert.equal(count, 1); assert.ok(seen!.messages.some((m: Wire) => m.tool_call_id === 'call_1'));
});
test('gateway streams before upstream finishes; client abort closes converted transport without retry', async t => {
  let close!: () => void; const closed = new Promise<void>(r => { close = r; }); let calls = 0;
  const upstream = await server((_req, res) => { calls++; res.setHeader('content-type', 'text/event-stream'); res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'); res.on('close', close); }); t.after(upstream.close);
  const gw = new AgentGateway(new RouterCredentials({ KEY: 'upstream' })); await gw.start({ version: 1, port: 0, providers: [{ id: 'p', name: 'p', protocol: 'chat', enabled: true, baseUrl: upstream.url, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }], groups: [] }); t.after(() => gw.stop());
  const abort = new AbortController();
  const response = await fetch(gw.status().baseUrl + '/messages', { method: 'POST', signal: abort.signal, headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'p/m', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 20 }) });
  const reader = response.body!.getReader(); let received = ''; while (!received.includes('first')) received += new TextDecoder().decode((await reader.read()).value);
  abort.abort(); await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('not cancelled')), 2000).unref())]); assert.equal(calls, 1);
});

test('fragmented tool names are assembled before publishing their start event', () => {
  const encoder = new EventEncoder('messages', 'm');
  assert.deepEqual([...encoder.push({ kind: 'tool', key: 'a', id: 'call_a', name: 'rea' }, true)], []);
  assert.deepEqual([...encoder.push({ kind: 'tool', key: 'a', name: 'd' }, true)], []);
  const frames = values([...encoder.push({ kind: 'tool', key: 'a', args: '{}' }, true)].join(''));
  assert.equal(frames.find(f => f.type === 'content_block_start')!.content_block.name, 'read');
  assert.ok([...encoder.finish()].join('').includes('message_stop'));
});
test('no-argument tool emits a balanced block with an empty object', () => {
  const encoder = new EventEncoder('messages', 'm'); [...encoder.push({ kind: 'tool', key: 'a', id: 'call', name: 'list' }, true)];
  const frames = values([...encoder.finish()].join(''));
  assert.equal(frames.filter(f => f.type === 'content_block_start').length, 1);
  assert.equal(frames.filter(f => f.type === 'content_block_stop').length, 1);
  assert.equal(frames.find(f => f.type === 'content_block_delta')!.delta.partial_json, '{}');
});
test('Responses parallel calls become one assistant turn before their results', () => {
  const chat = convertRequest({ model: 'm', input: [{ type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' }, { type: 'function_call', call_id: 'b', name: 'read', arguments: '{}' }, { type: 'function_call_output', call_id: 'a', output: 'A' }, { type: 'function_call_output', call_id: 'b', output: 'B' }] }, 'responses', 'chat');
  assert.equal(chat.messages.length, 3); assert.equal(chat.messages[0].tool_calls.length, 2);
});
test('converted gateway response can be replayed with tool output in the next turn', async t => {
  const bodies: Wire[] = [];
  const upstream = await server((req, res) => { void (async () => { let raw = ''; for await (const c of req) raw += c; bodies.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(replies.chat)); })(); }); t.after(upstream.close);
  const gw = new AgentGateway(new RouterCredentials({ KEY: 'upstream' })); await gw.start({ version: 1, port: 0, providers: [{ id: 'p', name: 'p', enabled: true, protocol: 'chat', baseUrl: upstream.url, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }], groups: [] }); t.after(() => gw.stop());
  const post = (b: Wire) => fetch(gw.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const first = await (await post({ model: 'p/m', input: 'read' })).json() as Wire;
  const next = await post({ model: 'p/m', input: [{ role: 'user', content: 'read' }, ...first.output, { type: 'function_call_output', call_id: 'call_2', output: 'file contents' }] }); assert.equal(next.status, 200); await next.text();
  assert.equal(bodies.length, 2); assert.equal(bodies[1].messages.at(-1).tool_call_id, 'call_2'); assert.equal(bodies[1].messages.at(-1).content, 'file contents');
});
test('conversion errors before content may fail over; after content never retry', async t => {
  let late = false; let goodCalls = 0;
  const bad = await server((_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    if (late) { res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); setTimeout(() => res.end('data: {bad}\n\n'), 30); }
    else res.end('data: {"error":{"type":"overloaded_error"}}\n\n');
  }); t.after(bad.close);
  const good = await server((_req, res) => { goodCalls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(replies.chat)); }); t.after(good.close);
  const gw = new AgentGateway(new RouterCredentials({ KEY: 'upstream' }));
  const provider = (id: string, baseUrl: string): RouterProvider => ({ id, name: id, enabled: true, protocol: 'chat', baseUrl, models: ['m'], auth: { kind: 'env', variable: 'KEY' } });
  await gw.start({ version: 1, port: 0, providers: [provider('bad', bad.url), provider('good', good.url)], groups: [{ id: 'g', members: ['bad/m', 'good/m'] }] }); t.after(() => gw.stop());
  const post = () => fetch(gw.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto/g', input: 'hello', stream: true }) });
  const success = await post(); assert.equal(success.status, 200); assert.ok((await success.text()).includes('response.completed')); assert.equal(goodCalls, 1);
  gw.resetHealth('bad'); late = true; const partial = await post(); assert.equal(partial.status, 200); await assert.rejects(partial.text()); assert.equal(goodCalls, 1);
});
test('converted SSE authentication errors retain status and never try another provider', async t => {
  let goodCalls = 0;
  const bad = await server((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end('data: {"error":{"type":"authentication_error","message":"private-key"}}\n\n'); }); t.after(bad.close);
  const good = await server((_req, res) => { goodCalls++; res.end(JSON.stringify(replies.chat)); }); t.after(good.close);
  const gw = new AgentGateway(new RouterCredentials({ KEY: 'upstream' }));
  await gw.start({ version: 1, port: 0, providers: [bad, good].map((s, i) => ({ id: 'p' + i, name: 'p', enabled: true, protocol: 'chat', baseUrl: s.url, models: ['m'], auth: { kind: 'env', variable: 'KEY' } })), groups: [{ id: 'g', members: ['p0/m', 'p1/m'] }] }); t.after(() => gw.stop());
  const result = await fetch(gw.status().baseUrl + '/messages', { method: 'POST', headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto/g', messages: [], stream: true }) });
  assert.equal(result.status, 401); const raw = await result.text(); assert.equal(JSON.parse(raw).type, 'error'); assert.equal(JSON.parse(raw).error.type, 'authentication_error'); assert.ok(!raw.includes('private-key')); assert.equal(goodCalls, 0);
});

for (const protocol of protocols) test(`same-protocol ${protocol} SSE is collected for a JSON client`, async () => {
  const source = Readable.from(chunks(streamFrames(protocol)));
  const reply = { status: 200, headers: { 'content-type': 'text/event-stream' }, body: source, dispose() { source.destroy(); } };
  const converted = convertReply(reply, protocol, protocol, 'gateway/model', false, new AbortController().signal);
  assert.notEqual(converted, reply); assert.equal(converted.headers['content-type'], 'application/json');
  const json = JSON.parse(await collect(converted.body)); assert.equal(json.model, 'gateway/model');
  assert.equal(json.usage.output_tokens ?? json.usage.completion_tokens, 4);
  assert.match(JSON.stringify(json), /你好/); assert.match(JSON.stringify(json), /call_2/);
});
test('same-protocol streaming and ordinary JSON responses remain unchanged', () => {
  for (const streaming of [true, false]) {
    const reply = { status: 200, headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' }, body: Readable.from([]), dispose() {} };
    assert.equal(convertReply(reply, 'chat', 'chat', 'm', streaming, new AbortController().signal), reply);
  }
});
test('same-protocol aggregation never returns partial JSON after an error or truncation', async () => {
  for (const tail of ['', 'data: {"error":{"type":"overloaded_error"}}\n\n']) {
    const source = Readable.from(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', tail]);
    const reply = convertReply({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: source, dispose() { source.destroy(); } }, 'chat', 'chat', 'm', false, new AbortController().signal);
    let output = '';
    await assert.rejects(async () => { for await (const chunk of reply.body) output += chunk; }, /UPSTREAM_(PROTOCOL_ERROR|TRUNCATED_STREAM)/);
    assert.equal(output, '');
  }
});
test('JSON collection uses upstream first-content time, not whole-response completion time', async t => {
  const upstream = await server((_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    const timer = setTimeout(() => res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 300);
    res.on('close', () => clearTimeout(timer));
  }); t.after(upstream.close);
  const gw = new AgentGateway(new RouterCredentials({ KEY: 'fake' })); t.after(() => gw.stop());
  await gw.start({ version: 1, port: 0, providers: [{ id: 'p', name: 'p', enabled: true, protocol: 'chat', baseUrl: upstream.url, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }], groups: [], gateway: { firstResponseTimeoutMs: 150, requestTimeoutMs: 2000 } });
  const response = await fetch(gw.status().baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'p/m', stream: false, messages: [] }) });
  assert.equal(response.status, 200); const json = await response.json() as Wire; assert.equal(json.choices[0].message.content, 'hello');
  assert.ok(gw.status().requests[0].attempts[0].responseStartMs! < 150);
});
