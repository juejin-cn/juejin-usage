import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { firstDifference } from '../scripts/golden/diff-json.mjs';

test('golden diff ignores object order but preserves all business differences', () => {
  const expected={amount:0.12345678, rows:[{value:null},{value:4}], empty:{}};
  assert.equal(firstDifference(expected,{empty:{},rows:[{value:null},{value:4}],amount:0.12345678}),null);
  for(const mutate of [x=>{x.amount+=0.00000001},x=>{x.rows.reverse()},x=>{delete x.rows[0].value},x=>{x.rows[0].value=0},x=>{x.extra=true}]) {
    const actual=structuredClone(expected);mutate(actual);
    assert.ok(firstDifference(expected,actual));
  }
});
test('frozen API capture matches the checked-in golden baseline', {timeout:30_000}, () => {
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/capture-golden.mjs',import.meta.url))],{stdio:'pipe'});
});
