import { gatewayModelName } from '@juejin-opensource/jusage-core/agent-router/presets';
import { sanitizeModelMetadata, type ModelCatalog } from '@juejin-opensource/jusage-core/agent-router/model-metadata';
import type { RouterProvider } from '@juejin-opensource/jusage-core/agent-router';
import { useEffect, useState } from 'react';
import { routerRequest, type AgentRouterSnapshot } from './agent-router';

const pending = new Map<string, Promise<ModelCatalog>>();
function fetchModelCatalog(providerId: string): Promise<ModelCatalog> {
  const existing = pending.get(providerId);
  if (existing) return existing;
  const request = routerRequest<ModelCatalog>('/models', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId }),
  }).then(result => ({ ...result, metadata: Object.fromEntries(Object.entries(result.metadata ?? {}).map(([id, meta]) => [id, sanitizeModelMetadata(meta)])) }))
    .finally(() => pending.delete(providerId));
  pending.set(providerId, request);
  return request;
}

/** All caches are keyed by account instance, never by vendor or model name. */
export function useGatewayModelCatalog(providers: RouterProvider[], snapshot: AgentRouterSnapshot | null, open = true, refresh = true) {
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalog>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now);
  const ids = open ? providers.filter(provider => provider.enabled && snapshot?.providers.some(status => status.id === provider.id && status.ready)).map(provider => provider.id).sort().join(',') : '';
  useEffect(() => {
    let cancelled = false;
    const deadlines = new Map<string, ReturnType<typeof setTimeout>>();
    const load = async (id: string) => {
      if (cancelled) return;
      setNow(Date.now());
      try {
        const result = await fetchModelCatalog(id);
        if (cancelled) return;
        setCatalogs(previous => ({ ...previous, [id]: result }));
        setErrors(previous => ({ ...previous, [id]: false }));
        clearTimeout(deadlines.get(id));
        if (refresh) {
          const until = Math.min(...Object.values(result.metadata ?? {}).map(meta => Date.parse(meta.billing?.validUntil ?? '')).filter(t => Number.isFinite(t) && t > Date.now()));
          if (Number.isFinite(until)) deadlines.set(id, setTimeout(() => { void load(id); }, Math.max(1, Math.min(60000, until - Date.now()))));
        }
      } catch {
        if (!cancelled) setErrors(previous => ({ ...previous, [id]: true }));
      } finally { if (!cancelled) setNow(Date.now()); }
    };
    const accounts = ids ? ids.split(',') : [];
    for (const id of accounts) void load(id);
    const refreshAll = () => { if (document.visibilityState !== 'hidden') for (const id of accounts) void load(id); };
    const timer = refresh && accounts.length ? setInterval(refreshAll, 60000) : undefined;
    if (refresh) {
      window.addEventListener('focus', refreshAll);
      document.addEventListener('visibilitychange', refreshAll);
    }
    return () => {
      cancelled = true; clearInterval(timer);
      window.removeEventListener('focus', refreshAll);
      document.removeEventListener('visibilitychange', refreshAll);
      for (const deadline of deadlines.values()) clearTimeout(deadline);
    };
  }, [ids, refresh]);
  return { catalogs, errors, now };
}

/** Names are presentation metadata only; IDs remain the selection and request keys. */
export function useGatewayModelNames(providers: RouterProvider[], snapshot: AgentRouterSnapshot | null, open = true) {
  const { catalogs } = useGatewayModelCatalog(providers, snapshot, open, false);
  return Object.fromEntries(providers.map(provider => [provider.id, Object.fromEntries(provider.models.map(id => [id,
    gatewayModelName(provider.auth.kind === 'subscription' ? provider.auth.provider : provider.preset, id, catalogs[provider.id]?.metadata?.[id]?.name ?? catalogs[provider.id]?.names?.[id]),
  ]))]));
}
