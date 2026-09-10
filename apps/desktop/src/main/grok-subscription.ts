import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  mapGrokBilling,
  type GrokSubscriptionSnapshot,
} from '../shared/grok-subscription';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const MAX_OUTPUT_BYTES = 512 * 1_024;
const METHOD_NOT_FOUND = -32_601;
const CUSTOM_ENV_KEYS = [
  'GROK_API_KEY',
  'XAI_API_KEY',
  'GROK_WS_URL',
  'GROK_WS_ORIGIN',
  'CLI_CHAT_PROXY_BASE_URL',
  'XAI_API_BASE_URL',
] as const;

type GrokRpcFailureKind =
  | 'not-authenticated'
  | 'unsupported-version'
  | 'timeout'
  | 'invalid-response'
  | 'command-failed';

class GrokRpcFailure extends Error {
  constructor(readonly kind: GrokRpcFailureKind) {
    super(kind);
  }
}

interface RpcEnvelope {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown };
}

let lastSuccess: GrokSubscriptionSnapshot | null = null;
let requestInFlight: Promise<GrokSubscriptionSnapshot> | null = null;
const activeChildren = new Set<ChildProcessWithoutNullStreams>();

function grokHomeDirectory(): string {
  const configured = process.env.AI_USAGE_GROK_HOME?.trim() || process.env.GROK_HOME?.trim();
  if (!configured) return path.join(homedir(), '.grok');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function unavailable(
  status: Exclude<GrokSubscriptionSnapshot['status'], 'ready'>,
  message: string,
): GrokSubscriptionSnapshot {
  return {
    status,
    planLabel: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message,
  };
}

function staleFallback(message: string): GrokSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', message);
  return { ...lastSuccess, stale: true, message };
}

function isConfigured(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/** API-key and endpoint overrides are not xAI subscription credentials. */
export function hasCustomGrokConfiguration(env: NodeJS.ProcessEnv): boolean {
  return CUSTOM_ENV_KEYS.some((key) => isConfigured(env[key]));
}

function resolveExecutableOnPath(command: string): string | null {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
      const originalCase = path.join(directory, `${command}${extension}`);
      if (existsSync(originalCase)) return originalCase;
    }
  }
  return null;
}

function resolveGrokCommand(): string | null {
  const override = process.env.GROK_CLI_PATH?.trim();
  if (override && existsSync(override)) return override;
  const executable = process.platform === 'win32' ? 'grok.exe' : 'grok';
  const candidates = [
    path.join(grokHomeDirectory(), 'bin', executable),
    path.join(homedir(), '.local', 'bin', executable),
    ...(process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'grok', executable)]
      : ['/opt/homebrew/bin/grok', '/usr/local/bin/grok']),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate))
    ?? resolveExecutableOnPath('grok');
}

function rpcRequest(id: number, method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {
    child.kill();
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // It exited between the check and the kill.
      }
      resolve();
    }, 1_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killChildImmediately(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // The process already exited.
  }
}

/** App-shutdown hook: detached ACP processes must never outlive Desktop. */
export function terminateGrokSubscriptionProcesses(): void {
  for (const child of activeChildren) killChildImmediately(child);
  activeChildren.clear();
}

/** Execute the official Grok Build ACP billing exchange over stdio. */
export async function runGrokBillingRpc(command: string, grokHome: string): Promise<unknown> {
  const child = spawn(command, ['--no-auto-update', 'agent', '--no-leader', 'stdio'], {
    cwd: homedir(),
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      GROK_HOME: grokHome,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
  child.stderr.resume();

  let buffer = '';
  let outputBytes = 0;
  let terminalFailure: GrokRpcFailure | null = null;
  const queued = new Map<number, RpcEnvelope>();
  const waiters = new Map<number, {
    reject: (reason: unknown) => void;
    resolve: (value: RpcEnvelope) => void;
  }>();

  const fail = (failure: GrokRpcFailure) => {
    terminalFailure ??= failure;
    for (const waiter of waiters.values()) waiter.reject(terminalFailure);
    waiters.clear();
  };
  const acceptLine = (line: string) => {
    let envelope: RpcEnvelope;
    try {
      envelope = JSON.parse(line) as RpcEnvelope;
    } catch {
      return;
    }
    if (typeof envelope.id !== 'number') return;
    const waiter = waiters.get(envelope.id);
    if (waiter) {
      waiters.delete(envelope.id);
      waiter.resolve(envelope);
    } else {
      queued.set(envelope.id, envelope);
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    if (terminalFailure) return;
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      fail(new GrokRpcFailure('invalid-response'));
      return;
    }
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) acceptLine(line);
      newline = buffer.indexOf('\n');
    }
  });
  child.stdin.on('error', () => fail(new GrokRpcFailure('command-failed')));
  child.once('error', () => fail(new GrokRpcFailure('command-failed')));
  child.once('exit', () => {
    const trailing = buffer.trim();
    if (trailing) acceptLine(trailing);
    fail(new GrokRpcFailure('command-failed'));
  });

  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const receive = (id: number): Promise<RpcEnvelope> => {
    const queuedEnvelope = queued.get(id);
    if (queuedEnvelope) {
      queued.delete(id);
      return Promise.resolve(queuedEnvelope);
    }
    if (terminalFailure) return Promise.reject(terminalFailure);
    return new Promise((resolve, reject) => {
      waiters.set(id, { resolve, reject });
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        waiters.delete(id);
        reject(new GrokRpcFailure('timeout'));
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new GrokRpcFailure('timeout'));
      }, remaining);
      const originalResolve = resolve;
      const originalReject = reject;
      waiters.set(id, {
        resolve: (value) => { clearTimeout(timer); originalResolve(value); },
        reject: (reason) => { clearTimeout(timer); originalReject(reason); },
      });
    });
  };
  const exchange = async (
    id: number,
    method: string,
    params: Record<string, unknown>,
    authentication = false,
  ): Promise<unknown> => {
    child.stdin.write(rpcRequest(id, method, params));
    const envelope = await receive(id);
    if (envelope.error) {
      const code = Number(envelope.error.code);
      if (authentication) throw new GrokRpcFailure('not-authenticated');
      if (code === METHOD_NOT_FOUND) throw new GrokRpcFailure('unsupported-version');
      throw new GrokRpcFailure('command-failed');
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
      throw new GrokRpcFailure('invalid-response');
    }
    return envelope.result;
  };

  try {
    await exchange(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'Jusage', version: '0.1.8' },
    });
    await exchange(2, 'authenticate', {
      methodId: 'cached_token',
      _meta: { headless: true },
    }, true);
    return await exchange(3, '_x.ai/billing', {});
  } finally {
    await stopChild(child);
    activeChildren.delete(child);
  }
}

async function fetchFreshGrokSubscription(): Promise<GrokSubscriptionSnapshot> {
  if (hasCustomGrokConfiguration(process.env)) {
    return unavailable('custom-provider', '自定义模型无法获取配额');
  }
  const grokHome = grokHomeDirectory();
  const command = resolveGrokCommand();
  if (!command) return unavailable('not-installed', '未检测到本机 Grok Build CLI');
  if (!existsSync(path.join(grokHome, 'auth.json'))) {
    return unavailable('not-signed-in', '请先登录 Grok Build');
  }

  try {
    const billing = await runGrokBillingRpc(command, grokHome);
    const mapped = mapGrokBilling(billing);
    if (mapped.limits.length === 0) {
      return staleFallback('Grok 暂未返回可用的订阅配额');
    }
    const snapshot: GrokSubscriptionSnapshot = {
      status: 'ready',
      ...mapped,
      fetchedAt: Math.floor(Date.now() / 1_000),
      stale: false,
      message: null,
    };
    lastSuccess = snapshot;
    return snapshot;
  } catch (error) {
    if (error instanceof GrokRpcFailure) {
      if (error.kind === 'not-authenticated') {
        return unavailable('not-signed-in', '请先登录 Grok Build');
      }
      if (error.kind === 'unsupported-version') {
        return unavailable('unsupported-version', '请升级 Grok Build CLI');
      }
    }
    return staleFallback('暂时无法读取 Grok 订阅配额');
  }
}

export async function readGrokSubscription(
  options: { forceRefresh?: boolean } = {},
): Promise<GrokSubscriptionSnapshot> {
  const cacheAge = lastSuccess?.fetchedAt
    ? Date.now() - lastSuccess.fetchedAt * 1_000
    : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshGrokSubscription();
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}
