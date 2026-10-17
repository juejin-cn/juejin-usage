import assert from 'node:assert/strict';
import test from 'node:test';
import { geminiProgressMetrics, miniMaxResetDetails, miniMaxProgressMetrics, qoderExpiryDetails, qoderProgressMetrics } from './subscription-progress.ts';
import { subscriptionAbsoluteTime } from './subscription-details.ts';

import type { AntigravitySubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/antigravity-subscription';
import type { QoderSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/qoder-subscription';
import type { MiniMaxSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/minimax-subscription';

const fetchedAt = 1_900_000_000;
const after = (hours: number) => fetchedAt + Math.round(hours * 3600);
const base = { status: 'ready' as const, fetchedAt, stale: false, message: null };
const snapshots: {
  antigravity: AntigravitySubscriptionSnapshot;
  qoder: QoderSubscriptionSnapshot;
  minimax: MiniMaxSubscriptionSnapshot;
} = {
    antigravity: {
      ...base, planLabel: 'Pro', limits: [
        { id: 'gemini-pro', label: 'Gemini 3 Pro', usedPercent: 18, resetsAt: after(4) },
        { id: 'gemini-flash', label: 'Gemini 3 Flash', usedPercent: 35, resetsAt: after(4) },
        { id: 'claude-sonnet', label: 'Claude Sonnet', usedPercent: 64, resetsAt: after(5) },
        { id: 'claude-opus', label: 'Claude Opus', usedPercent: 92, resetsAt: after(6) },
        { id: 'gemini-exhausted', label: 'Gemini Pro', usedPercent: 100, resetsAt: after(8) },
      ],
    },
    qoder: {
      ...base, planLabel: 'Pro', stale: true, fetchedAt: after(-0.5),
      message: null, limits: [
        { id: 'plan', label: 'Credits', usedPercent: 24, resetsAt: after(20 * 24), amounts: { total: 2000, used: 480, remaining: 1520, unit: 'Credits' } },
        { id: 'add-on', label: 'Add-on', usedPercent: 60, resetsAt: after(20 * 24), amounts: { total: 500, used: 300, remaining: 200, unit: 'Credits' } },
        { id: 'shared', label: 'Shared Credits', usedPercent: 38, resetsAt: after(20 * 24), amounts: { total: 10000, used: 3800, remaining: 6200, unit: 'Credits' } },
        { id: 'dedicated-0', label: 'Dedicated Credits', usedPercent: 85, resetsAt: after(20 * 24), amounts: { total: 1000, used: 850, remaining: 150, unit: 'Credits' } },
      ],
    },
    minimax: {
      ...base, planLabel: 'Max', region: 'mainland', limits: [
        { id: 'five-hour', label: '5h', modelName: 'general', usedPercent: 21, resetsAt: after(3) },
        { id: 'weekly', label: '7d', modelName: 'general', usedPercent: 59, resetsAt: after(4 * 24) },
      ], modelLimits: [
        { id: 'five-hour', label: '5h', modelName: 'general', usedPercent: 21, resetsAt: after(3) },
        { id: 'weekly', label: '7d', modelName: 'general', usedPercent: 59, resetsAt: after(4 * 24) },
        { id: 'five-hour', label: '5h', modelName: 'image', usedPercent: 40, resetsAt: after(3), amounts: { total: 50, used: 20, remaining: 30, unit: '次' } },
        { id: 'weekly', label: '7d', modelName: 'image', usedPercent: 90, resetsAt: after(4 * 24), amounts: { total: 200, used: 180, remaining: 20, unit: '次' } },
        { id: 'five-hour', label: '5h', modelName: 'video', usedPercent: 0, unlimited: true, resetsAt: after(3) },
        { id: 'weekly', label: '7d', modelName: 'video', usedPercent: 100, resetsAt: after(4 * 24) },
      ],
    },
};

test('Gemini shows every model, including exhausted pools, with its own reset time', () => {
  const metrics = geminiProgressMetrics(snapshots.antigravity);
  assert.equal(metrics.length, 5);
  assert.equal(metrics.at(-1)?.remainingPercent, 0);
  assert.deepEqual(metrics.map((metric) => metric.resetsAt), snapshots.antigravity.limits.map((limit) => limit.resetsAt));
  assert.equal(new Set(metrics.map((metric) => metric.poolKey)).size, metrics.length);
});
test('Qoder shows all reported pools with remaining percentages', () => {
  const metrics = qoderProgressMetrics(snapshots.qoder);
  assert.deepEqual(metrics.map((metric) => metric.label), ['Credits', 'Add-on', 'Shared Credits', 'Dedicated Credits']);
  assert.deepEqual(metrics.map((metric) => metric.remainingPercent), [76, 40, 62, 15]);
  assert.deepEqual(metrics.map((metric) => metric.valueText), [
    '剩余 1,520 / 2,000 Credits', undefined,
    '剩余 6,200 / 10,000 Credits', '剩余 150 / 1,000 Credits',
  ]);
  assert.ok(metrics.every((metric) => !('valueTag' in metric)));
  assert.equal(new Set(metrics.map((metric) => metric.poolKey)).size, metrics.length);
  assert.deepEqual(metrics.map((metric) => metric.poolKey), qoderProgressMetrics({ ...snapshots.qoder, stale: false }).map((metric) => metric.poolKey));
});
test('Qoder displays a percentage for zero capacity without hiding its add-on balance', () => {
  const metrics = qoderProgressMetrics({ ...snapshots.qoder, limits: [
    { id: 'plan', label: 'Credits', usedPercent: 0, resetsAt: null, amounts: { total: 0, used: 0, remaining: 0, unit: 'Credits' } },
    { id: 'add-on', label: 'Add-on Credits', usedPercent: 0, resetsAt: null, amounts: { total: 200, used: 100, remaining: 100, unit: 'Credits' } },
  ] });

  assert.deepEqual(metrics.map((metric) => metric.remainingPercent), [0, 50]);
  assert.deepEqual(metrics.map((metric) => metric.valueText), [undefined, undefined]);
});
test('Qoder Add-on always displays a percentage for full, partial and exhausted credits', () => {
  for (const [remaining, expectedPercent] of [[800, 100], [200, 25], [0, 0]]) {
    const [metric] = qoderProgressMetrics({ ...snapshots.qoder, limits: [
      { id: 'add-on', label: 'Add-on Credits', usedPercent: 0, resetsAt: null,
        amounts: { total: 800, used: 800 - remaining, remaining, unit: 'credit' } },
    ] });
    assert.equal(metric.label, 'Add-on');
    assert.equal(metric.valueText, undefined);
    assert.equal(metric.remainingPercent, expectedPercent);
  }
});
test('Qoder zero-capacity Add-on displays 0% and remains visible', () => {
  const metrics = qoderProgressMetrics({ ...snapshots.qoder, limits: [
    { id: 'add-on', label: 'Add-on Credits', usedPercent: 0, resetsAt: null, amounts: { total: 0, used: 0, remaining: 0, unit: 'Credits' } },
  ] });

  assert.equal(metrics[0].label, 'Add-on');
  assert.equal(metrics[0].valueText, undefined);
  assert.equal(metrics[0].remainingPercent, 0);
  assert.deepEqual(selectProgressMetrics(metrics, true, null), metrics);
});
test('Qoder derives known remaining amounts without inventing counters from percentages', () => {
  const metrics = qoderProgressMetrics({ ...snapshots.qoder, limits: [
    { id: 'plan', label: 'Credits', usedPercent: 0, resetsAt: null, amounts: { total: 200, used: 99.75, unit: 'Credits' } },
    { id: 'add-on', label: 'Add-on Credits', usedPercent: 50, resetsAt: null },
  ] });

  assert.equal(metrics[0].valueText, '剩余 100.25 / 200 Credits');
  assert.equal(metrics[1].valueText, undefined);
  assert.equal(metrics[1].remainingPercent, 50);
});
test('Qoder keeps one main-plan expiry and falls back to the earliest known expiry', () => {
  const snapshot = snapshots.qoder;
  const limits = snapshot.limits.map((limit, index) => ({ ...limit, resetsAt: 1_900_000_000 + index * 1000 }));
  limits[0].resetsAt = 1_900_010_000;
  assert.deepEqual(qoderExpiryDetails({ ...snapshot, limits }), [{ label: '套餐到期时间', value: subscriptionAbsoluteTime(limits[0].resetsAt)! }]);
  assert.deepEqual(qoderExpiryDetails({ ...snapshot, limits: limits.slice(1) }), [{ label: '最近到期时间', value: subscriptionAbsoluteTime(limits[1].resetsAt)! }]);
  assert.deepEqual(qoderExpiryDetails({ ...snapshot, limits: limits.slice(2) }), [{ label: '最近到期时间', value: subscriptionAbsoluteTime(limits[2].resetsAt)! }]);
  assert.deepEqual(qoderExpiryDetails({ ...snapshot, limits: limits.map((limit) => ({ ...limit, resetsAt: null })) }), []);
});
test('MiniMax shows media percentages and omits the video five-hour pool', () => {
  const metrics = miniMaxProgressMetrics(snapshots.minimax);
  assert.equal(metrics.length, 5);
  assert.deepEqual(metrics.map((metric) => metric.group), [undefined, undefined, 'image', 'image', 'video']);
  assert.deepEqual(metrics.map((metric) => metric.label), ['5h', '7d', '5h', '7d', '7d']);
  assert.deepEqual(metrics.slice(2).map((metric) => metric.remainingPercent), [60, 10, 0]);
  assert.ok(metrics.every((metric) => !('valueText' in metric) && !('valueTag' in metric)));
  assert.equal(new Set(metrics.map((metric) => metric.poolKey)).size, 5);
});
test('media percentages preserve zero and fall back to reported usage without totals', () => {
  const snapshot = snapshots.minimax;
  const limit = snapshot.modelLimits!.find((limit) => limit.modelName === 'image')!;
  const metrics = miniMaxProgressMetrics({ ...snapshot, modelLimits: [
    { ...limit, amounts: { remaining: 0, total: 50, unit: '次' } },
    { ...limit, id: 'weekly', label: '7d', amounts: { remaining: 10, unit: '次' } },
  ] });
  assert.equal(metrics[0].remainingPercent, 0);
  assert.equal(metrics[1].remainingPercent, 100 - limit.usedPercent);
  const fallback = miniMaxProgressMetrics({ ...snapshot, modelLimits: undefined });
  assert.equal(fallback.length, snapshot.limits.length);
});

import { selectProgressMetrics } from './subscription-progress.ts';

test('Gemini previews the first three valid models and expands to every model', () => {
  const metrics = geminiProgressMetrics(snapshots.antigravity);
  assert.deepEqual(selectProgressMetrics(metrics, true, 3, true), metrics.slice(0, 3));
  assert.deepEqual(selectProgressMetrics(metrics, false, 3, true), metrics);
  assert.deepEqual(selectProgressMetrics(metrics, true, 3, true), metrics.slice(0, 3));
});
test('MiniMax previews only text pools and expands image/video cycles with distinct identities', () => {
  const metrics = miniMaxProgressMetrics(snapshots.minimax);
  const preview = selectProgressMetrics(metrics, true, null, true);
  assert.equal(preview.length, 2);
  assert.ok(preview.every((metric) => !metric.group && !metric.collapsedHidden));
  assert.equal(selectProgressMetrics(metrics, false, null, true).length, 5);
  const media = metrics.filter((metric) => metric.group);
  assert.equal(new Set(media.map((metric) => metric.poolKey)).size, 3);
});
test('previews count valid readings and retain the usual cap for non-expandable cards', () => {
  const metrics = [{ remainingPercent: null }, { remainingPercent: NaN }, ...[0, 20, 40, 60].map((remainingPercent) => ({ remainingPercent }))];
  assert.equal(selectProgressMetrics(metrics, true, 3, true).length, 3);
  assert.equal(selectProgressMetrics(metrics, false, 3, true).length, 4);
  assert.equal(selectProgressMetrics(metrics, false).length, 3);
  assert.equal(selectProgressMetrics(metrics, true, null).length, 4);
});

test('MiniMax uses concise media reset labels and preserves distinct cycle dates', () => {
  const rows = miniMaxResetDetails(snapshots.minimax);
  assert.deepEqual(rows.map((row) => row.label), ['会话重置时间', '每周重置时间', '图片重置', '视频重置']);
  assert.match(rows[2].value, /^5h：.*；7d：/);
  const limits = snapshots.minimax.modelLimits!.map((limit) => ({ ...limit, resetsAt: 1900000000 }));
  const sameTime = miniMaxResetDetails({ ...snapshots.minimax, modelLimits: limits });
  assert.equal(sameTime.find((row) => row.label === '图片重置')?.value, subscriptionAbsoluteTime(1900000000));
  assert.equal(miniMaxResetDetails({ ...snapshots.minimax, limits: [], modelLimits: [] }).length, 0);
});
