import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { firstDifference } from './golden/diff-json.mjs';

const app = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) { const i=args.indexOf(name); return i<0 ? fallback : args[i+1]; }
const node = option('--node', process.execPath);
const fixture = resolve(option('--fixture', fileURLToPath(new URL('./golden/fixture.json', import.meta.url))));
const expected = resolve(option('--baseline', fileURLToPath(new URL('./golden/expected.json', import.meta.url))));
const result = JSON.parse(execFileSync(node, [fileURLToPath(new URL('./golden/worker.mjs', import.meta.url)), fixture], {
  cwd: app, encoding:'utf8', maxBuffer:32*1024*1024,
  // Prevent a build-machine NODE_OPTIONS/ICU override changing the candidate.
  env: { ...process.env, NODE_OPTIONS:'', NODE_ICU_DATA:'', TZ:'UTC', LANG:'en_US.UTF-8', LC_ALL:'en_US.UTF-8' },
}));
const {native, ...baseline} = result;
if (args.includes('--update')) writeFileSync(expected, '{\n"schemaVersion":1,\n"now":'+JSON.stringify(result.now)+',\n"responses":[\n'+result.responses.map(row=>JSON.stringify(row)).join(',\n')+'\n],\n"calendar":'+JSON.stringify(result.calendar)+'\n}\n');
else {
  const difference = firstDifference(JSON.parse(readFileSync(expected, 'utf8')), baseline);
  if (difference) throw new Error(`Golden mismatch at ${difference}`);
}
const rust = option('--rust-bin', null);
if (rust) {
  for (const record of result.native) {
    const actual = JSON.parse(execFileSync(resolve(rust), [], {
      input:JSON.stringify(record), encoding:'utf8', maxBuffer:8*1024*1024,
    }));
    const difference = firstDifference({status:record.status, body:record.body}, actual);
    if (difference) throw new Error(`Rust mismatch: ${record.scenario} ${record.path} at ${difference}`);
  }
}
const output = option('--output', null);
if (output) { mkdirSync(dirname(resolve(output)), {recursive:true}); writeFileSync(resolve(output), JSON.stringify(result,null,2)+'\n'); }
console.log(`Golden OK: ${result.responses.length} responses, ${result.calendar.length} timezone cases${rust ? `, ${result.native.length} Rust daily comparisons` : ''}`);
