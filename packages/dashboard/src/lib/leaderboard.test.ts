import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { uniqueRankModelOptions, isRankRange } from './leaderboard.ts';

describe('isRankRange', () => {
  it('accepts the four leaderboard ranges', () => {
    assert.equal(isRankRange('today'), true);
    assert.equal(isRankRange('week'), true);
    assert.equal(isRankRange('month'), true);
    assert.equal(isRankRange('all'), true);
  });

  it('rejects unknown values', () => {
    assert.equal(isRankRange('last-7-days'), false);
    assert.equal(isRankRange(''), false);
    assert.equal(isRankRange(1), false);
  });
});

describe('uniqueRankModelOptions', () => {
  const options = [
    { tool: 'cursor', model: 'claude-sonnet-4-6' },
    { tool: 'cursor', model: 'gpt-5' },
    { tool: 'claude-code', model: 'claude-sonnet-4-6' },
    { tool: 'claude-code', model: 'claude-opus-4' },
  ];

  it('deduplicates models when all tools are selected', () => {
    assert.deepEqual(uniqueRankModelOptions(options), [
      { tool: 'cursor', model: 'claude-sonnet-4-6' },
      { tool: 'cursor', model: 'gpt-5' },
      { tool: 'claude-code', model: 'claude-opus-4' },
    ]);
  });

  it('filters by tool before deduplicating', () => {
    assert.deepEqual(uniqueRankModelOptions(options, 'claude-code'), [
      { tool: 'claude-code', model: 'claude-sonnet-4-6' },
      { tool: 'claude-code', model: 'claude-opus-4' },
    ]);
  });

  it('ignores empty model ids', () => {
    assert.deepEqual(
      uniqueRankModelOptions([
        { tool: 'cursor', model: '' },
        { tool: 'cursor', model: 'gpt-5' },
      ]),
      [{ tool: 'cursor', model: 'gpt-5' }],
    );
  });
});
