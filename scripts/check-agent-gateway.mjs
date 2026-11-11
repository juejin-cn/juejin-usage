// Opt-in live audit. Reads local credentials in memory; never writes credentials or response bodies.
import { readFile, writeFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

if (!process.argv.includes('--live')) throw Error('Real inference requires --live');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : 'gateway-audit.json');
const selectedModels = process.argv.flatMap((arg, i) => arg === '--model' ? [process.argv[i + 1]] : []);
const config = JSON.parse(await readFile(join(homedir(), '.ai-usage/agent-router/config.json'), 'utf8'));
const settings = JSON.parse(await readFile(join(homedir(), '.claude/settings.json'), 'utf8'));
const base = settings.env.ANTHROPIC_BASE_URL;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw Error('Local gateway required');
const token = settings.env.ANTHROPIC_AUTH_TOKEN || settings.env.ANTHROPIC_API_KEY;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
for (let attempt = 0; attempt < 40; attempt++) {
  try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
  if (attempt === 39) throw Error('Gateway unavailable');
  await new Promise(resolve => setTimeout(resolve, 500));
}
const catalogResponse = await fetch(base + '/v1/models', { headers, signal: AbortSignal.timeout(5000) });
if (!catalogResponse.ok) throw Error(`Catalog status ${catalogResponse.status}`);
const catalog = await catalogResponse.json();
const available = new Set(catalog.data.map(item => item.id));
const providers = config.providers.filter(p => p.enabled).map(p => ({ ...p, models: p.models.filter(m => !selectedModels.length || selectedModels.includes(m)) })).filter(p => p.models.length);
const report = { startedAt: new Date().toISOString(), catalogCount: available.size, providers: providers.map(p => ({ id: p.id, name: p.name, protocol: p.protocol, models: p.models.filter(m => !p.excludedModels?.includes(m)) })), results: [] };
let writes = Promise.resolve();
async function save(result) {
  report.results.push(result);
  console.log(JSON.stringify(result));
  writes = writes.then(() => writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }));
  await writes;
}
function inspectStream(raw, protocol) {
  let visible = '', terminal = false, finish;
  for (const block of raw.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') { if (protocol === 'chat' && finish) terminal = true; continue; }
    let event; try { event = JSON.parse(data); } catch { continue; }
    if (protocol === 'messages') {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') visible += event.delta.text;
      if (event.type === 'message_delta') finish = event.delta?.stop_reason;
      if (event.type === 'message_stop') terminal = true;
    } else if (protocol === 'chat') {
      for (const choice of event.choices ?? []) { visible += choice.delta?.content ?? ''; if (choice.finish_reason) finish = choice.finish_reason; }
    } else if (protocol === 'responses') {
      if (event.type === 'response.output_text.delta') visible += event.delta;
      if (event.type === 'response.completed') { terminal = true; finish = 'completed'; }
    } else {
      for (const candidate of event.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) if (!part.thought && typeof part.text === 'string') visible += part.text;
        if (candidate.finishReason) { terminal = true; finish = candidate.finishReason; }
      }
    }
  }
  return { visible, terminal, finish };
}
async function probe(provider, name, protocol) {
  const model = `${provider.id}/${name}`, nonce = 'CHECK_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const prompt = `Reply with exactly ${nonce}. Do not use tools.`;
  const messages = [{ role: 'user', content: prompt }];
  let path, body;
  if (protocol === 'messages') { path = '/v1/messages'; body = { model, max_tokens: 2048, stream: true, messages }; }
  if (protocol === 'chat') { path = '/v1/chat/completions'; body = { model, max_tokens: 2048, stream: true, messages }; }
  if (protocol === 'responses') { path = '/v1/responses'; body = { model, max_output_tokens: 2048, stream: true, input: prompt }; }
  if (protocol === 'gemini') { path = `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`; body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048 } }; }
  const started = Date.now();
  try {
    const response = await fetch(base + path, { method: 'POST', headers: { ...headers, 'x-agent-router-session-id': randomUUID(), 'x-goog-api-key': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(50000) });
    const raw = await response.text();
    if (!response.ok) {
      let code; try { const error = JSON.parse(raw); code = typeof error.error?.code === 'string' ? error.error.code : error.error?.message; } catch {}
      return { model, protocol, kind: 'inference', status: response.status, passed: false, error: typeof code === 'string' && /^[A-Z_0-9 :.-]{1,120}$/.test(code) ? code : 'HTTP_ERROR', ms: Date.now() - started };
    }
    const parsed = inspectStream(raw, protocol);
    const answerCorrect = parsed.visible.trim() === nonce;
    return { model, protocol, kind: 'inference', status: response.status, passed: answerCorrect && parsed.terminal && !['length', 'max_tokens', 'MAX_TOKENS'].includes(parsed.finish), answerCorrect, terminal: parsed.terminal, finish: parsed.finish, visibleChars: parsed.visible.length, ms: Date.now() - started };
  } catch (error) { return { model, protocol, kind: 'inference', passed: false, error: error.name === 'TimeoutError' ? 'CLIENT_TIMEOUT' : 'TRANSPORT_ERROR', ms: Date.now() - started }; }
}
async function cliProbe(model) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'gateway-audit-')));
  const nonce = 'READ_' + randomUUID(), file = join(dir, 'canary.txt'), fixture = join(dir, 'settings.json');
  const env = { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: token, ANTHROPIC_MODEL: model, ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  await writeFile(file, nonce + '\n', { mode: 0o600 });
  await writeFile(fixture, JSON.stringify({ env, disableAllHooks: true }), { mode: 0o600 });
  const start = Date.now();
  try {
    const child = spawn('claude', ['--bare', '--settings', fixture, '--model', model, '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--max-turns', '4', '--system-prompt', 'Use Read to read the requested file, then answer only its contents.', '--tools', 'Read', '--allowedTools', `Read(/${file})`, '-p', `Use Read to read ${file} and output its exact contents.`], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let raw = ''; child.stdout.on('data', c => raw += c); child.stderr.resume();
    let forceTimer;
    const timer = setTimeout(() => { child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000); }, 65000);
    let code; try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); clearTimeout(forceTimer); }
    const rows = raw.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    const result = rows.findLast(r => r.type === 'result');
    const content = rows.flatMap(r => Array.isArray(r.message?.content) ? r.message.content : []);
    const toolUsed = content.some(p => p.type === 'tool_use' && p.name === 'Read');
    const toolReturned = content.some(p => p.type === 'tool_result' && !p.is_error && JSON.stringify(p.content).includes(nonce));
    const answerCorrect = result?.result?.includes(nonce) === true;
    return { model, protocol: 'messages', kind: 'claude-read-tool', passed: code === 0 && !result?.is_error && toolUsed && toolReturned && answerCorrect, exitCode: code, toolUsed, toolReturned, answerCorrect, turns: result?.num_turns, error: result?.is_error ? result.result?.match(/(?:UPSTREAM_[A-Z_0-9]+|NO_READY_PROVIDER_FOR_PROTOCOL|PROTOCOL_CONVERSION_UNSUPPORTED_[A-Z_]+)/)?.[0] ?? 'CLI_ERROR' : !result ? 'CLI_NO_RESULT' : undefined, ms: Date.now() - start };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
// Serialize each provider's requests; independent providers may progress concurrently.
async function auditProvider(provider) {
  const models = provider.models.filter(m => !provider.excludedModels?.includes(m));
  const passed = [];
  for (const model of models) {
    if (!available.has(`${provider.id}/${model}`)) { await save({ model: `${provider.id}/${model}`, kind: 'catalog', passed: false, error: 'NOT_IN_LIVE_CATALOG' }); continue; }
    const result = await probe(provider, model, 'messages'); await save(result); if (result.passed) passed.push(model);
  }
  const preferred = ['gpt-6.1-sol', 'qfmodel', 'gemini-2.5-flash', 'hy4free'];
  const representative = preferred.find(m => passed.includes(m)) ?? passed[0];
  if (!representative) return;
  for (const protocol of ['chat', 'responses', 'gemini']) await save(await probe(provider, representative, protocol));
  await save(await cliProbe(`${provider.id}/${representative}`));
}
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(4, providers.length) }, async () => {
  while (cursor < providers.length) await auditProvider(providers[cursor++]);
}));
report.finishedAt = new Date().toISOString();
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ output, total: report.results.length, passed: report.results.filter(r => r.passed).length }));
if (report.results.some(r => !r.passed)) process.exitCode = 1;
