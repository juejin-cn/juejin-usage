import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syncVersion } from './sync-version.mjs';

// Run in a release checkout; never infer a version from the stable package.
const version=process.argv[2];
if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:beta|next)\.(0|[1-9]\d*)$/.test(version||'')) {
  throw new Error('Provide an explicit version such as 2.0.0-next.1');
}
const path=fileURLToPath(new URL('../package.json',import.meta.url));
const pkg=JSON.parse(readFileSync(path,'utf8'));
pkg.version=version;
writeFileSync(path,JSON.stringify(pkg,null,2)+'\n');
syncVersion(fileURLToPath(new URL('..',import.meta.url)));
console.log(`Prepared beta version ${version}`);
