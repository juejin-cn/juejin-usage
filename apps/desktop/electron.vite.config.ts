import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

const sharedRenderPlugins = () => [
  tanstackRouter({
    target: 'react',
    autoCodeSplitting: true,
    routesDirectory: 'routes',
    generatedRouteTree: 'routeTree.gen.ts',
  }),
  react(),
  tailwindcss(),
];

/**
 * electron-vite 5 主配置。
 *
 * 四段式：
 *  - main:     主进程入口 src/main/index.ts        → out/main/index.js
 *  - sync-worker: `?modulePath` 打出的独立 chunk（utilityProcess）
 *  - preload:  预加载入口 src/preload/index.ts     → out/preload/index.js
 *  - renderer: index.html（面板 + 托盘）与 pet.html（宠物独立入口，不打包 Dashboard）
 *
 * Main 嵌入 jusage-core（读 ~/.ai-usage，内存 local-api）；renderer 经 IPC 取数。
 * 默认 VITE_ENABLE_MOCK_DATA=false；需要样本数据时用 `pnpm dev:mock`。
 *
 * jusage-core / hono 为纯 ESM（exports 仅有 import），Electron main 产物是 CJS，
 * 不能 require 它们 — 打进 main bundle，避免 ERR_PACKAGE_PATH_NOT_EXPORTED。
 */
export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@juejin-opensource/jusage-core',
          'electron-updater',
          'hono',
        ],
      }),
    ],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: sharedRenderPlugins(),
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          pet: resolve(__dirname, 'src/renderer/pet.html'),
        },
      },
    },
    resolve: {
      alias: [
        { find: '@', replacement: resolve(__dirname, 'src/renderer') },
      ],
    },
    server: {
      port: 5195,
    },
  },
});
