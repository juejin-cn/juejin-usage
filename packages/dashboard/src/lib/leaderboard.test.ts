import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatRankPosition,
  groupRankModelsByVendor,
  uniqueRankModelOptions,
  isRankRange,
  pinCurrentUserRows,
  rankShareFallbackLabel,
  resolveLeaderboardCurrentUser,
  resolveRankShareViewer,
} from './leaderboard.ts';
import type { LeaderboardRow } from './api.ts';

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

describe('groupRankModelsByVendor', () => {
  const models = [
    'claude-sonnet-4-6',
    'Claude Haiku 4.5',
    'fable-5-thinking-max',
    'openai/gpt-5',
    'gemini-2.5-pro',
    'qwen3-coder',
    'kimi-k2.5',
    'K2.7 Code',
    'k3-256k',
    'doubao-seed-2.1-turbo',
    'MiniMax-M3',
    'grok-4',
    'deepseek-chat',
    'glm-5',
    'zai_auto',
    'mistral-large',
    'meta-llama/llama-4',
    'local/custom-model',
  ];

  it('groups models in the product-defined vendor order', () => {
    assert.deepEqual(
      groupRankModelsByVendor(models).map(({ key, models: groupedModels }) => ({
        key,
        models: groupedModels,
      })),
      [
        {
          key: 'anthropic',
          models: ['Claude Haiku 4.5', 'claude-sonnet-4-6', 'fable-5-thinking-max'],
        },
        { key: 'openai', models: ['openai/gpt-5'] },
        { key: 'google', models: ['gemini-2.5-pro'] },
        { key: 'alibaba', models: ['qwen3-coder'] },
        { key: 'moonshot', models: ['K2.7 Code', 'k3-256k', 'kimi-k2.5'] },
        { key: 'doubao', models: ['doubao-seed-2.1-turbo'] },
        { key: 'minimax', models: ['MiniMax-M3'] },
        { key: 'xai', models: ['grok-4'] },
        { key: 'deepseek', models: ['deepseek-chat'] },
        { key: 'zhipu', models: ['glm-5', 'zai_auto'] },
        { key: 'meta', models: ['meta-llama/llama-4'] },
        { key: 'mistral', models: ['mistral-large'] },
        { key: 'other', models: ['local/custom-model'] },
      ],
    );
  });

  it('matches a vendor name and keeps all models in that vendor', () => {
    assert.deepEqual(
      groupRankModelsByVendor(models, 'Anthro').map((group) => group.models),
      [['Claude Haiku 4.5', 'claude-sonnet-4-6', 'fable-5-thinking-max']],
    );
  });

  it('matches model names case-insensitively together with their vendor', () => {
    assert.deepEqual(
      groupRankModelsByVendor(models, 'GPT').map((group) => group.models),
      [['openai/gpt-5']],
    );
  });

  it('merges provider aliases and exposes the icon metadata used by ModelProviderIcon', () => {
    assert.deepEqual(
      groupRankModelsByVendor(['kimi-k2.5', 'moonshot/k3'])[0],
      {
        key: 'moonshot',
        label: 'Moonshot',
        icon: 'moonshot',
        models: ['kimi-k2.5', 'moonshot/k3'],
      },
    );
  });

  it('sorts non-priority vendors by label and always keeps Other last', () => {
    assert.deepEqual(
      groupRankModelsByVendor(['mistral-large', 'meta-llama/llama-4']).map(
        (group) => group.label,
      ),
      ['Meta', 'Mistral', '其他'],
    );
  });

  it('keeps Other as an empty fallback vendor when all models are recognized', () => {
    assert.deepEqual(groupRankModelsByVendor(['gpt-5']).at(-1), {
      key: 'other',
      label: '其他',
      icon: 'unknown',
      models: [],
    });
  });

  it('deduplicates repeated model names', () => {
    assert.deepEqual(
      groupRankModelsByVendor(['gpt-5', 'gpt-5'])[0]?.models,
      ['gpt-5'],
    );
  });
});

describe('formatRankPosition', () => {
  it('returns an em dash for missing ranks', () => {
    assert.equal(formatRankPosition(null), '—');
    assert.equal(formatRankPosition(undefined), '—');
    assert.equal(formatRankPosition(0), '—');
    assert.equal(formatRankPosition(-1), '—');
  });

  it('shows the actual rank including values above 99', () => {
    assert.equal(formatRankPosition(1), '1');
    assert.equal(formatRankPosition(99), '99');
    assert.equal(formatRankPosition(100), '100');
    assert.equal(formatRankPosition(237), '237');
  });
});

function sampleRow(
  userHash: string,
  rank: number,
  isCurrentUser = false,
): LeaderboardRow {
  return {
    rank,
    displayName: `用户 ${userHash}`,
    userHash,
    tokens: 1_000 - rank,
    costUsd: 1,
    isCurrentUser,
  };
}

describe('pinCurrentUserRows', () => {
  it('returns rows unchanged without a current user', () => {
    const top = sampleRow('aaa', 1);
    assert.deepEqual(pinCurrentUserRows([top], null), [
      { pinned: false, row: top },
    ]);
  });

  it('pins the current user above the existing rows', () => {
    const top = sampleRow('aaa', 1);
    const me = sampleRow('me', 2, true);
    const result = pinCurrentUserRows([top, me], me);

    assert.deepEqual(
      result.map((item) => ({
        pinned: item.pinned,
        userHash: item.row.userHash,
      })),
      [
        { pinned: true, userHash: 'me' },
        { pinned: false, userHash: 'aaa' },
        { pinned: false, userHash: 'me' },
      ],
    );
  });
});

describe('resolveLeaderboardCurrentUser', () => {
  it('prefers the currentUser field over matching rows', () => {
    const listed = sampleRow('me', 4, true);
    const currentUser = sampleRow('me', 137, true);
    assert.equal(
      resolveLeaderboardCurrentUser({ currentUser, rows: [listed] }),
      currentUser,
    );
  });

  it('falls back to the in-list current-user row', () => {
    const listed = sampleRow('me', 4, true);
    assert.equal(
      resolveLeaderboardCurrentUser({ currentUser: null, rows: [listed] }),
      listed,
    );
  });
});

describe('resolveRankShareViewer', () => {
  it('uses 100+ copy for signed-in users who are off the board', () => {
    const viewer = resolveRankShareViewer(
      { currentUser: null, rows: [sampleRow('aaa', 1)] },
      { isSignedIn: true },
    );
    assert.deepEqual(viewer, { kind: 'off_board' });
    assert.equal(rankShareFallbackLabel('off_board'), '100+名');
  });

  it('keeps the login hint for anonymous viewers', () => {
    const viewer = resolveRankShareViewer(
      { currentUser: null, rows: [sampleRow('aaa', 1)] },
      { isSignedIn: false },
    );
    assert.deepEqual(viewer, { kind: 'anonymous' });
    assert.equal(rankShareFallbackLabel('anonymous'), '登录后查看');
  });

  it('omits personal rank when the viewer hid themselves', () => {
    const me = sampleRow('me', 137, true);
    const viewer = resolveRankShareViewer(
      { currentUser: me, rows: [] },
      { hideFromLeaderboard: true, isSignedIn: true },
    );
    assert.deepEqual(viewer, { kind: 'hidden' });
  });
});
