import test from 'node:test';
import assert from 'node:assert/strict';
import { preferredClientProtocol, CLIENT_PROTOCOL_PRIORITY, flexibleClientBaseUrl } from '../src/agent-router/integrations/protocol.js';
import { SESSION_AGENTS } from '../src/agent-router/agent-session.js';
import { makeRouterPreset } from '../src/agent-router/presets.js';

test('client protocol preference is Messages, Responses, then Chat, independent of capability order', () => {
  assert.deepEqual(CLIENT_PROTOCOL_PRIORITY, ['messages', 'responses', 'chat']);
  assert.equal(preferredClientProtocol(['chat', 'responses', 'messages']), 'messages');
  assert.equal(preferredClientProtocol(['chat', 'responses']), 'responses');
  assert.equal(preferredClientProtocol(['chat']), 'chat');
  assert.equal(preferredClientProtocol(['gemini']), 'gemini');
  assert.equal(SESSION_AGENTS.opencode, 'messages'); assert.equal(SESSION_AGENTS.codex, 'responses');
  assert.equal(flexibleClientBaseUrl('http://127.0.0.1:18453/v1'), 'http://127.0.0.1:18453');
  assert.equal(makeRouterPreset('claude').protocol, 'messages');
  assert.equal(makeRouterPreset('codex').protocol, 'responses');
  assert.equal(makeRouterPreset('glm-cn-coding').protocol, 'messages');
  assert.equal(makeRouterPreset('deepseek-api').protocol, 'chat');
  assert.equal(makeRouterPreset('glm-cn-coding', 'chat').protocol, 'chat');
});
