import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';

const execFileAsync = promisify(execFile);
export interface ProxySettings { httpProxy?: string; httpsProxy?: string; noProxy?: string }

/** scutil exposes the active network service, including changes made in Settings. */
export function parseMacProxySettings(output: string): ProxySettings {
  const value = (key: string) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const proxy = (prefix: string) => {
    if (value(`${prefix}Enable`) !== '1') return undefined;
    const host = value(`${prefix}Proxy`);
    const port = Number(value(`${prefix}Port`));
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  };
  const exceptions = output.match(/ExceptionsList\s*:\s*<array>\s*{([^}]*)}/)?.[1];
  const noProxy = exceptions?.split('\n').flatMap(line => {
    const match = line.match(/^\s*\d+\s*:\s*(\S+)\s*$/);
    return match ? [match[1]] : [];
  }).join(',');
  return { httpProxy: proxy('HTTP'), httpsProxy: proxy('HTTPS'), noProxy };
}

export async function readSystemProxy(): Promise<ProxySettings> {
  if (process.platform !== 'darwin') return {};
  const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 2_000, maxBuffer: 64 * 1024 });
  return parseMacProxySettings(stdout);
}

/** Explicit shell configuration takes priority over macOS network settings. */
export function resolveProxySettings(system: ProxySettings, env: NodeJS.ProcessEnv): ProxySettings {
  const all = env.all_proxy || env.ALL_PROXY;
  return {
    httpProxy: env.http_proxy || env.HTTP_PROXY || all || system.httpProxy || '',
    httpsProxy: env.https_proxy || env.HTTPS_PROXY || all || system.httpsProxy || env.http_proxy || env.HTTP_PROXY || system.httpProxy || '',
    noProxy: env.no_proxy ?? env.NO_PROXY ?? system.noProxy ?? '',
  };
}

export function createSubscriptionTransport(options: {
  readProxy?: () => Promise<ProxySettings>;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
} = {}) {
  let cached: { key: string; agent: EnvHttpProxyAgent } | undefined;
  let system: ProxySettings = {};
  let refreshAt = 0;
  // Serialize settings refreshes; concurrent provider readers share a dispatcher.
  let refreshing: Promise<void> | undefined;
  const retired = new Set<Promise<void>>();
  const log = options.log ?? console.warn;
  const fetcher: typeof fetch = async (input, init) => {
    if (Date.now() >= refreshAt) {
      refreshing ??= (async () => {
        try { system = await (options.readProxy ?? readSystemProxy)(); }
        catch { log('[subscription] system proxy lookup failed'); }
        refreshAt = Date.now() + 30_000;
      })().finally(() => { refreshing = undefined; });
      await refreshing;
    }
    const settings = resolveProxySettings(system, options.env ?? process.env);
    const key = JSON.stringify(settings);
    if (cached?.key !== key) {
      const agent = new EnvHttpProxyAgent(settings);
      if (cached) {
        const closing = cached.agent.close().catch(() => {}).finally(() => retired.delete(closing));
        retired.add(closing);
      }
      cached = { key, agent };
    }
    try {
      // Use the matching fetch implementation: a newer host Node may use a
      // different dispatcher protocol than the pinned sidecar dependency.
      const request = new Request(input, init);
      const response = await proxyFetch(request.url, {
        method: request.method,
        headers: Array.from(request.headers.entries()),
        body: request.body as import('undici').RequestInit['body'],
        duplex: 'half',
        signal: request.signal,
        redirect: request.redirect,
        dispatcher: cached.agent,
      });
      return response as unknown as Response;
    } catch (error) {
      const cause = (error as { cause?: { code?: unknown } })?.cause;
      const code = typeof cause?.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : 'REQUEST_FAILED';
      log(`[subscription] network error: ${code}`);
      throw error;
    }
  };
  return {
    fetch: fetcher,
    close: async () => {
      await refreshing;
      await cached?.agent.close();
      await Promise.all(retired);
      cached = undefined;
    },
  };
}
