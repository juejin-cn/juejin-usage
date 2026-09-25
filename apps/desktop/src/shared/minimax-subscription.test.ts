import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapMiniMaxAccountQuota,
  mapMiniMaxQuota,
  miniMaxPlanLabel,
  miniMaxRemainingPercent,
  miniMaxResponseAuthFailed,
} from './minimax-subscription';

test('maps MiniMax Coding Plan 5h and 7d windows and surfaces plan label', () => {
  const result = mapMiniMaxQuota({
    data: {
      plan: 'coding_plan',
      windows: [
        { type: 'TOKENS_LIMIT', windowDurationMins: 300, usedPercent: 30, nextResetTime: 1_900_000_000 },
        { type: 'TOKENS_LIMIT', windowDurationMins: 10_080, usedPercent: 0.55, nextResetTime: 1_900_086_400 },
      ],
    },
  });
  assert.equal(result.planLabel, 'Coding Plan');
  assert.deepEqual(result.limits.map((limit) => [limit.id, limit.label, limit.usedPercent, limit.resetsAt]), [
    ['five-hour', '5h', 30, 1_900_000_000],
    ['weekly', '7d', 55, 1_900_086_400],
  ]);
});

test('falls back to primary/secondary named windows when the array is missing', () => {
  const result = mapMiniMaxQuota({
    data: {
      plan: 'plus',
      primary: { usedPercent: 12, windowDurationMins: 300, nextResetTime: 1_900_000_000 },
      secondary: { usedPercent: 0.81, windowDurationMins: 10_080, nextResetTime: 1_900_086_400 },
    },
  });
  assert.equal(result.planLabel, 'Plus');
  assert.deepEqual(result.limits.map((limit) => limit.id), ['five-hour', 'weekly']);
  assert.equal(result.limits[1].usedPercent, 81);
});

test('drops unknown MiniMax windows and returns no quota', () => {
  const result = mapMiniMaxQuota({ data: { windows: [{ usedPercent: 50 }] } });
  assert.deepEqual(result.limits, []);
});

test('returns empty snapshot for missing data envelope', () => {
  assert.deepEqual(mapMiniMaxQuota(null), { planLabel: null, limits: [] });
});

test('normalizes MiniMax plan labels and keeps unknown values verbatim', () => {
  assert.equal(miniMaxPlanLabel('coding_plan'), 'Coding Plan');
  assert.equal(miniMaxPlanLabel('STARTER'), 'Starter');
  assert.equal(miniMaxPlanLabel('Custom-Tier-X'), 'Custom-Tier-X');
  assert.equal(miniMaxPlanLabel(null), null);
});

test('clamps MiniMax remaining percentage to [0, 100]', () => {
  assert.equal(miniMaxRemainingPercent(0), 100);
  assert.equal(miniMaxRemainingPercent(70), 30);
  assert.equal(miniMaxRemainingPercent(150), 0);
  assert.equal(miniMaxRemainingPercent(Number.NaN), 0);
});

test('maps mcode account API membership and remains_percent windows', () => {
  const result = mapMiniMaxAccountQuota(
    { has_token_plan: true, token_plan_tier: 'Max Plan', plan_name: '' },
    {
      model_remains: [
        {
          model_name: 'general',
          end_time: 1_790_251_200_000,
          weekly_end_time: 1_790_524_800_000,
          current_interval_used_percent: '1%',
          current_interval_status: 1,
          current_weekly_used_percent: '4%',
        },
      ],
    },
  );
  assert.equal(result.planLabel, 'Max');
  assert.deepEqual(result.limits.map((limit) => [limit.id, limit.label, limit.usedPercent, limit.resetsAt]), [
    ['five-hour', '5h', 1, 1_790_251_200],
    ['weekly', '7d', 4, 1_790_524_800],
  ]);
});

test('renders unlimited account intervals as a fresh window', () => {
  const result = mapMiniMaxAccountQuota(null, {
    model_remains: [
      {
        model_name: 'general',
        end_time: 1_790_251_200_000,
        current_interval_status: 3,
        current_interval_used_percent: '100%',
      },
    ],
  });
  assert.equal(result.planLabel, null);
  assert.deepEqual(result.limits.map((limit) => [limit.id, limit.usedPercent]), [['five-hour', 0]]);
});

test('returns no account quota when remains windows are missing', () => {
  assert.deepEqual(mapMiniMaxAccountQuota({ token_plan_tier: 'Max Plan' }, { model_remains: [] }), {
    planLabel: 'Max',
    limits: [],
  });
});

test('detects account API auth failures wrapped in HTTP 200 bodies', () => {
  assert.equal(miniMaxResponseAuthFailed({ base_resp: { status_code: 1004, status_msg: 'login fail' } }), true);
  assert.equal(miniMaxResponseAuthFailed({ base_resp: { status_code: 0 } }), false);
  assert.equal(miniMaxResponseAuthFailed(null), false);
});
