import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { RouterError, type RouterProvider } from './config.js';
import type { RouterTrace } from './gateway.js';
import type { TransportReply } from './transport.js';

const BODY_LIMIT = 8 * 1024 * 1024;
const SECRET = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|x-goog-api-key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|secret|client[-_]?secret)$/i;
/** Preserve prompts and tools, remove credentials in structured fields and common token strings. */
export function redactArchive(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/(\"(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|secret|client[-_]?secret)\"\s*:\s*\")[^\"\r\n]*/gi, '$1[REDACTED]').replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redactArchive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET.test(key) ? '[REDACTED]' : redactArchive(item)]));
  return value;
}
function archiveHeaders(value: object) {
  const visible = /^(?:content-type|content-length|content-encoding|user-agent|accept|host|request-id|x-request-id|x-agent-router-request-id|x-agent-router-session-id|anthropic-version|anthropic-beta|openai-beta|retry-after|cache-control|date|connection|transfer-encoding|x-accel-buffering)$/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visible.test(key) ? redactArchive(item) : '[REDACTED]']));
}
export interface ArchiveBody { text: string; bytes: number; truncated: boolean; encoding?: string; incomplete?: boolean }
export interface ArchivePart { method?: string; path?: string; headers: unknown; status?: number; body: ArchiveBody }
export interface ArchivedUpstream extends ArchivePart { providerId: string; model: unknown; protocol: string; startedAt: string; durationMs?: number; response?: ArchivePart; error?: string; layer: 'provider-adapter' }
export interface RequestArchive { version: 1; id: string; startedAt: string; trace?: RouterTrace; request: ArchivePart; response: ArchivePart; upstream: ArchivedUpstream[]; upstreamOmitted: number }
class BodyCapture {
  complete = true;
  private chunks: Buffer[] = []; private retained = 0; bytes = 0;
  constructor(private encoding?: string, private budget?: { remaining: number }) {}
  add(chunk: unknown, encoding?: BufferEncoding) {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), encoding);
    this.bytes += buffer.length;
    const kept = buffer.subarray(0, Math.max(0, Math.min(BODY_LIMIT - this.retained, this.budget?.remaining ?? BODY_LIMIT)));
    if (kept.length) { this.chunks.push(Buffer.from(kept)); this.retained += kept.length; if (this.budget) this.budget.remaining -= kept.length; }
  }
  value(): ArchiveBody {
    let buffer = Buffer.concat(this.chunks); const truncated = this.bytes > this.retained;
    if (this.encoding && !truncated) {
      try { const options = { maxOutputLength: BODY_LIMIT }; buffer = this.encoding === 'gzip' ? gunzipSync(buffer, options) : this.encoding === 'br' ? brotliDecompressSync(buffer, options) : this.encoding === 'deflate' ? inflateSync(buffer, options) : buffer; }
      catch { return { text: '', bytes: this.bytes, truncated, encoding: 'compressed-body-unavailable' }; }
    } else if (this.encoding && truncated) return { text: '', bytes: this.bytes, truncated, encoding: 'compressed-body-unavailable' };
    const text = buffer.toString('utf8');
    let clean: string;
    try { clean = JSON.stringify(redactArchive(JSON.parse(text))); }
    catch { clean = text.split('\n').map(line => { if (line.startsWith('data: ')) { try { return 'data: ' + JSON.stringify(redactArchive(JSON.parse(line.slice(6)))); } catch {} } return String(redactArchive(line)); }).join('\n'); }
    return { text: clean, bytes: this.bytes, truncated, ...(!this.complete ? { incomplete: true } : {}) };
  }
}
const context = new AsyncLocalStorage<RequestRecording>();
export const currentRequestRecording = () => context.getStore();

/** Captures the ordinary stream as consumed; never reads ahead or changes backpressure. */
export class RequestRecording {
  trace?: RouterTrace;
  private budget = { remaining: 16 * 1024 * 1024 };
  private requestBody = new BodyCapture(undefined, this.budget); private responseBody = new BodyCapture(undefined, this.budget);
  private secrets = new Set<string>();
  secret(value: string) { if (value.length >= 6) this.secrets.add(value); }
  private upstream: Array<{ row: Omit<ArchivedUpstream, 'body'>; body: BodyCapture; response?: BodyCapture }> = [];
  private omitted = 0; private done = false;
  constructor(private req: IncomingMessage, private res: ServerResponse, private complete: (record: RequestArchive) => void) {
    const write = res.write.bind(res), end = res.end.bind(res);
    res.write = ((...args: Parameters<ServerResponse['write']>) => { this.responseBody.add(args[0], typeof args[1] === 'string' ? args[1] : undefined); return write(...args); }) as ServerResponse['write'];
    res.end = ((...args: Parameters<ServerResponse['end']>) => { this.responseBody.add(args[0], typeof args[1] === 'string' ? args[1] : undefined); return end(...args); }) as ServerResponse['end'];
    const finish = () => { if (this.trace?.outcome !== 'running') this.finish(); else setImmediate(() => this.finish()); };
    res.once('finish', finish); res.once('close', finish);
  }
  settled() { if (this.res.writableFinished || this.res.destroyed) this.finish(); }
  run<T>(fn: () => T): T { return context.run(this, fn); }
  body(raw: Buffer) { this.requestBody.add(raw); }
  async send(provider: RouterProvider, body: Record<string, unknown>, path: string, send: () => Promise<TransportReply>, features: Record<string, string> = {}): Promise<TransportReply> {
    // Protect the process from a pathological hosted tool loop as well as large bodies.
    if (this.upstream.length >= 16) { this.omitted++; return send(); }
    const at = Date.now(); const capture = new BodyCapture(undefined, this.budget); capture.add(JSON.stringify(body));
    const item = { row: { providerId: provider.id, model: body.model, protocol: provider.protocol, startedAt: new Date(at).toISOString(), method: 'POST', path, headers: archiveHeaders({ 'content-type': 'application/json', ...features }), layer: 'provider-adapter' as const } as Omit<ArchivedUpstream, 'body'>, body: capture, response: undefined as BodyCapture | undefined };
    this.upstream.push(item);
    try {
      const reply = await send(); item.row.durationMs = Date.now() - at;
      const response = new BodyCapture(reply.headers['content-encoding'], this.budget); item.response = response;
      item.row.response = { status: reply.status, headers: archiveHeaders(reply.headers), body: { text: '', bytes: 0, truncated: false } };
      const source = reply.body; response.complete = false;
      const wrapped = Readable.from((async function* () { try { for await (const chunk of source) { response.add(chunk); yield chunk; } response.complete = true; } finally { item.row.durationMs = Date.now() - at; } })());
      return { ...reply, body: wrapped, dispose() { wrapped.destroy(); reply.dispose(); } };
    } catch (error) { item.row.error = error instanceof RouterError ? error.code : 'TRANSPORT_FAILED'; item.row.durationMs = Date.now() - at; throw error; }
  }
  private finish() {
    if (this.done || !this.trace) return; this.done = true;
    try {
      this.responseBody.complete = this.res.writableFinished; this.requestBody.complete = this.req.complete;
      const record: RequestArchive = { version: 1, id: this.trace.id, startedAt: this.trace.startedAt, trace: structuredClone(this.trace),
        request: { method: this.req.method, path: this.req.url?.split('?')[0], headers: archiveHeaders(this.req.headers), body: this.requestBody.value() },
        response: { status: this.res.statusCode, headers: archiveHeaders(this.res.getHeaders()), body: this.responseBody.value() },
        upstream: this.upstream.map(item => ({ ...item.row, body: item.body.value(), ...(item.row.response ? { response: { ...item.row.response, body: item.response!.value() } } : {}) })), upstreamOmitted: this.omitted };
      let raw = JSON.stringify(record); for (const secret of this.secrets) raw = raw.split(secret).join('[REDACTED]');
      this.complete(JSON.parse(raw));
    } catch { /* Recording must never fail inference. */ }
  }
}

/** Local only, atomic files, 1 GiB FIFO retention. Bodies never enter the summary feed. */
export class RouterRequestArchive {
  private pending = Promise.resolve(); private queued = 0; private error: string | null = null; private dropped = 0;
  constructor(readonly directory: string, private maxBytes = 1024 ** 3) {}
  status() { return { directory: this.directory, enabled: true, error: this.error, dropped: this.dropped, pending: this.queued, maxBytes: this.maxBytes, maxBodyBytes: BODY_LIMIT }; }
  append(record: RequestArchive) {
    if (this.queued >= 8) { this.dropped++; this.error = 'ARCHIVE_QUEUE_FULL'; return; }
    this.queued++;
    this.pending = this.pending.then(async () => {
      const file = this.path(record.startedAt.slice(0, 10), record.id);
      await mkdir(join(this.directory, record.startedAt.slice(0, 10)), { recursive: true, mode: 0o700 });
      const temporary = file + '.tmp'; const metadata = file + '.meta';
      try { await writeFile(temporary, JSON.stringify(redactArchive(record)), { mode: 0o600 }); await rename(temporary, file);
        await writeFile(metadata + '.tmp', JSON.stringify(redactArchive({ id: record.id, trace: record.trace })), { mode: 0o600 }); await rename(metadata + '.tmp', metadata);
      }
      finally { await unlink(temporary).catch(() => {}); await unlink(metadata + '.tmp').catch(() => {}); }
      const files = await this.files(); let total = files.reduce((sum, row) => sum + row.bytes, 0);
      for (const old of files.reverse()) { if (total <= this.maxBytes || old.path === file) continue; await unlink(old.path); await unlink(old.path + '.meta').catch(() => {}); total -= old.bytes; }
      this.error = this.dropped ? 'ARCHIVE_QUEUE_FULL' : null;
    }).catch(() => { this.error = 'ARCHIVE_WRITE_FAILED'; }).finally(() => { this.queued--; });
  }
  private path(day: string, id: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[a-f0-9-]{36}$/.test(id)) throw new RouterError('INVALID_ARCHIVE_ID');
    return join(this.directory, day, id + '.json');
  }
  private async files() {
    const out: Array<{ day: string; id: string; path: string; bytes: number; modified: number }> = [];
    let days: string[];
    try { days = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out; throw error; }
    for (const day of days.filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().reverse()) {
      for (const name of await readdir(join(this.directory, day))) {
        const id = name.slice(0, -5); if (!name.endsWith('.json') || !/^[a-f0-9-]{36}$/.test(id)) continue;
        const path = this.path(day, id); const info = await stat(path); const metadata = await stat(path + '.meta').catch(() => null); out.push({ day, id, path, bytes: info.size + (metadata?.size ?? 0), modified: info.mtimeMs });
      }
    }
    return out.sort((a, b) => b.modified - a.modified || b.id.localeCompare(a.id));
  }
  async list(before?: string) {
    if (before !== undefined && !/^\d+(?:\.\d+)?:[a-f0-9-]{36}$/.test(before)) throw new RouterError('INVALID_ARCHIVE_CURSOR');
    await this.pending;
    const all = await this.files();
    const offset = before === undefined ? -1 : all.findIndex(file => `${file.modified}:${file.id}` === before);
    if (before !== undefined && offset < 0) throw new RouterError('ARCHIVE_CURSOR_EXPIRED', 409);
    const files = all.slice(offset + 1, offset + 52);
    const page = files.slice(0, 50); const requests = [];
    for (const file of page) {
      let trace: RouterTrace | undefined;
      try { if ((await stat(file.path + '.meta')).size > 65536) throw new Error(); trace = JSON.parse(await readFile(file.path + '.meta', 'utf8')).trace; }
      catch { trace = (await this.read(file.day, file.id)).trace; }
      requests.push({ day: file.day, id: file.id, trace });
    }
    return { requests, next: files.length > 50 ? `${page.at(-1)!.modified}:${page.at(-1)!.id}` : null };
  }
  async read(day: string, id: string): Promise<RequestArchive> {
    const file = this.path(day, id); await this.pending;
    try { if ((await stat(file)).size > BODY_LIMIT * 40) throw new Error(); return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RouterError('ARCHIVE_NOT_FOUND', 404); throw new RouterError('ARCHIVE_READ_FAILED', 500); }
  }
  async flush() { await this.pending; }
}
