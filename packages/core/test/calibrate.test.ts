import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReconcileBatches,
  diffCalibrateRows,
  rollupDayDiffs,
  shanghaiDayBounds,
  summarizeCalibrateDays,
  type CalibrateEventRow,
} from '../src/upload/calibrate.js';

function row(
  partial: Partial<CalibrateEventRow> &
    Pick<CalibrateEventRow, 'event_id' | 'occurred_at'>,
): CalibrateEventRow {
  return {
    integration: 'cursor',
    collector: 'cursor-composer',
    model: 'gpt-5',
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
    conversations_count: 1,
    reported_cost_usd: 1.5,
    ...partial,
  };
}

test('diffCalibrateRows classifies missing / only / mismatch including cost', () => {
  const local = [
    row({
      event_id: 'a',
      occurred_at: '2026-08-01T02:00:00.000Z',
    }),
    row({
      event_id: 'b',
      occurred_at: '2026-08-01T03:00:00.000Z',
      usage: {
        input_tokens: 20,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    }),
  ];
  const remote = [
    row({
      event_id: 'b',
      occurred_at: '2026-08-01T03:00:00.000Z',
      reported_cost_usd: 2.5,
    }),
    row({
      event_id: 'c',
      occurred_at: '2026-08-02T02:00:00.000Z',
    }),
  ];
  const diffs = diffCalibrateRows(local, remote, null);
  assert.equal(diffs.filter((d) => d.kind === 'online_missing').length, 1);
  assert.equal(diffs.filter((d) => d.kind === 'online_only').length, 1);
  assert.equal(diffs.filter((d) => d.kind === 'mismatch').length, 1);

  const days = rollupDayDiffs(diffs);
  const summary = summarizeCalibrateDays(days);
  assert.equal(summary.diffDayCount, 2);
  assert.equal(summary.onlineMissingRows, 1);
  assert.equal(summary.onlineOnlyRows, 1);
  assert.equal(summary.mismatchRows, 1);
});

test('shanghaiDayBounds uses +08:00 half-open window', () => {
  const { from, to } = shanghaiDayBounds('2026-08-01');
  assert.equal(from, '2026-07-31T16:00:00.000Z');
  assert.equal(to, '2026-08-01T16:00:00.000Z');
});

test('buildReconcileBatches emits empty events to clear online-only days', () => {
  const batches = buildReconcileBatches({
    deviceId: '550e8400-e29b-41d4-a716-446655440000',
    selectedDates: ['2026-08-01'],
    localRows: [],
  });
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]?.events, []);
  assert.equal(batches[0]?.from, '2026-07-31T16:00:00.000Z');
});
