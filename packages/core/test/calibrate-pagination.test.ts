import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchAllDeviceEvents,
  type CalibrateEventRow,
} from '../src/upload/calibrate.js';

const API_URL = 'https://example.invalid';
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const FROM = '2026-07-27T16:00:00.000Z';
const TO = '2026-07-28T16:00:00.000Z';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

function event(index: number, timestampMs: number): CalibrateEventRow {
  return {
    event_id: `event-${String(index).padStart(4, '0')}`,
    occurred_at: new Date(timestampMs).toISOString(),
    integration: 'claude-code',
    collector: 'claude-code',
    model: 'claude-opus-4-6',
    usage: {
      input_tokens: index + 1,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
    conversations_count: 1,
    reported_cost_usd: null,
  };
}

function minuteEvents(count: number): CalibrateEventRow[] {
  return Array.from({ length: count }, (_, index) =>
    event(index, Date.parse(FROM) + index * 60 * 1000),
  );
}

/**
 * Model the observed server failure: filtering uses stored UTC timestamps,
 * but returned timestamps and cursors are shifted by eight hours.
 */
function paginatedServer(
  stored: CalibrateEventRow[],
  requests: URL[],
  metadata?: (url: URL, requestIndex: number) => Record<string, unknown>,
): typeof fetch {
  return (async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.pathname, '/functions/tud-usage-device-events');
    assert.equal(url.searchParams.get('deviceId'), DEVICE_ID);
    const from = url.searchParams.get('from')!;
    const to = url.searchParams.get('to')!;
    const cursor = url.searchParams.get('cursor');
    const [cursorTime, cursorId] = cursor?.split('|') ?? [];
    const eligible = stored.filter((record) => {
      const timestamp = Date.parse(record.occurred_at);
      if (timestamp < Date.parse(from) || timestamp >= Date.parse(to)) return false;
      if (!cursorTime) return true;
      return timestamp > Date.parse(cursorTime) || (
        timestamp === Date.parse(cursorTime) && record.event_id > cursorId!
      );
    }).sort((left, right) =>
      left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id),
    );
    const limit = Number(url.searchParams.get('limit'));
    const events = eligible.slice(0, limit).map((record) => ({
      ...record,
      occurred_at: new Date(Date.parse(record.occurred_at) + EIGHT_HOURS_MS).toISOString(),
    }));
    const last = events.at(-1);
    return Response.json({
      success: true,
      data: {
        events,
        next_cursor: eligible.length > limit && last
          ? `${last.occurred_at}|${last.event_id}`
          : null,
        from,
        to,
        ...metadata?.(url, requests.length - 1),
      },
    });
  }) as typeof fetch;
}

test('reads all 601 events despite a cursor based on shifted response timestamps', async () => {
  const stored = minuteEvents(601);
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  const rootFrom = '2026-07-27T16:00:00.001Z';
  const rootTo = '2026-07-28T15:59:59.999Z';
  const ingestMin = '2026-07-01T00:00:00.000Z';
  globalThis.fetch = paginatedServer(stored, requests, (url, requestIndex) => ({
    from: requestIndex === 0 ? rootFrom : url.searchParams.get('from'),
    to: requestIndex === 0 ? rootTo : url.searchParams.get('to'),
    ingest_min_occurred_at: requestIndex === 0 ? ingestMin : '2026-07-02T00:00:00.000Z',
  }));

  try {
    const result = await fetchAllDeviceEvents(API_URL, 'token', DEVICE_ID, FROM, TO);
    assert.equal(result.events.length, 601);
    assert.deepEqual(result.events.map((record) => record.event_id).sort(), stored.map((record) => record.event_id));
    assert.equal(new Set(result.events.map((record) => record.event_id)).size, 601);
    assert.equal(result.from, rootFrom);
    assert.equal(result.to, rootTo);
    assert.equal(result.ingestMinOccurredAt, ingestMin);
    assert.ok(requests.length > 1);
    assert.ok(requests.every((url) => !url.searchParams.has('cursor')));
    assert.equal(
      result.events.find((record) => record.event_id === stored[600]!.event_id)?.occurred_at,
      new Date(Date.parse(stored[600]!.occurred_at) + EIGHT_HOURS_MS).toISOString(),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('split windows retain the midpoint once and exclude the half-open upper bound', async () => {
  const start = Date.parse(FROM);
  const to = new Date(start + 1000).toISOString();
  const stored = [
    ...Array.from({ length: 250 }, (_, index) => event(index, start + index)),
    event(250, start + 500),
    ...Array.from({ length: 250 }, (_, index) => event(index + 251, start + 750 + index)),
    event(501, start + 1000),
  ];
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = paginatedServer(stored, requests);

  try {
    const result = await fetchAllDeviceEvents(API_URL, 'token', DEVICE_ID, FROM, to);
    assert.equal(result.events.length, 501);
    assert.deepEqual(
      result.events.map((record) => record.event_id).sort(),
      stored.slice(0, -1).map((record) => record.event_id),
    );
    assert.equal(result.events.filter((record) => record.event_id === 'event-0250').length, 1);
    assert.ok(!result.events.some((record) => record.event_id === 'event-0501'));
    assert.ok(requests.every((url) => !url.searchParams.has('cursor')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unpaginated response needs one request and preserves response metadata', async () => {
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  const resolvedFrom = '2026-07-27T18:00:00.000Z';
  const resolvedTo = '2026-07-28T14:00:00.000Z';
  const ingestMin = '2026-07-01T00:00:00.000Z';
  globalThis.fetch = paginatedServer(minuteEvents(2), requests, () => ({
    from: resolvedFrom,
    to: resolvedTo,
    ingest_min_occurred_at: ingestMin,
  }));

  try {
    const result = await fetchAllDeviceEvents(API_URL, 'token', DEVICE_ID, FROM, TO);
    assert.equal(requests.length, 1);
    assert.equal(result.events.length, 2);
    assert.equal(result.from, resolvedFrom);
    assert.equal(result.to, resolvedTo);
    assert.equal(result.ingestMinOccurredAt, ingestMin);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a one-millisecond window that still exceeds the page limit fails instead of returning a partial snapshot', async () => {
  const timestamp = Date.parse(FROM);
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = paginatedServer(
    Array.from({ length: 501 }, (_, index) => event(index, timestamp)),
    requests,
  );

  try {
    await assert.rejects(
      () => fetchAllDeviceEvents(API_URL, 'token', DEVICE_ID, FROM, new Date(timestamp + 1).toISOString()),
      /无法完整读取/,
    );
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed child-window request rejects the entire snapshot', async () => {
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  const respond = paginatedServer(minuteEvents(601), requests);
  let calls = 0;
  globalThis.fetch = (async (input, init) => {
    calls += 1;
    if (calls > 1) return new Response('unavailable', { status: 503 });
    return respond(input, init);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchAllDeviceEvents(API_URL, 'token', DEVICE_ID, FROM, TO),
      /tud-usage-device-events failed: HTTP 503/,
    );
    assert.ok(calls > 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
