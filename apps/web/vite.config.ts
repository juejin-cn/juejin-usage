import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import pkg from './package.json';

const dashboard = fileURLToPath(new URL('../../packages/dashboard/', import.meta.url));
const publicApi = 'https://api.juejin.cn/aiusage_api';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.PUBLIC_PATH || env.VITE_BASE || '/aiusage/';
  const proxy = command === 'serve' && env.DEV_API_PROXY;
  const proxyPath = base.replace(/\/$/, '') + '/api';
  return {
    base,
    publicDir: dashboard + 'public',
    plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      'import.meta.env.VITE_API_TARGET': JSON.stringify('server'),
      'import.meta.env.VITE_ROUTER_BASE': JSON.stringify(env.VITE_ROUTER_BASE || '/aiusage/'),
      'import.meta.env.VITE_API_BASE': JSON.stringify(proxy ? proxyPath : env.VITE_API_BASE ?? publicApi),
    },
    resolve: {
      alias: {
        'lucide-react': fileURLToPath(new URL('./src/components/ui/shared-icons.ts', import.meta.url)),
        '@/components/UsageCard': fileURLToPath(new URL('./src/components/UsageCard.tsx', import.meta.url)),
        '@web': fileURLToPath(new URL('./src', import.meta.url)),
        '@': dashboard + 'src',
      },
    },
    server: {
      port: 5194,
      proxy: proxy ? { [proxyPath + '/']: {
        target: ['1', 'true'].includes(proxy) ? publicApi : proxy,
        changeOrigin: true,
        rewrite: path => path.slice(proxyPath.length),
      } } : undefined,
    },
  };
});
