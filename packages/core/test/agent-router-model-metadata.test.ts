import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelCatalog, sanitizeModelMetadata } from '../src/agent-router/model-metadata.js';
import { antigravityMetadata, codexMetadata, copilotMetadata, grokMetadata, kiroMetadata, nameOnlyMetadata, minimaxMetadata, zcodeMetadata, opencodeMetadata, qoderMetadata, traeMetadata, workbuddyMetadata } from '../src/agent-router/channels/model-metadata.js';
import { modelRows } from '../src/agent-router/channels/http.js';
import { traeChannel } from '../src/agent-router/channels/trae.js';

const now = Date.parse('2026-11-05T10:00:00Z');

test('catalog boundary preserves unknown/false/zero while excluding credentials and invalid optional fields', () => {
  const result = buildModelCatalog({ model: { name: 'Test', capabilities: { vision: false, reasoning: true }, limits: { contextTokens: 200000, outputTokens: -1 }, billing: { multiplier: 0, isFree: false } },
    malformed: { name: '<script>', capabilities: { vision: 'yes' }, limits: { contextTokens: Infinity, outputTokens: 1.5 }, billing: { multiplier: -1, conditions: ['hello', '<img>'] }, access: 'secret' } as never });
  assert.deepEqual(result.metadata?.model, { name: 'Test', capabilities: { vision: false, reasoning: true }, limits: { contextTokens: 200000 }, billing: { multiplier: 0, isFree: false } });
  assert.deepEqual(result.metadata?.malformed, { billing: { conditions: ['hello'] } });
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(result.checkedAt);
  assert.deepEqual(modelRows([{ id: 'still-usable' }], 'id', () => { throw new Error('bad optional schema'); })['still-usable'], { name: 'still-usable' });
});

test('verified vendor catalog samples map to the same capabilities and limits', () => {
  const samples = [
    copilotMetadata({ capabilities: { supports: { vision: true, tool_calls: false }, limits: { max_context_window_tokens: 128000, max_output_tokens: 16000 } }, billing: { multiplier: 0 } }),
    codexMetadata({ input_modalities: ['text', 'image'], context_window: 128000, max_context_window: 1000000 }),
    kiroMetadata({ supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 128000, maxOutputTokens: 16000 } }),
    qoderMetadata({ is_vl: true, is_reasoning: false, context_config: { normal: { token_count: 128000, is_default: true }, large: { token_count: 1000000 } } }),
    workbuddyMetadata({ supportsImages: true, maxInputTokens: 128000, maxOutputTokens: 16000 }),
    opencodeMetadata({ modalities: { input: ['text', 'image'] }, limit: { context: 128000, output: 16000 }, cost: { input: 0, output: 0 } }),
  ];
  for (const sample of samples) {
    const m = sanitizeModelMetadata(sample);
    assert.equal(m.capabilities?.vision, true);
    assert.equal(m.limits?.contextTokens, 128000);
  }
  assert.equal(samples[0].billing?.isFree, undefined, 'premium request multiplier is not subscription pricing');
  assert.equal(samples[5].billing?.isFree, true);
  assert.equal(opencodeMetadata({ cost: { input: 0, output: 0, cache_read: 1 } }).billing?.isFree, false);
  assert.equal(grokMetadata({ context_window: 256000 }).limits?.contextTokens, 256000);
  assert.equal(antigravityMetadata({ displayName: 'Gemini', maxTokens: 1000000, supportsImages: true }).capabilities?.vision, true);
  assert.equal(minimaxMetadata({ modalities: { input: ['text', 'image'] }, limit: { context: 1000000 }, thinking_config: { mode: 'switchable' } }).limits?.contextTokens, 1000000);
  assert.equal(zcodeMetadata({ properties: { contextWindow: 200000, inputFormat: { supportsImage: false } } }).capabilities?.vision, false);
});

test('unverified schemas and manual model IDs remain name-only across existing channels', () => {
  for (const channel of ['claude', 'cursor', 'kimi-work', 'volcengine', 'opencode-go']) {
    const catalog = buildModelCatalog(modelRows([{ id: channel, name: 'Model', arbitraryVision: true }], 'id', nameOnlyMetadata));
    assert.deepEqual(catalog.metadata?.[channel], { name: 'Model' });
  }
});

test('Qoder promotion zero placeholder is not incorrectly labeled free', () => {
  const meta = qoderMetadata({ price_factor: 0, is_free: true, promotion: { active: true, before_promotion_price_factor: 0.5, discount_factor: 0.4 } }, now);
  assert.equal(meta.billing?.multiplier, 0.2);
  assert.equal(meta.billing?.isFree, false);
  assert.equal(meta.billing?.discountRatio, 0.4);
  assert.ok(Date.parse(meta.billing!.validUntil!) > now);
  assert.equal(qoderMetadata({ price_factor: 0.5, is_free: true }).billing?.isFree, false);
  assert.equal(qoderMetadata({ price_factor: 0, original_price_factor: 0.1 }).billing?.isFree, true);
  assert.equal(qoderMetadata({}).billing?.isFree, undefined);
});

test('WorkBuddy discounts preserve the baseline and hourly offers never advertise an unverified free price', () => {
  const promotions = [{ kind: 'discount', enabled: true, modelIds: ['model'], discount: { factor: 0.5 }, schedule: { validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-11-06T00:00:00Z' } }];
  const m = workbuddyMetadata({ id: 'model', credits: 'x0.8' }, promotions, now);
  assert.equal(m.billing?.multiplier, 0.4);
  assert.equal(m.billing?.originalMultiplier, 0.8);
  assert.equal(workbuddyMetadata({ id: 'model', credits: 'x0.8' }, promotions, Date.parse('2026-11-07')).billing?.multiplier, 0.8);
  const hourly = workbuddyMetadata({ id: 'model', credits: 'x0' }, [{ ...promotions[0], schedule: { daily: ['23:00-08:00'] } }]);
  assert.equal(hourly.billing?.multiplier, undefined);
  assert.equal(hourly.billing?.isFree, undefined);
});

const trae = {
  config_name: 'test-model', display_config: { display_name: 'Test model', multimodal: true },
  context_window_tokens: { dev: 200000, max: 1000000 },
  model_detail_list: [{ model_name: 'test__dev', max_tokens: 32000 }, { model_name: 'test__max' }],
  display_contact_config: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 0.78 } }, discount: { enable: true, data: { consumption_rate: 0.58, original_consumption_rate: 0.78 } } }),
};

test('Trae ordinary context and optional Max mode stay distinct from billing', () => {
  const m = traeMetadata(trae, [trae], now);
  assert.equal(m.name, 'Test model');
  assert.deepEqual(m.limits, { contextTokens: 200000, maxContextTokens: 1000000, outputTokens: 32000 });
  assert.equal(m.capabilities?.vision, true);
  assert.equal(m.billing?.multiplier, 0.58);
  assert.equal(m.billing?.originalMultiplier, 0.78);
  const noMax = traeMetadata({ ...trae, model_detail_list: [{ model_name: 'test__dev' }] }, [{ model_detail_list: [] }], now);
  assert.equal(noMax.limits?.maxContextTokens, undefined, 'a large numeric window alone does not enable Max');
});

test('Trae timed prices honor the vendor timezone and stop applying at the end boundary', () => {
  const m = { ...trae, display_contact_config: { consumption_rate: { data: { rate: 1 } }, activity_discount: { enable: true, data: { off_peak: {
    time_zone: 'Asia/Shanghai', before_consumption_rate: 1, after_consumption_rate: 0,
    time_windows: [{ weekdays: [4], start_minute: 18 * 60, end_minute: 19 * 60 }],
  } } } } };
  assert.equal(traeMetadata(m, [m], now - 1).billing?.multiplier, 1);
  assert.equal(traeMetadata(m, [m], now).billing?.isFree, true);
  assert.equal(traeMetadata(m, [m], now + 3600000).billing?.multiplier, 1);
  assert.equal(traeMetadata({ ...m, display_contact_config: '{invalid' }).limits?.contextTokens, 200000);
  assert.equal(traeMetadata({ ...m, display_contact_config: '{invalid' }).billing, undefined);
});

for (const global of [false, true]) test(`Trae ${global ? 'Global' : 'CN'} adapter retains metadata from the raw upstream list`, async () => {
  const channel = traeChannel(global, async () => Response.json({ config_info_list: [trae] }));
  const rows = await channel.models({ access: 'test-access', uid: 'test-uid', deviceId: 'test-device', machineId: 'test-machine' });
  const result = buildModelCatalog(rows);
  assert.equal(result.metadata?.['test-model'].capabilities?.vision, true);
  assert.equal(result.metadata?.['test-model'].limits?.maxContextTokens, 1000000);
});
