import { cpSync, mkdirSync, readFileSync, realpathSync, existsSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetTriple, externalNodeName } from './platform.mjs';
import { execFileSync } from 'node:child_process';

const appRoot = fileURLToPath(new URL('..', import.meta.url));

// Resolve from each consumer, preserving pnpm's exact transitive versions.
// Never scan the store for a newest version or flatten conflicting versions.
export function copyRuntimePackage(name, consumer, destination, ancestors = new Set()) {
  const require = createRequire(join(consumer, 'package.json'));
  // Resolve package directories, rather than require entry points: Core is
  // ESM-only and deliberately has no require condition in its exports map.
  let root = (require.resolve.paths(name) ?? [])
    .map(base => join(base, name))
    .find(candidate => existsSync(join(candidate, 'package.json')));
  if (!root) throw new Error(`Cannot locate runtime dependency ${name} from ${consumer}`);
  root = realpathSync(root);
  if (ancestors.has(root)) throw new Error(`Dependency cycle while staging ${name}`);
  const nextAncestors = new Set([...ancestors, root]);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  cpSync(root, destination, {
    recursive: true, dereference: true,
    filter: (source) => source === root || !source.slice(root.length + 1).split(/[\\/]/).some((part) => ['node_modules', '.git'].includes(part)),
  });
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    copyRuntimePackage(dependency, root, join(destination, 'node_modules', dependency), nextAncestors);
  }
}

export function stageNodeApp() {
  const out = join(appRoot, 'src-tauri/node-app');
  const node = realpathSync(process.env.TUD_NODE_BIN || process.execPath);
  const runtime = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({arch:process.arch,platform:process.platform,major:Number(process.versions.node.split(".")[0])})'], { encoding: 'utf8' }));
  if (runtime.major < 20 || runtime.arch !== process.arch || runtime.platform !== process.platform) {
    throw new Error('Stage requires a host-platform Node >=20; cross-platform bundles are not supported yet');
  }
  if (!existsSync(join(appRoot, 'dist/host/index.js'))) throw new Error('Build the desktop host first');
  rmSync(out, { force: true, recursive: true });
  mkdirSync(out,{recursive:true});
  const target=targetTriple();
  const nodeOut=join(appRoot,'src-tauri/binaries',externalNodeName(target));
  mkdirSync(dirname(nodeOut), { recursive: true });
  cpSync(node, nodeOut);
  if (process.platform !== 'win32') chmodSync(nodeOut, 0o755);
  writeFileSync(join(out,'runtime.json'),JSON.stringify({schemaVersion:1,target,platform:runtime.platform,arch:runtime.arch,nodeVersion:runtime.major,binary:externalNodeName(target)},null,2)+'\n');
  const app = join(out, 'app');
  cpSync(join(appRoot, 'dist'), join(app, 'dist'), { recursive: true });
  cpSync(join(appRoot, 'package.json'), join(app, 'package.json'));
  copyRuntimePackage('@juejin-opensource/jusage-core', appRoot, join(app, 'node_modules/@juejin-opensource/jusage-core'));
  console.log(`Staged ${runtime.platform}/${runtime.arch} Node ${runtime.major} and Core runtime at ${out}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) stageNodeApp();
