import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { AgentGateway, RouterCredentials } from '../src/agent-router/index.js';
import { convertRequest, convertReply } from '../src/agent-router/protocol/index.js';
import { responseToolMap } from '../src/agent-router/protocol/response-tools.js';
import { hasNativeReferences } from '../src/agent-router/protocol/native-state.js';
import type { Wire } from '../src/agent-router/protocol/request.js';

const patch = '*** Begin Patch\n*** Add File: 🐱.txt\n+"hello"\\world\n*** End Patch';
const tools = [{ type: 'namespace', name: 'workspace', description: 'Workspace tools', tools: [
  { type: 'custom', name: 'apply_patch', description: 'Apply edits', format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' } },
  { type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
] }, { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }];

test('Responses custom and namespace tools preserve exact history and named tool choice', () => {
  const body = { tools, input: [
    { type: 'custom_tool_call', name: 'apply_patch', namespace: 'workspace', call_id: 'c', input: patch },
    { type: 'custom_tool_call_output', call_id: 'c', output: 'applied' },
    { type: 'function_call', name: 'read', namespace: 'workspace', call_id: 'r', arguments: '{"path":"🐱.txt"}', encrypted_function_args: [] },
    { type: 'function_call_output', call_id: 'r', output: 'hello' },
  ], tool_choice: { type: 'custom', name: 'apply_patch', namespace: 'workspace' } };
  const before = structuredClone(body);
  for (const protocol of ['chat', 'messages', 'gemini'] as const) {
    const native = convertRequest(body, 'responses', protocol);
    const chat = protocol === 'chat' ? native : convertRequest(native, protocol, 'chat');
    const names = chat.tools.map((t: Wire) => t.function.name);
    assert.equal(new Set(names).size, 3);
    assert.equal(chat.messages[0].tool_calls[0].function.arguments, JSON.stringify({ input: patch }));
    assert.equal(protocol === 'gemini' ? JSON.parse(chat.messages[1].content).output : chat.messages[1].content, 'applied');
    assert.equal(chat.tool_choice.function.name, names[0]);
    assert.match(chat.tools[0].function.description, /Input grammar \(lark\)/);
    assert.deepEqual(chat.tools[0].function.parameters.required, ['input']);
  }
  assert.deepEqual(body, before);
  assert.equal(convertRequest(body, 'responses', 'responses'), body);
  assert.ok(hasNativeReferences({ input: [{ type: 'custom_tool_call_output', call_id: 'call_jusage_fixture' }] }, 'responses'));
});

test('namespace collisions and unsupported execution/format features fail explicitly', () => {
  const alias = [...responseToolMap(tools).keys()][0];
  assert.throws(() => responseToolMap([...tools, { type: 'function', name: alias }]), /AMBIGUOUS_TOOL_NAME/);
  for (const tool of [{ type: 'custom', name: 'x', async: true }, { type: 'custom', name: 'x', defer_loading: true }, { type: 'custom', name: 'x', format: { type: 'unknown' } }]) {
    assert.throws(() => convertRequest({ tools: [tool] }, 'responses', 'chat'), /UNSUPPORTED/);
  }
});

test('fragmented upstream JSON is decoded once into exact Responses custom tool input events', async () => {
  const alias = [...responseToolMap(tools).keys()][0], args = JSON.stringify({ input: patch });
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: alias, arguments: args.slice(0, 20) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(20) } }] }, finish_reason: 'tool_calls' }] },
  ];
  const raw = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const body = Readable.from([...Buffer.from(raw)].map(c => Buffer.from([c])));
  const reply = convertReply({ status: 200, headers: { 'content-type': 'text/event-stream' }, body, dispose() { body.destroy(); } }, 'chat', 'responses', 'p/m', true, new AbortController().signal, undefined, tools);
  let output = ''; for await (const c of reply.body) output += c;
  const frames = output.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  const item = frames.find(f => f.type === 'response.output_item.added').item;
  assert.equal(item.type, 'custom_tool_call'); assert.equal(item.input, '');
  assert.equal(item.name, 'apply_patch'); assert.equal(item.namespace, 'workspace');
  assert.equal(frames.filter(f => f.type === 'response.custom_tool_call_input.delta').map(f => f.delta).join(''), patch);
  assert.equal(frames.find(f => f.type === 'response.custom_tool_call_input.done').input, patch);
  assert.equal(frames.at(-1).response.output[0].input, patch);
  assert.ok(!frames.some(f => f.type === 'response.function_call_arguments.delta'));
  assert.deepEqual(frames.map(f => f.sequence_number), frames.map((_, i) => i));
});

test('parallel namespace functions and a standalone function keep distinct names and IDs', async () => {
  const named = [...responseToolMap(tools)].find(([, value]) => value.namespace && value.name === 'read')![0];
  const body = Readable.from([JSON.stringify({ choices: [{ message: { tool_calls: [
    { id: 'namespace-call', function: { name: named, arguments: '{"path":"a"}' } },
    { id: 'standalone-call', function: { name: 'read', arguments: '{}' } },
  ] }, finish_reason: 'tool_calls' }] })]);
  const reply = convertReply({ status: 200, headers: { 'content-type': 'application/json' }, body, dispose() { body.destroy(); } }, 'chat', 'responses', 'p/m', false, new AbortController().signal, undefined, tools);
  let raw = ''; for await (const c of reply.body) raw += c;
  const calls = JSON.parse(raw).output;
  assert.deepEqual(calls.map((c: Wire) => [c.name, c.namespace, c.call_id]), [['read', 'workspace', 'namespace-call'], ['read', undefined, 'standalone-call']]);
  assert.deepEqual(calls[0].encrypted_function_args, []);
  assert.equal(calls[0].arguments, '{"path":"a"}');
});

for (const protocol of ['chat', 'messages', 'gemini'] as const) for (const stream of [false, true]) {
  test(`HTTP Responses custom tool round trip via ${protocol}, streaming=${stream}`, async t => {
    const received: Wire[] = [];
    const upstream = createServer((req, res) => { void (async () => {
      let raw = ''; for await (const c of req) raw += c; const b = JSON.parse(raw); received.push(b);
      const tool = protocol === 'chat' ? b.tools[0].function : protocol === 'messages' ? b.tools[0] : b.tools[0].functionDeclarations[0];
      const call = received.length === 1;
      const value = protocol === 'chat' ? { choices: [{ message: call ? { tool_calls: [{ id: 'native-call', type: 'function', function: { name: tool.name, arguments: JSON.stringify({ input: patch }) } }] } : { content: 'applied' }, finish_reason: call ? 'tool_calls' : 'stop' }] }
        : protocol === 'messages' ? { type: 'message', content: call ? [{ type: 'tool_use', id: 'native-call', name: tool.name, input: { input: patch } }] : [{ type: 'text', text: 'applied' }], stop_reason: call ? 'tool_use' : 'end_turn' }
          : { candidates: [{ content: { parts: call ? [{ functionCall: { id: 'native-call', name: tool.name, args: { input: patch } } }] : [{ text: 'applied' }] }, finishReason: 'STOP' }] };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
    })(); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const gateway = new AgentGateway(new RouterCredentials({ KEY: 'fixture' }));
    await gateway.start({ version: 1, port: 0, groups: [], providers: [{ id: 'p', name: 'p', enabled: true, protocol, baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'KEY' } }] });
    t.after(() => gateway.stop());
    const post = (input: Wire[]) => fetch(gateway.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'p/m', tools, stream, input }) });
    const first = await post([{ role: 'user', content: 'apply patch' }]);
    const raw = await first.text(); assert.equal(first.status, 200, raw);
    const result = stream ? JSON.parse(raw.split('\n').filter(l => l.startsWith('data: {')).at(-1)!.slice(6)).response : JSON.parse(raw);
    const call = result.output[0]; assert.equal(call.type, 'custom_tool_call'); assert.equal(call.input, patch);
    assert.match(call.call_id, /^call_jusage_/);
    const second = await post([{ role: 'user', content: 'apply patch' }, call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'applied' }]);
    const secondRaw = await second.text(); assert.equal(second.status, 200, secondRaw); assert.match(secondRaw, /applied/);
    const chat = protocol === 'chat' ? received[1] : convertRequest(received[1], protocol, 'chat');
    assert.equal(chat.messages[1].tool_calls[0].id, 'native-call');
    assert.equal(chat.messages[1].tool_calls[0].function.arguments, JSON.stringify({ input: patch }));
    assert.equal(chat.messages[2].tool_call_id, 'native-call');
  });
}

test('invalid wrapped custom tool input is not published as successful JSON', async () => {
  const alias = [...responseToolMap(tools).keys()][0];
  for (const args of ['{}', '{"input":12}', '{"input":"a","extra":true}']) {
    const body = Readable.from([JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: alias, arguments: args } }] }, finish_reason: 'tool_calls' }] })]);
    const reply = convertReply({ status: 200, headers: { 'content-type': 'application/json' }, body, dispose() { body.destroy(); } }, 'chat', 'responses', 'p/m', false, new AbortController().signal, undefined, tools);
    await assert.rejects(async () => { for await (const _ of reply.body) {} }, /UPSTREAM_INVALID_CUSTOM_TOOL_INPUT/);
  }
});
