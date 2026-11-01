import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { codexCredentials, codexLogin, codexChannel } from '../src/agent-router/native/codex.js';
import { claudeEnv, claudeInput, claudeModels, claudeChannel } from '../src/agent-router/native/claude.js';
import { makeRouterPreset } from '../src/agent-router/presets.js';
import { validateRouterConfig } from '../src/agent-router/config.js';
import { RouterSubscriptions } from '../src/agent-router/subscriptions.js';
import { RouterCredentialStore } from '../src/agent-router/credential-store.js';
import { sameSubscriptionAccount } from '../src/agent-router/credential-store.js';

const jwt = (value: object) => 'header.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.signature';
const tokens = { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: 'refresh-fixture',
  id_token: jwt({ email: 'test@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1', chatgpt_plan_type: 'plus' } }) };

test('native channels pin their protocol and identity; token rotation does not duplicate Codex', () => {
  const codex = makeRouterPreset('codex', 'responses'); const claude = makeRouterPreset('claude', 'messages');
  assert.equal(validateRouterConfig({ version: 1, port: 0, providers: [codex, claude], groups: [] }).providers.length, 2);
  assert.throws(() => makeRouterPreset('codex', 'chat'));
  const auth = codexCredentials(tokens);
  assert.equal(auth.accountId, 'account-1'); assert.equal(auth.accountName, 'test@example.com');
  assert.equal(sameSubscriptionAccount(codex, { kind: 'subscription', auth }, codex, { kind: 'subscription', auth: { ...auth, access: 'rotated' } }), true);
  assert.equal(sameSubscriptionAccount(codex, { kind: 'subscription', auth }, codex, { kind: 'subscription', auth: { ...auth, accountId: 'other' } }), false);
  const local = { type: 'oauth', source: 'claude-code-local', accountName: 'test@example.com', organizationId: 'team-a' };
  assert.equal(sameSubscriptionAccount(claude, { kind: 'subscription', auth: local }, claude, { kind: 'subscription', auth: local }), true);
  assert.equal(sameSubscriptionAccount(claude, { kind: 'subscription', auth: local }, claude, { kind: 'subscription', auth: { ...local, organizationId: 'team-b' } }), false);
});

test('Codex catalog, refresh, quota and Responses adaptation use the signed-in account', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/oauth/token')) return Response.json({ ...tokens, access_token: 'renewed', expires_in: 3600 });
    if (url.includes('/models')) return Response.json({ models: [{ slug: 'gpt-test', display_name: 'GPT Test' }, { slug: 'hidden', visibility: 'hidden' }] });
    if (url.includes('/usage')) return Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, reset_at: 2_000_000_000 } } });
    return new Response('event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp-test","output":[]}}\r\n\r\n', { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const channel = codexChannel(fetcher); const auth = codexCredentials(tokens);
  const models = await channel.models(auth); assert.deepEqual(Object.keys(models), ['gpt-test']); assert.equal(models['gpt-test'].name, 'GPT Test');
  const renewed = await channel.auth.refresh!(auth); assert.equal(renewed!.access, 'renewed'); assert.equal(renewed!.accountId, 'account-1');
  const usage = await channel.auth.usage!(async () => auth) as any; assert.equal(usage.windows[0].used, 12);
  const loader = await channel.auth.transport(async () => auth);
  const response = await loader.fetch!('https://ignored.test', { body: JSON.stringify({ model: 'gpt-test', stream: false, max_output_tokens: 10, prompt_cache_key: 'session-1' }) });
  assert.equal((await response.json() as any).id, 'resp-test');
  const request = calls.at(-1)!; assert.match(request.url, /backend-api\/codex\/responses$/);
  const sent = JSON.parse(String(request.init!.body)); assert.equal(sent.stream, true); assert.equal(sent.store, false); assert.equal(sent.max_output_tokens, undefined);
  assert.equal(new Headers(request.init!.headers).get('chatgpt-account-id'), 'account-1'); assert.equal(new Headers(request.init!.headers).get('session-id'), 'session-1');
});

test('Codex OAuth validates state before exchanging code and releases its port', async t => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as any).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  let exchanged = 0;
  const flow = await codexLogin((async (_url, init) => {
    exchanged++; const params = new URLSearchParams(String(init!.body));
    assert.equal(params.get('grant_type'), 'authorization_code'); assert.ok(params.get('code_verifier')); assert.equal(params.get('code'), 'test-code');
    return Response.json(tokens);
  }) as typeof fetch, port);
  t.after(() => flow.cancel());
  const url = new URL(flow.url); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await fetch(`http://127.0.0.1:${port}/auth/callback?state=wrong&code=test-code`)).status, 400); assert.equal(exchanged, 0);
  const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?state=${url.searchParams.get('state')}&code=test-code`);
  assert.equal(callback.status, 200); assert.equal((await flow.callback()).accountId, 'account-1'); assert.equal(exchanged, 1);
});

test('Claude environment, account model cache and history retain only the intended channel data', () => {
  const env = claudeEnv({ access: 'setup-token' }, { PATH: '/bin', ANTHROPIC_API_KEY: 'other', ANTHROPIC_BASE_URL: 'https://other', CLAUDECODE: '1' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.ANTHROPIC_BASE_URL, undefined); assert.equal(env.CLAUDECODE, undefined); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'setup-token');
  const models = claudeModels({ additionalModelOptionsCache: [{ value: 'claude-extra', label: 'Extra' }, { value: 'claude-denied', label: 'Denied' }], modelAccessCache: [{ apiName: 'claude-denied', entitled: false }] });
  assert.equal(models['claude-extra'].name, 'Extra'); assert.equal(models['claude-denied'], undefined);
  const input = claudeInput([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] }]);
  assert.match(JSON.stringify(input), /tool_result/); assert.match(JSON.stringify(input), /lookup/);
});

test('Claude native CLI login, quota, text/tool streaming and cancellation without real credentials', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jusage-native-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'claude'); const old = process.env.CLAUDE_CLI_PATH; process.env.CLAUDE_CLI_PATH = binary;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = old; });
  await writeFile(binary, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('auth')) { console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'test@example.com',subscriptionType:'pro'})); }
else if (args.includes('/usage')) { console.log(JSON.stringify({type:'result',result:'Current session: 12% used'})); }
else {
 if (!args.includes('--strict-mcp-config') || args[args.indexOf('--tools')+1] !== '') process.exit(2);
 let input=''; process.stdin.on('data', data => input += data); process.stdin.on('end', () => {
 const model=args[args.indexOf('--model')+1]; const tool=model==='tool'; const emit=event=>console.log(JSON.stringify({type:'stream_event',event}));
 emit({type:'message_start',message:{id:'msg-test',type:'message',role:'assistant',content:[],usage:{input_tokens:4,output_tokens:0}}});
 if(model==='hold') { setInterval(()=>{},1000); return; }
 emit({type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:'call-1',name:'mcp__gateway__tool_0',input:{}}:{type:'text',text:''}});
 emit({type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:'{"query":"test"}'}:{type:'text_delta',text:'你好'}});
 emit({type:'content_block_stop',index:0}); emit({type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:2}}); emit({type:'message_stop'});
 });
}
`, { mode: 0o700 });
  const channel = claudeChannel(); const auth = await channel.auth.methods[0].authorize!({});
  assert.equal((auth as any).accountName, 'test@example.com');
  const getAuth = async () => auth as any; const usage = await channel.auth.usage!(getAuth) as any; assert.equal(usage.windows[0].used, 12);
  const loader = await channel.auth.transport(getAuth);
  const reply = await loader.fetch!('https://ignored.test', { body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] }) });
  const whole = await reply.json() as any; assert.equal(whole.content[0].text, '你好'); assert.equal(whole.usage.output_tokens, 2);
  const toolReply = await loader.fetch!('https://ignored.test', { body: JSON.stringify({ model: 'tool', stream: true, tools: [{ name: 'lookup', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }] }) });
  const text = await toolReply.text(); assert.match(text, /"name":"lookup"/); assert.match(text, /tool_use/); assert.doesNotMatch(text, /mcp__gateway__/);
  const abort = new AbortController(); const held = await loader.fetch!('https://ignored.test', { signal: abort.signal, body: JSON.stringify({ model: 'hold', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  abort.abort(); await assert.rejects(held.text(), /CANCELLED/);
  // Exercise the actual worker/IPC path as well as the adapter directly.
  const store = new RouterCredentialStore(join(dir, 'credentials.enc'), Buffer.alloc(32, 21)); await store.init();
  const manager = new RouterSubscriptions({}, undefined, store);
  try {
    const provider = makeRouterPreset('claude', 'messages');
    await store.set(provider, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-setup-token' } });
    const catalog = await manager.modelCatalog(provider); assert.equal(catalog.names?.sonnet, 'Claude Sonnet');
    const throughWorker = await manager.fetch(provider, { model: 'sonnet', messages: [{ role: 'user', content: 'worker-test' }] }, new AbortController().signal);
    assert.equal((await throughWorker.json() as any).content[0].text, '你好');
  } finally { await manager.close(); }
  const switched = await channel.auth.transport(async () => ({ ...auth, accountName: 'another@example.com' }));
  await assert.rejects(switched.fetch!('https://ignored.test', { body: '{}' }), /ACCOUNT_CHANGED/);
});
