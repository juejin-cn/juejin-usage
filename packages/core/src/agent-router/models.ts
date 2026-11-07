import { buildModelCatalog, sanitizeModelMetadata, type ModelCatalog, type ModelMetadata } from './model-metadata.js';
import type { RouterCredentials } from './auth.js';
import { RouterError, type RouterProvider } from './config.js';
import { nativeAuthHeaders } from './glm.js';
import { geminiCatalogDestination } from './gemini-route.js';

/** Query the upstream catalog without persisting a draft or exposing its credentials. */
export async function pullProviderModels(credentials: RouterCredentials, provider: RouterProvider, gatewayPort = 0): Promise<string[]> {
  return (await pullProviderModelCatalog(credentials, provider, gatewayPort)).models;
}

export async function pullProviderModelCatalog(credentials: RouterCredentials, provider: RouterProvider, gatewayPort = 0): Promise<ModelCatalog> {
  if (provider.auth.kind === 'subscription') return credentials.subscriptions.modelCatalog(provider);
  const destination = provider.protocol === 'gemini' ? geminiCatalogDestination(provider.baseUrl) : new URL(`${provider.baseUrl}/models`);
  if (gatewayPort && ['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname) && Number(destination.port) === gatewayPort) throw new RouterError('GATEWAY_LOOP');
  const key = await credentials.resolve(provider);
  const models = new Set<string>();
  const metadata: Record<string, ModelMetadata> = Object.create(null);
  const signal = AbortSignal.timeout(15_000);
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < 20; page++) {
      const response = await fetch(destination, { redirect: 'error', signal, headers: { accept: 'application/json', ...nativeAuthHeaders(provider, key) } });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new RouterError(response.status === 401 || response.status === 403 ? 'MODEL_CATALOG_UNAUTHORIZED' : 'MODEL_CATALOG_UNAVAILABLE', 502);
      }
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new RouterError('MODEL_CATALOG_TOO_LARGE', 502);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: Array<{ id?: unknown; name?: unknown }>; models?: Array<{ name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; outputTokenLimit?: unknown; supportedGenerationMethods?: unknown }>; nextPageToken?: unknown; has_more?: boolean; last_id?: unknown };
      if (provider.protocol === 'gemini') {
        if (!Array.isArray(body.models)) throw new RouterError('MODEL_CATALOG_INVALID', 502);
        for (const item of body.models) {
          if (typeof item?.name !== 'string' || !item.name.startsWith('models/') || !item.name.slice(7) || item.name.length > 207 || /[\x00-\x1f\x7f]/.test(item.name)) throw new RouterError('MODEL_CATALOG_INVALID', 502);
          if (!Array.isArray(item.supportedGenerationMethods) || !item.supportedGenerationMethods.includes('generateContent')) continue;
          const id = item.name.slice(7); models.add(id);
          metadata[id] = sanitizeModelMetadata({ name: item.displayName, limits: { contextTokens: item.inputTokenLimit, outputTokens: item.outputTokenLimit } });
        }
        if (models.size > 4096) throw new RouterError('MODEL_CATALOG_TOO_LARGE', 502);
        if (!body.nextPageToken) return buildModelCatalog(Object.fromEntries([...models].sort().map(id => [id, metadata[id]])));
        if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length > 4096 || cursors.has(body.nextPageToken)) throw new RouterError('MODEL_CATALOG_INVALID', 502);
        cursors.add(body.nextPageToken); destination.searchParams.set('pageToken', body.nextPageToken); continue;
      }
      if (!Array.isArray(body.data)) throw new RouterError('MODEL_CATALOG_INVALID', 502);
      for (const item of body.data) {
        if (typeof item?.id !== 'string' || !item.id.trim() || item.id.length > 200 || /[\r\n\x00]/.test(item.id)) throw new RouterError('MODEL_CATALOG_INVALID', 502);
        models.add(item.id.trim());
        // OpenAI-compatible catalogs have no standard capability/pricing fields.
        metadata[item.id.trim()] = sanitizeModelMetadata({ name: item.name });
      }
      if (models.size > 4096) throw new RouterError('MODEL_CATALOG_TOO_LARGE', 502);
      if (!body.has_more) return buildModelCatalog(Object.fromEntries([...models].sort().map(id => [id, metadata[id]])));
      const cursor = body.last_id ?? body.data.at(-1)?.id;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new RouterError('MODEL_CATALOG_INVALID', 502);
      cursors.add(cursor); destination.searchParams.set('after_id', cursor);
    }
    throw new RouterError('MODEL_CATALOG_TOO_LARGE', 502);
  } catch (error) {
    if (error instanceof RouterError) throw error;
    throw new RouterError('MODEL_CATALOG_UNAVAILABLE', 502);
  }
}
