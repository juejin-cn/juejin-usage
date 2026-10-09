import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { aggregateForIngest } from '../src/aggregate.js';
import { daysAgoIso } from '../src/config.js';
import { appendBuckets, loadBucketsForRange } from '../src/queue/index.js';
import {
  DEFAULT_STATS_TIMEZONE,
  localDateAndHour,
} from '../src/timezone.js';
import type { QueueBucket, TudConfig } from '../src/types.js';
import {
  applyCalibrateSelectedDates,
  buildReconcileBatches,
  calibrateWindowSinceIso,
  diffCalibrateRows,
  loadLocalCalibrateEvents,
  rollupDayDiffs,
  shanghaiDayBounds,
  summarizeCalibrateDays,
  type CalibrateEventRow,
} from '../src/upload/calibrate.js';
import type { IngestEventPayload } from '../src/upload/events.js';
import {
  commitBucketHashes,
  findUploadDelta,
  getUploadSlot,
  loadUploadStateFile,
  saveUploadStateFile,
  setUploadSlot,
} from '../src/upload/state.js';

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

test('calibrate window is the rolling 90-day online floor', () => {
  const now = Date.parse('2026-09-16T01:00:00.000Z');
  assert.equal(calibrateWindowSinceIso(now), daysAgoIso(90, now));
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

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const API_URL = 'https://example.invalid';

function configFor(dir: string): TudConfig {
  return {
    deviceId: DEVICE_ID,
    statsSince: '2026-01-01T00:00:00.000Z',
    hostname: 'test',
    dataDir: dir,
    juejin: {
      enabled: true,
      apiUrl: API_URL,
      authMode: 'tbd',
      token: 'user-token-not-device',
    },
  };
}

function recentHourIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function liveBucket(hourStart: string): QueueBucket {
  return {
    hour_start: hourStart,
    source: 'claude',
    model: 'claude-opus-4-6',
    project: '',
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 120,
    conversation_count: 1,
  };
}

function eventsResponse(events: CalibrateEventRow[]): Response {
  return Response.json({
    success: true,
    data: { events, next_cursor: null },
  });
}

function reportResponse(accepted: number, duplicate = 0): Response {
  return Response.json({
    success: true,
    data: {
      accepted_count: accepted,
      duplicate_count: duplicate,
      report_id: 'test-report',
    },
  });
}

function shiftedRows(events: CalibrateEventRow[]): CalibrateEventRow[] {
  return events.map((event) => ({
    ...event,
    occurred_at: new Date(
      Date.parse(event.occurred_at) + 8 * 60 * 60 * 1000,
    ).toISOString(),
  }));
}

test('missing events use reports with original afternoon timestamps despite shifted online timestamps', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-missing-'));
  const date = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const buckets = ['00', '08', '14'].map((hour) =>
    liveBucket(`${date}T${hour}:00:00.000Z`),
  );
  const originalFetch = globalThis.fetch;

  try {
    await appendBuckets(dir, buckets);
    const localRows = await loadLocalCalibrateEvents(
      dir, configFor(dir), DEVICE_ID, calibrateWindowSinceIso(),
    );
    const present = localRows.find((event) => event.occurred_at === buckets[0]!.hour_start)!;
    const missing = localRows.filter((event) => event.event_id !== present.event_id);
    let getCount = 0;
    let postCount = 0;
    const queryWindows: string[][] = [];

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (init?.method !== 'POST') {
        assert.equal(url.pathname, '/functions/tud-usage-device-events');
        assert.equal(url.searchParams.get('deviceId'), DEVICE_ID);
        const from = url.searchParams.get('from')!;
        const to = url.searchParams.get('to')!;
        assert.ok(Date.parse(to) - Date.parse(from) >= 89 * 24 * 60 * 60 * 1000);
        queryWindows.push([from, to]);
        getCount += 1;
        return eventsResponse(shiftedRows(getCount === 1 ? [present] : localRows));
      }
      assert.equal(url.pathname, '/v1/model-usage/reports');
      assert.equal(getCount, 1);
      postCount += 1;
      const payload = JSON.parse(String(init.body)) as {
        device_id: string;
        events: IngestEventPayload[];
      };
      assert.equal(payload.device_id, DEVICE_ID);
      assert.deepEqual(
        payload.events.map((event) => [event.event_id, event.occurred_at, event.usage]),
        missing.map((event) => [event.event_id, event.occurred_at, event.usage]),
      );
      return reportResponse(missing.length);
    }) as typeof fetch;

    const result = await applyCalibrateSelectedDates(dir, configFor(dir), [date]);
    assert.equal(postCount, 1);
    assert.equal(getCount, 2);
    assert.equal(queryWindows[1]![0], queryWindows[0]![0]);
    assert.ok(Date.parse(queryWindows[1]![1]!) >= Date.parse(queryWindows[0]![1]!));
    assert.equal(result.upserted, missing.length);
    assert.equal(result.deleted, 0);
    assert.deepEqual(
      findUploadDelta(
        aggregateForIngest(buckets),
        getUploadSlot(await loadUploadStateFile(dir), API_URL, DEVICE_ID),
      ),
      [],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('mismatched events still reconcile and report the failing date and window on 422', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-422-'));
  const hour = recentHourIso();
  const date = localDateAndHour(hour, DEFAULT_STATS_TIMEZONE).date;
  const originalFetch = globalThis.fetch;

  try {
    await appendBuckets(dir, [liveBucket(hour)]);
    const localRows = await loadLocalCalibrateEvents(
      dir, configFor(dir), DEVICE_ID, calibrateWindowSinceIso(),
    );
    let postCount = 0;
    globalThis.fetch = (async (input, init) => {
      if (init?.method !== 'POST') {
        return eventsResponse(localRows.map((event) => ({
          ...event,
          usage: { ...event.usage, input_tokens: 1 },
        })));
      }
      assert.equal(new URL(String(input)).pathname, '/v1/model-usage/reconcile');
      postCount += 1;
      return Response.json({
        success: false,
        message: 'INVALID_USAGE_EVENT',
        data: null,
      }, { status: 422 });
    }) as typeof fetch;

    await assert.rejects(
      () => applyCalibrateSelectedDates(dir, configFor(dir), [date]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith(`${date} 校准失败`));
        assert.match(err.message, /1 条事件/);
        assert.match(err.message, /窗口 .*T16:00:00\.000Z ~ .*T16:00:00\.000Z/);
        assert.match(err.message, /INVALID_USAGE_EVENT/);
        return true;
      },
    );
    assert.equal(postCount, 1);
    assert.deepEqual(await loadUploadStateFile(dir), { version: 2, remotes: {} });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('online-only events retain an empty replace-window reconcile', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-online-only-'));
  const hour = recentHourIso();
  const date = localDateAndHour(hour, DEFAULT_STATS_TIMEZONE).date;
  const originalFetch = globalThis.fetch;
  let postCount = 0;

  globalThis.fetch = (async (input, init) => {
    if (init?.method !== 'POST') {
      return eventsResponse(postCount === 0 ? [row({
        event_id: 'online-only',
        occurred_at: hour,
      })] : []);
    }
    assert.equal(new URL(String(input)).pathname, '/v1/model-usage/reconcile');
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.mode, 'replace_window');
    assert.deepEqual(payload.events, []);
    assert.deepEqual({ from: payload.from, to: payload.to }, shanghaiDayBounds(date));
    postCount += 1;
    return Response.json({
      success: true,
      data: { deleted_count: 1, upserted_count: 0, floored_count: 0, received_at: hour },
    });
  }) as typeof fetch;

  try {
    const result = await applyCalibrateSelectedDates(dir, configFor(dir), [date]);
    assert.equal(postCount, 1);
    assert.equal(result.deleted, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

for (const outcome of ['accepted', 'duplicate'] as const) {
  test(`a reports ${outcome} response cannot commit state while readback still lacks the event`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-unverified-'));
    const hour = recentHourIso();
    const date = localDateAndHour(hour, DEFAULT_STATS_TIMEZONE).date;
    const originalFetch = globalThis.fetch;
    let getCount = 0;
    let postCount = 0;

    globalThis.fetch = (async (input, init) => {
      if (init?.method !== 'POST') {
        getCount += 1;
        return eventsResponse([]);
      }
      assert.equal(new URL(String(input)).pathname, '/v1/model-usage/reports');
      postCount += 1;
      return reportResponse(outcome === 'accepted' ? 1 : 0, outcome === 'duplicate' ? 1 : 0);
    }) as typeof fetch;

    try {
      await appendBuckets(dir, [liveBucket(hour)]);
      const initialState = setUploadSlot(await loadUploadStateFile(dir), API_URL, DEVICE_ID, {
        buckets: { unrelated: 'untouched' },
        needsFullScan: true,
      });
      await saveUploadStateFile(dir, initialState);
      await assert.rejects(() => applyCalibrateSelectedDates(dir, configFor(dir), [date]));
      assert.equal(postCount, 1);
      assert.equal(getCount, 2);
      assert.deepEqual(await loadUploadStateFile(dir), initialState);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('failed online refresh makes no POST and leaves upload state untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-refresh-failed-'));
  const hour = recentHourIso();
  const date = localDateAndHour(hour, DEFAULT_STATS_TIMEZONE).date;
  const originalFetch = globalThis.fetch;
  let requests = 0;

  globalThis.fetch = (async (input, init) => {
    requests += 1;
    assert.notEqual(init?.method, 'POST');
    assert.equal(new URL(String(input)).pathname, '/functions/tud-usage-device-events');
    return new Response('unavailable', { status: 503 });
  }) as typeof fetch;

  try {
    await appendBuckets(dir, [liveBucket(hour)]);
    await assert.rejects(
      () => applyCalibrateSelectedDates(dir, configFor(dir), [date]),
      /503/,
    );
    assert.equal(requests, 1);
    assert.deepEqual(await loadUploadStateFile(dir), { version: 2, remotes: {} });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful calibration commits only its starting snapshot and preserves a pending full scan', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-snapshot-'));
  const hour = recentHourIso();
  const date = localDateAndHour(hour, DEFAULT_STATS_TIMEZONE).date;
  const bucket = liveBucket(hour);
  const originalFetch = globalThis.fetch;

  try {
    await appendBuckets(dir, [bucket]);
    const localRows = await loadLocalCalibrateEvents(
      dir, configFor(dir), DEVICE_ID, calibrateWindowSinceIso(),
    );
    const initialState = setUploadSlot(await loadUploadStateFile(dir), API_URL, DEVICE_ID, {
      buckets: {},
      needsFullScan: true,
    });
    await saveUploadStateFile(dir, initialState);
    let postCount = 0;
    globalThis.fetch = (async (input, init) => {
      if (init?.method !== 'POST') {
        return eventsResponse(postCount === 0 ? [] : localRows);
      }
      assert.equal(new URL(String(input)).pathname, '/v1/model-usage/reports');
      postCount += 1;
      await appendBuckets(dir, [{ ...bucket, input_tokens: 50, total_tokens: 70 }]);
      return reportResponse(1);
    }) as typeof fetch;

    await applyCalibrateSelectedDates(dir, configFor(dir), [date]);
    assert.equal(postCount, 1);
    const slot = getUploadSlot(await loadUploadStateFile(dir), API_URL, DEVICE_ID);
    assert.deepEqual(
      slot,
      commitBucketHashes(getUploadSlot(initialState, API_URL, DEVICE_ID), aggregateForIngest([bucket])),
    );
    assert.equal(slot.needsFullScan, true);
    const currentBuckets = aggregateForIngest(await loadBucketsForRange(dir, calibrateWindowSinceIso()));
    assert.equal(findUploadDelta(currentBuckets, slot).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('matching usage with conflicting metadata must use reconcile instead of additive reports', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-metadata-'));
  const hour = recentHourIso();
  const date = localDateAndHour(hour, DEFAULT_STATS_TIMEZONE).date;
  const originalFetch = globalThis.fetch;

  try {
    await appendBuckets(dir, [liveBucket(hour)]);
    const localRows = await loadLocalCalibrateEvents(
      dir, configFor(dir), DEVICE_ID, calibrateWindowSinceIso(),
    );
    let postCount = 0;
    globalThis.fetch = (async (input, init) => {
      if (init?.method !== 'POST') {
        return eventsResponse(postCount === 0
          ? localRows.map((event) => ({ ...event, conversations_count: event.conversations_count + 1 }))
          : localRows);
      }
      assert.equal(new URL(String(input)).pathname, '/v1/model-usage/reconcile');
      postCount += 1;
      return Response.json({
        success: true,
        data: { deleted_count: 1, upserted_count: 1, floored_count: 0, received_at: hour },
      });
    }) as typeof fetch;

    await applyCalibrateSelectedDates(dir, configFor(dir), [date]);
    assert.equal(postCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a preceding reconcile refreshes online state before deciding the next day missing events', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-multi-day-'));
  const firstDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const nextDate = new Date(Date.parse(`${firstDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const originalFetch = globalThis.fetch;

  try {
    await appendBuckets(dir, [
      liveBucket(`${firstDate}T02:00:00.000Z`),
      liveBucket(`${nextDate}T02:00:00.000Z`),
      liveBucket(`${nextDate}T03:00:00.000Z`),
    ]);
    const localRows = await loadLocalCalibrateEvents(
      dir, configFor(dir), DEVICE_ID, calibrateWindowSinceIso(),
    );
    const first = localRows.find((event) => event.occurred_at.startsWith(firstDate))!;
    const nextDay = localRows.filter((event) => event.occurred_at.startsWith(nextDate));
    let remote = [
      { ...first, usage: { ...first.usage, input_tokens: 1 } },
      nextDay[0]!,
    ];
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      calls.push(init?.method === 'POST' ? pathname : 'GET');
      if (init?.method !== 'POST') return eventsResponse(remote);
      if (pathname === '/v1/model-usage/reconcile') {
        remote = [first];
        return Response.json({
          success: true,
          data: {
            deleted_count: 2,
            upserted_count: 1,
            floored_count: 0,
            received_at: new Date().toISOString(),
          },
        });
      }
      assert.equal(pathname, '/v1/model-usage/reports');
      const payload = JSON.parse(String(init.body)) as { events: IngestEventPayload[] };
      assert.deepEqual(
        payload.events.map((event) => event.event_id),
        nextDay.map((event) => event.event_id),
      );
      remote = localRows;
      return reportResponse(nextDay.length);
    }) as typeof fetch;

    await applyCalibrateSelectedDates(dir, configFor(dir), [firstDate, nextDate]);
    assert.deepEqual(calls, [
      'GET',
      '/v1/model-usage/reconcile',
      'GET',
      '/v1/model-usage/reports',
      'GET',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a later reconcile cannot silently invalidate an earlier verified missing-event repair', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-calibrate-later-reconcile-'));
  const firstDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const nextDate = new Date(Date.parse(`${firstDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const originalFetch = globalThis.fetch;

  try {
    await appendBuckets(dir, [
      liveBucket(`${firstDate}T14:00:00.000Z`),
      liveBucket(`${nextDate}T02:00:00.000Z`),
    ]);
    const localRows = await loadLocalCalibrateEvents(
      dir, configFor(dir), DEVICE_ID, calibrateWindowSinceIso(),
    );
    const first = localRows.find((event) => event.occurred_at.startsWith(firstDate))!;
    const next = localRows.find((event) => event.occurred_at.startsWith(nextDate))!;
    const nextMismatch = { ...next, usage: { ...next.usage, input_tokens: 1 } };
    let remote = [nextMismatch];
    const posts: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (init?.method !== 'POST') return eventsResponse(remote);
      posts.push(pathname);
      if (pathname === '/v1/model-usage/reports') {
        remote = [...shiftedRows([first]), nextMismatch];
        return reportResponse(1);
      }
      assert.equal(pathname, '/v1/model-usage/reconcile');
      remote = [next];
      return Response.json({
        success: true,
        data: {
          deleted_count: 2,
          upserted_count: 1,
          floored_count: 0,
          received_at: new Date().toISOString(),
        },
      });
    }) as typeof fetch;

    await assert.rejects(
      () => applyCalibrateSelectedDates(dir, configFor(dir), [firstDate, nextDate]),
      /后续覆盖影响了已校验记录/,
    );
    assert.deepEqual(posts, ['/v1/model-usage/reports', '/v1/model-usage/reconcile']);
    assert.deepEqual(await loadUploadStateFile(dir), { version: 2, remotes: {} });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
