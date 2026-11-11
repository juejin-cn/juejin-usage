import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(process.env.TUD_STAGED_ROOT || join(appRoot, 'src-tauri/node-app'));
const manifest=JSON.parse(readFileSync(join(root,'runtime.json'),'utf8'));
assert.equal(manifest.schemaVersion,2,'Runtime manifest schema must include ICU metadata');
const filename=process.platform==='win32'?'jusage-node.exe':'jusage-node';
const binary=process.env.TUD_STAGED_NODE || [join(root,'../../MacOS',filename),join(root,'..',filename),join(root,'../binaries',manifest.binary)].find(path=>existsSync(path));
if(!binary)throw new Error('Cannot locate staged/bundled Node sidecar; set TUD_STAGED_NODE');
const expectedNode = readFileSync(join(appRoot, '.node-version'), 'utf8').trim();
const actualNode = execFileSync(binary, ['-p', 'process.versions.node'], {encoding:'utf8'}).trim();
assert.equal(actualNode, expectedNode, 'Packaged Node must match Electron-aligned runtime');
assert.equal(manifest.nodeFullVersion, expectedNode, 'Runtime manifest must record the full Node version');
const actualRuntime = JSON.parse(execFileSync(binary, ['-p','JSON.stringify({platform:process.platform,arch:process.arch,type:process.config.variables.icu_small ? "small" : "full",version:process.versions.icu})'], {encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NODE_ICU_DATA:''}}));
assert.equal(actualRuntime.platform,manifest.platform,'Packaged runtime platform must match its manifest');
assert.equal(actualRuntime.arch,manifest.arch,'Packaged runtime architecture must match its manifest');
const {platform,arch,...icu}=actualRuntime;
assert.deepEqual(icu,manifest.icu,'ICU metadata must match the actual packaged binary');
if(icu.type==='small')assert.ok(manifest.build?.sourceSha256,'Custom Node needs build provenance');
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
execFileSync(process.execPath, [join(appRoot,'scripts/capture-golden.mjs'),'--node',resolve(binary)], {
  stdio:'inherit', env:{...process.env,
    TUD_GOLDEN_CORE_PATH:join(core,'dist/index.js'),
    TUD_GOLDEN_SNAPSHOT_PATH:join(root,'app/dist/host/read-snapshot.js'),
  },
});
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

// Exercise the actual staged inference runtime, not the workspace Core build.
// A stale node-app once kept rejecting Codex web_search after Core tests passed.
assert.ok(existsSync(join(core, 'dist/agent-router/protocol/hosted-tools.js')), 'Staged Core lacks hosted tools; rebuild and stage the desktop runtime');
execFileSync(binary, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import { createServer } from 'node:http';
  import { once } from 'node:events';
  import { AgentGateway, RouterCredentials } from ${JSON.stringify(pathToFileURL(join(core, 'dist/agent-router/index.js')).href)};
  let received = false;
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received = body.model === 'fixture' && body.tools.length === 1 && body.tools[0].type === 'function';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = new AgentGateway(new RouterCredentials({ STAGED_TEST_KEY: 'fixture-key' }));
  try {
    await gateway.start({ version: 1, port: 0, providers: [{ id: 'fixture', name: 'Fixture', enabled: true, protocol: 'chat', baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1', models: ['fixture'], auth: { kind: 'env', variable: 'STAGED_TEST_KEY' } }], groups: [] });
    const reply = await fetch(gateway.status().baseUrl + '/responses', { method: 'POST', headers: { authorization: 'Bearer ' + gateway.token(), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture/fixture', input: 'Reply OK', tools: [{ type: 'web_search' }], stream: true }), signal: AbortSignal.timeout(5000) });
    const raw = await reply.text(); assert.equal(reply.status, 200, raw); assert.ok(received);
    assert.match(raw, /response.completed/); assert.doesNotMatch(raw, /PROTOCOL_CONVERSION_UNSUPPORTED_BUILTIN_TOOL/);
  } finally { await gateway.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
`], { stdio: 'inherit', timeout: 15000 });
