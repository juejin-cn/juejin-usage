import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessions } from '../src/agent-router/agent-session.js';

test('temporary launchers isolate original settings, quote shell input and clean up after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-'));
  const original = join(dir, 'original.json');
  const raw = '{ "originalKey": "user-secret", "custom": true }\n';
  await writeFile(original, raw);
  const sessions = new AgentSessions(join(dir, 'sessions'));
  for (const agent of ['claude', 'codex', 'opencode'] as const) {
    const result = await sessions.create(agent, 'http://127.0.0.1:18453/v1', 'fake-secret', "provider/model'$(touch dangerous)");
    assert.equal(JSON.stringify(result).includes('fake-secret'), false);
    const script = await readFile(join(dir, 'sessions', agent + '.sh'), 'utf8');
    if (agent === 'claude') assert.equal(JSON.parse(await readFile(join(dir, 'sessions', 'claude.json'), 'utf8')).env.ENABLE_TOOL_SEARCH, process.env.ENABLE_TOOL_SEARCH ?? 'true');
    if (agent === 'opencode') { assert.match(script, /@ai-sdk\/anthropic/); assert.doesNotMatch(script, /@ai-sdk\/openai-compatible/); }
    assert.ok(script.includes("'\\''"));
    assert.equal((await stat(join(dir, 'sessions', agent + '.sh'))).mode & 0o777, 0o700);
  }
  assert.equal(await readFile(original, 'utf8'), raw);
  await new AgentSessions(join(dir, 'sessions')).clear();
  for (const file of ['claude.sh', 'claude.json', 'codex.sh', 'opencode.sh']) await assert.rejects(stat(join(dir, 'sessions', file)), { code: 'ENOENT' });
  assert.equal(await readFile(original, 'utf8'), raw);
});

test('refuses a symlink directory and non-local destinations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-link-'));
  await symlink(dir, join(dir, 'link'));
  await assert.rejects(new AgentSessions(join(dir, 'link')).clear(), /UNSAFE/);
  await assert.rejects(new AgentSessions(join(dir, 'sessions')).create('codex', 'https://example.com/v1', 'secret', 'm'), /INVALID_URL/);
});
