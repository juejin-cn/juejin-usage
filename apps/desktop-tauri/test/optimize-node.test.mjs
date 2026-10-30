import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { optimizeNodeBinary } from '../scripts/optimize-node.mjs';

test('optimized macOS Node keeps SQLite and crypto working without changing host Node', {
  skip: process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 22,
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'jusage-node-optimize-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'jusage-node');
  const hostSize = statSync(process.execPath).size;
  cpSync(process.execPath, binary);
  optimizeNodeBinary(binary);
  execFileSync('codesign', ['--verify', '--strict', binary]);
  const output = execFileSync(binary, ['-e', `
    const db = new (require('node:sqlite').DatabaseSync)(':memory:');
    console.log(JSON.stringify({
      value: db.prepare('select 42 as value').get().value,
      hash: require('node:crypto').createHash('sha256').update('test').digest('hex'),
    }));
    db.close();
  `], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.value, 42);
  assert.equal(result.hash, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  assert.ok(statSync(binary).size <= hostSize);
  assert.equal(statSync(process.execPath).size, hostSize);
});
