/// <reference types="vite/client" />

/** Injected at build time from package.json via Vite `define`. */
declare const __APP_VERSION__: string;

/** Static asset imports for icon files. */
declare module '*.ico' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  /** Public API root; defaults to https://api.juejin.cn/aiusage_api. */
  readonly VITE_API_BASE?: string;
  readonly VITE_API_BEARER?: string;
  /** Dev-only: force portable “available” update UI for style checks. */
  readonly VITE_MOCK_PORTABLE_UPDATE?: string;
  /** Dev-only: render Codex / Claude / Cursor subscription cards without local accounts. */
  readonly VITE_DESKTOP_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
