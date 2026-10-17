import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodexSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/codex-subscription';
import { codexSubscriptionDetails } from './codex-subscription-details.ts';

const snapshot: CodexSubscriptionSnapshot = {
  status: 'ready', hasAccount: true, fetchedAt: null, stale: false,
  planLabel: 'Plus', fiveHour: null, weekly: null, message: null,
};

test('Codex details keep balance and reset times without duplicating summary values', () => {
  const rows = codexSubscriptionDetails({ ...snapshot, credits: { balance: 12.5 } });
  assert.equal(rows.find(({ label }) => label === '积分余额')?.value, '12.50 积分');
  assert.equal(rows.some(({ value }) => value.includes('%')), false);
  assert.equal(rows.some(({ label }) => label.includes('卡')), false);
  assert.deepEqual(codexSubscriptionDetails(snapshot), []);
  assert.equal(codexSubscriptionDetails({ ...snapshot, credits: { balance: 0 } })[0].value, '0.00 积分');
});

test('Codex details show reported reset card counts, including zero', () => {
  for (const availableCount of [3, 0]) {
    const rows = codexSubscriptionDetails({ ...snapshot, resetCredits: { availableCount } });
    assert.equal(rows.find(({ label }) => label === '重置卡')?.value, `${availableCount} 张`);
  }
});
