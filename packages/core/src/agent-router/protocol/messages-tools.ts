import { RouterError } from '../config.js';
import type { Wire } from './request.js';

const array = (value: unknown): Wire[] => Array.isArray(value) ? value : [];
const searchNames = new Set(['ToolSearch', 'MCPSearch']);
const nameOf = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new RouterError('INVALID_TOOL_NAME');
  return value;
};

/** Lower client-side tool discovery to ordinary functions, without exposing dormant schemas. */
export function portableMessagesTools(body: Wire): Wire {
  const definitions = new Map<string, Wire>();
  const other: Wire[] = [];
  let deferred = false;
  for (const tool of array(body.tools)) {
    // Leave vendor built-ins to the existing capability checks/runtime.
    if (tool?.type && tool.type !== 'custom' && !tool.input_schema) { other.push(tool); continue; }
    const name = nameOf(tool.name);
    if (definitions.has(name)) throw new RouterError('AMBIGUOUS_TOOL_NAME');
    definitions.set(name, tool);
    if (tool.defer_loading) deferred = true;
  }
  const loaded = new Set<string>();
  const reference = (part: Wire): Wire => {
    if (part.type !== 'tool_reference') return part;
    const name = nameOf(part.tool_name);
    const tool = definitions.get(name);
    if (!tool || name === 'DeferredToolPlaceholder' || !tool.input_schema || typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema)) {
      throw new RouterError('TOOL_REFERENCE_DEFINITION_MISSING');
    }
    loaded.add(name);
    return { type: 'text', text: `Tool available: ${name}` };
  };
  const messages = array(body.messages).map(message => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map((part: Wire) => {
      if (message.role === 'assistant' && part.type === 'tool_use') loaded.add(nameOf(part.name));
      if (part.type !== 'tool_result' || !Array.isArray(part.content)) return part;
      return { ...part, content: part.content.map(reference) };
    }) };
  });
  if (body.tool_choice?.type === 'tool') loaded.add(nameOf(body.tool_choice.name));
  const searchable = [...definitions.values()].some(tool => searchNames.has(tool.name) && (!tool.type || tool.type === 'custom'));
  if (deferred && !searchable && [...definitions.values()].some(tool => tool.defer_loading && tool.name !== 'DeferredToolPlaceholder' && !loaded.has(tool.name))) {
    throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_TOOL_SEARCH_EXECUTION');
  }
  const tools = [...other, ...[...definitions.values()].flatMap(tool => {
    if (tool.defer_loading && (tool.name === 'DeferredToolPlaceholder' || !loaded.has(tool.name))) return [];
    const { defer_loading, ...definition } = tool;
    return [definition];
  })];
  return { ...body, messages, ...(body.tools !== undefined ? { tools } : {}) };
}

/** Same-protocol state restoration must keep the client's original discovery metadata. */
export function restoreMessagesTools(original: Wire, converted: Wire): Wire {
  const results: Wire[] = [];
  for (const message of array(original.messages)) for (const part of array(message.content)) {
    if (part.type === 'tool_result') results.push(part);
  }
  let resultIndex = 0;
  for (const message of array(converted.messages)) for (const part of array(message.content)) {
    if (part.type !== 'tool_result') continue;
    // State restoration may rename call IDs; result order remains unchanged.
    const result = results[resultIndex++];
    if (array(result?.content).some(item => item.type === 'tool_reference')) part.content = structuredClone(result.content);
  }
  if (original.tools !== undefined) converted.tools = structuredClone(original.tools);
  return converted;
}
