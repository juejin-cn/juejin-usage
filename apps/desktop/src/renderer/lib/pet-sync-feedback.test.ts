import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPetSyncFeedback,
  countActiveStreak,
  type PetUsageSnapshot,
} from './pet-sync-feedback.js';

function snapshot(
  totalTokens: number,
  days: Array<[date: string, tokens: number]>,
): PetUsageSnapshot {
  return {
    totalTokens,
    dailyRows: days.map(([date, tokens]) => ({ date, tokens })),
  };
}

test('reports only the tokens added by the completed sync', () => {
  const feedback = buildPetSyncFeedback(
    snapshot(10_000, [['2026-09-02', 1_000]]),
    snapshot(22_800, [['2026-09-02', 13_800]]),
    '2026-09-02',
  );

  assert.equal(feedback?.addedTokens, 12_800);
});

test('does not show feedback when sync added no tokens', () => {
  const before = snapshot(10_000, [['2026-09-02', 1_000]]);
  assert.equal(buildPetSyncFeedback(before, before, '2026-09-02'), null);
});

test('celebrates only when today first crosses the previous daily high', () => {
  const historical = [
    ['2026-08-31', 8_000],
    ['2026-09-01', 10_000],
  ] as Array<[string, number]>;
  const crossing = buildPetSyncFeedback(
    snapshot(20_000, [...historical, ['2026-09-02', 9_000]]),
    snapshot(22_000, [...historical, ['2026-09-02', 11_000]]),
    '2026-09-02',
  );
  const laterSync = buildPetSyncFeedback(
    snapshot(22_000, [...historical, ['2026-09-02', 11_000]]),
    snapshot(23_000, [...historical, ['2026-09-02', 12_000]]),
    '2026-09-02',
  );

  assert.equal(crossing?.isDailyRecord, true);
  assert.equal(laterSync?.isDailyRecord, false);
});

test('equaling the previous daily high is not a new record', () => {
  const feedback = buildPetSyncFeedback(
    snapshot(20_000, [
      ['2026-09-01', 10_000],
      ['2026-09-02', 9_000],
    ]),
    snapshot(21_000, [
      ['2026-09-01', 10_000],
      ['2026-09-02', 10_000],
    ]),
    '2026-09-02',
  );

  assert.equal(feedback?.isDailyRecord, false);
});

test('does not celebrate a daily record without prior active history', () => {
  const feedback = buildPetSyncFeedback(
    snapshot(100, [['2026-09-02', 100]]),
    snapshot(200, [['2026-09-02', 200]]),
    '2026-09-02',
  );

  assert.equal(feedback?.isDailyRecord, false);
});

test('counts consecutive active days ending today', () => {
  assert.equal(countActiveStreak([
    { date: '2026-08-29', tokens: 50 },
    { date: '2026-08-30', tokens: 0 },
    { date: '2026-08-31', tokens: 100 },
    { date: '2026-09-01', tokens: 200 },
    { date: '2026-09-02', tokens: 300 },
  ], '2026-09-02'), 3);
});

test('returns a one-day streak when only today is active', () => {
  assert.equal(countActiveStreak([
    { date: '2026-09-01', tokens: 0 },
    { date: '2026-09-02', tokens: 300 },
  ], '2026-09-02'), 1);
});
