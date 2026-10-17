import assert from 'node:assert/strict';
import test from 'node:test';
import type { KimiSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/kimi-subscription';
import { selectKimiSubscription, isKimiSubscriptionVisible } from './kimi-subscription-state.ts';

const firstFailure: KimiSubscriptionSnapshot = {
  status: 'temporarily-unavailable', source: 'desktop', planLabel: null,
  limits: [], fetchedAt: null, stale: false, message: '暂时无法读取 Kimi 订阅额度',
};

const desktop: KimiSubscriptionSnapshot = {
  ...firstFailure, status: 'ready', source: 'desktop', planLabel: 'Plus', fetchedAt: 100, message: null,
  limits: [{ id: 'subscription', label: '订阅额度', usedPercent: 30, resetsAt: null }],
};
const code: KimiSubscriptionSnapshot = {
  ...desktop, source: 'code', limits: [
    { id: 'limit_5h', label: '5h', usedPercent: 10, resetsAt: null },
    { id: 'limit_7d', label: '7d', usedPercent: 20, resetsAt: null },
    { id: 'limit_month_total', label: '月度共享额度', usedPercent: 30, resetsAt: null },
  ],
};

test('selects one complete subscription when either or both clients are signed in', () => {
  assert.equal(selectKimiSubscription([desktop]), desktop);
  assert.equal(selectKimiSubscription([code]), code);
  assert.equal(selectKimiSubscription([desktop, code]), code);
  assert.equal(selectKimiSubscription([code, desktop]), code);
});

test('uses the healthy source when the other client is unavailable or signed out', () => {
  for (const status of ['not-installed', 'not-signed-in', 'temporarily-unavailable', 'expired', 'custom-provider'] as const) {
    assert.equal(selectKimiSubscription([{ ...firstFailure, status }, code]), code);
    assert.equal(selectKimiSubscription([desktop, { ...firstFailure, source: 'code', status }]), desktop);
  }
});

test('prefers fresh readings, then useful quotas and a confirmed shared plan', () => {
  assert.equal(selectKimiSubscription([{ ...desktop, stale: true }, code]), code);
  assert.equal(selectKimiSubscription([desktop, { ...code, stale: true }]), desktop);
  const legacyCode = { ...code, limits: code.limits.slice(0, 2) };
  assert.equal(selectKimiSubscription([desktop, legacyCode]), desktop);
  assert.equal(selectKimiSubscription([{ ...desktop, limits: [] }, legacyCode]), legacyCode);
  assert.equal(selectKimiSubscription([desktop, { ...code, planLabel: null }]), desktop);
  const planOnly = { ...desktop, limits: [] };
  assert.equal(selectKimiSubscription([planOnly]), planOnly);
});

test('returns a whole snapshot without combining plans, quotas or failure messages', () => {
  const otherAccount = { ...code, planLabel: 'Max' };
  assert.equal(selectKimiSubscription([desktop, otherAccount]), otherAccount);
  assert.equal(desktop.planLabel, 'Plus');
  assert.equal(selectKimiSubscription([desktop, { ...firstFailure, source: 'code', planLabel: 'Max' }]), desktop);
  const staleCode = { ...code, stale: true, message: '暂时无法读取 Kimi 订阅额度' };
  assert.equal(selectKimiSubscription([{ ...desktop, stale: true }, staleCode]), staleCode);
});

test('keeps confirmed Free and custom-provider feedback only when no successful reading is available', () => {
  const signedOut = { ...firstFailure, status: 'not-signed-in' as const };
  const free = { ...firstFailure, planLabel: 'Free', stale: true };
  assert.equal(selectKimiSubscription([signedOut]), null);
  const customProvider = { ...firstFailure, source: 'code' as const, status: 'custom-provider' as const };
  assert.equal(selectKimiSubscription([signedOut, customProvider]), customProvider);
  assert.equal(selectKimiSubscription([signedOut, free]), free);
  assert.equal(selectKimiSubscription([free, code]), code);
  assert.equal(selectKimiSubscription([firstFailure]), null);
  assert.equal(selectKimiSubscription([{ ...firstFailure, status: 'not-installed' }]), null);
  assert.equal(selectKimiSubscription([]), null);
});

test('hides a failed first lookup with no confirmed plan or successful reading', () => {
  assert.equal(isKimiSubscriptionVisible(null), false);
  assert.equal(isKimiSubscriptionVisible(firstFailure), false);
  assert.equal(isKimiSubscriptionVisible({ ...firstFailure, status: 'not-installed' }), false);
});

for (const planLabel of ['Go', 'Plus', 'Pro', 'Max', 'Future Tier']) {
  test(`${planLabel} hides its first failure, appears after recovery, and retains a cached reading`, () => {
    assert.equal(isKimiSubscriptionVisible({ ...firstFailure, planLabel }), false);

    const ready: KimiSubscriptionSnapshot = {
      ...firstFailure, status: 'ready', planLabel, fetchedAt: 1_800_000_000,
      limits: [{ id: 'subscription', label: '订阅额度', usedPercent: 30, resetsAt: null }],
      message: null,
    };
    assert.equal(isKimiSubscriptionVisible(ready), true);
    assert.equal(isKimiSubscriptionVisible({ ...ready, stale: true, message: firstFailure.message }), true);
    assert.equal(isKimiSubscriptionVisible({ ...ready, limits: [] }), true);

    // A failed new account must not inherit the previous account's visibility.
    assert.equal(isKimiSubscriptionVisible(firstFailure), false);
  });
}

test('hides the card when neither desktop nor Code has an active login', () => {
  for (const desktopStatus of ['not-installed', 'not-signed-in', 'expired'] as const) {
    for (const codeStatus of ['not-installed', 'not-signed-in', 'expired'] as const) {
      assert.equal(selectKimiSubscription([
        { ...firstFailure, source: 'desktop', status: desktopStatus },
        { ...firstFailure, source: 'code', status: codeStatus },
      ]), null, `${desktopStatus} desktop / ${codeStatus} Code`);
    }
  }
});

test('hides signed-out and expired accounts even when old plan metadata is present', () => {
  for (const source of ['desktop', 'code'] as const) {
    for (const status of ['not-signed-in', 'expired'] as const) {
      assert.equal(isKimiSubscriptionVisible({ ...firstFailure, source, status }), false);
      assert.equal(isKimiSubscriptionVisible({ ...desktop, source, status, stale: true }), false);
      assert.equal(isKimiSubscriptionVisible({ ...desktop, source, status, planLabel: 'Free' }), false);
    }
  }
});

test('keeps confirmed Free metadata and custom-provider feedback visible', () => {
  assert.equal(isKimiSubscriptionVisible({ ...firstFailure, planLabel: 'Free', stale: true }), true);
  assert.equal(isKimiSubscriptionVisible({ ...firstFailure, status: 'custom-provider' }), true);
});
