import { createHash } from 'node:crypto';
import { RouterError } from '../config.js';
import type { Wire } from './request.js';

export interface ResponseTool { name: string; namespace?: string; custom: boolean; search?: boolean; tool: Wire }
const array = (v: unknown): Wire[] => Array.isArray(v) ? v : [];
function toolName(name: unknown, namespace?: unknown): string {
  if (typeof name !== 'string' || !name || typeof namespace !== 'undefined' && (typeof namespace !== 'string' || !namespace)) throw new RouterError('INVALID_TOOL_NAME');
  return namespace ? 'tool_' + createHash('sha256').update(JSON.stringify([namespace, name])).digest('hex').slice(0, 32) : name;
}
/** Stable aliases avoid collisions between namespaces and vendor name limits. */
export function responseToolMap(tools: unknown, input?: unknown): Map<string, ResponseTool> {
  const out = new Map<string, ResponseTool>();
  let deferred = false, loaded = false;
  const append = (values: unknown, found: boolean) => {
    if (!Array.isArray(values)) throw new RouterError('INVALID_TOOL_DEFINITIONS');
    const seen = new Set<string>();
    const add = (tool: Wire, namespace?: string, description?: string) => {
      if (!tool || !['function', 'custom', 'tool_search'].includes(tool.type)) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_BUILTIN_TOOL');
      const search = tool.type === 'tool_search';
      if (search && (namespace || found || tool.execution !== 'client')) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_TOOL_SEARCH_EXECUTION');
      if (tool.allowed_callers != null && !Array.isArray(tool.allowed_callers)) throw new RouterError('INVALID_TOOL_CALLERS');
      if (tool.parameters != null && (typeof tool.parameters !== 'object' || Array.isArray(tool.parameters))) throw new RouterError('INVALID_TOOL_SCHEMA');
      if (tool.async || tool.allowed_callers?.some((v: unknown) => v !== 'direct')) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_TOOL_FEATURE');
      const name = search ? 'tool_search' : tool.name;
      const alias = toolName(name, namespace);
      if (seen.has(alias)) throw new RouterError('AMBIGUOUS_TOOL_NAME');
      seen.add(alias);
      if (tool.defer_loading && !found) { deferred = true; return; }
      const previous = out.get(alias);
      if (previous && (!found || previous.name !== name || previous.namespace !== namespace || previous.custom !== (tool.type === 'custom') || Boolean(previous.search) !== search)) throw new RouterError('AMBIGUOUS_TOOL_NAME');
      const { defer_loading, ...definition } = tool;
      out.set(alias, { name, namespace, custom: tool.type === 'custom', search, tool: { ...definition, description: [description, tool.description].filter(Boolean).join('\n\n') || undefined } });
    };
    for (const tool of values) {
      if (tool?.type === 'namespace') {
        toolName(tool.name);
        if (!Array.isArray(tool.tools) || !tool.tools.length) throw new RouterError('INVALID_TOOL_NAMESPACE');
        for (const child of tool.tools) add(child, tool.name, tool.description);
      } else add(tool);
    }
  };
  if (tools !== undefined) append(tools, false);
  for (const item of array(input)) {
    if (item.type === 'tool_search_output') {
      if (item.execution !== 'client' || typeof item.call_id !== 'string' || !item.call_id || item.status && item.status !== 'completed') throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_TOOL_SEARCH_EXECUTION');
      append(item.tools, true); loaded = true;
    } else if (item.type === 'additional_tools') {
      if (item.role !== 'developer') throw new RouterError('INVALID_ADDITIONAL_TOOLS_ROLE');
      append(item.tools, true); loaded = true;
    }
  }
  if (deferred && !loaded && ![...out.values()].some(t => t.search)) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_TOOL_FEATURE');
  return out;
}
function definition(alias: string, value: ResponseTool): Wire {
  const t = value.tool;
  if (value.search) return { type: 'function', name: alias, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } };
  if (!value.custom) return { ...t, name: alias };
  const format = t.format;
  if (format && !['text', 'grammar'].includes(format.type)) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_CUSTOM_TOOL_FORMAT');
  if (format?.type === 'grammar' && (!['lark', 'regex'].includes(format.syntax) || typeof format.definition !== 'string')) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_CUSTOM_TOOL_FORMAT');
  const grammar = format?.type === 'grammar' ? `\nInput grammar (${format.syntax}):\n${format.definition}` : '';
  return { type: 'function', name: alias, description: `${t.description ?? ''}\nProvide the complete tool input as the input string, preserving all characters and line breaks.${grammar}`.trim(),
    parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } };
}
/** Only used for cross-protocol conversion; native Responses stays untouched. */
export function portableResponseTools(body: Wire): Wire {
  const tools = responseToolMap(body.tools, body.input);
  const input = typeof body.input === 'string' ? body.input : array(body.input).map(item => {
    if (item.type === 'tool_search_call') {
      if (item.execution !== 'client' || typeof item.call_id !== 'string' || !item.call_id) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_TOOL_SEARCH_EXECUTION');
      let args = item.arguments;
      try { if (typeof args === 'string') args = JSON.parse(args); } catch { throw new RouterError('INVALID_TOOL_SEARCH_ARGUMENTS'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RouterError('INVALID_TOOL_SEARCH_ARGUMENTS');
      return { type: 'function_call', call_id: item.call_id, name: 'tool_search', arguments: JSON.stringify(args) };
    }
    if (item.type === 'tool_search_output' || item.type === 'additional_tools') {
      const found = responseToolMap(undefined, [item]);
      const names = [...found.keys()];
      const text = names.length ? 'Tools available from this point: ' + names.join(', ') : 'No tools matched the search.';
      return item.type === 'additional_tools' ? { type: 'message', role: 'developer', content: text } : { type: 'function_call_output', call_id: item.call_id, output: text };
    }
    if (!['function_call', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type)) return item;
    if (item.type === 'custom_tool_call_output') return { ...item, type: 'function_call_output' };
    if (item.encrypted_function_args?.length) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_ENCRYPTED_FUNCTION_ARGUMENTS');
    const name = toolName(item.name, item.namespace);
    if (item.type === 'custom_tool_call' && typeof item.input !== 'string') throw new RouterError('INVALID_CUSTOM_TOOL_INPUT');
    const { namespace, input, encrypted_function_args, ...rest } = item;
    return { ...rest, type: 'function_call', name, arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input }) : item.arguments };
  });
  let choice = body.tool_choice;
  if (choice && typeof choice === 'object' && ['function', 'custom'].includes(choice.type)) choice = { type: 'function', name: toolName(choice.name, choice.namespace) };
  return { ...body, input, ...(body.tools !== undefined || tools.size ? { tools: [...tools].map(([alias, value]) => definition(alias, value)) } : {}), ...(choice !== undefined ? { tool_choice: choice } : {}) };
}
export function customToolInput(args: string): string {
  let value: Wire;
  try { value = JSON.parse(args); } catch { throw new RouterError('UPSTREAM_INVALID_CUSTOM_TOOL_INPUT', 502); }
  if (!value || typeof value.input !== 'string' || Object.keys(value).some(k => k !== 'input')) throw new RouterError('UPSTREAM_INVALID_CUSTOM_TOOL_INPUT', 502);
  return value.input;
}
