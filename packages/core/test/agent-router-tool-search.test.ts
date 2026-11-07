import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { AgentGateway, RouterCredentials } from '../src/agent-router/index.js';
import { convertReply, convertRequest } from '../src/agent-router/protocol/index.js';
import { responseToolMap } from '../src/agent-router/protocol/response-tools.js';
import { hasNativeReferences } from '../src/agent-router/protocol/native-state.js';
import type { Wire } from '../src/agent-router/protocol/request.js';

const search = { type: 'tool_search', execution: 'client', description: 'Find a tool by goal', parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'], additionalProperties: false } };
const deferred = { type: 'namespace', name: 'files', tools: [{ type: 'custom', name: 'read', description: 'Read a file by path', defer_loading: true, format: { type: 'text' } }] };
const searchCall = { type: 'tool_search_call', execution: 'client', call_id: 's1', arguments: { goal: 'read file' }, status: 'completed' };
const found = { type: 'tool_search_output', execution: 'client', call_id: 's1', status: 'completed', tools: [deferred] };

test('client search defers schemas until found, and tools remain available through full history', () => {
  const initial = { tools: [search, deferred], input: 'read file' };
  const before = structuredClone(initial);
  const first = convertRequest(initial, 'responses', 'chat');
  assert.deepEqual(first.tools.map((t: Wire) => t.function.name), ['tool_search']);
  assert.deepEqual(first.tools[0].function.parameters, search.parameters);
  assert.equal(JSON.stringify(first).includes('Read a file by path'), false);
  const history = { input: [searchCall, found] };
  const next = convertRequest(history, 'responses', 'chat');
  assert.equal(next.tools.length, 1);
  assert.equal(next.messages[0].tool_calls[0].function.name, 'tool_search');
  assert.equal(next.messages[0].tool_calls[0].function.arguments, '{"goal":"read file"}');
  assert.match(next.messages[1].content, new RegExp(next.tools[0].function.name));
  assert.equal(next.tools[0].function.defer_loading, undefined);
  assert.deepEqual(next.tools[0].function.parameters.required, ['input']);
  assert.deepEqual(initial, before);
  const future = convertRequest({ input: [...history.input, { role: 'user', content: 'read another file' }] }, 'responses', 'chat');
  assert.deepEqual(future.tools, next.tools);
  assert.ok(hasNativeReferences({ input: [{ ...searchCall, call_id: 'call_jusage_fixture' }] }, 'responses'));
});

test('repeated loaded namespaces deduplicate but alias and execution conflicts are explicit', () => {
  const map = responseToolMap([search, deferred], [searchCall, found, { ...found, call_id: 's2' }]);
  assert.equal(map.size, 2);
  const alias = [...map.keys()].find(n => n !== 'tool_search')!;
  assert.throws(() => responseToolMap([{ type: 'function', name: alias }], [found]), /AMBIGUOUS_TOOL_NAME/);
  for (const body of [
    { tools: [{ ...search, execution: 'server' }] },
    { input: [{ ...searchCall, execution: 'server' }] },
    { input: [{ ...searchCall, call_id: null }] },
    { input: [{ ...searchCall, arguments: 'not json' }] },
    { input: [{ ...searchCall, arguments: [] }] },
    { input: [{ ...found, execution: 'server' }] },
    { input: [{ ...found, tools: [{ type: 'web_search' }] }] },
    { input: [{ ...found, tools: [{ type: 'function', name: 'x', async: true }] }] },
    { input: [{ ...found, tools: [{ type: 'function', name: 'x', allowed_callers: 'direct' }] }] },
    { input: [{ ...found, tools: [{ type: 'function', name: 'x', parameters: 'not a schema' }] }] },
    { input: [{ ...found, tools: 'not tools' }] },
  ]) assert.throws(() => convertRequest(body, 'responses', 'chat'), /UNSUPPORTED|INVALID/);
});

test('additional_tools keeps a developer history marker and introduces callable schemas', () => {
  const added = { type: 'additional_tools', role: 'developer', tools: [deferred] };
  const native = convertRequest({ input: [{ role: 'user', content: 'before' }, added, { role: 'user', content: 'after' }] }, 'responses', 'chat');
  assert.deepEqual(native.messages.map((m: Wire) => m.role), ['user', 'developer', 'user']);
  assert.match(native.messages[1].content[0].text, /Tools available from this point/);
  assert.equal(native.tools.length, 1);
  assert.throws(() => convertRequest({ input: [{ ...added, role: 'user' }] }, 'responses', 'chat'), /INVALID_ADDITIONAL_TOOLS_ROLE/);
});

test('fragmented tool search names/arguments produce a client-owned object call without function deltas', async () => {
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 's', function: { name: 'tool_', arguments: '{"go' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: 'al":"read file"}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  const raw = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  const body = Readable.from([...Buffer.from(raw)].map(b => Buffer.from([b])));
  const reply = convertReply({ status: 200, headers: { 'content-type': 'text/event-stream' }, body, dispose() { body.destroy(); } }, 'chat', 'responses', 'p/m', true, new AbortController().signal, undefined, [search]);
  let output = ''; for await (const c of reply.body) output += c;
  const events = output.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
  assert.equal(events.filter(e => e.type === 'response.output_item.added').length, 1);
  assert.equal(events.find(e => e.type === 'response.output_item.added').item.type, 'tool_search_call');
  const call = events.find(e => e.type === 'response.output_item.done').item;
  assert.equal(call.execution, 'client'); assert.deepEqual(call.arguments, { goal: 'read file' }); assert.equal(call.call_id, 's');
  assert.ok(!events.some(e => e.type.startsWith('response.function_call_arguments.')));
  assert.deepEqual(events.at(-1).response.output, [call]);
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
});

for (const protocol of ['chat', 'messages', 'gemini'] as const) for (const stream of [false, true]) {
  test(`HTTP search → discovered custom tool → result via ${protocol}, streaming=${stream}`, async t => {
    const received: Wire[] = [];
    const upstream = createServer((req, res) => { void (async () => {
      let raw = ''; for await (const c of req) raw += c; const b = JSON.parse(raw); received.push(b);
      const phase = received.length;
      const definitions = protocol === 'chat' ? b.tools.map((t: Wire) => t.function) : protocol === 'messages' ? b.tools : b.tools[0].functionDeclarations;
      if (phase === 1) assert.deepEqual(definitions.map((d: Wire) => d.name), ['tool_search']);
      else { assert.equal(definitions.length, 1); assert.notEqual(definitions[0].name, 'tool_search'); }
      const name = definitions[0].name;
      const args = phase === 1 ? { goal: 'read file' } : { input: 'canary.txt' };
      const call = phase < 3;
      const value = protocol === 'chat' ? { choices: [{ message: call ? { tool_calls: [{ id: `native-${phase}`, function: { name, arguments: JSON.stringify(args) } }] } : { content: 'CANARY' }, finish_reason: call ? 'tool_calls' : 'stop' }] }
        : protocol === 'messages' ? { type: 'message', content: call ? [{ type: 'tool_use', id: `native-${phase}`, name, input: args }] : [{ type: 'text', text: 'CANARY' }], stop_reason: call ? 'tool_use' : 'end_turn' }
          : { candidates: [{ content: { parts: call ? [{ functionCall: { id: `native-${phase}`, name, args } }] : [{ text: 'CANARY' }] }, finishReason: 'STOP' }] };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
    })(); }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const gateway = new AgentGateway(new RouterCredentials({ KEY: 'fixture' }));
    await gateway.start({ version: 1, port: 0, groups: [], providers: [{ id: 'p', name: 'p', enabled: true, protocol, baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }] });
    t.after(() => gateway.stop());
    const post = async (input: Wire[], tools?: Wire[]) => {
      const reply = await fetch(gateway.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'p/m', input, tools, stream }) });
      const raw = await reply.text(); assert.equal(reply.status, 200, raw);
      return stream ? JSON.parse(raw.split('\n').filter(l => l.startsWith('data: {')).at(-1)!.slice(6)).response : JSON.parse(raw);
    };
    const user = { role: 'user', content: 'read file' };
    const first = await post([user], [search, deferred]);
    const call = first.output[0]; assert.equal(call.type, 'tool_search_call'); assert.equal(call.execution, 'client'); assert.deepEqual(call.arguments, { goal: 'read file' });
    const loaded = { ...found, call_id: call.call_id };
    if (protocol === 'chat' && !stream) {
      const invalid = await fetch(gateway.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'p/m', input: [user, { ...call, arguments: { goal: 'altered' } }, loaded] }) });
      assert.equal(invalid.status, 409); assert.match(await invalid.text(), /NATIVE_STATE_CALL_MISMATCH/);
      assert.equal(received.length, 1);
    }
    const second = await post([user, call, loaded]);
    const read = second.output[0]; assert.equal(read.type, 'custom_tool_call'); assert.equal(read.name, 'read'); assert.equal(read.namespace, 'files'); assert.equal(read.input, 'canary.txt');
    const third = await post([user, call, loaded, read, { type: 'custom_tool_call_output', call_id: read.call_id, output: 'CANARY' }]);
    assert.equal(third.output[0].content[0].text, 'CANARY');
    const chat = protocol === 'chat' ? received[2] : convertRequest(received[2], protocol, 'chat');
    const calls = chat.messages.flatMap((m: Wire) => m.tool_calls ?? []);
    assert.deepEqual(calls.map((c: Wire) => c.id), ['native-1', 'native-2']);
    assert.deepEqual(chat.messages.filter((m: Wire) => m.role === 'tool').map((m: Wire) => m.tool_call_id), ['native-1', 'native-2']);
  });
}
