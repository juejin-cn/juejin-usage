import { RouterError } from './config.js';

export type GeminiAction = 'generateContent' | 'streamGenerateContent' | 'countTokens';
export interface GeminiRoute { model?: string; action?: GeminiAction }
export function parseGeminiRoute(path: string): GeminiRoute | undefined {
  if (path === '/v1beta/models') return {};
  if (!path.startsWith('/v1beta/models/')) return;
  const raw = path.slice('/v1beta/models/'.length);
  const match = /:(generateContent|streamGenerateContent|countTokens)$/.exec(raw);
  let model: string;
  try { model = decodeURIComponent(match ? raw.slice(0, match.index) : raw); } catch { throw new RouterError('INVALID_MODEL_PATH', 400); }
  if (!model || /[\x00-\x20\x7f?#]/.test(model)) throw new RouterError('INVALID_MODEL_PATH', 400);
  return { model, ...(match ? { action: match[1] as GeminiAction } : {}) };
}
export function geminiDestination(base: string, model: string, action: GeminiAction): URL {
  // API root and version roots are both accepted; no client-supplied host/path.
  const root = base.replace(/\/+$/, '').replace(/\/(?:v1beta|v1)$/, '');
  const url = new URL(`${root}/v1beta/models/${encodeURIComponent(model)}:${action}`);
  if (action === 'streamGenerateContent') url.searchParams.set('alt', 'sse');
  return url;
}
export function geminiCatalogDestination(base: string): URL {
  const url = geminiDestination(base, '_', 'generateContent');
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/models/')) + '/models';
  return url;
}
