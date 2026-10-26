import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(process.env.TUD_STAGED_ROOT || join(appRoot, 'src-tauri/node-app'));
const manifest=JSON.parse(readFileSync(join(root,'runtime.json'),'utf8'));
const filename=process.platform==='win32'?'jusage-node.exe':'jusage-node';
const binary=process.env.TUD_STAGED_NODE || [join(root,'../../MacOS',filename),join(root,'..',filename),join(root,'../binaries',manifest.binary)].find(path=>existsSync(path));
if(!binary)throw new Error('Cannot locate staged/bundled Node sidecar; set TUD_STAGED_NODE');
execFileSync(process.execPath, ['--test', join(appRoot, 'test/host.test.mjs')], {
  stdio: 'inherit',
  env: { ...process.env,
    TUD_TEST_NODE_BIN: resolve(binary),
    TUD_TEST_HOST_PATH: join(root, 'app/dist/host/runtime.js'),
  },
});
