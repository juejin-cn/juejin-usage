import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { AgentGateway, RouterCredentials } from '../src/agent-router/index.js';
import { convertRequest } from '../src/agent-router/protocol/index.js';
import { NativeStateStore } from '../src/agent-router/protocol/native-state.js';
import type { Wire } from '../src/agent-router/protocol/request.js';

const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const search = { name: 'ToolSearch', description: 'Find and load tools', input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] } };
const bash = { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } };
const placeholder = { name: 'DeferredToolPlaceholder', defer_loading: true, input_schema: { type: 'object' } };
const a = { name: 'mcp__files__read_a', description: 'Read file A', defer_loading: true, input_schema: schema };
const b = { ...a, name: 'mcp__files__read_b', description: 'Read file B' };
const question = { role: 'user', content: 'Read A, then B.' };
const call = (id: string, name: string, input: Wire) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
const found = (id: string, ...names: string[]) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: names.map(tool_name => ({ type: 'tool_reference', tool_name })) }] });
const history = [question, call('search-a', 'ToolSearch', { query: 'read A' }), found('search-a', a.name)];
const request = (tools: Wire[], messages: Wire[] = [question]) => ({ model: 'model', max_tokens: 1000, tools, messages });
const toolNames = (body: Wire, target: string) => target === 'gemini' ? body.tools.flatMap((group: Wire) => group.functionDeclarations.map((tool: Wire) => tool.name)) : body.tools.map((tool: Wire) => tool.function?.name ?? tool.name);

for (const target of ['chat', 'responses', 'gemini'] as const) test(`Messages discovers tools incrementally through ${target}`, () => {
  const initial = request([bash, search, a, b, placeholder]); const snapshot = structuredClone(initial);
  const first = convertRequest(initial, 'messages', target);
  assert.deepEqual(toolNames(first, target), ['Bash', 'ToolSearch']); assert.doesNotMatch(JSON.stringify(first), /Read file [AB]|defer_loading|DeferredToolPlaceholder/);
  const second = convertRequest(request(initial.tools, history), 'messages', target);
  assert.deepEqual(toolNames(second, target), ['Bash', 'ToolSearch', a.name]); assert.match(JSON.stringify(second), /Tool available: mcp__files__read_a/); assert.doesNotMatch(JSON.stringify(second), /Read file B|tool_reference/);
  const third = convertRequest(request(initial.tools, [...history, call('read-a', a.name, { path: 'a' }), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-a', content: 'A' }] }, call('search-b', 'ToolSearch', { query: 'read B' }), found('search-b', b.name)]), 'messages', target);
  assert.deepEqual(toolNames(third, target), ['Bash', 'ToolSearch', a.name, b.name]);
  assert.equal(JSON.stringify(third).includes('defer_loading'), false); assert.deepEqual(initial, snapshot);
});

test('references deduplicate and preserve parallel result/text order and failed results', () => {
  const messages = [call('a', 'ToolSearch', {}), call('b', 'ToolSearch', {}), { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'Found:' }, { type: 'tool_reference', tool_name: a.name }, { type: 'tool_reference', tool_name: a.name }] },
    { type: 'tool_result', tool_use_id: 'b', is_error: true, content: [{ type: 'tool_reference', tool_name: b.name }] },
    { type: 'text', text: 'Continue.' },
  ] }];
  const converted = convertRequest(request([search, a, b], messages), 'messages', 'chat');
  assert.deepEqual(converted.tools.map((t: Wire) => t.function.name), ['ToolSearch', a.name, b.name]);
  assert.deepEqual(converted.messages.filter((m: Wire) => m.role === 'tool').map((m: Wire) => m.tool_call_id), ['a', 'b']);
  assert.match(converted.messages[1].content, /Found:/); assert.match(converted.messages[2].content, /^Tool error:/);
  assert.deepEqual(converted.messages.at(-1).content, [{ type: 'text', text: 'Continue.' }]);
});

test('later history works without search; native Messages and state restoration preserve references', () => {
  const body = request([a, placeholder], history);
  const converted = convertRequest(body, 'messages', 'chat'); assert.deepEqual(toolNames(converted, 'chat'), [a.name]);
  assert.equal(convertRequest(body, 'messages', 'messages'), body);
  const restored = convertRequest(body, 'messages', 'messages', new NativeStateStore().exchange('test', 'messages'));
  assert.deepEqual(restored.tools, body.tools);
  const result = restored.messages.flatMap((m: Wire) => Array.isArray(m.content) ? m.content : []).find((p: Wire) => p.type === 'tool_result');
  assert.deepEqual(result.content, found('search-a', a.name).content[0].content);
  const compacted = convertRequest({ model: 'm', messages: [{ role: 'user', content: 'Summarize prior conversation.' }] }, 'messages', 'chat'); assert.equal(compacted.tools, undefined);
});

test('missing, ambiguous and unsearchable deferred tools fail without expanding dormant definitions', () => {
  assert.throws(() => convertRequest(request([search], history), 'messages', 'chat'), /TOOL_REFERENCE_DEFINITION_MISSING/);
  assert.throws(() => convertRequest(request([search, a, a], history), 'messages', 'chat'), /AMBIGUOUS_TOOL_NAME/);
  assert.throws(() => convertRequest(request([a]), 'messages', 'chat'), /UNSUPPORTED_TOOL_SEARCH_EXECUTION/);
  const malformed = { ...a, input_schema: 'invalid' };
  assert.throws(() => convertRequest(request([search, malformed], history), 'messages', 'chat'), /TOOL_REFERENCE_DEFINITION_MISSING/);
});

test('279 large dormant tools stay out of the initial upstream context', () => {
  const tools = Array.from({ length: 279 }, (_, i) => ({ ...a, name: `mcp__fixture__tool_${i}`, description: 'fixture description '.repeat(180) }));
  const body = request([search, ...tools, placeholder]); assert.ok(Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024);
  const first = convertRequest(body, 'messages', 'chat'); assert.equal(first.tools.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(first)) < 2048);
  const selected = convertRequest(request(body.tools, [question, call('s', 'ToolSearch', {}), found('s', tools[42].name)]), 'messages', 'chat');
  assert.deepEqual(toolNames(selected, 'chat'), ['ToolSearch', tools[42].name]);
});

for (const streaming of [true, false]) test(`gateway executes search/load/call/result loop (${streaming ? 'SSE' : 'JSON'})`, async t => {
  const received: Wire[] = [];
  const upstream = createServer((req, res) => { void (async () => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); received.push(body);
    const turn = received.length;
    const message = turn === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'ToolSearch', arguments: '{"query":"read A"}' } }] } : turn === 2 ? { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: a.name, arguments: '{"path":"a"}' } }] } : { role: 'assistant', content: 'fixture-contents' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'reply', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: turn < 3 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  })(); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gw = new AgentGateway(new RouterCredentials({ TEST_KEY: 'test' }));
  t.after(async () => { await gw.stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  await gw.start({ version: 1, port: 0, providers: [{ id: 'p', name: 'p', enabled: true, protocol: 'chat', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, models: ['model'], auth: { kind: 'env', variable: 'TEST_KEY' } }], groups: [] });
  const messages: Wire[] = [question];
  for (let turn = 0; turn < 3; turn++) {
    const response = await fetch(gw.status().baseUrl + '/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': gw.token() }, body: JSON.stringify({ ...request([search, a, b, placeholder], messages), model: 'p/model', stream: streaming }) });
    assert.equal(response.status, 200);
    let content: Wire[];
    const raw = await response.text();
    if (streaming) {
      assert.match(raw, /message_stop/); const events = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
      const blocks = events.filter(e => e.type === 'content_block_start').map(e => e.content_block);
      for (const block of blocks) if (block.type === 'tool_use') block.input = JSON.parse(events.filter(e => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta').map(e => e.delta.partial_json).join(''));
      content = blocks;
    } else content = JSON.parse(raw).content;
    if (turn < 2) {
      const tool = content.find(p => p.type === 'tool_use')!; assert.equal(tool.name, turn === 0 ? 'ToolSearch' : a.name);
      messages.push({ role: 'assistant', content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: turn === 0 ? [{ type: 'tool_reference', tool_name: a.name }] : 'fixture-contents' }] });
    } else assert.match(raw, /fixture-contents/);
  }
  assert.deepEqual(received.map(body => toolNames(body, 'chat')), [['ToolSearch'], ['ToolSearch', a.name], ['ToolSearch', a.name]]);
});

test('native state restores renamed call IDs without losing the discovery result', () => {
  const store = new NativeStateStore(); const id = 'call_jusage_search_fixture';
  store.save('origin', 'messages', [{ id, nativeId: 'native-search-id', name: 'ToolSearch', args: '{"query":"read A"}' }], []);
  const body = request([search, a, placeholder], [question, call(id, 'ToolSearch', { query: 'read A' }), found(id, a.name)]);
  const restored = convertRequest(body, 'messages', 'messages', store.exchange('origin', 'messages'));
  const blocks = restored.messages.flatMap((m: Wire) => m.content);
  assert.equal(blocks.find((b: Wire) => b.type === 'tool_use').id, 'native-search-id');
  const result = blocks.find((b: Wire) => b.type === 'tool_result'); assert.equal(result.tool_use_id, 'native-search-id');
  assert.deepEqual(result.content, found(id, a.name).content[0].content); assert.deepEqual(restored.tools, body.tools);
});
