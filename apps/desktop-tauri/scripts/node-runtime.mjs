import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const nodeSource = JSON.parse(readFileSync(new URL('./node-source.json', import.meta.url),'utf8'));
export function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function validateIcuRuntime(runtime, expected = 'full', manifest = null, binaryHash = null) {
  if (!['full','small'].includes(expected)) throw new Error('TUD_NODE_ICU must be full or small');
  if (typeof runtime.icuSmall !== 'boolean' || !runtime.icuVersion) throw new Error('Node must include ICU');
  const actual = runtime.icuSmall ? 'small' : 'full';
  if (actual !== expected) throw new Error(`Expected ${expected}-icu Node, received ${actual}-icu`);
  if (actual === 'small' && (!manifest || manifest.schemaVersion !== 1
      || manifest.nodeVersion !== nodeSource.nodeVersion
      || manifest.sourceSha256 !== nodeSource.sha256
      || manifest.platform !== runtime.platform || manifest.arch !== runtime.arch
      || manifest.binarySha256 !== binaryHash
      || !manifest.configureArgs?.includes('--with-intl=small-icu'))) {
    throw new Error('small-icu requires a matching, verified TUD_NODE_BUILD_MANIFEST');
  }
  return {type:actual, version:runtime.icuVersion};
}
