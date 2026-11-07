import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { RouterError } from '../config.js';
import type { TransportReply } from '../transport.js';
import { checkError } from './events.js';
import { wireFrames } from './sse.js';
import type { Wire } from './request.js';

const list = (v: unknown): Wire[] => Array.isArray(v) ? v : [];
function args(value: unknown, upstream = false): Wire {
  let parsed = value;
  try { if (typeof value === 'string') parsed = JSON.parse(value || '{}'); } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RouterError(upstream ? 'UPSTREAM_INVALID_TOOL_SEARCH_ARGUMENTS' : 'INVALID_TOOL_SEARCH_ARGUMENTS', upstream ? 502 : 400);
  return parsed as Wire;
}
function names(tools: Wire[]): string[] {
  return tools.flatMap(t => t.type === 'namespace' ? list(t.tools).map(child => `${t.name}.${child.name}`) : [t.name]).filter(n => typeof n === 'string');
}
/** Adapt only client search. Native custom tools, opaque history, storage and
 * all unrelated Responses fields stay in their original protocol. */
export function nativeSearchRequest(body: Wire): { body: Wire; rewrite: boolean } | undefined {
  const offered = list(body.tools).some(t => t.type === 'tool_search' && t.execution === 'client');
  const history = list(body.input).some(t => ['tool_search_call', 'tool_search_output'].includes(t.type) && t.execution === 'client' || t.type === 'additional_tools');
  if (!offered && !history) return undefined;
  const tools: Wire[] = [];
  const add = (tool: Wire, loaded: boolean) => {
    if (!tool || typeof tool !== 'object') throw new RouterError('INVALID_TOOL_DEFINITIONS');
    if (tool.type === 'namespace') {
      if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) throw new RouterError('INVALID_TOOL_NAMESPACE');
      if (tool.tools.some((t: Wire) => !t || typeof t !== 'object')) throw new RouterError('INVALID_TOOL_DEFINITIONS');
      const children = tool.tools.filter((t: Wire) => loaded || !t.defer_loading).map((t: Wire) => { const { defer_loading, ...rest } = t; return rest; });
      if (!children.length) return;
      const previous = tools.find(t => t.type === 'namespace' && t.name === tool.name);
      if (previous) {
        for (const child of children) {
          const index = previous.tools.findIndex((t: Wire) => t.name === child.name);
          if (index >= 0) { if (previous.tools[index].type !== child.type) throw new RouterError('AMBIGUOUS_TOOL_NAME'); previous.tools[index] = child; }
          else previous.tools.push(child);
        }
      } else tools.push({ ...tool, tools: children });
    } else {
      if (tool.defer_loading && !loaded) return;
      if (offered && tool.type === 'function' && tool.name === 'tool_search') throw new RouterError('AMBIGUOUS_TOOL_NAME');
      const { defer_loading, ...rest } = tool;
      const previous = tools.findIndex(t => t.type !== 'namespace' && t.name && t.name === rest.name);
      if (previous >= 0) { if (tools[previous].type !== rest.type) throw new RouterError('AMBIGUOUS_TOOL_NAME'); tools[previous] = rest; }
      else tools.push(rest);
    }
  };
  for (const tool of list(body.tools)) {
    if (tool.type === 'tool_search' && tool.execution === 'client') {
      if (tools.some(t => t.type === 'function' && t.name === 'tool_search')) throw new RouterError('AMBIGUOUS_TOOL_NAME');
      tools.push({ type: 'function', name: 'tool_search', description: tool.description, parameters: tool.parameters ?? { type: 'object', properties: {} } });
    } else add(tool, false);
  }
  const input = typeof body.input === 'string' ? body.input : list(body.input).map(item => {
    if (item.type === 'tool_search_call' && item.execution === 'client') {
      if (typeof item.call_id !== 'string' || !item.call_id) throw new RouterError('INVALID_TOOL_SEARCH_CALL_ID');
      const { execution, ...rest } = item;
      return { ...rest, type: 'function_call', name: 'tool_search', arguments: JSON.stringify(args(item.arguments)) };
    }
    if (item.type === 'tool_search_output' && item.execution === 'client' || item.type === 'additional_tools') {
      if (!Array.isArray(item.tools)) throw new RouterError('INVALID_TOOL_DEFINITIONS');
      if (item.type === 'additional_tools' ? item.role !== 'developer' : typeof item.call_id !== 'string' || !item.call_id || item.status && item.status !== 'completed') throw new RouterError('INVALID_TOOL_SEARCH_OUTPUT');
      for (const tool of item.tools) add(tool, true);
      const found = names(item.tools);
      const text = found.length ? 'Tools available from this point: ' + found.join(', ') : 'No tools matched the search.';
      return item.type === 'additional_tools' ? { type: 'message', role: 'developer', content: text } : { type: 'function_call_output', call_id: item.call_id, output: text };
    }
    return item;
  });
  const choice = body.tool_choice?.type === 'tool_search' && offered ? { type: 'function', name: 'tool_search' } : body.tool_choice;
  return { body: { ...body, input, tools, ...(choice !== undefined ? { tool_choice: choice } : {}) }, rewrite: offered };
}
function searchCall(item: Wire, partial = false): Wire {
  if (item?.type !== 'function_call' || item.name !== 'tool_search' || item.namespace) return item;
  const { name, ...rest } = item;
  return { ...rest, type: 'tool_search_call', execution: 'client', arguments: partial ? {} : args(item.arguments, true) };
}
function result(value: Wire): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RouterError('UPSTREAM_INVALID_RESPONSE', 502);
  checkError(value);
  return Array.isArray(value.output) ? { ...value, output: value.output.map((item: Wire) => searchCall(item)) } : value;
}
/** Surgical native reply rewriting: no normalized representation is involved. */
export function rewriteNativeSearchReply(reply: TransportReply, signal: AbortSignal): TransportReply {
  let input = reply.body;
  const compression = reply.headers['content-encoding']?.toLowerCase();
  if (compression && compression !== 'identity') {
    const unzip = compression === 'gzip' ? createGunzip() : compression === 'deflate' ? createInflate() : compression === 'br' ? createBrotliDecompress() : null;
    if (!unzip) throw new RouterError('UPSTREAM_UNSUPPORTED_ENCODING', 502);
    reply.body.once('error', error => unzip.destroy(error)); input = reply.body.pipe(unzip);
  }
  const streaming = reply.headers['content-type'].toLowerCase().includes('text/event-stream');
  const output = Readable.from((async function* () {
    try {
      if (!streaming) {
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of input) {
          if (signal.aborted) throw signal.reason;
          const value = Buffer.from(chunk); bytes += value.length;
          if (bytes > 32 * 1024 * 1024) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502); chunks.push(value);
        }
        if (signal.aborted) throw signal.reason;
        let value: Wire; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new RouterError('UPSTREAM_INVALID_JSON', 502); }
        yield JSON.stringify(result(value)); return;
      }
      const searches = new Set<string>(); let sequence = 0, terminal = false;
      const key = (v: Wire) => String(v.output_index ?? v.item_id);
      for await (const frame of wireFrames(input, signal)) {
        const v = frame.value; if (!v) { yield frame.raw; continue; }
        if (typeof v.type === 'string' && /[\r\n]/.test(v.type)) throw new RouterError('UPSTREAM_INVALID_SSE', 502);
        checkError(v);
        if (terminal && String(v.type).startsWith('response.')) throw new RouterError('UPSTREAM_EVENT_AFTER_FINISH', 502);
        if (v.type === 'response.output_item.added' || v.type === 'response.output_item.done') {
          if (v.item?.type === 'function_call' && v.item.name === 'tool_search' && !v.item.namespace) {
            searches.add(key(v)); if (v.item.id) searches.add(String(v.item.id));
            v.item = searchCall(v.item, v.type.endsWith('.added'));
          }
        }
        if (v.type === 'response.function_call_arguments.delta' || v.type === 'response.function_call_arguments.done') {
          if (searches.has(key(v)) || searches.has(String(v.item_id))) continue;
        }
        if (v.type === 'response.completed' || v.type === 'response.incomplete') { v.response = result(v.response); terminal = true; }
        if (Number.isSafeInteger(v.sequence_number) || typeof v.type === 'string' && v.type.startsWith('response.')) v.sequence_number = sequence++;
        yield `${typeof v.type === 'string' ? `event: ${v.type}\n` : ''}data: ${JSON.stringify(v)}\n\n`;
      }
      if (!terminal) throw new RouterError('UPSTREAM_TRUNCATED_STREAM', 502);
    } finally { input.destroy(); reply.dispose(); }
  })());
  const abort = () => { output.destroy(signal.reason instanceof Error ? signal.reason : new Error('REQUEST_CANCELLED')); input.destroy(); reply.dispose(); };
  signal.addEventListener('abort', abort, { once: true });
  output.once('close', () => { signal.removeEventListener('abort', abort); input.destroy(); reply.dispose(); });
  if (signal.aborted) abort();
  return { status: reply.status, headers: { 'content-type': reply.headers['content-type'] }, body: output, dispose() { output.destroy(); input.destroy(); reply.dispose(); } };
}
