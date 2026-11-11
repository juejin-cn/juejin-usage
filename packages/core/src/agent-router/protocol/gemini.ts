import { randomUUID } from 'node:crypto';
import { RouterError } from '../config.js';
import type { Event, Usage } from './events.js';
import type { Wire } from './request.js';

const list = (v: unknown): Wire[] => Array.isArray(v) ? v : [];
const unsupported = (feature: string): never => { throw new RouterError(`PROTOCOL_CONVERSION_UNSUPPORTED_${feature}`, 400); };
const plain = (v: unknown): string => typeof v === 'string' ? v : list(v).map(p => {
  if (p.type !== 'text') return unsupported('CONTENT'); return p.text ?? '';
}).join('\n');
function objectArgs(value: unknown): Wire {
  let v = value;
  try { if (typeof v === 'string') v = JSON.parse(v || '{}'); } catch { throw new RouterError('INVALID_TOOL_ARGUMENTS', 400); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RouterError('INVALID_TOOL_ARGUMENTS', 400);
  return v as Wire;
}
/** Google's Schema uses uppercase Type enums and string-encoded integer bounds. */
function nativeSchema(value: unknown): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unsupported('GEMINI_SCHEMA');
  const raw = value as Wire;
  const allowed = ['type', 'format', 'title', 'description', 'default', 'example', 'enum', 'properties', 'items', 'required', 'anyOf', 'nullable', 'minimum', 'maximum', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) unsupported('GEMINI_SCHEMA_FIELD');
  const out = { ...raw }; delete out.nullable;
  if (raw.type !== undefined) {
    const type = String(raw.type).toLowerCase();
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) unsupported('GEMINI_SCHEMA_TYPE');
    out.type = type;
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) if (raw[key] !== undefined) {
    const n = Number(raw[key]); if (!Number.isSafeInteger(n) || n < 0) unsupported('GEMINI_SCHEMA_BOUND'); out[key] = n;
  }
  if (raw.properties !== undefined && (!raw.properties || typeof raw.properties !== 'object' || Array.isArray(raw.properties))) unsupported('GEMINI_SCHEMA');
  if (raw.anyOf !== undefined && !Array.isArray(raw.anyOf)) unsupported('GEMINI_SCHEMA');
  if (raw.properties) out.properties = Object.fromEntries(Object.entries(raw.properties).map(([key, schema]) => [key, nativeSchema(schema)]));
  if (raw.items) out.items = nativeSchema(raw.items);
  if (raw.anyOf) out.anyOf = list(raw.anyOf).map(nativeSchema);
  if (raw.nullable !== undefined && typeof raw.nullable !== 'boolean') unsupported('GEMINI_SCHEMA_NULLABLE');
  return raw.nullable === true ? { anyOf: [out, { type: 'null' }] } : out;
}

/** Native GenerateContent is a fourth wire protocol, not an OpenAI URL alias. */
export function geminiToChat(body: Wire): Wire {
  const known = ['model', 'stream', 'contents', 'systemInstruction', 'generationConfig', 'tools', 'toolConfig'];
  if (Object.keys(body).some(key => !known.includes(key))) unsupported('GEMINI_REQUEST_FIELD');
  if (body.generationConfig !== undefined && (!body.generationConfig || typeof body.generationConfig !== 'object' || Array.isArray(body.generationConfig))) unsupported('GEMINI_GENERATION_CONFIG');
  const config = body.generationConfig ?? {};
  const allowed = ['temperature', 'topP', 'maxOutputTokens', 'stopSequences', 'responseMimeType', 'responseJsonSchema', 'responseSchema', 'candidateCount'];
  if (Object.keys(config).some(k => !allowed.includes(k))) unsupported('GEMINI_GENERATION_CONFIG');
  if (config.candidateCount !== undefined && config.candidateCount !== 1) unsupported('MULTIPLE_CHOICES');
  if (!Array.isArray(body.contents)) unsupported('GEMINI_CONTENTS');
  const messages: Wire[] = []; const names = new Map<string, string[]>();
  if (body.systemInstruction) messages.push({ role: 'system', content: list(body.systemInstruction.parts).map(p => {
    if (typeof p.text !== 'string' || p.thoughtSignature) return unsupported('GEMINI_SYSTEM'); return p.text;
  }).join('\n') });
  for (const item of list(body.contents)) {
    if (!Array.isArray(item.parts)) unsupported('GEMINI_PARTS');
    if (!['user', 'model'].includes(item.role)) unsupported('GEMINI_ROLE');
    const content: Wire[] = []; const calls: Wire[] = []; const results: Wire[] = [];
    for (const part of list(item.parts)) {
      if (Object.keys(part).some(k => !['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse', 'thought', 'thoughtSignature'].includes(k))) unsupported('GEMINI_PART');
      if (part.thoughtSignature) unsupported('NATIVE_SIGNATURE_HISTORY');
      if (part.thought) unsupported('GEMINI_THOUGHT_HISTORY');
      if (typeof part.text === 'string') content.push({ type: 'text', text: part.text });
      else if (part.inlineData) {
        if (!String(part.inlineData.mimeType).startsWith('image/') || typeof part.inlineData.data !== 'string') unsupported('GEMINI_MEDIA');
        content.push({ type: 'image_url', image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } });
      } else if (part.fileData) {
        if (!String(part.fileData.mimeType).startsWith('image/') || !/^https:\/\//.test(part.fileData.fileUri)) unsupported('GEMINI_FILE_CONTENT');
        content.push({ type: 'image_url', image_url: { url: part.fileData.fileUri } });
      }
      else if (part.functionCall) {
        const f = part.functionCall; const id = f.id || `call_${randomUUID().replaceAll('-', '')}`;
        if (Object.keys(f).some(k => !['id', 'name', 'args'].includes(k))) unsupported('GEMINI_FUNCTION_CALL');
        names.set(f.name, [...(names.get(f.name) ?? []), id]);
        calls.push({ id, type: 'function', function: { name: f.name, arguments: JSON.stringify(objectArgs(f.args ?? {})) }, ...(part.thoughtSignature ? { extra_content: { google: { thought_signature: part.thoughtSignature } } } : {}) });
      } else if (part.functionResponse) {
        const f = part.functionResponse; const matches = names.get(f.name) ?? [];
        if (Object.keys(f).some(k => !['id', 'name', 'response'].includes(k))) unsupported('GEMINI_FUNCTION_RESPONSE');
        if (!f.id && matches.length !== 1) unsupported('AMBIGUOUS_TOOL_RESULT');
        const id = f.id ?? matches[0];
        results.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(f.response ?? {}) });
        names.set(f.name, matches.filter(call => call !== id));
      } else unsupported('GEMINI_PART');
    }
    messages.push(...results);
    if (content.length || calls.length) messages.push({ role: item.role === 'model' ? 'assistant' : 'user', content: content.length ? content : null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  const out: Wire = { model: body.model, stream: body.stream === true, messages };
  for (const [source, target] of [['temperature', 'temperature'], ['topP', 'top_p'], ['maxOutputTokens', 'max_tokens'], ['stopSequences', 'stop']]) if (config[source] !== undefined) out[target] = config[source];
  if (config.responseJsonSchema !== undefined && config.responseSchema !== undefined) unsupported('GEMINI_SCHEMA_CONFLICT');
  if (config.responseMimeType === 'application/json') out.response_format = config.responseJsonSchema || config.responseSchema ? { type: 'json_schema', json_schema: { name: 'response', schema: config.responseJsonSchema ?? nativeSchema(config.responseSchema) } } : { type: 'json_object' };
  else if (config.responseJsonSchema || config.responseSchema) unsupported('GEMINI_RESPONSE_MIME');
  else if (config.responseMimeType && config.responseMimeType !== 'text/plain') unsupported('GEMINI_RESPONSE_MIME');
  const tools = list(body.tools).flatMap(tool => {
    if (Object.keys(tool).some(k => k !== 'functionDeclarations')) unsupported('BUILTIN_TOOL');
    return list(tool.functionDeclarations).map(f => {
      if (Object.keys(f).some(k => !['name', 'description', 'parameters', 'parametersJsonSchema'].includes(k))) unsupported('GEMINI_FUNCTION_DECLARATION');
      if (f.parameters !== undefined && f.parametersJsonSchema !== undefined) unsupported('GEMINI_SCHEMA_CONFLICT');
      return { type: 'function', function: { name: f.name, description: f.description, parameters: f.parametersJsonSchema ?? (f.parameters !== undefined ? nativeSchema(f.parameters) : { type: 'object', properties: {} }) } };
    });
  });
  if (tools.length) out.tools = tools;
  if (body.toolConfig) {
    if (Object.keys(body.toolConfig).some(k => k !== 'functionCallingConfig')) unsupported('GEMINI_TOOL_CONFIG');
    const f = body.toolConfig.functionCallingConfig ?? {}; const mode = f.mode ?? 'AUTO';
    if (Object.keys(f).some(k => !['mode', 'allowedFunctionNames'].includes(k))) unsupported('GEMINI_TOOL_CONFIG');
    if (!['AUTO', 'ANY', 'NONE'].includes(mode)) unsupported('TOOL_CHOICE');
    if (f.allowedFunctionNames?.length) {
      if (mode !== 'ANY' || f.allowedFunctionNames.length !== 1) unsupported('TOOL_CHOICE');
      out.tool_choice = { type: 'function', function: { name: f.allowedFunctionNames[0] } };
    } else out.tool_choice = mode === 'ANY' ? 'required' : mode.toLowerCase();
  }
  return out;
}

export function chatToGemini(chat: Wire): Wire {
  const out: Wire = { model: chat.model, stream: chat.stream === true, contents: [] };
  const system: Wire[] = []; const calls = new Map<string, { name: string; noId: boolean }>();
  for (const m of list(chat.messages)) {
    if (m.role === 'system' || m.role === 'developer') { system.push({ text: plain(m.content) }); continue; }
    const parts: Wire[] = [...(m.native_reasoning ?? [])];
    if (m.role === 'tool') {
      const call = calls.get(m.tool_call_id); if (!call) unsupported('ORPHAN_TOOL_RESULT');
      let response: unknown; try { response = JSON.parse(plain(m.content)); } catch { response = { output: plain(m.content) }; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) response = { output: response };
      parts.push({ functionResponse: { ...(!call!.noId ? { id: m.tool_call_id } : {}), name: call!.name, response } });
    } else {
      for (const part of typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : list(m.content)) {
        if (part.type === 'text') parts.push({ text: part.text });
        else if (part.type === 'image_url') {
          const url = String(part.image_url?.url); const data = /^data:([^;]+);base64,([\s\S]*)$/.exec(url);
          // HTTP image URLs do not have a reliable Gemini file MIME type.
          if (!data || !data[1].startsWith('image/')) return unsupported('GEMINI_IMAGE_URL');
          parts.push({ inlineData: { mimeType: data[1], data: data[2] } });
        } else unsupported('CONTENT');
      }
      for (const call of list(m.tool_calls)) {
        calls.set(call.id, { name: call.function.name, noId: call.native_id_absent === true });
        parts.push({ functionCall: { ...(!call.native_id_absent ? { id: call.id } : {}), name: call.function.name, args: objectArgs(call.function.arguments || '{}') }, ...(call.extra_content?.google?.thought_signature ? { thoughtSignature: call.extra_content.google.thought_signature } : {}) });
      }
    }
    if (parts.length) {
      const role = m.role === 'assistant' ? 'model' : 'user'; const previous = out.contents.at(-1);
      if (previous?.role === role) previous.parts.push(...parts); else out.contents.push({ role, parts });
    }
  }
  if (system.length) out.systemInstruction = { parts: system };
  const config: Wire = {};
  for (const [source, target] of [['temperature', 'temperature'], ['top_p', 'topP'], ['max_tokens', 'maxOutputTokens']]) if (chat[source] !== undefined) config[target] = chat[source];
  if (chat.max_completion_tokens !== undefined) config.maxOutputTokens = chat.max_completion_tokens;
  if (chat.stop) config.stopSequences = typeof chat.stop === 'string' ? [chat.stop] : chat.stop;
  if (chat.reasoning_effort) unsupported('GEMINI_REASONING_CONTROL');
  if (chat.response_format && chat.response_format.type !== 'text') {
    config.responseMimeType = 'application/json';
    if (chat.response_format.type === 'json_schema') config.responseJsonSchema = chat.response_format.json_schema.schema;
    else if (chat.response_format.type !== 'json_object') unsupported('STRUCTURED_OUTPUT');
  }
  if (Object.keys(config).length) out.generationConfig = config;
  if (chat.parallel_tool_calls === false) unsupported('PARALLEL_TOOL_CONTROL');
  if (chat.tools) out.tools = [{ functionDeclarations: list(chat.tools).map(t => {
    if (t.type !== 'function' || t.function.strict === true) unsupported('GEMINI_TOOL_SCHEMA');
    return { name: t.function.name, description: t.function.description, parametersJsonSchema: t.function.parameters ?? { type: 'object', properties: {} } };
  }) }];
  if (chat.tool_choice !== undefined) out.toolConfig = { functionCallingConfig: typeof chat.tool_choice === 'string'
    ? { mode: ({ auto: 'AUTO', none: 'NONE', required: 'ANY' } as Wire)[chat.tool_choice] ?? unsupported('TOOL_CHOICE') }
    : { mode: 'ANY', allowedFunctionNames: [chat.tool_choice.function.name] } };
  return out;
}

export function geminiUsage(v: Wire = {}): Usage {
  return { input: Number(v.promptTokenCount ?? 0), output: Number(v.candidatesTokenCount ?? 0) + Number(v.thoughtsTokenCount ?? 0), cached: Number(v.cachedContentTokenCount ?? 0), reasoning: Number(v.thoughtsTokenCount ?? 0) };
}
/** Google text parts are deltas; functionCall objects are complete snapshots. */
export function* geminiEvents(v: Wire): Generator<Event> {
  if (v.promptFeedback?.blockReason) { if (v.usageMetadata) yield { kind: 'usage', usage: geminiUsage(v.usageMetadata) }; yield { kind: 'finish', reason: 'content_filter' }; return; }
  if (list(v.candidates).length > 1) throw new RouterError('UPSTREAM_MULTIPLE_CHOICES', 502);
  const candidate = v.candidates?.[0];
  for (const [i, p] of list(candidate?.content?.parts).entries()) {
    if (p.functionCall?.partialArgs) throw new RouterError('UPSTREAM_UNSUPPORTED_TOOL_DELTA', 502);
    if (p.functionCall) yield { kind: 'tool', key: `g${p.functionCall.id ?? i}`, id: p.functionCall.id ?? `call_g${i}`, name: p.functionCall.name, args: JSON.stringify(p.functionCall.args ?? {}), snapshot: true, native: { ...(!p.functionCall.id ? { native_id_absent: true } : {}), ...(p.thoughtSignature ? { extra_content: { google: { thought_signature: p.thoughtSignature } } } : {}) } };
    else if (typeof p.text === 'string') {
      yield { kind: p.thought ? 'reasoning' : 'text', key: `g${i}${p.thought ? 'r' : 't'}`, text: p.text };
      if (p.thoughtSignature) yield { kind: 'native', key: `g${i}${p.thought ? 'r' : 't'}`, value: p };
    } else if (p.thoughtSignature) yield { kind: 'native', key: `g${i}${p.thought ? 'r' : 't'}`, value: p };
    else throw new RouterError('UPSTREAM_UNSUPPORTED_CONTENT', 502);
  }
  if (v.usageMetadata) yield { kind: 'usage', usage: geminiUsage(v.usageMetadata) };
  if (candidate?.finishReason) {
    const reason = candidate.finishReason;
    if (!['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) throw new RouterError('UPSTREAM_GEMINI_FINISH_UNSUPPORTED', 502);
    yield { kind: 'finish', reason: reason === 'STOP' ? 'stop' : reason === 'MAX_TOKENS' ? 'length' : 'content_filter' };
  }
}
