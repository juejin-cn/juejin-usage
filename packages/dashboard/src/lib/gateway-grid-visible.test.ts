import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayProviderColumns, gatewayRuntimeColumns, splitVisibleRows } from './gateway-grid-visible.ts';

test('splitVisibleRows keeps the first rows and folds the overflow', () => {
  assert.deepEqual(splitVisibleRows([1, 2, 3, 4, 5, 6, 7], 3, 2), { visible: [1, 2, 3, 4, 5, 6], rest: [7] });
  assert.deepEqual(splitVisibleRows([1, 2], 3, 1), { visible: [1, 2], rest: [] });
  assert.deepEqual(splitVisibleRows([1, 2, 3, 4], 3, 1), { visible: [1, 2, 3], rest: [4] });
});

test('provider columns follow the gateway grid breakpoints', () => {
  assert.equal(gatewayProviderColumns(479), 1);
  assert.equal(gatewayProviderColumns(480), 2);
  assert.equal(gatewayProviderColumns(640), 3);
  assert.equal(gatewayProviderColumns(1280), 4);
  assert.equal(gatewayProviderColumns(1536), 5);
});

test('runtime columns fit minmax tiles into the measured width', () => {
  assert.equal(gatewayRuntimeColumns(240), 1);
  assert.equal(gatewayRuntimeColumns(488), 2);
  assert.equal(gatewayRuntimeColumns(736), 3);
});
