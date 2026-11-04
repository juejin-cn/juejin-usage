import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syncVersion } from './sync-version.mjs';

// Stable release checkout only; never infer from a beta package version.
const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '')) {
  throw new Error('Provide an explicit stable version such as 1.0.0');
}
const path = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(path, 'utf8'));
pkg.version = version;
writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
syncVersion(fileURLToPath(new URL('..', import.meta.url)));
console.log(`Prepared stable version ${version}`);
