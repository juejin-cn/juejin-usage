import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { convertReply } from '../src/agent-router/protocol/index.js';
import { AgentGateway, RouterCredentials } from '../src/agent-router/index.js';
import type { Wire } from '../src/agent-router/protocol/request.js';

const native: Wire = { id: 'resp_native', object: 'response', status: 'completed', model: 'upstream', store: true, previous_response_id: 'resp_previous', metadata: { native: true }, output: [
  { type: 'reasoning', id: 'rs_original', summary: [], encrypted_content: 'opaque-native-state' },
  { type: 'custom_tool_call', id: 'ctc_original', call_id: 'custom-call', name: 'apply_patch', input: '*** Begin Patch\n🐱\n*** End Patch', namespace: 'workspace', status: 'completed' },
  { type: 'tool_search_call', id: 'ts_original', call_id: 'search-call', arguments: { goal: 'read' }, execution: 'client', status: 'completed' },
  { type: 'tool_search_output', execution: 'client', call_id: 'search-call', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
  { type: 'web_search_call', id: 'ws_original', action: { type: 'search', query: 'fixture' }, status: 'completed' },
  { type: 'future_vendor_item', opaque: { future: ['preserve', 1] } },
], usage: { input_tokens: 21, output_tokens: 7, total_tokens: 28, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 } }, service_tier: 'default', native_extension: { preserve: true } };
const frame = (value: Wire) => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
async function collect(frames: string, compressed = false): Promise<Wire> {
  const bytes = compressed ? gzipSync(frames) : Buffer.from(frames);
  const body = Readable.from([...bytes].map(c => Buffer.from([c])));
  const reply = convertReply({ status: 200, headers: { 'content-type': 'text/event-stream', ...(compressed ? { 'content-encoding': 'gzip' } : {}) }, body, dispose() { body.destroy(); } }, 'responses', 'responses', 'gateway/model', false, new AbortController().signal);
  let raw = ''; for await (const chunk of reply.body) raw += chunk;
  return JSON.parse(raw);
}

test('native Responses aggregation preserves IDs, custom/search/hosted items and opaque state with or without gzip', async () => {
  for (const compressed of [false, true]) {
    const stream = ': heartbeat\r\n\r\n' + frame({ type: 'response.created', response: { ...native, status: 'in_progress', output: [] } })
      + native.output.map((item: Wire, output_index: number) => frame({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress' } })).join('')
      + frame({ type: 'response.completed', response: native }) + 'data: [DONE]\r\n\r\n';
    assert.deepEqual(await collect(stream, compressed), { ...native, model: 'gateway/model' });
  }
});

test('native incomplete reasons, native item status and partial custom input remain intact', async () => {
  const response = { ...native, status: 'incomplete', incomplete_details: { reason: 'content_filter', native_detail: true }, output: [{ type: 'custom_tool_call', id: 'ctc_partial', call_id: 'c', name: 'edit', input: 'partial', status: 'incomplete' }] };
  assert.deepEqual(await collect(frame({ type: 'response.incomplete', response })), { ...response, model: 'gateway/model' });
});

test('native JSON → SSE emits text/refusal/custom deltas and retains opaque terminal snapshots', async () => {
  const response = { ...native, output: [...native.output, { type: 'message', id: 'msg_text', role: 'assistant', content: [{ type: 'output_text', text: '你好🐱', annotations: [] }, { type: 'refusal', refusal: 'No' }] }] };
  const body = Readable.from([JSON.stringify(response)]);
  const reply = convertReply({ status: 200, headers: { 'content-type': 'application/json' }, body, dispose() { body.destroy(); } }, 'responses', 'responses', 'p/m', true, new AbortController().signal);
  let raw = ''; for await (const c of reply.body) raw += c;
  const frames = raw.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
  assert.equal(frames.find(f => f.type === 'response.output_text.delta').delta, '你好🐱');
  assert.equal(frames.find(f => f.type === 'response.refusal.delta').delta, 'No');
  assert.equal(frames.find(f => f.type === 'response.custom_tool_call_input.delta').delta, native.output[1].input);
  assert.deepEqual(frames.at(-1).response, { ...response, model: 'p/m' });
  assert.deepEqual(frames.map(f => f.sequence_number), frames.map((_, i) => i));
});

test('missing terminal output reconstructs full native item snapshots and retains response metadata', async () => {
  const stream = frame({ type: 'response.created', response: { id: 'resp_legacy', object: 'response', metadata: { retained: true }, status: 'in_progress' } })
    + native.output.map((item: Wire, output_index: number) => frame({ type: 'response.output_item.done', output_index, item })).join('')
    + frame({ type: 'response.completed', response: { status: 'completed', usage: native.usage } });
  const result = await collect(stream);
  assert.equal(result.id, 'resp_legacy'); assert.deepEqual(result.metadata, { retained: true });
  assert.deepEqual(result.output, native.output); assert.deepEqual(result.usage, native.usage);
});

test('legacy native text/reasoning/function/custom deltas reconstruct exact input without duplicated done snapshots', async () => {
  const values = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '你好' },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: '你好', annotations: [{ type: 'native' }] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"a"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"a"}' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'custom_tool_call', id: 'ctc', call_id: 'cc', name: 'edit', input: '' } },
    { type: 'response.custom_tool_call_input.delta', output_index: 2, delta: 'a\n"🐱"' },
    { type: 'response.custom_tool_call_input.done', output_index: 2, input: 'a\n"🐱"' },
    { type: 'response.reasoning_summary_text.delta', output_index: 3, summary_index: 0, delta: 'thought' },
    { type: 'response.refusal.done', output_index: 4, content_index: 0, refusal: 'Cannot comply' },
    { type: 'response.completed', response: { usage: native.usage } },
  ];
  const result = await collect(values.map(frame).join(''));
  assert.equal(result.output[0].content[0].text, '你好'); assert.deepEqual(result.output[0].content[0].annotations, [{ type: 'native' }]);
  assert.equal(result.output[1].arguments, '{"path":"a"}'); assert.equal(result.output[1].call_id, 'c');
  assert.equal(result.output[2].input, 'a\n"🐱"'); assert.equal(result.output[3].summary[0].text, 'thought');
  assert.deepEqual(result.output[4].content[0], { type: 'refusal', refusal: 'Cannot comply' });
});

test('native collection rejects truncation, errors, unfinished unknown items and malformed terminal data', async () => {
  for (const stream of [
    frame({ type: 'response.output_item.added', output_index: 0, item: native.output[1] }),
    frame({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }),
    frame({ type: 'error', error: { code: 429 } }),
    frame({ type: 'response.completed', response: { status: 'completed', output: 'not an array' } }),
    frame({ type: 'response.completed', response: { status: 'failed', output: [] } }),
    frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'future_item' } }) + frame({ type: 'response.completed', response: {} }),
    frame({ type: 'response.output_item.done', output_index: 0, item: native.output[1] }) + frame({ type: 'response.completed', response: { output: [] } }),
    frame({ type: 'response.completed', response: native }) + frame({ type: 'response.output_text.delta', output_index: 0, delta: 'late' }),
    frame({ type: 'response.output_text.delta', output_index: 10000000, delta: 'invalid index' }),
  ]) await assert.rejects(collect(stream), /UPSTREAM_/);
  await assert.rejects(collect(frame({ type: 'error', error: { code: 429 } })), e => (e as { status?: number }).status === 429);
});

test('gateway native Responses SSE → JSON preserves advanced items at the actual HTTP entry', async t => {
  const upstream = createServer((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(frame({ type: 'response.completed', response: native })); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const gateway = new AgentGateway(new RouterCredentials({ KEY: 'fixture' }));
  await gateway.start({ version: 1, port: 0, groups: [], providers: [{ id: 'p', name: 'p', enabled: true, protocol: 'responses', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }] }); t.after(() => gateway.stop());
  const response = await fetch(gateway.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: '{"model":"p/m","input":"test","stream":false}' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ...native, model: 'p/m' });
});

for (const encoding of [undefined, 'gzip', 'identity'] as const) test(`native committed SSE truncation fails without replay, encoding=${encoding ?? 'none'}`, async t => {
  let secondCalls = 0;
  const partial = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  const upstream = createServer((_req, res) => {
    res.setHeader('content-type', 'Text/Event-Stream; charset=utf-8');
    if (encoding) res.setHeader('content-encoding', encoding);
    res.end(encoding === 'gzip' ? gzipSync(partial) : partial);
  }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const second = createServer((_req, res) => { secondCalls++; res.end('{}'); }); second.listen(0, '127.0.0.1'); await once(second, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); second.closeAllConnections(); second.close(); });
  const gateway = new AgentGateway(new RouterCredentials({ KEY: 'fixture' }));
  await gateway.start({ version: 1, port: 0, groups: [{ id: 'fallback', members: ['p0/m', 'p1/m'] }], providers: [upstream, second].map((server, i) => ({ id: 'p' + i, name: 'p', enabled: true, protocol: 'chat', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'KEY' } })) }); t.after(() => gateway.stop());
  await assert.rejects(async () => {
    const response = await fetch(gateway.status().baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: '{"model":"auto/fallback","stream":true,"messages":[]}' });
    await response.text();
  });
  assert.equal(secondCalls, 0);
  const trace = gateway.status().requests[0];
  assert.equal(trace.reason, 'UPSTREAM_TRUNCATED_STREAM'); assert.equal(trace.outcome, 'failed'); assert.equal(trace.attempts[0].committed, true);
});
