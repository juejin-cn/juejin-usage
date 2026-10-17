import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenedSubscriptionDetails, subscriptionAbsoluteTime, subscriptionDetails, subscriptionPercentageTone, subscriptionPoolKey } from './subscription-details.ts';

const base = { planLabel: null, fetchedAt: null, stale: false, message: null };

test('detail view distinguishes expiry from fetch time and hides absent counts', () => {
  const sections = subscriptionDetails({ ...base, fetchedAt: 1800000000, limits: [{ label: 'Credits', usedPercent: 70, resetsAt: 1900000000 }] }, 'Qoder', '到期时间');
  assert.deepEqual(sections[0].rows.map((row) => row.label), ['剩余额度', '到期时间']);
  assert.equal(sections[0].rows[0].tone, 'warning');
  assert.equal(sections[0].rows[1].value, subscriptionAbsoluteTime(1900000000));
  assert.equal(sections.some((section) => section.kind === 'metadata'), false);
});

test('balance detail never renders a quota percentage or fake quota denominator', () => {
  const sections = subscriptionDetails({ ...base, limits: [{ label: 'CNY', remaining: 0, usedPercent: 0, granted: 0, toppedUp: 0, available: false }] }, 'DeepSeek');
  assert.deepEqual(sections[0].rows.map((row) => row.value), ['¥0.00', '¥0.00', '¥0.00', '不可用']);
  assert.equal(JSON.stringify(sections).includes('%'), false);
});

test('unlimited/exhausted quotas show explicit status while model lists remain complete', () => {
  const sections = subscriptionDetails({ ...base, modelLimits: [
    { label: '5h', modelName: 'Video', unlimited: true, usedPercent: 0 },
    { label: '7d', modelName: 'Image', exhausted: true, remainingPercent: 100 },
  ] }, 'MiniMax');
  assert.equal(sections[0].title, 'Video · 5h');
  assert.deepEqual(sections[0].rows, [{ label: '额度状态', value: '无限' }]);
  assert.deepEqual(sections[1].rows, [{ label: '额度状态', value: '已用尽', tone: 'muted' }]);
});

test('independent Kimi sources keep their quota pools and omit source metadata', () => {
  const desktop = subscriptionDetails({ ...base, planLabel: 'Plus', limits: [{ label: '订阅额度', usedPercent: 10 }] }, 'Kimi Desktop', '到期时间');
  const code = subscriptionDetails({ ...base, planLabel: 'Pro', stale: true, message: '缓存读数', limits: [{ label: '5h', usedPercent: 80 }] }, 'Kimi Code');
  assert.equal(desktop[0].rows[0].value, '90%');
  assert.equal(code[0].rows[0].value, '20%');
  assert.equal(desktop.length, 1);
  assert.equal(code.length, 1);
  assert.equal(JSON.stringify([...desktop, ...code]).includes('数据来源'), false);
});

test('unknown units stay unspecified and semantic color boundaries match the summary', () => {
  const sections = subscriptionDetails({ ...base, limits: [{ label: '额度', amounts: { total: 100, remaining: 0 } }] }, 'Copilot');
  assert.deepEqual(sections[0].rows, [{ label: '用量', tag: '已用', value: '100/100' }]);
  assert.deepEqual([0, 1, 20, 21, 50, 51, 100].map(subscriptionPercentageTone), ['muted', 'danger', 'danger', 'warning', 'warning', 'success', 'success']);
  for (const timestamp of [null, undefined, NaN, Infinity, -1, 0]) assert.equal(subscriptionAbsoluteTime(timestamp), null);
});

test('Cursor detail labels match Auto/API/Grok Bot and keep the bot reset distinct from billing', () => {
  const sections = subscriptionDetails({ ...base,
    cursorModels: { usedPercent: 20, resetsAt: 1900000000 },
    otherModels: { usedPercent: 40, resetsAt: 1900000000 },
    grokBot: { usedPercent: 70, resetsAt: 1800000000 },
  }, 'Cursor Dashboard', '账期结束');
  assert.deepEqual(sections.slice(0, 3).map(({ title }) => title), ['Auto', 'API', 'Grok Bot']);
  assert.ok(sections[0].rows.some(({ label }) => label === '账期结束'));
  assert.ok(sections[2].rows.some(({ label }) => label === '重置时间'));
  assert.ok(!sections[2].rows.some(({ label }) => label === '账期结束'));
});

test('flat details remove summary percentages and preserve hidden MCP allowance', () => {
  const sections = subscriptionDetails({ ...base, limits: [
    { label: '5h', usedPercent: 20, resetsAt: 1900000000 },
    { label: '7d', usedPercent: 60, resetsAt: 1900000000 },
    { label: 'MCP', usedPercent: 88, resetsAt: 1900000000 },
  ] }, 'ZCode');
  const rows = flattenedSubscriptionDetails(sections, sections.filter((section) => ['5h', '7d'].includes(section.title)).map((section) => ({ poolKey: section.poolKey, label: section.title })));
  assert.deepEqual(rows.map((row) => row.label), ['会话重置时间', '每周重置时间', 'MCP 剩余额度', 'MCP 重置时间']);
  assert.equal(rows[2].value, '12%');
});
test('flat details preserve model names, absolute amounts and expiry semantics', () => {
  const sections = subscriptionDetails({ ...base, limits: [
    { label: 'Video', amounts: { remaining: 10, unit: '次' }, resetsAt: 1900000000 },
    { label: 'Image', unlimited: true },
  ] }, 'MiniMax', '到期时间');
  const rows = flattenedSubscriptionDetails(sections, [{ poolKey: sections[0].poolKey, label: 'Video' }]);
  assert.deepEqual(rows.map((row) => row.label), ['Video', 'Video 到期时间', 'Image 额度状态']);
  assert.equal(rows[0].value, '10 次');
});

test('count quotas combine usage and total with their unit, without duplicate percentages', () => {
  const sections = subscriptionDetails({ ...base, limits: [{ label: 'MCP', usedPercent: 20, amounts: { used: 200, total: 1000, remaining: 800, unit: '次' } }] }, 'ZCode');
  assert.deepEqual(flattenedSubscriptionDetails(sections, []), [{ label: 'MCP', tag: '已用', value: '200/1,000 次' }]);
});
test('subscription quotas retain percentages and do not duplicate internal absolute values', () => {
  const sections = subscriptionDetails({ ...base, limits: [{ label: '5h', usedPercent: 20, amounts: { total: 1000, remaining: 800 } }] }, 'Kimi');
  assert.deepEqual(sections[0].rows, [{ label: '剩余额度', value: '80%', tone: 'success' }]);
});
test('combined usage derives from reported counts and preserves zero without inventing totals', () => {
  const rows = (amounts: { total?: number; used?: number; remaining?: number; unit?: string }) => subscriptionDetails({ ...base, limits: [{ label: 'MCP', amounts }] }, 'ZCode')[0]?.rows;
  assert.deepEqual(rows({ total: 1000, remaining: 800, unit: '次' }), [{ label: '用量', tag: '已用', value: '200/1,000 次' }]);
  assert.deepEqual(rows({ total: 1000, used: 0, unit: '次' }), [{ label: '用量', tag: '已用', value: '0/1,000 次' }]);
  assert.deepEqual(rows({ used: 200, unit: '次' }), [{ label: '用量', tag: '已用', value: '200 次' }]);
  assert.equal(rows({ total: 1000, unit: '次' }), undefined);
});

test('displayed 5h and 7d pools keep only reset or expiry dates in details', () => {
  const sections = subscriptionDetails({ ...base, limits: [
    { label: '5h', startsAt: 1800000000, resetsAt: 1900000000, amounts: { total: 1000, used: 200, unit: '次' } },
    { label: '7d', startsAt: 1800000000, expiresAt: 1900000000, usedPercent: 20 },
    { label: 'MCP', amounts: { total: 1000, used: 200, unit: '次' } },
  ] }, 'ZCode');
  assert.equal(JSON.stringify(sections).includes('周期开始'), false);
  const rows = flattenedSubscriptionDetails(sections, sections.filter((section) => ['5h', '7d'].includes(section.title)).map((section) => ({ poolKey: section.poolKey, label: section.title })));
  assert.deepEqual(rows.map((row) => row.label), ['会话重置时间', '每周到期时间', 'MCP']);
  assert.equal(rows[2].value, '200/1,000 次');
  assert.ok(flattenedSubscriptionDetails(sections, []).some((row) => row.tag === '已用' && row.label === '5h'));
});

test('pool identity ignores summary aliases but distinguishes sources and models', () => {
  const limit = { id: 'five-hour', label: '5h', usedPercent: 20, resetsAt: 1900000000 };
  const code = subscriptionDetails({ ...base, limits: [limit] }, 'Kimi Code').map((section) => ({ ...section, title: `Code · ${section.title}` }));
  const desktop = subscriptionDetails({ ...base, limits: [limit] }, 'Kimi Desktop').map((section) => ({ ...section, title: `Desktop · ${section.title}` }));
  const rows = flattenedSubscriptionDetails([...code, ...desktop], [{ label: '5h', poolKey: subscriptionPoolKey('Kimi Code', limit) }]);
  assert.deepEqual(rows.map((row) => row.label), ['Code · 5h 重置时间', 'Desktop · 5h 剩余额度', 'Desktop · 5h 重置时间']);
  const models = subscriptionDetails({ ...base, modelLimits: [{ ...limit, modelName: 'general' }, { ...limit, modelName: 'image', amounts: { used: 20, total: 50, unit: '次' } }] }, 'MiniMax');
  const modelRows = flattenedSubscriptionDetails(models, [{ label: '5h', poolKey: subscriptionPoolKey('MiniMax', { ...limit, modelName: 'general' }) }]);
  assert.deepEqual(modelRows.map((row) => row.label), ['general · 5h 重置时间', 'image · 5h', 'image · 5h 重置时间']);
});
test('balance summary removes only the duplicated total, preserving zero and failures', () => {
  const limit = { id: 'balance-cny', label: 'CNY 余额', remaining: 0, granted: 0, toppedUp: 0, available: true };
  const summary = [{ label: '余额', poolKey: subscriptionPoolKey('DeepSeek', limit), hideProgress: true, valueText: '¥0.00' }];
  const rows = flattenedSubscriptionDetails(subscriptionDetails({ ...base, limits: [limit] }, 'DeepSeek'), summary);
  assert.deepEqual(rows.map((row) => row.label), ['赠送余额', '充值余额']);
  assert.ok(rows.every((row) => row.value === '¥0.00'));
  assert.ok(flattenedSubscriptionDetails(subscriptionDetails({ ...base, limits: [{ ...limit, available: false }] }, 'DeepSeek'), summary).some((row) => row.value === '不可用'));
});
test('dates deduplicate within a pool and semantic meaning, not across independent pools', () => {
  const limit = { id: 'plan', label: 'Plan', resetsAt: 1900000000, expiresAt: 1900000000 };
  const sections = subscriptionDetails({ ...base, limits: [limit] }, 'Qoder', '到期时间');
  assert.equal(sections[0].rows.length, 1);
  assert.equal(flattenedSubscriptionDetails([...sections, ...sections], []).length, 1);
  const distinct = subscriptionDetails({ ...base, limits: [limit, { ...limit, id: 'shared', label: 'Shared' }] }, 'Qoder', '到期时间');
  assert.equal(flattenedSubscriptionDetails(distinct, []).length, 2);
  assert.equal(subscriptionDetails({ ...base, limits: [limit] }, 'Cursor', '重置时间')[0].rows.length, 2);
});
test('only displayed models lose repeated values; hidden unlimited and exhausted pools remain', () => {
  const limits = [
    { id: 'one', label: 'One', unlimited: true },
    { id: 'two', label: 'Two', exhausted: true },
    { id: 'three', label: 'Three', usedPercent: 20 },
    { id: 'four', label: 'Four', exhausted: true },
  ];
  const sections = subscriptionDetails({ ...base, limits }, 'Gemini');
  const rows = flattenedSubscriptionDetails(sections, [
    { label: 'One', poolKey: sections[0].poolKey, valueText: '无限' },
    { label: 'Two', poolKey: sections[1].poolKey, remainingPercent: 0 },
    { label: 'Three', poolKey: sections[2].poolKey },
  ]);
  assert.deepEqual(rows, [{ label: 'Four 额度状态', value: '已用尽', tone: 'muted' }]);
});
