import { gatewayModelName } from '@juejin-opensource/jusage-core/agent-router/presets';
import { useEffect, useState } from 'react';
import type { RouterProvider } from '@juejin-opensource/jusage-core/agent-router';
import { routerRequest, type AgentRouterSnapshot } from './agent-router';

const pending = new Map<string, Promise<Record<string, string>>>();
function fetchModelNames(providerId: string): Promise<Record<string, string>> {
  const existing = pending.get(providerId);
  if (existing) return existing;
  const request = routerRequest<{ names?: Record<string, string> }>('/models', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId }),
  }).then(result => result.names ?? {}).finally(() => pending.delete(providerId));
  pending.set(providerId, request);
  return request;
}

/** Names are presentation metadata only; IDs remain the selection and request keys. */
export function useGatewayModelNames(providers: RouterProvider[], snapshot: AgentRouterSnapshot | null, open = true) {
  const [names, setNames] = useState<Record<string, Record<string, string>>>({});
  const ids = open ? providers.filter(provider => provider.enabled && provider.auth.kind === 'subscription'
    && snapshot?.providers.some(status => status.id === provider.id && status.ready)).map(provider => provider.id).join(',') : '';
  useEffect(() => {
    let cancelled = false;
    if (ids) for (const id of ids.split(',')) {
      void fetchModelNames(id).then(result => {
        if (!cancelled) setNames(previous => ({ ...previous, [id]: result }));
      }).catch(() => { /* Keep IDs visible when the upstream catalog is unavailable. */ });
    }
    return () => { cancelled = true; };
  }, [ids]);
  return Object.fromEntries(providers.map(provider => [provider.id, Object.fromEntries(provider.models.map(id => [id,
    gatewayModelName(provider.auth.kind === 'subscription' ? provider.auth.provider : provider.preset, id, names[provider.id]?.[id]),
  ]))]));
}
