import { buildModelCatalog } from './model-metadata.js';
import { createSubscriptionChannel } from './channels/index.js';
import { ChannelError } from './channels/http.js';
import { FAILURE_HEADER, verifiedFailureCode } from './failure-codes.js';
import { randomUUID } from 'node:crypto';
import { sanitizeUsage, readSubscriptionDetails } from './usage.js';
// Each account runs in a disposable worker; termination closes its resources.
import { parentPort, workerData } from 'node:worker_threads';
import type { SubscriptionAuth, SubscriptionCommand, SubscriptionWorkerData, SubscriptionChannel, SubscriptionModel, LoginFlow } from './subscription-types.js';
import { normalizeSubscriptionAuth, subscriptionAuthReader, subscriptionLoginMethods, validLoginUrl } from './subscription-auth.js';
import { CHANNEL_CATALOG } from './channel-catalog.js';
import { gatewayModelName } from './model-names.js';
import { routerPreset } from './presets.js';

const settings = workerData as SubscriptionWorkerData;
const parent = parentPort!;
let auth: SubscriptionAuth | null = settings.auth ?? null;
let signingIn = false;
let pendingFlow: LoginFlow | null = null;
let readingUsage: Promise<ReturnType<typeof sanitizeUsage>> | null = null;
const status = (phase: string, error: string | null = null) => parent.postMessage({ status: { phase, error, ...(auth?.type === 'api' || auth?.type === 'oauth' ? { authType: auth.type } : {}) } });
const safeCode = (error: unknown) => error instanceof Error && /^SUBSCRIPTION_[A-Z_]+$/.test(error.message) ? error.message : 'SUBSCRIPTION_FAILED';
const getAuth = async (): Promise<SubscriptionAuth> => {
  if (!auth) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
  return readAuth();
};
async function saveAuth(next: SubscriptionAuth): Promise<void> {
  next = normalizeSubscriptionAuth(next);
  if (settings.persist && ['oauth', 'api'].includes(String(next.type))) {
    await new Promise<void>((resolve, reject) => {
      const credentialId = randomUUID();
      const listener = (message: { credentialId?: string; error?: boolean }) => {
        if (message.credentialId !== credentialId) return;
        clearTimeout(timer); parent.off('message', listener);
        if (message.error) reject(new Error('SUBSCRIPTION_CREDENTIAL_SAVE_FAILED')); else resolve();
      };
      const timer = setTimeout(() => { parent.off('message', listener); reject(new Error('SUBSCRIPTION_CREDENTIAL_SAVE_FAILED')); }, 15000);
      parent.on('message', listener); parent.postMessage({ credentialId, auth: next });
    });
  }
  auth = next;
}
const descriptor = CHANNEL_CATALOG.find(p => p.id === settings.provider);
const channelPromise: Promise<SubscriptionChannel> = (async () => {
  if (!descriptor || descriptor.protocol !== settings.protocol || settings.method !== 'browser') throw new Error('SUBSCRIPTION_ADAPTER_UNAVAILABLE');
  return createSubscriptionChannel(settings.provider);
})();
const readAuth = subscriptionAuthReader(() => auth, saveAuth, () => channelPromise);
let liveModels: Record<string, SubscriptionModel> | undefined;
async function finishLogin(result: SubscriptionAuth): Promise<void> {
  await saveAuth(result); pendingFlow = null; signingIn = false; status('ready');
}
async function login(command: SubscriptionCommand): Promise<void> {
  const { id } = command;
  if (signingIn) throw new Error('SUBSCRIPTION_LOGIN_BUSY');
  signingIn = true; status('authorizing');
  try {
    const channel = await channelPromise;
    const index = command.methodIndex ?? 0;
    const method = channel.auth.methods[index];
    if (!method) throw new Error('SUBSCRIPTION_LOGIN_UNSUPPORTED');
    const inputs = command.inputs ?? {};
    for (const prompt of method.prompts ?? []) {
      if (prompt.condition && !prompt.condition(inputs)) continue;
      if (prompt.validate?.(inputs[prompt.key] ?? '')) throw new Error('SUBSCRIPTION_INPUT_INVALID');
    }
    if (method.type === 'api' && !method.authorize) {
      await finishLogin({ type: 'api', key: inputs.key, metadata: Object.fromEntries(Object.entries(inputs).filter(([key]) => key !== 'key')) });
      parent.postMessage({ id, result: { url: '', completed: true } }); return;
    }
    if (!method.authorize) throw new Error('SUBSCRIPTION_LOGIN_UNSUPPORTED');
    const result = await method.authorize(inputs);
    if ('type' in result) {
      await finishLogin(result as SubscriptionAuth); parent.postMessage({ id, result: { url: '', completed: true } }); return;
    }
    const flow = result as LoginFlow;
    if (typeof flow.callback !== 'function' || (flow.url && !validLoginUrl(flow.url))) throw new Error('SUBSCRIPTION_LOGIN_URL_INVALID');
    pendingFlow = flow;
    parent.postMessage({ id, result: { url: flow.url ?? '', instructions: flow.instructions, opened: flow.opened, method: flow.method ?? 'auto' } });
    if (flow.method === 'code') return;
    await finishLogin(await flow.callback());
  } catch (error) {
    pendingFlow = null; signingIn = false; status('error', safeCode(error)); parent.postMessage({ id, error: safeCode(error) });
  }
}
async function complete(command: SubscriptionCommand): Promise<void> {
  if (!pendingFlow || pendingFlow.method !== 'code') throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
  try {
    await finishLogin(await pendingFlow.callback(command.code));
    parent.postMessage({ id: command.id, result: { url: '', completed: true } });
  } catch (error) {
    pendingFlow = null; signingIn = false; status('error', safeCode(error)); throw error;
  }
}
async function listModels(): Promise<string[]> {
  const channel = await channelPromise;
  liveModels = await channel.models(await getAuth());
  return Object.keys(liveModels).filter(m => m.length <= 200 && !/[\r\n\x00]/.test(m)).slice(0, 128);
}

async function serve(command: SubscriptionCommand): Promise<void> {
  const port = command.port!; const abort = new AbortController();
  let credit = 0; let wake: (() => void) | undefined;
  const wait = async () => { if (!credit && !abort.signal.aborted) await new Promise<void>(resolve => { wake = resolve; }); if (abort.signal.aborted) throw new Error('SUBSCRIPTION_CANCELLED'); credit--; };
  port.on('message', message => { if (message.next) { credit = Math.min(credit + 1, 1); wake?.(); wake = undefined; } if (message.cancel) { abort.abort(); wake?.(); } });
  port.on('close', () => { abort.abort(); wake?.(); });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const channel = await channelPromise;
    const transport = await channel.auth.transport(getAuth);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (settings.protocol === 'messages') headers['anthropic-version'] = '2023-06-01';
    const baseURL = transport.baseURL || routerPreset(settings.provider)!.endpoints[settings.protocol]!;
    if (settings.protocol === 'gemini') throw new Error('SUBSCRIPTION_PROTOCOL_UNSUPPORTED');
    const path = { messages: '/messages', responses: '/responses', chat: '/chat/completions' }[settings.protocol];
    Object.assign(headers, command.features, transport.headers);
    for (const key of ['anthropic-beta', 'openai-beta']) if (command.features?.[key] && transport.headers?.[key]) headers[key] = [...new Set((command.features[key] + ',' + transport.headers[key]).split(',').map(v => v.trim()).filter(Boolean))].join(',');
    if (transport.apiKey && !headers.authorization) headers.authorization = `Bearer ${transport.apiKey}`;
    if (command.session && !['claude', 'codex'].includes(settings.provider)) headers['x-jusage-session'] = command.session;
    const response = await (transport.fetch ?? fetch)(baseURL.replace(/\/+$/, '') + path, {
      method: 'POST', headers, body: JSON.stringify(command.body), signal: abort.signal,
    }).catch(error => {
      if (error instanceof ChannelError) return Response.json({ error: { message: safeCode(error) } }, { status: error.status, headers: error.headers });
      throw error;
    });
    if (response.status === 401) status('error', 'SUBSCRIPTION_LOGIN_REQUIRED');
    port.postMessage({ headers: true, status: response.status, contentType: response.headers.get('content-type') || 'application/json', retryAfter: response.headers.get('retry-after'), failureCode: verifiedFailureCode(response.headers.get(FAILURE_HEADER), response.status) });
    reader = response.body?.getReader();
    if (reader) for (;;) {
      await wait(); const part = await reader.read();
      if (part.done) break;
      for (let i = 0; i < part.value.length; i += 65536) {
        if (i) await wait();
        const chunk = Uint8Array.from(part.value.subarray(i, i + 65536)); port.postMessage({ chunk }, [chunk.buffer]);
      }
    }
    port.postMessage({ done: true });
  } catch (error) { if (safeCode(error) === 'SUBSCRIPTION_LOGIN_REQUIRED') status('error', safeCode(error)); port.postMessage({ error: safeCode(error) }); }
  finally { abort.abort(); await reader?.cancel().catch(() => {}); port.close(); }
}

parent.on('message', (command: SubscriptionCommand) => {
  if (!command.kind) return;
  if (command.kind === 'request') { void serve(command); return; }
  if (command.kind === 'usage') {
    readingUsage ??= (async () => {
      const channel = await channelPromise;
      const result = await readSubscriptionDetails(settings.provider, channel, getAuth, auth ?? {});
      if (result.state === 'expired') status('error', 'SUBSCRIPTION_LOGIN_REQUIRED');
      return result;
    })().catch(() => sanitizeUsage(null)).finally(() => { readingUsage = null; });
    void readingUsage.then(result => parent.postMessage({ id: command.id, result }));
    return;
  }
  const action = command.kind === 'login' ? login(command) : command.kind === 'complete' ? complete(command) : command.kind === 'methods' ? channelPromise.then(channel => { parent.postMessage({ id: command.id, result: subscriptionLoginMethods(channel, command.inputs) }); }) : listModels().then(models => {
    const names = Object.fromEntries(models.map(id => [id, gatewayModelName(settings.provider, id, liveModels?.[id]?.name)]).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && !!entry[1].trim() && entry[1].length <= 200 && !/[\x00-\x1f\x7f]/.test(entry[1])));
    const catalog = buildModelCatalog(Object.fromEntries(models.map(id => [id, { ...liveModels?.[id], ...(names[id] ? { name: names[id] } : {}) }])));
    parent.postMessage({ id: command.id, result: catalog });
  });
  void action.catch(error => { status('error', safeCode(error)); parent.postMessage({ id: command.id, error: safeCode(error) }); });
});
void channelPromise.then(() => { if (auth) status('ready'); }).catch(() => status('error', 'SUBSCRIPTION_ADAPTER_UNAVAILABLE'));
