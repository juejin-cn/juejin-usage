import type { IncomingHttpHeaders } from 'node:http';
import { RouterError, type Protocol } from '../config.js';

/** Only same-protocol feature declarations survive. Authentication is rebuilt. */
export function featureHeaders(headers: IncomingHttpHeaders, source: Protocol, target: Protocol): Record<string, string> {
  if (source !== target) return {};
  const keys = source === 'messages' ? ['anthropic-version', 'anthropic-beta'] : source === 'responses' ? ['openai-beta'] : [];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const v = headers[key]; if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 2048 || !/^[\x20-\x7e]+$/.test(v)) throw new RouterError('INVALID_FEATURE_HEADER', 400);
    if (key === 'anthropic-version' && v !== '2023-06-01') throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_ANTHROPIC_VERSION', 400);
    out[key] = v;
  }
  return out;
}
