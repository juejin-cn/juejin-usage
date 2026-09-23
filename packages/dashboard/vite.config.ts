import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite `base` — asset URLs in built HTML/JS only.
 * SPA route prefix is `VITE_ROUTER_BASE` (see src/router.tsx).
 *
 * Priority (first non-empty wins):
 *   1. `PUBLIC_PATH` — CDN override (absolute URL); not set by npm scripts
 *   2. `VITE_BASE` — from `build` (CLI `/`); Tauri variant passes `./` so the
 *      dashboard dist can be nested under a Tauri frontend sub-path without
 *      absolute-asset breakage
 *   3. `/`
 */
function resolveAssetBase(raw: string | undefined): string {
  const value = (raw ?? '/').trim() || '/';
  if (value === '/') return '/';
  return value.endsWith('/') ? value : `${value}/`;
}

function pickAssetBase(env: Record<string, string>): string {
  return resolveAssetBase(env.PUBLIC_PATH || env.VITE_BASE);
}

const DEFAULT_DEV_API_PROXY = 'https://api.juejin.cn/aiusage_api';

function resolveDevApiProxy(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return DEFAULT_DEV_API_PROXY;
  return value.replace(/\/$/, '');
}

function buildProxy(
  apiTarget: string,
  devApiProxy: string | undefined,
): Record<string, string | ProxyOptions> | undefined {
  if (apiTarget === 'cli') {
    return {
      '/functions': 'http://127.0.0.1:8452',
      '/health': 'http://127.0.0.1:8452',
    };
  }
  if (devApiProxy) {
    // Browser hits same-origin `/api/functions/tud-*`; Vite forwards to the public API root.
    return {
      '/api': {
        target: devApiProxy,
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api/, ''),
      },
    };
  }
  // No Vite proxy: use Whistle / Charles to reverse-proxy juejin.cn.
  return undefined;
}

export default defineConfig(({ mode }) => {
  // loadEnv merges `.env*` under process.env (existing keys win).
  const env = loadEnv(mode, rootDir, '');
  const apiTarget = env.VITE_API_TARGET || 'cli';
  const apiBase = env.VITE_API_BASE || '';
  const devApiProxy = resolveDevApiProxy(env.DEV_API_PROXY);

  return {
    base: pickAssetBase(env),
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      'import.meta.env.VITE_API_BASE': JSON.stringify(apiBase),
    },
    plugins: [
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, './src'),
      },
    },
    server: {
      port: 5194,
      proxy: buildProxy(apiTarget, devApiProxy),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
