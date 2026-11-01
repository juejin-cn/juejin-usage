import { guiCliEnvironment } from '../../subscription/readers/cli-runtime.js';
import { resolveClaudeCommand, CLAUDE_USAGE_ARGS } from '../../subscription/readers/claude-subscription.js';
import { parseClaudeUsageResult } from '../../subscription/readers/claude-usage-parser.js';
// Subscription inference runs through the user's installed Claude Code binary.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { SubscriptionAuth, SubscriptionModel, SubscriptionChannel } from '../subscription-types.js';

export function claudeEnv(auth?: SubscriptionAuth, env = guiCliEnvironment()): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^ANTHROPIC_|^CLAUDE_CODE_(OAUTH_TOKEN|USE_|ENTRYPOINT)|^CLAUDECODE$/.test(key)));
  // Keep the user's CLI config location for local login; setup-token is passed only in the child environment.
  if (typeof auth?.access === 'string') clean.CLAUDE_CODE_OAUTH_TOKEN = auth.access;
  clean.DISABLE_AUTOUPDATER = '1';
  return clean;
}
function launch(args: string[], auth?: SubscriptionAuth): ChildProcess {
  // User settings may now point Claude Code back at this gateway. Never load
  // them for the upstream subscription process, including auth-status checks.
  const isolated = args.includes('--setting-sources') ? args : ['--setting-sources', '', ...args];
  const child = spawn(resolveClaudeCommand(), isolated, { env: claudeEnv(auth), cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  if (child.pid) parentPort?.postMessage({ childPid: child.pid, running: true });
  child.once('close', () => parentPort?.postMessage({ childPid: child.pid, running: false }));
  child.stdout?.setEncoding('utf8');
  child.stderr?.resume(); // CLI failures may include credentials; never expose raw stderr.
  return child;
}
async function command(args: string[], auth?: SubscriptionAuth): Promise<string> {
  const child = launch(args, auth);
  return new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('SUBSCRIPTION_TIMEOUT')); }, 15000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('SUBSCRIPTION_CLAUDE_NOT_INSTALLED')); });
    child.stdout?.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) child.kill(); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error('SUBSCRIPTION_CLAUDE_SIGNED_OUT')); });
    child.stdin?.end();
  });
}
export function claudeModels(cache: Record<string, any>): Record<string, SubscriptionModel> {
  // CLI aliases track Anthropic's current default models without hard-coding dated API IDs.
  const models: Record<string, SubscriptionModel> = { sonnet: { name: 'Claude Sonnet' }, opus: { name: 'Claude Opus' }, haiku: { name: 'Claude Haiku' } };
  for (const option of Array.isArray(cache.additionalModelOptionsCache) ? cache.additionalModelOptionsCache : []) {
    if (typeof option.value === 'string' && option.value.startsWith('claude-') && !option.disabled) models[option.value] = { name: option.label || option.value };
  }
  for (const option of Array.isArray(cache.modelAccessCache) ? cache.modelAccessCache : []) {
    if (typeof option.apiName !== 'string' || !option.apiName.startsWith('claude-')) continue;
    if (option.entitled === true) models[option.apiName] ??= { name: option.apiName };
    if (option.entitled === false) delete models[option.apiName];
  }
  return models;
}
export function claudeInput(messages: Array<Record<string, any>>) {
  // Replaying a transcript avoids sharing Claude Code sessions between gateway callers.
  const content: Record<string, any>[] = [];
  for (const message of messages) {
    content.push({ type: 'text', text: `\n<${message.role === 'assistant' ? 'assistant' : 'user'}>\n` });
    for (const part of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
      if (part.type === 'text' || part.type === 'image') content.push(part);
      else if (part.type === 'tool_use' || part.type === 'tool_result') content.push({ type: 'text', text: JSON.stringify(part) });
    }
    content.push({ type: 'text', text: `\n</${message.role === 'assistant' ? 'assistant' : 'user'}>\n` });
  }
  return { type: 'user', message: { role: 'user', content } };
}
export async function claudeFetch(body: Record<string, any>, auth: SubscriptionAuth, signal?: AbortSignal | null): Promise<Response> {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('SUBSCRIPTION_INPUT_INVALID');
  signal?.throwIfAborted();
  const tools = Array.isArray(body.tools) ? body.tools.filter((tool: any) => typeof tool.name === 'string') : [];
  const names = new Map<string, string>(tools.map((tool: any, index: number) => [`mcp__gateway__tool_${index}`, tool.name]));
  const token = randomBytes(24).toString('hex');
  // Only advertise client tools. The bridge never executes them; tool_use is returned to the caller.
  const server = createServer(async (req, res) => {
    if (req.url !== '/' + token || req.method !== 'POST' || req.headers.origin) { res.writeHead(404).end(); return; }
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) throw new Error(); }
      const request = JSON.parse(raw);
      if (request.id === undefined) { res.writeHead(202).end(); return; }
      let result: unknown;
      if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'gateway', version: '1.0.0' } };
      else if (request.method === 'tools/list') result = { tools: tools.map((tool: any, index: number) => ({ name: `tool_${index}`, description: `Client tool ${tool.name}. ${tool.description || ''}`, inputSchema: tool.input_schema ?? { type: 'object', properties: {} } })) };
      else if (request.method === 'ping') result = {};
      else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Tools are executed by the gateway client' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const config = JSON.stringify({ mcpServers: tools.length ? { gateway: { type: 'http', url: `http://127.0.0.1:${port}/${token}` } } : {} });
  const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((block: any) => block.text || '').join('\n');
  const choice = body.tool_choice;
  const directive = choice?.type === 'none' ? '\nDo not call tools this turn.' : choice?.type === 'tool' ? `\nCall the tool named mcp__gateway__tool_${tools.findIndex((tool: any) => tool.name === choice.name)} this turn.` : choice?.type === 'any' ? '\nCall a tool this turn.' : '';
  const child = launch(['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages',
    '--model', String(body.model), '--tools', '', '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '',
    '--system-prompt', system + directive, '--no-session-persistence'], auth);
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { stop(); } });
  let done = false; let started = false; let buffer = ''; let message: any; const blocks: any[] = []; const partial = new Map<number, string>();
  const encoder = new TextEncoder();
  let resolve!: (response: Response) => void; let reject!: (error: Error) => void;
  const response = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  const stop = () => { child.kill(); server.close(); server.closeAllConnections(); clearTimeout(timer); signal?.removeEventListener('abort', abort); };
  const fail = (error: Error) => { if (done) return; done = true; stop(); if (started && body.stream) controller.error(error); else reject(error); };
  const abort = () => fail(new Error('SUBSCRIPTION_CANCELLED'));
  const timer = setTimeout(() => fail(new Error('SUBSCRIPTION_TIMEOUT')), 5 * 60_000);
  signal?.addEventListener('abort', abort, { once: true });
  child.on('error', () => fail(new Error('SUBSCRIPTION_CLAUDE_NOT_INSTALLED')));
  child.on('close', () => { if (!done) fail(new Error('SUBSCRIPTION_FAILED')); });
  child.stdout?.on('data', chunk => {
    if (done) return;
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { fail(new Error('SUBSCRIPTION_FAILED')); return; }
    let end: number;
    while (!done && (end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const wrapper = JSON.parse(line); if (wrapper.type !== 'stream_event') continue;
        const event = wrapper.event;
        if (event.type === 'message_start') {
          message = { ...event.message, model: body.model }; event.message.model = body.model;
          started = true;
          if (body.stream) resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
        }
        if (!started) continue;
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            if (!names.has(block.name) || choice?.type === 'none') throw new Error();
            block.name = names.get(block.name);
            if (choice?.type === 'tool' && block.name !== choice.name) throw new Error();
          }
          blocks[event.index] = { ...block };
        }
        if (event.type === 'content_block_delta') {
          const block = blocks[event.index]; const delta = event.delta;
          if (delta.type === 'text_delta') block.text += delta.text;
          else if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
          else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
          else if (delta.type === 'input_json_delta') partial.set(event.index, (partial.get(event.index) || '') + delta.partial_json);
        }
        if (event.type === 'content_block_stop' && partial.has(event.index)) blocks[event.index].input = JSON.parse(partial.get(event.index)!);
        if (event.type === 'message_delta') { Object.assign(message, event.delta); message.usage = { ...message.usage, ...event.usage }; }
        if (body.stream) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        if (event.type === 'message_stop') {
          done = true; stop();
          if (body.stream) controller.close(); else resolve(Response.json({ ...message, content: blocks }));
        }
      } catch { fail(new Error('SUBSCRIPTION_FAILED')); }
    }
  });
  child.stdin?.on('error', () => fail(new Error('SUBSCRIPTION_FAILED')));
  child.stdin?.end(JSON.stringify(claudeInput(body.messages)) + '\n');
  if (signal?.aborted) abort();
  return response;
}
export function claudeChannel(): SubscriptionChannel {
  return {
    models: async auth => {
      if (auth.source === 'claude-code-local') {
        const status = JSON.parse(await command(['auth', 'status']));
        if (!status.loggedIn || status.email !== auth.accountName || (auth.organizationId && (status.orgId ?? status.organizationId) !== auth.organizationId)) throw new Error('SUBSCRIPTION_CLAUDE_ACCOUNT_CHANGED');
      }
      // A setup-token account must not inherit the local account's gated models.
      if (auth.source !== 'claude-code-local') return claudeModels({});
      try { return claudeModels(JSON.parse(await readFile(process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'), 'utf8'))); }
      catch { return claudeModels({}); }
    },
    auth: {
      methods: [
        { type: 'oauth', label: '使用已登录的 Claude Code', authorize: async () => {
          const status = JSON.parse(await command(['auth', 'status']));
          if (!status.loggedIn || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty' || typeof status.email !== 'string') throw new Error('SUBSCRIPTION_CLAUDE_SIGNED_OUT');
          return { type: 'oauth', source: 'claude-code-local', accountName: status.email, organizationId: status.orgId ?? status.organizationId, plan: status.subscriptionType };
        } },
        { type: 'oauth', label: '使用 Claude setup-token', prompts: [{ key: 'token', type: 'password', message: '运行 claude setup-token 后粘贴令牌', validate: value => /^sk-ant-oat\S+$/.test(value) ? undefined : 'invalid token' }],
          authorize: async (inputs = {}) => {
            const auth = { type: 'oauth', access: inputs.token };
            const usage = parseClaudeUsageResult(await command(CLAUDE_USAGE_ARGS, auth));
            if (usage.denied || usage.isError) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
            return auth;
          } },
      ],
      usage: async getAuth => {
        const auth = await getAuth();
        if (auth.source === 'claude-code-local') {
          const status = JSON.parse(await command(['auth', 'status']));
          if (!status.loggedIn || status.email !== auth.accountName || (auth.organizationId && (status.orgId ?? status.organizationId) !== auth.organizationId)) return { signIn: 'expired' };
        }
        const usage = parseClaudeUsageResult(await command(CLAUDE_USAGE_ARGS, auth));
        if (usage.denied) return { signIn: 'expired' };
        return { plan: auth.plan, windows: [usage.fiveHour, usage.sevenDay].filter(w => w !== null).map(w => ({ used: w.usedPercent, ...(w.resetsAt ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}) })) };
      },
      transport: async getAuth => ({ fetch: async (_url, init) => {
        const auth = await getAuth();
        if (auth.source === 'claude-code-local') {
          const status = JSON.parse(await command(['auth', 'status']));
          if (!status.loggedIn || status.email !== auth.accountName || (auth.organizationId && (status.orgId ?? status.organizationId) !== auth.organizationId)) throw new Error('SUBSCRIPTION_CLAUDE_ACCOUNT_CHANGED');
        }
        return claudeFetch(JSON.parse(String(init?.body || '{}')), auth, init?.signal);
      } }),
    },
  };
}
