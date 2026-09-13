/// <reference types="vite/client" />

/** Injected at build time from package.json via Vite `define`. */
declare const __APP_VERSION__: string;

/** Static asset imports for icon files. */
declare module '*.ico' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly VITE_API_TARGET?: 'cli' | 'server';
  readonly VITE_API_BEARER?: string;
  /**
   * Public API root for `VITE_API_TARGET=server` (no trailing slash).
   * Empty → same-origin `/api/functions/tud-*`.
   */
  readonly VITE_API_BASE?: string;
  /** Only `'true'` enables leaderboard mocks and dashboard sample fallback. */
  readonly VITE_ENABLE_MOCK_DATA?: string;
  /**
   * Default Vite asset `base` (e.g. `/aiusage/`).
   * Overridden by process env `PUBLIC_PATH` when set (CDN absolute URL).
   * Does not control SPA routing; see `VITE_ROUTER_BASE`.
   */
  readonly VITE_BASE?: string;
  /**
   * SPA router basepath (e.g. `/aiusage`). Independent of asset CDN base.
   */
  readonly VITE_ROUTER_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
