import { lstat, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';

const STAT_BATCH_SIZE = 8;
const MAX_DIRECTORIES = 64;
const MAX_RESPONSE_BYTES = 16 * 1024;
// The official context server bounds its processing time to three seconds.
const REQUEST_TIMEOUT_MS = 3_500;
const UNAVAILABLE = 'Kimi desktop context is unavailable';

interface Identity {
  userId: string;
  region: 'china' | 'overseas';
}

export interface KimiDesktopContext extends Identity {
  accessToken: string;
  /** Checks the current account without requesting or refreshing another token. */
  validateIdentity: () => Promise<boolean>;
}

interface ContextOptions {
  socketRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface Endpoint {
  address: string;
  verify: () => Promise<void>;
}

/** A missing listener is distinct from a live endpoint that cannot be trusted. */
class InactiveEndpointError extends Error {}

function unavailable(): never {
  throw new Error(UNAVAILABLE);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identityFrom(value: unknown): Identity | null {
  const data = record(value);
  if (data?.error !== undefined) return null;
  const userId = data?.uid;
  const region = data?.user_region;
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 512 || /[\x00-\x1f]/.test(userId)) return null;
  if (region !== 'cn' && region !== 'oversea') return null;
  return { userId, region: region === 'cn' ? 'china' : 'overseas' };
}

function sameIdentity(a: Identity, b: Identity | null): boolean {
  return a.userId === b?.userId && a.region === b.region;
}

async function unixIdentity(directory: string, address: string): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) unavailable();
  const [parent, socket] = await Promise.all([lstat(directory), lstat(address)]);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700
    || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) unavailable();
  return `${parent.dev}:${parent.ino}:${socket.dev}:${socket.ino}`;
}

async function discover(options: ContextOptions): Promise<Endpoint[]> {
  if ((options.platform ?? process.platform) === 'win32') {
    const address = (options.env ?? process.env).KIMI_WORK_CONTEXT_IPC?.trim();
    // Windows exposes the official endpoint to child processes through this variable.
    if (!address || !/^\\\\\.\\pipe\\kimi-work-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(address)) return [];
    return [{ address, verify: async () => {} }];
  }
  // Kimi itself uses mkdtemp('/tmp/kimi-work-'), not os.tmpdir().
  const root = options.socketRoot ?? '/tmp';
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => /^kimi-work-[A-Za-z0-9_-]+$/.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (names.length > MAX_DIRECTORIES) unavailable();
  const inspect = async (name: string): Promise<Endpoint | null> => {
    const directory = path.join(root, name);
    const address = path.join(directory, 'context.sock');
    let initial: string;
    try {
      initial = await unixIdentity(directory, address);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return {
      address,
      verify: async () => {
        if (await unixIdentity(directory, address) !== initial) unavailable();
      },
    };
  };
  const endpoints: Endpoint[] = [];
  for (let offset = 0; offset < names.length; offset += STAT_BATCH_SIZE) {
    const batch = await Promise.all(names.slice(offset, offset + STAT_BATCH_SIZE).map(inspect));
    endpoints.push(...batch.filter((endpoint): endpoint is Endpoint => endpoint !== null));
  }
  return endpoints;
}

async function request(endpoint: Endpoint, op: 'get_user_info' | 'get_access_token', timeoutMs: number, deadline?: number): Promise<unknown> {
  try {
    await endpoint.verify();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InactiveEndpointError(UNAVAILABLE);
    throw error;
  }
  const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - Date.now());
  if (remaining <= 0) unavailable();
  const value = await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(endpoint.address);
    let settled = false;
    let connected = false;
    let data = Buffer.alloc(0);
    const finish = (result?: unknown, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const fail = (inactive = false) => finish(undefined, inactive ? new InactiveEndpointError(UNAVAILABLE) : new Error(UNAVAILABLE));
    const timer = setTimeout(() => fail(), remaining);
    socket.once('error', (error: NodeJS.ErrnoException) => {
      fail(!connected && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED'));
    });
    socket.once('close', () => fail());
    socket.once('connect', () => {
      connected = true;
      socket.write(JSON.stringify({ op }) + '\n');
    });
    socket.on('data', (chunk: Buffer) => {
      if (data.length + chunk.length > MAX_RESPONSE_BYTES) {
        fail();
        return;
      }
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(10);
      if (end === -1) return;
      try {
        finish(JSON.parse(data.subarray(0, end).toString('utf8')));
      } catch {
        fail();
      }
    });
  });
  await endpoint.verify();
  return value;
}

function tokenFrom(value: unknown, identity: Identity): string {
  const data = record(value);
  if (data?.error !== undefined) unavailable();
  const token = data?.access_token;
  if (typeof token !== 'string' || token.length === 0 || /[\s]/.test(token)) unavailable();
  const parts = token.split('.');
  if (parts.length !== 3) unavailable();
  const claims = record(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
  if (claims?.sub !== identity.userId || typeof claims.exp !== 'number'
    || !Number.isFinite(claims.exp) || claims.exp * 1_000 <= Date.now()) unavailable();
  return token;
}

/** The official local context owns token refresh; credentials never cross renderer IPC. */
export async function readKimiDesktopContext(options: ContextOptions = {}): Promise<KimiDesktopContext | null> {
  try {
    const timeoutMs = Math.max(10, Math.min(REQUEST_TIMEOUT_MS, options.timeoutMs ?? REQUEST_TIMEOUT_MS));
    const endpoints = await discover(options);
    if (endpoints.length === 0) return null;
    const deadline = Date.now() + timeoutMs;
    // Dead sockets can survive a crash. Probe every bounded candidate together;
    // Missing listeners do not block Code; failures from live endpoints do.
    const candidates = await Promise.all(endpoints.map(async (endpoint) => {
      try {
        const identity = identityFrom(await request(endpoint, 'get_user_info', timeoutMs, deadline));
        if (!identity) unavailable();
        return { endpoint, identity };
      } catch (error) {
        if (error instanceof InactiveEndpointError) return null;
        throw error;
      }
    }));
    const active = candidates.filter((candidate) => candidate !== null);
    const selected = active[0];
    if (!selected) return null;
    if (active.some((candidate) => !sameIdentity(selected.identity, candidate.identity))) unavailable();
    const { endpoint, identity } = selected;
    const accessToken = tokenFrom(await request(endpoint, 'get_access_token', timeoutMs), identity);
    const validateIdentity = async (): Promise<boolean> => {
      try {
        return sameIdentity(identity, identityFrom(await request(endpoint, 'get_user_info', timeoutMs)));
      } catch {
        return false;
      }
    };
    if (!await validateIdentity()) unavailable();
    return { ...identity, accessToken, validateIdentity };
  } catch {
    // Do not propagate socket paths, tokens, user IDs or arbitrary server error text.
    return unavailable();
  }
}
