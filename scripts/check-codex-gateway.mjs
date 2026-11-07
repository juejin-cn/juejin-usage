// Real Codex apply_patch round trip in a temporary sandbox. No user configuration is edited.
import { readFile, writeFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

if (!process.argv.includes('--live')) throw Error('Real inference requires --live');
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined;
if (!model) throw Error('Pass --model provider-id/model');
const config = JSON.parse(await readFile(join(homedir(), '.ai-usage/agent-router/config.json'), 'utf8'));
const provider = config.providers.find(p => p.enabled && p.models.some(m => !p.excludedModels?.includes(m) && `${p.id}/${m}` === model));
if (!provider) throw Error('Model is not currently exposed');
const { adapterPlans } = await import('../packages/core/dist/agent-router/integrations/adapters.js');
const settings = JSON.parse(await readFile(join(homedir(), '.claude/settings.json'), 'utf8'));
const base = settings.env.ANTHROPIC_BASE_URL;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw Error('Local gateway required');
const token = settings.env.ANTHROPIC_AUTH_TOKEN || settings.env.ANTHROPIC_API_KEY;
if (!(await fetch(base + '/health', { signal: AbortSignal.timeout(3000) })).ok) throw Error('Gateway unavailable');
const dir = await realpath(await mkdtemp(join(tmpdir(), 'codex-gateway-')));
const nonce = 'CODEX_' + randomUUID().replaceAll('-', '');
let passed = false;
try {
  const catalog = join(dir, 'models.json');
  const models = [{ id: model, name: model.slice(provider.id.length + 1), provider: provider.name }];
  const plans = adapterPlans('codex', { codex: join(dir, 'config.toml'), catalog }, base, token, models, model);
  await writeFile(catalog, JSON.stringify({ models: plans.find(p => p.path === catalog).fields[0].value }), { mode: 0o600 });
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json', '-m', model];
  for (const value of [
    `model_catalog_json=${JSON.stringify(catalog)}`, 'model_provider="gateway_audit"',
    'model_providers.gateway_audit.name="Gateway Audit"', `model_providers.gateway_audit.base_url=${JSON.stringify(base.replace(/\/+$/, '') + '/v1')}`,
    'model_providers.gateway_audit.env_key="JUSAGE_AUDIT_KEY"', 'model_providers.gateway_audit.wire_api="responses"',
    'model_providers.gateway_audit.supports_websockets=false', 'model_providers.gateway_audit.request_max_retries=0',
    'model_providers.gateway_audit.stream_max_retries=0', 'project_doc_max_bytes=0', 'web_search="disabled"',
    'features.multi_agent=false', 'features.apps=false', 'model_reasoning_effort="none"',
  ]) args.push('-c', value);
  args.push(`Use apply_patch to create canary.txt in the current directory containing exactly ${nonce} and a newline. Do not use the shell or other tools. Then reply with only ${nonce}.`);
  const env = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'TMPDIR', 'TERM'].flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]]]));
  env.JUSAGE_AUDIT_KEY = token;
  const start = Date.now();
  const child = spawn('codex', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let raw = '', stderrBytes = 0, forceTimer;
  child.stdout.on('data', c => raw += c); child.stderr.on('data', c => stderrBytes += c.length);
  const timer = setTimeout(() => { child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000); }, 60000);
  let code; try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); clearTimeout(forceTimer); }
  const rows = raw.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const patchCompleted = rows.some(r => r.type === 'item.completed' && r.item?.type === 'file_change' && r.item.status === 'completed');
  const shellUsed = rows.some(r => r.item?.type === 'command_execution');
  const answerCorrect = rows.some(r => r.item?.type === 'agent_message' && r.item.text?.trim() === nonce);
  let fileCorrect = false;
  try { fileCorrect = await readFile(join(dir, 'canary.txt'), 'utf8') === nonce + '\n'; } catch {}
  passed = code === 0 && patchCompleted && !shellUsed && fileCorrect && answerCorrect && rows.some(r => r.type === 'turn.completed');
  const errorText = rows.find(r => r.type === 'turn.failed')?.error?.message ?? '';
  console.log(JSON.stringify({ model, passed, exitCode: code, patchCompleted, shellUsed, fileCorrect, answerCorrect,
    error: passed ? undefined : errorText.match(/(?:UPSTREAM_[A-Z_0-9]+|NO_READY_PROVIDER_FOR_PROTOCOL|PROTOCOL_CONVERSION_UNSUPPORTED_[A-Z_]+)/)?.[0] ?? 'CLI_CHECK_FAILED',
    stderrBytes, ms: Date.now() - start }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
if (!passed) process.exitCode = 1;
