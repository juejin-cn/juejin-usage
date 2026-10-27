import { cpSync, mkdirSync, readFileSync, realpathSync, existsSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetTriple, externalNodeName } from './platform.mjs';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { optimizeNodeBinary } from './optimize-node.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
export const desktopNodeVersion = readFileSync(join(appRoot, '.node-version'), 'utf8').trim();

export function validateNodeRuntime(runtime, platform = process.platform, arch = process.arch) {
  if (runtime.version !== desktopNodeVersion || runtime.arch !== arch || runtime.platform !== platform) {
    throw new Error(`Stage requires ${platform}/${arch} Node ${desktopNodeVersion} (Electron parity); received ${runtime.platform}/${runtime.arch} Node ${runtime.version}. Switch Node or set TUD_NODE_BIN to the matching binary.`);
  }
}

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
    filter: (source) => {
      if(source===root)return true;
      const parts=source.slice(root.length+1).split(/[\\/]/);
      if(parts.some(part=>['node_modules','.git'].includes(part)||part==='.env'||part.startsWith('.env.')))return false;
      return name!=='@juejin-opensource/jusage-core'||parts[0]==='dist'||parts[0]==='package.json'||/^licen[cs]e/i.test(parts[0]);
    },
  });
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    copyRuntimePackage(dependency, root, join(destination, 'node_modules', dependency), nextAncestors);
  }
}

export function stageNodeApp() {
  const out = join(appRoot, 'src-tauri/node-app');
  const node = realpathSync(process.env.TUD_NODE_BIN || process.execPath);
  const runtime = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({arch:process.arch,platform:process.platform,version:process.versions.node,major:Number(process.versions.node.split(".")[0])})'], { encoding: 'utf8' }));
  validateNodeRuntime(runtime);
  if (!existsSync(join(appRoot, 'dist/host/index.js'))) throw new Error('Build the desktop host first');
  rmSync(out, { force: true, recursive: true });
  mkdirSync(out,{recursive:true});
  const target=targetTriple();
  const nodeOut=join(appRoot,'src-tauri/binaries',externalNodeName(target));
  mkdirSync(dirname(nodeOut), { recursive: true });
  cpSync(node, nodeOut);
  if (process.platform !== 'win32') chmodSync(nodeOut, 0o755);
  if (process.env.TAURI_ENV_DEBUG !== 'true') optimizeNodeBinary(nodeOut);
  writeFileSync(join(out,'runtime.json'),JSON.stringify({schemaVersion:1,target,platform:runtime.platform,arch:runtime.arch,nodeVersion:runtime.major,nodeFullVersion:runtime.version,binary:externalNodeName(target)},null,2)+'\n');
  const license=process.env.TUD_NODE_LICENSE || [join(dirname(node),'../LICENSE'),join(dirname(node),'LICENSE')].find(path=>existsSync(path));
  if(license)cpSync(license,join(out,'NODE-LICENSE'));
  cpSync(join(appRoot,'../../LICENSE'),join(out,'LICENSE'));
  const app = join(out, 'app');
  cpSync(join(appRoot, 'dist'), join(app, 'dist'), { recursive: true });
  cpSync(join(appRoot, 'package.json'), join(app, 'package.json'));
  const petResources=join(app,'dist/pet-resources');
  mkdirSync(petResources,{recursive:true});
  for(const name of ['desktop-pet-scanner','desktop-pet-remote']) {
    const source=readFileSync(join(appRoot,'../desktop/src/main',`${name}.ts`),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    writeFileSync(join(petResources,`${name}.js`),code);
  }
  copyRuntimePackage('@juejin-opensource/jusage-core', appRoot, join(app, 'node_modules/@juejin-opensource/jusage-core'));
  console.log(`Staged ${runtime.platform}/${runtime.arch} Node ${runtime.version} and Core runtime at ${out}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) stageNodeApp();
