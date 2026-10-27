import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(process.env.TUD_STAGED_ROOT || join(appRoot, 'src-tauri/node-app'));
const manifest=JSON.parse(readFileSync(join(root,'runtime.json'),'utf8'));
const filename=process.platform==='win32'?'jusage-node.exe':'jusage-node';
const binary=process.env.TUD_STAGED_NODE || [join(root,'../../MacOS',filename),join(root,'..',filename),join(root,'../binaries',manifest.binary)].find(path=>existsSync(path));
if(!binary)throw new Error('Cannot locate staged/bundled Node sidecar; set TUD_STAGED_NODE');
const expectedNode = readFileSync(join(appRoot, '.node-version'), 'utf8').trim();
const actualNode = execFileSync(binary, ['-p', 'process.versions.node'], {encoding:'utf8'}).trim();
assert.equal(actualNode, expectedNode, 'Packaged Node must match Electron-aligned runtime');
assert.equal(manifest.nodeFullVersion, expectedNode, 'Runtime manifest must record the full Node version');
assert.equal(existsSync(join(root, 'app/dist/ui')), false, 'UI must be embedded once, not copied into Node resources');
const core = join(root, 'app/node_modules/@juejin-opensource/jusage-core');
for (const path of ['node_modules/hono/dist/cjs', 'node_modules/yaml/browser']) {
  assert.equal(existsSync(join(core, path)), false, `Non-runtime package variant: ${path}`);
}
function checkFiles(dir) {
  for (const entry of readdirSync(dir, {withFileTypes:true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) checkFiles(path);
    else assert.doesNotMatch(entry.name, /\.d\.(?:ts|mts|cts)$|\.map$/, 'Runtime must not include types or source maps');
  }
}
checkFiles(join(root, 'app'));
// Exercise package exports after pruning, rather than only checking file names.
const yamlResult = execFileSync(binary, ['--input-type=module', '-e', `
  import { createRequire } from 'node:module';
  import { pathToFileURL } from 'node:url';
  const require = createRequire(${JSON.stringify(join(core, 'package.json'))});
  const yaml = await import(pathToFileURL(require.resolve('yaml')).href);
  console.log(JSON.stringify(yaml.parse('quota: 42')));
`], {encoding:'utf8'});
assert.deepEqual(JSON.parse(yamlResult), {quota:42});


execFileSync(process.execPath, ['--test', join(appRoot, 'test/host.test.mjs')], {
  stdio: 'inherit',
  env: { ...process.env,
    TUD_TEST_NODE_BIN: resolve(binary),
    TUD_TEST_HOST_PATH: join(root, 'app/dist/host/runtime.js'),
  },
});
