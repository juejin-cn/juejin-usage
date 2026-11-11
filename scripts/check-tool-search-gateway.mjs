// Live client-owned search → custom tool → local file result → final answer.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

if (!process.argv.includes('--live')) throw Error('Real inference requires --live');
const index = process.argv.indexOf('--model');
const model = index >= 0 ? process.argv[index + 1] : undefined;
if (!model) throw Error('Pass --model provider-id/model');
const config = JSON.parse(await readFile(join(homedir(), '.ai-usage/agent-router/config.json'), 'utf8'));
if (!config.providers.some(p => p.enabled && p.models.some(m => !p.excludedModels?.includes(m) && `${p.id}/${m}` === model))) throw Error('Model is not currently exposed');
const settings = JSON.parse(await readFile(join(homedir(), '.claude/settings.json'), 'utf8'));
const base = settings.env.ANTHROPIC_BASE_URL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw Error('Local gateway required');
const token = settings.env.ANTHROPIC_AUTH_TOKEN || settings.env.ANTHROPIC_API_KEY;
const streaming = !process.argv.includes('--non-streaming');
const session = randomUUID(), nonce = 'CANARY_' + randomUUID().replaceAll('-', '');
const directory = await mkdtemp(join(tmpdir(), 'gateway-search-'));
const calls = [];
let passed = false, searchReturned = false, customReturned = false, fileRead = false;
const search = { type: 'tool_search', execution: 'client', description: 'Find the local diagnostic file reading tool needed for the task.', parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'], additionalProperties: false } };
const loaded = { type: 'namespace', name: 'diagnostic', description: 'Read the isolated canary file', tools: [{ type: 'custom', name: 'read_canary', description: 'Read canary.txt. Input is exactly the filename canary.txt, with no quotation marks or extra text.', format: { type: 'text' }, defer_loading: true }] };
async function request(input, tools, toolChoice) {
  const start = Date.now();
  const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-agent-router-session-id': session }, body: JSON.stringify({ model, input, tools, tool_choice: toolChoice, max_output_tokens: 4096, stream: streaming }), signal: AbortSignal.timeout(50000) });
  const raw = await response.text();
  const row = { status: response.status, ms: Date.now() - start }; calls.push(row);
  if (!response.ok) {
    let value; try { value = JSON.parse(raw); } catch {}
    const code = value?.error?.code || value?.error?.message;
    row.error = typeof code === 'string' && /^[A-Z_0-9]{1,120}$/.test(code) ? code : 'HTTP_ERROR';
    throw Error(row.error);
  }
  let result;
  if (streaming) {
    const events = raw.replaceAll('\r\n', '\n').split('\n\n').flatMap(block => {
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    if (events.some(e => e.type === 'error' || e.type === 'response.failed')) throw Error('STREAM_ERROR');
    result = events.findLast(e => e.type === 'response.completed')?.response;
  } else result = JSON.parse(raw);
  row.completed = result?.status === 'completed';
  row.outputTypes = result?.output?.map(item => item.type);
  if (!row.completed || !Array.isArray(result.output)) throw Error('INCOMPLETE_RESPONSE');
  return result.output;
}
const start = Date.now();
try {
  await writeFile(join(directory, 'canary.txt'), nonce + '\n', { mode: 0o600 });
  const user = { role: 'user', content: 'Find the local file reading tool with tool search first. Then use it to read canary.txt. After the tool returns, reply only with the exact file contents. Do not guess the contents.' };
  const first = await request([user], [search, loaded], 'required');
  const searches = first.filter(item => item.type === 'tool_search_call');
  if (searches.length !== 1 || searches[0].execution !== 'client' || typeof searches[0].arguments?.goal !== 'string') throw Error('INVALID_SEARCH_CALL');
  searchReturned = true;
  // The client owns discovery; only the allowlisted local schema is returned.
  const found = { type: 'tool_search_output', execution: 'client', call_id: searches[0].call_id, status: 'completed', tools: [loaded] };
  const history = [user, ...first, found];
  const second = await request(history, undefined, 'required');
  const custom = second.filter(item => item.type === 'custom_tool_call');
  if (custom.length !== 1 || custom[0].name !== 'read_canary' || custom[0].namespace !== 'diagnostic' || custom[0].input !== 'canary.txt') throw Error('INVALID_CUSTOM_CALL');
  customReturned = true;
  const content = await readFile(join(directory, 'canary.txt'), 'utf8'); fileRead = true;
  const last = await request([...history, ...second, { type: 'custom_tool_call_output', call_id: custom[0].call_id, output: content }], undefined, 'none');
  const answer = last.flatMap(item => item.type === 'message' ? item.content ?? [] : []).filter(part => part.type === 'output_text').map(part => part.text).join('');
  passed = answer.trim() === nonce;
  console.log(JSON.stringify({ model, streaming, passed, searchReturned, customReturned, fileRead, answerCorrect: passed, calls, ms: Date.now() - start }, null, 2));
} catch (error) {
  const code = typeof error.message === 'string' && /^[A-Z_0-9]{1,120}$/.test(error.message) ? error.message : error.name === 'TimeoutError' ? 'CLIENT_TIMEOUT' : 'TRANSPORT_ERROR';
  console.log(JSON.stringify({ model, streaming, passed: false, searchReturned, customReturned, fileRead, error: code, calls, ms: Date.now() - start }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
if (!passed) process.exitCode = 1;
