import assert from 'node:assert/strict';
import test from 'node:test';
import { syncFeedback } from './sync-feedback.ts';

test('sync feedback distinguishes local success from every cloud outcome', () => {
  const result = { ok: true, results: [], message: '' };
  assert.equal(syncFeedback({ ...result, ok: false }).variant, 'danger');
  assert.match(syncFeedback(result).title, /未确认/);
  assert.equal(syncFeedback({ ...result, cloudUpload: { status: 'uploaded' } }).variant, 'success');
  for (const status of ['failed', 'pending'] as const) {
    assert.equal(syncFeedback({ ...result, cloudUpload: { status } }).variant, 'warning');
  }
  assert.match(syncFeedback({ ...result, cloudUpload: { status: 'skipped' } }).title, /未上报/);
});
