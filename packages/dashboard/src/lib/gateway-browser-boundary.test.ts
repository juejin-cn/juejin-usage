import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';

for (const [name, entry] of [
  ['Dashboard', new URL('./gateway-model-names.ts', import.meta.url)],
  ['Desktop', new URL('../../../../apps/desktop/src/renderer/lib/gateway-model-names.ts', import.meta.url)],
] as const) {
  test(`${name} model metadata dependency graph stays browser-safe before tree shaking`, async () => {
    let checked = 0;
    const result = await build({
      configFile: false, publicDir: false, logLevel: 'silent',
      plugins: [{ name: 'reject-node-in-browser-models', enforce: 'pre', resolveId(id) {
        checked++;
        if (isBuiltin(id)) throw new Error(`Browser model metadata imported Node module: ${id}`);
      } }],
      build: { write: false, minify: false, lib: { entry: fileURLToPath(entry), formats: ['es'] },
        rollupOptions: { external: ['react'], treeshake: false } },
    });
    assert.ok(result);
    assert.ok(checked > 0);
  });
}
