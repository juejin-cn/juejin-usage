import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { AgentGateway, RouterCredentials } from '../src/agent-router/index.js';
import { convertRequest } from '../src/agent-router/protocol/index.js';
import { hostedToolPlan, runHostedTools, replyJson } from '../src/agent-router/protocol/hosted-tools.js';
import type { Protocol } from '../src/agent-router/config.js';
import type { Wire } from '../src/agent-router/protocol/request.js';

const requests: Record<Protocol, Wire> = {
  responses: { model: 'p/m', input: 'Search for the release', tools: [{ type: 'web_search' }] },
  messages: { model: 'p/m', max_tokens: 1024, messages: [{ role: 'user', content: 'Search for the release' }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] },
  chat: { model: 'p/m', messages: [{ role: 'user', content: 'Search for the release' }], web_search_options: {} },
  gemini: { model: 'p/m', contents: [{ role: 'user', parts: [{ text: 'Search for the release' }] }], tools: [{ googleSearch: {} }] },
};
const protocols = Object.keys(requests) as Protocol[];
const hit = { title: 'Release notes', url: 'https://example.com/release', snippet: 'Version 2 released.' };

for (const source of protocols) for (const target of protocols) test(`hosted web search lowering ${source} → ${target}`, () => {
  const input = structuredClone(requests[source]);
  const plan = hostedToolPlan(input, source, target);
  if (source === target) { assert.equal(plan, undefined); return; }
  assert.ok(plan);
  assert.equal(plan.body.tools.length, 1);
  assert.equal(plan.body.tools[0].type, 'function');
  assert.equal(plan.body.tools[0].function.name, plan.name);
  assert.doesNotThrow(() => convertRequest(plan.body, 'chat', target));
  assert.deepEqual(input, requests[source]);
});

for (const source of protocols) for (const stream of [false, true]) test(`${source} hosted search executes, feeds results back and serializes ${stream ? 'SSE' : 'JSON'}`, async () => {
  const plan = hostedToolPlan(requests[source], source, source === 'chat' ? 'messages' : 'chat')!;
  let calls = 0; let searched = 0;
  const signal = new AbortController().signal;
  const reply = await runHostedTools(plan, 'p/m', stream, signal, async body => {
    calls++;
    if (calls === 2) assert.match(JSON.stringify(body.messages.at(-1)), /Version 2 released/);
    const message = calls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: plan.name, arguments: '{"query":"latest release"}' } }] }
      : { role: 'assistant', content: 'Version 2: https://example.com/release' };
    const bodyStream = Readable.from([JSON.stringify({ choices: [{ message, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })]);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: bodyStream, dispose() { bodyStream.destroy(); } };
  }, async query => { searched++; assert.equal(query, 'latest release'); return { text: hit.snippet, sources: [hit] }; });
  let raw = ''; for await (const c of reply.body) raw += c;
  assert.equal(calls, 2); assert.equal(searched, 1);
  assert.match(raw, /example.com\/release/); assert.doesNotMatch(raw, new RegExp(plan.name));
  if (stream) assert.match(raw, source === 'responses' ? /response.completed/ : source === 'messages' ? /message_stop/ : source === 'chat' ? /\[DONE\]/ : /finishReason/);
  else {
    const value = JSON.parse(raw);
    if (source === 'responses') { assert.equal(value.output[0].type, 'web_search_call'); assert.equal(value.output[0].status, 'completed'); assert.equal(value.usage.input_tokens, 20); }
    if (source === 'messages') assert.equal(value.content[1].type, 'web_search_tool_result');
  }
});

test('failed search is a real tool error followed by a normal answer, never fake success', async () => {
  const plan = hostedToolPlan(requests.responses, 'responses', 'chat')!; let calls = 0;
  const reply = await runHostedTools(plan, 'p/m', false, new AbortController().signal, async body => {
    calls++;
    if (calls === 2) assert.match(body.messages.at(-1).content, /SEARCH_UNAVAILABLE/);
    const message = calls === 1 ? { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: plan.name, arguments: '{"query":"release"}' } }] } : { role: 'assistant', content: 'Search is unavailable.' };
    const bodyStream = Readable.from([JSON.stringify({ choices: [{ message }] })]);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: bodyStream, dispose() { bodyStream.destroy(); } };
  }, async () => { throw new Error('backend refused'); });
  const value = await replyJson(reply, new AbortController().signal);
  assert.equal(value.status, 'completed'); assert.equal(value.output[0].status, 'failed');
  assert.equal(value.output[0].action.sources.length, 0);
});

test('search history replays after the client stops offering search, without exposing a new tool', () => {
  const plan = hostedToolPlan({ model: 'p/m', input: [{ type: 'web_search_call', id: 'ws_previous', status: 'completed', action: { query: 'release', sources: [hit] } }, { role: 'user', content: 'Explain the release' }] }, 'responses', 'chat')!;
  assert.ok(plan); assert.equal(plan.body.tools, undefined);
  assert.match(JSON.stringify(plan.body.messages), /example.com\/release/);
});

test('search budget and cancellation prevent backend execution', async () => {
  for (const options of [{ max_uses: 0 }]) {
    const plan = hostedToolPlan({ ...requests.responses, tools: [{ type: 'web_search', ...options }] }, 'responses', 'chat')!;
    let calls = 0;
    const reply = await runHostedTools(plan, 'p/m', false, new AbortController().signal, async body => {
      const message = ++calls === 1 ? { role: 'assistant', tool_calls: [{ id: 's', type: 'function', function: { name: plan.name, arguments: '{"query":"release"}' } }] } : { role: 'assistant', content: 'No search was performed.' };
      if (calls === 2) assert.ok(!body.tools.some((t: Wire) => t.function.name === plan.name));
      const stream = Readable.from([JSON.stringify({ choices: [{ message }] })]);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: stream, dispose() { stream.destroy(); } };
    }, async () => { assert.fail('backend must not execute'); });
    const value = await replyJson(reply, new AbortController().signal);
    assert.equal(value.output[0].status, 'failed');
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runHostedTools(hostedToolPlan(requests.responses, 'responses', 'chat')!, 'p/m', false, controller.signal, async () => { assert.fail('model must not execute'); }, async () => { assert.fail('search must not execute'); }));
});

test('Codex web search and custom client tool work through a Chat upstream over real HTTP', async t => {
  let calls = 0; const bodies: Wire[] = []; let searches = 0;
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (req.url === '/v1/responses') {
      searches++; assert.equal(body.input, 'release'); assert.equal(body.tool_choice.type, 'web_search');
      assert.equal(body.tools[0].type, 'web_search'); assert.equal(body.tools[0].external_web_access, false); assert.doesNotMatch(JSON.stringify(body), /Search for the release|apply_patch/);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'search_response', object: 'response', status: 'completed', output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'release', sources: [hit] } }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: hit.snippet, annotations: [] }] }] })); return;
    }
    bodies.push(body); calls++;
    const name = body.tools.find((t: Wire) => t.function.name.startsWith('gateway_web_search_'))?.function.name;
    const message = calls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'search1', type: 'function', function: { name, arguments: '{"query":"release"}' } }] }
      : { role: 'assistant', content: 'Found https://example.com/release', tool_calls: [{ id: 'edit1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) } }] };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('listener');
  const gateway = new AgentGateway(new RouterCredentials({ TEST_KEY: 'key' }));
  t.after(() => gateway.stop());
  await gateway.start({ version: 1, port: 0, providers: [
    { id: 'p', name: 'Provider', enabled: true, protocol: 'chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ['m'], auth: { kind: 'env', variable: 'TEST_KEY' } },
    { id: 'search', name: 'Search backend', enabled: true, protocol: 'responses', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ['native'], auth: { kind: 'env', variable: 'TEST_KEY' } },
  ], groups: [] });
  const response = await fetch(gateway.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: 'Bearer ' + gateway.token(), 'content-type': 'application/json' }, body: JSON.stringify({ ...requests.responses, stream: true, tools: [{ type: 'web_search', external_web_access: false }, { type: 'custom', name: 'apply_patch', format: { type: 'text' } }] }) });
  const raw = await response.text();
  assert.equal(response.status, 200, raw); assert.match(raw, /response.completed/); assert.match(raw, /web_search_call/); assert.match(raw, /custom_tool_call/);
  assert.doesNotMatch(raw, /gateway_web_search_/); assert.equal(searches, 1); assert.equal(calls, 2);
  assert.match(JSON.stringify(bodies[1].messages), /Version 2 released/);
});
