import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { NativeStateStore } from '../src/agent-router/protocol/native-state.js';
import { convertReply, convertRequest } from '../src/agent-router/protocol/index.js';
import type { Wire } from '../src/agent-router/protocol/request.js';

async function convert(raw: Wire | string, store: NativeStateStore, source: 'messages' | 'responses' | 'chat') {
  const body = Readable.from([typeof raw === 'string' ? raw : JSON.stringify(raw)]);
  const reply = convertReply({ status: 200, headers: { 'content-type': typeof raw === 'string' ? 'text/event-stream' : 'application/json' }, body, dispose: () => body.destroy() }, source, 'chat', 'p/m', false, new AbortController().signal, store.exchange('account/model/session', source));
  let out = ''; for await (const part of reply.body) out += part.toString(); return JSON.parse(out) as Wire;
}
test('signed Messages thinking and redacted blocks restore before parallel native tool calls', async () => {
  const store = new NativeStateStore();
  const first = await convert({ type: 'message', content: [
    { type: 'thinking', thinking: 'thought', signature: 'signed-native' }, { type: 'redacted_thinking', data: 'redacted-native' },
    { type: 'tool_use', id: 'a', name: 'read', input: { path: 'A', deep: { x: 1, y: 2 } } },
    { type: 'tool_use', id: 'b', name: 'read', input: { path: 'B' } },
  ], stop_reason: 'tool_use' }, store, 'messages');
  assert.ok(!JSON.stringify(first).includes('signed-native'));
  const calls = first.choices[0].message.tool_calls;
  const messages = [{ role: 'assistant', ...first.choices[0].message }, ...calls.map((c: Wire) => ({ role: 'tool', tool_call_id: c.id, content: 'result' }))];
  calls[0].function.arguments = '{"deep":{"y":2,"x":1},"path":"A"}';
  const restored = convertRequest({ model: 'm', messages }, 'chat', 'messages', store.exchange('account/model/session', 'messages'));
  assert.deepEqual(restored.messages[0].content.slice(0, 2), [{ type: 'thinking', thinking: 'thought', signature: 'signed-native' }, { type: 'redacted_thinking', data: 'redacted-native' }]);
  assert.deepEqual(restored.messages[0].content.filter((p: Wire) => p.type === 'tool_use').map((p: Wire) => p.id), ['a', 'b']);
  assert.deepEqual(restored.messages[1].content.map((p: Wire) => p.tool_use_id), ['a', 'b']);
  assert.throws(() => convertRequest({ model: 'm', messages }, 'chat', 'messages', store.exchange('other-account/model/session', 'messages')), /ORIGIN_MISMATCH/);
  calls[0].function.arguments = '{"path":"changed"}';
  assert.throws(() => convertRequest({ model: 'm', messages }, 'chat', 'messages', store.exchange('account/model/session', 'messages')), /CALL_MISMATCH/);
});
test('streamed thinking/signature fragments and Responses encrypted state survive tool round trip', async () => {
  const store = new NativeStateStore();
  const frames = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'native' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
  ].map(v => `data: ${JSON.stringify(v)}\n\n`).join('');
  const first = await convert(frames, store, 'messages');
  const restored = convertRequest({ messages: [first.choices[0].message] }, 'chat', 'messages', store.exchange('account/model/session', 'messages'));
  assert.deepEqual(restored.messages[0].content[0], { type: 'thinking', thinking: 'thought', signature: 'signed-native' });
  const encrypted = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'summary' }], encrypted_content: 'opaque-ciphertext' };
  const response = await convert({ output: [encrypted, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}' }], status: 'completed' }, store, 'responses');
  const native = convertRequest({ messages: [response.choices[0].message] }, 'chat', 'responses', store.exchange('account/model/session', 'responses'));
  assert.deepEqual(native.input[0], encrypted); assert.equal(native.input[1].call_id, 'call_1');
});
test('state TTL, bounded eviction, missing history, and unsigned-only restoration never fabricate context', async () => {
  let now = 100; const store = new NativeStateStore(() => now, 50, 1);
  const first = await convert({ choices: [{ message: { tool_calls: [{ id: 'native', function: { name: 'read', arguments: '{}' }, extra_content: { google: { thought_signature: 'opaque' } } }] }, finish_reason: 'tool_calls' }] }, store, 'chat');
  // Same-protocol pass-through intentionally does not map native tool IDs.
  const mappedBody = Readable.from([JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: 'n', name: 'read', args: {} }, thoughtSignature: 'opaque' }] }, finishReason: 'STOP' }] })]);
  const mapped = convertReply({ status: 200, headers: { 'content-type': 'application/json' }, body: mappedBody, dispose() { mappedBody.destroy(); } }, 'gemini', 'chat', 'm', false, new AbortController().signal, store.exchange('origin', 'gemini'));
  let raw = ''; for await (const c of mapped.body) raw += c; const call = JSON.parse(raw).choices[0].message.tool_calls[0];
  const history = { messages: [{ role: 'assistant', content: null, tool_calls: [call] }] };
  assert.throws(() => convertRequest({ messages: [{ role: 'tool', tool_call_id: call.id, content: 'x' }] }, 'chat', 'gemini', store.exchange('origin', 'gemini')), /HISTORY_REQUIRED/);
  now = 151;
  assert.throws(() => convertRequest(history, 'chat', 'gemini', store.exchange('origin', 'gemini')), /EXPIRED_RESTART_SESSION/);
  assert.equal(first.choices[0].message.tool_calls[0].id, 'native');
  await assert.rejects(convert({ type: 'message', content: [{ type: 'thinking', thinking: 'hidden', signature: 'real' }], stop_reason: 'end_turn' }, store, 'messages'), /REQUIRES_TOOL_CALL/);
});
test('cache reads/writes and reasoning remain details of input/output totals', async () => {
  const store = new NativeStateStore();
  const converted = await convert({ type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 3, output_tokens: 7 } }, store, 'messages');
  assert.equal(converted.usage.prompt_tokens, 18); assert.equal(converted.usage.total_tokens, 25); assert.equal(converted.usage.prompt_tokens_details.cache_write_tokens, 3);
});

test('native Messages SSE aggregation keeps signed thinking without requiring tool calls', async () => {
  const frames = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'native' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'encrypted' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ].map(v => `data: ${JSON.stringify(v)}\n\n`).join('');
  const input = Readable.from([frames]);
  const converted = convertReply({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: input, dispose() { input.destroy(); } }, 'messages', 'messages', 'm', false, new AbortController().signal);
  let raw = ''; for await (const c of converted.body) raw += c;
  assert.deepEqual(JSON.parse(raw).content, [{ type: 'thinking', thinking: 'thought', signature: 'native' }, { type: 'redacted_thinking', data: 'encrypted' }]);
});

test('state capacity evicts old calls and clear invalidates all remaining references', () => {
  const store = new NativeStateStore(Date.now, 1000, 1); const exchange = store.exchange('origin', 'gemini');
  const first = exchange.reserve(); const second = exchange.reserve();
  exchange.complete([{ id: first, nativeId: 'a', name: 'read', args: '{}' }], []);
  exchange.complete([{ id: second, nativeId: 'b', name: 'read', args: '{}' }], []);
  assert.throws(() => store.get(first, 'origin'), /EXPIRED/); assert.equal(store.get(second, 'origin').nativeId, 'b');
  store.clear(); assert.throws(() => store.get(second, 'origin'), /EXPIRED/);
});
