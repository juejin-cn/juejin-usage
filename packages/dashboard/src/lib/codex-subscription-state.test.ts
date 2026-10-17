import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodexSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/codex-subscription';
import { INITIAL_CODEX_SUBSCRIPTION_STATE, shouldRefreshCodexOnFocus, updateCodexSubscriptionState } from './codex-subscription-state.ts';
const ready: CodexSubscriptionSnapshot = {
  status: 'ready', hasAccount: true, fetchedAt: 100, stale: false, planLabel: 'Plus',
  fiveHour: { usedPercent: 20, resetsAt: 1800000000 }, weekly: null, message: null,
};
const unavailable: CodexSubscriptionSnapshot = {
  status: 'unavailable', hasAccount: true, fetchedAt: null, stale: false, planLabel: 'Plus',
  fiveHour: null, weekly: null, message: '暂时无法读取额度',
};
test('focus retries transient failures and stale success, but waits on authentication failures', () => {
  assert.equal(shouldRefreshCodexOnFocus(unavailable), true);
  assert.equal(shouldRefreshCodexOnFocus({ ...ready, stale: true, message: '网络异常' }), true);
  assert.equal(shouldRefreshCodexOnFocus({ ...unavailable, hasAccount: false, status: 'not-signed-in' }), true);
  for (const status of ['expired', 'access-denied'] as const) {
    assert.equal(shouldRefreshCodexOnFocus({ ...unavailable, status }), false);
  }
});
test('known account failures stay visible, including expired credentials', () => {
  for (const status of ['unavailable', 'expired', 'access-denied'] as const) {
    const snapshot = { ...unavailable, status };
    const state = updateCodexSubscriptionState(INITIAL_CODEX_SUBSCRIPTION_STATE, snapshot, 200);
    assert.equal(state.snapshot, snapshot);
    assert.equal(state.lastUpdatedAt, null);
  }
});
test('renderer trusts account-aware main-process cache and its actual fetch time', () => {
  const loaded = updateCodexSubscriptionState(INITIAL_CODEX_SUBSCRIPTION_STATE, ready, 999);
  assert.equal(loaded.lastUpdatedAt, 100000);
  const stale = { ...ready, stale: true, message: '显示上次额度' };
  assert.equal(updateCodexSubscriptionState(loaded, stale, 200000).lastUpdatedAt, 100000);
  const failed = updateCodexSubscriptionState(loaded, unavailable, 300000);
  assert.equal(failed.snapshot?.fiveHour, null);
  assert.equal(failed.lastUpdatedAt, null);
});
test('no-account responses hide card and cannot retain previous account allowances', () => {
  const loaded = updateCodexSubscriptionState(INITIAL_CODEX_SUBSCRIPTION_STATE, ready, 100);
  for (const status of ['not-signed-in', 'unsupported-account', 'not-installed'] as const) {
    assert.deepEqual(updateCodexSubscriptionState(loaded, { ...unavailable, hasAccount: false, status }, 200), INITIAL_CODEX_SUBSCRIPTION_STATE);
  }
});
