import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { nativeSearchRequest, rewriteNativeSearchReply } from '../src/agent-router/protocol/native-search.js';
import { AgentGateway, RouterCredentials } from '../src/agent-router/index.js';
import type { Wire } from '../src/agent-router/protocol/request.js';

const search = { type: 'tool_search', execution: 'client', description: 'Find tool', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
const namespace = { type: 'namespace', name: 'files', description: 'Files', tools: [{ type: 'custom', name: 'edit', defer_loading: true, format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }] };
const called = { type: 'tool_search_call', id: 'fc_native', call_id: 's', execution: 'client', status: 'completed', arguments: { query: 'edit' } };
const found = { type: 'tool_search_output', call_id: 's', execution: 'client', status: 'completed', tools: [namespace] };
const event = (v: Wire) => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`;
async function collect(body: Readable): Promise<string> { let raw = ''; for await (const c of body) raw += c; return raw; }

test('native search adaptation preserves opaque Responses fields, custom tools, namespaces and caller body', () => {
  const body = { model: 'm', store: true, background: true, previous_response_id: 'resp_previous', include: ['reasoning.encrypted_content'], tools: [search, namespace, { type: 'web_search' }], input: [
    { type: 'reasoning', encrypted_content: 'opaque', summary: [] }, called, found,
    { type: 'custom_tool_call', call_id: 'c', name: 'edit', namespace: 'files', input: 'RAW PATCH' },
    { type: 'custom_tool_call_output', call_id: 'c', output: 'done' },
  ] };
  const before = structuredClone(body), plan = nativeSearchRequest(body)!;
  assert.equal(plan.rewrite, true); assert.equal(plan.body.store, true); assert.equal(plan.body.background, true);
  assert.equal(plan.body.previous_response_id, 'resp_previous'); assert.deepEqual(plan.body.include, body.include);
  assert.deepEqual(plan.body.input[0], body.input[0]); assert.deepEqual(plan.body.input.slice(3), body.input.slice(3));
  assert.deepEqual(plan.body.input[1], { type: 'function_call', id: 'fc_native', call_id: 's', status: 'completed', name: 'tool_search', arguments: '{"query":"edit"}' });
  assert.equal(plan.body.input[2].type, 'function_call_output'); assert.match(plan.body.input[2].output, /files.edit/);
  assert.equal(plan.body.tools.find((t: Wire) => t.type === 'namespace').tools[0].defer_loading, undefined);
  assert.equal(plan.body.tools.find((t: Wire) => t.type === 'namespace').tools[0].type, 'custom');
  assert.deepEqual(body, before);
  assert.deepEqual(nativeSearchRequest({ tools: [search, namespace] })!.body.tools.map((t: Wire) => t.type), ['function']);
  assert.equal(nativeSearchRequest({ tools: [{ type: 'tool_search', execution: 'server' }] }), undefined);
});

test('native loaded namespaces merge, history remains portable without another search tool, and collisions fail', () => {
  const another = { ...found, tools: [{ ...namespace, tools: [{ type: 'function', name: 'read', parameters: { type: 'object' }, defer_loading: true }] }] };
  const plan = nativeSearchRequest({ input: [called, found, another] })!;
  assert.equal(plan.rewrite, false); assert.deepEqual(plan.body.tools[0].tools.map((t: Wire) => t.name), ['edit', 'read']);
  assert.throws(() => nativeSearchRequest({ tools: [search, { type: 'function', name: 'tool_search' }] }), /AMBIGUOUS_TOOL_NAME/);
  assert.throws(() => nativeSearchRequest({ tools: [{ type: 'function', name: 'tool_search' }, search] }), /AMBIGUOUS_TOOL_NAME/);
  assert.throws(() => nativeSearchRequest({ input: [{ ...found, call_id: null }] }), /INVALID_TOOL_SEARCH_OUTPUT/);
  assert.throws(() => nativeSearchRequest({ input: [{ ...called, arguments: [] }] }), /INVALID_TOOL_SEARCH_ARGUMENTS/);
});

test('native reply rewrite preserves every unrelated native item and rewrites search ownership in JSON and gzip SSE', async () => {
  const call = { type: 'function_call', id: 'fc', call_id: 's', name: 'tool_search', arguments: '{"query":"edit"}', status: 'completed' };
  const response = { id: 'resp_native', status: 'completed', output: [call, { type: 'reasoning', encrypted_content: 'opaque' }, { type: 'custom_tool_call', name: 'edit', input: 'RAW' }, { type: 'future_native', opaque: true }], metadata: { native: true } };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' }, sequence_number: 0 },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc', delta: '{"query":', sequence_number: 1 },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc', arguments: call.arguments, sequence_number: 2 },
    { type: 'response.output_item.done', output_index: 0, item: call, sequence_number: 3 },
    { type: 'response.completed', response },
  ];
  for (const sse of [false, true]) {
    const input = sse ? gzipSync(events.map(event).join('')) : Buffer.from(JSON.stringify(response));
    const body = Readable.from([...input].map(n => Buffer.from([n])));
    const reply = rewriteNativeSearchReply({ status: 200, headers: { 'content-type': sse ? 'text/event-stream' : 'application/json', ...(sse ? { 'content-encoding': 'gzip' } : {}) }, body, dispose() { body.destroy(); } }, new AbortController().signal);
    const raw = await collect(reply.body);
    const frames = sse ? raw.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6))) : [];
    const result = sse ? frames.at(-1).response : JSON.parse(raw);
    assert.equal(result.output[0].type, 'tool_search_call'); assert.equal(result.output[0].execution, 'client'); assert.deepEqual(result.output[0].arguments, { query: 'edit' });
    assert.equal(result.output[0].id, 'fc'); assert.equal(result.output[0].call_id, 's');
    assert.deepEqual(result.output.slice(1), response.output.slice(1)); assert.deepEqual(result.metadata, response.metadata);
    if (sse) { assert.ok(!frames.some(f => f.type.startsWith('response.function_call_arguments.'))); assert.deepEqual(frames.map(f => f.sequence_number), [0, 1, 2]); }
  }
});

for (const sourceStreaming of [false, true]) for (const clientStreaming of [false, true]) {
  test(`native Responses search → custom tool HTTP loop, upstream SSE=${sourceStreaming}, client SSE=${clientStreaming}`, async t => {
    const received: Wire[] = [];
    const upstream = createServer((req, res) => { void (async () => {
      let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw); received.push(body);
      const phase = received.length;
      if (phase === 1) { assert.equal(body.tools[0].type, 'function'); assert.equal(body.tools[0].name, 'tool_search'); assert.equal(body.tools.length, 1); }
      else { assert.equal(body.input[1].type, 'function_call'); assert.equal(body.input[1].call_id, 's'); assert.equal(body.input[2].type, 'function_call_output'); assert.equal(body.tools[0].type, 'namespace'); assert.equal(body.tools[0].tools[0].type, 'custom'); }
      const output = phase === 1 ? [{ type: 'function_call', id: 'fc_s', call_id: 's', name: 'tool_search', arguments: '{"query":"edit"}' }]
        : phase === 2 ? [{ type: 'custom_tool_call', id: 'ctc_c', call_id: 'c', name: 'edit', namespace: 'files', input: 'RAW PATCH' }]
          : [{ type: 'message', id: 'msg_final', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] }];
      const response = { id: `resp_${phase}`, object: 'response', status: 'completed', model: 'native', output, native_extension: { preserved: true } };
      if (sourceStreaming) {
        res.setHeader('content-type', 'text/event-stream');
        res.end(output.map((item, output_index) => event({ type: 'response.output_item.added', output_index, item })).join('') + output.map((item, output_index) => event({ type: 'response.output_item.done', output_index, item })).join('') + event({ type: 'response.completed', response }));
      } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); }
    })(); }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const gateway = new AgentGateway(new RouterCredentials({ KEY: 'fixture' }));
    await gateway.start({ version: 1, port: 0, groups: [], providers: [{ id: 'p', name: 'p', enabled: true, protocol: 'responses', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }] }); t.after(() => gateway.stop());
    const post = async (input: Wire[], tools?: Wire[]) => {
      const reply = await fetch(gateway.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'p/m', input, tools, stream: clientStreaming }) });
      const raw = await reply.text(); assert.equal(reply.status, 200, raw);
      if (clientStreaming) { assert.match(reply.headers.get('content-type')!, /text\/event-stream/); return JSON.parse(raw.split('\n').filter(l => l.startsWith('data: {')).at(-1)!.slice(6)).response; }
      return JSON.parse(raw);
    };
    const user = { role: 'user', content: 'edit' };
    const first = await post([user], [search, namespace]); assert.equal(first.output[0].type, 'tool_search_call'); assert.equal(first.output[0].execution, 'client');
    const history = [user, ...first.output, { ...found, call_id: first.output[0].call_id }];
    const second = await post(history); assert.equal(second.output[0].type, 'custom_tool_call'); assert.equal(second.output[0].input, 'RAW PATCH');
    const third = await post([...history, ...second.output, { type: 'custom_tool_call_output', call_id: second.output[0].call_id, output: 'done' }]);
    assert.equal(third.output[0].content[0].text, 'done'); assert.deepEqual(third.native_extension, { preserved: true });
    assert.equal(received[2].input[3].type, 'custom_tool_call'); assert.equal(received[2].input[3].input, 'RAW PATCH');
  });
}

test('native search mapping never skips origin validation for managed state references', async t => {
  let calls = 0;
  const upstream = createServer((_req, res) => { calls++; res.end('{}'); }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const gateway = new AgentGateway(new RouterCredentials({ KEY: 'fixture' }));
  await gateway.start({ version: 1, port: 0, groups: [], providers: [{ id: 'p', name: 'p', enabled: true, protocol: 'responses', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }] }); t.after(() => gateway.stop());
  const reply = await fetch(gateway.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'p/m', tools: [search], input: [{ ...called, call_id: 'call_jusage_foreign' }] }) });
  assert.equal(reply.status, 409); assert.match(await reply.text(), /NATIVE_STATE_EXPIRED/); assert.equal(calls, 0);
});

test('native search rewrite rejects malformed arguments and truncation without a success event', async () => {
  for (const raw of [
    event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'tool_search', call_id: 's', arguments: '' } }),
    event({ type: 'response.completed', response: { output: [{ type: 'function_call', name: 'tool_search', call_id: 's', arguments: 'not JSON' }] } }),
    event({ type: 'error', error: { code: 429 } }),
  ]) {
    const body = Readable.from([raw]);
    const reply = rewriteNativeSearchReply({ status: 200, headers: { 'content-type': 'text/event-stream' }, body, dispose() { body.destroy(); } }, new AbortController().signal);
    await assert.rejects(collect(reply.body), /UPSTREAM_/);
  }
});
