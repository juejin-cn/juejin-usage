import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// The renderer is copied from apps/desktop and keeps its original directory
// layout (src/renderer + src/shared). Vite root stays on src/renderer so all
// the relative `../../shared/*` and `../../../../packages/*` imports keep
// resolving exactly as they do in the Electron app — no source changes needed.
const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig(() => ({
  root: rendererRoot,
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "routes",
      generatedRouteTree: "routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: [{ find: "@", replacement: rendererRoot }],
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    // Two entries: index.html (dashboard + tray popover, toggled by ?view=tray-popover)
    // and pet.html (standalone desktop-pet window).
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./src/renderer/index.html", import.meta.url)),
        pet: fileURLToPath(new URL("./src/renderer/pet.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 1720,
    strictPort: true,
    // Bind explicitly to the IPv4 loopback. On this machine Node's `localhost`
    // default resolves to the IPv6 `::1` listener only, so `http://localhost:1720`
    // (what the Tauri WKWebView dials, IPv4-first per /etc/hosts) gets refused
    // and the webview renders a blank body. `TAURI_DEV_HOST` still wins if set.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1721,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
