import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

/**
 * SPA mount prefix (e.g. `/aiusage`), independent of Vite asset `base`
 * (`VITE_BASE` may be a CDN absolute URL).
 */
const basepath = (() => {
  const raw = (import.meta.env.VITE_ROUTER_BASE ?? '').trim();
  if (!raw || raw === '/') return undefined;
  return raw.replace(/\/+$/, '');
})();

export const router = createRouter({
  routeTree,
  ...(basepath ? { basepath } : {}),
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
