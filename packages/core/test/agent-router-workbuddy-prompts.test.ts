import test from 'node:test';
import assert from 'node:assert/strict';
import { workbuddyChannel } from '../src/agent-router/channels/workbuddy.js';
import { HARNESS_PATH_GUIDANCE, HARNESS_CHECKOUT_GUIDANCE, HARNESS_GUI_IDENTITY, portableHarnessGuidance } from '../src/agent-router/channels/workbuddy-prompts.js';
import { portableClientIdentity, PORTABLE_CLIENT_IDENTITY } from '../src/agent-router/protocol/client-identity.js';

const codexIdentity = 'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.';
test('portable identity preserves every instruction after the closed Codex introduction and leaves quoted text alone', () => {
  const suffix = ' You are expected to be precise, safe, and helpful.\n\n# AGENTS.md spec\nKeep all repository guidance.\r\n';
  assert.equal(portableClientIdentity(codexIdentity + suffix), PORTABLE_CLIENT_IDENTITY + suffix);
  for (const text of ['Quoted example: ' + codexIdentity, 'User asks about Codex CLI and OpenAI.', codexIdentity + 'custom suffix', codexIdentity.replace('terminal-based', 'custom')]) assert.equal(portableClientIdentity(text), text);
});

for (const role of ['system', 'developer']) for (const blocks of [false, true]) test(`WorkBuddy normalizes the stock Codex ${role} identity in ${blocks ? 'text blocks' : 'text'} without modifying user content`, async () => {
  const original = codexIdentity + ' You are expected to be precise, safe, and helpful.\n\nRetain every tool and all repository instructions.';
  const body = { model: 'hy4free', stream: true, messages: [{ role, content: blocks ? [{ type: 'text', text: original }] : original }, { role: 'user', content: original }], tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }] };
  const channel = workbuddyChannel(false, async (_url, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.messages[0].role, 'system');
    const text = blocks ? sent.messages[0].content[0].text : sent.messages[0].content;
    assert.equal(text, PORTABLE_CLIENT_IDENTITY + original.slice(codexIdentity.length));
    assert.deepEqual(sent.messages[1], body.messages[1]); assert.deepEqual(sent.tools, body.tools);
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const transport = await channel.auth.transport(async () => ({ type: 'oauth', access: 'fixture', uid: 'fixture' }));
  assert.equal((await transport.fetch!('https://fixture.example/chat/completions', { method: 'POST', body: JSON.stringify(body) })).status, 200);
});

for (const global of [false, true]) test(`WorkBuddy ${global ? 'global' : 'China'} accepts Harness Desktop guidance while retaining every tool and user instruction`, async () => {
  const guiSuffix = ' Keep all user language preferences.\nNever claim an unexecuted tool succeeded.';
  const custom = 'Repository instructions: retain the exact text of user files.';
  const system = ['You are an AI agent powered by DeepSeek Harness.', custom, HARNESS_PATH_GUIDANCE, HARNESS_CHECKOUT_GUIDANCE, HARNESS_GUI_IDENTITY + guiSuffix].join('\n\n');
  const tools = Array.from({ length: 43 }, (_, i) => ({ type: 'function', function: { name: 'tool_' + i, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }));
  const body = { model: 'hy4free', stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: system }, { role: 'assistant', content: 'Contact @user and preserve DeepSeek Harness in the requested answer.' }], tools };
  const original = structuredClone(body);
  const channel = workbuddyChannel(global, async (_url, init) => {
    const sent = JSON.parse(String(init?.body)); const content = sent.messages[0].content;
    assert.ok(content.startsWith("You are an AI coding assistant running in the user's local CLI."));
    assert.ok(content.includes(custom)); assert.ok(content.endsWith(guiSuffix));
    assert.ok(content.includes('Unicode U+0040')); assert.ok(content.includes('double-quoted path'));
    assert.ok(content.includes('Relative paths resolve from the workspace root'));
    assert.ok(content.includes('do not claim to have inspected it before reading'));
    assert.ok(content.includes('Use pwd to determine the current working directory'));
    assert.ok(content.includes('Use this checkout only to inspect or extend the agent itself'));
    assert.ok(content.includes('Web GUI whose URL the runtime context names'));
    assert.ok(!content.includes('DeepSeek Harness')); assert.ok(!content.includes('@'));
    assert.deepEqual(sent.tools, tools); assert.equal(sent.tools.length, 43);
    assert.deepEqual(sent.messages.slice(1), body.messages.slice(1));
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const transport = await channel.auth.transport(async () => ({ type: 'oauth', access: 'fixture', uid: 'fixture' }));
  const response = await transport.fetch!('https://fixture.example/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 200); assert.match(await response.text(), /OK/); assert.deepEqual(body, original);
});

test('Harness guidance conversion preserves paragraph boundaries and leaves custom prose and partial matches alone', () => {
  const separator = '\r\n\r\n';
  const custom = 'User instruction: ' + HARNESS_PATH_GUIDANCE;
  const changed = HARNESS_PATH_GUIDANCE.replace('Tokens prefixed', 'Custom tokens prefixed');
  const other = 'Retain the literal brand DeepSeek Harness and @ characters in user documentation.';
  const suffix = ' Preserve this exact additional requirement.';
  const result = portableHarnessGuidance([custom, changed, other, HARNESS_GUI_IDENTITY + suffix, HARNESS_PATH_GUIDANCE].join(separator));
  assert.ok(result.startsWith([custom, changed, other].join(separator)));
  assert.ok(result.includes('Web GUI whose URL the runtime context names.' + suffix));
  assert.equal(result.split(separator).length, 5);
  assert.equal(portableHarnessGuidance('Quoted example: ' + HARNESS_GUI_IDENTITY), 'Quoted example: ' + HARNESS_GUI_IDENTITY);
});
