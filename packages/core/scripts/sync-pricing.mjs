#!/usr/bin/env node
/**
 * Incremental pricing sync from models.dev.
 *
 * Merge strategy (highest priority first):
 *   1. OVERRIDES  — manual corrections for known-bad models.dev prices.
 *   2. models.dev — official-channel text models from the scoped providers.
 *   3. current table — entries models.dev does not cover are kept as-is
 *      (the ~118 hand-supplemented models like claude-mythos-5, gpt-5.5-fast,
 *      deepseek-v3.2, cursor, tencent/hy3 …), so a re-sync never loses them.
 *
 * fuzzy / alias / sourceAlias / default are hand-curated parser-name → model
 * mappings and are preserved verbatim.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = join(__dirname, '..', 'src', 'pricing', 'pricing.json');
const MODELS_DEV_URL = 'https://models.dev/api.json';

// Official-channel providers kept in the bundle. Everything else in models.dev
// (third-party / community / AWS / regional relays) is excluded.
const SCOPED_PROVIDERS = new Set([
  'anthropic', 'openai', 'google', 'google-vertex', 'google-vertex-anthropic',
  'xai', 'deepseek', 'alibaba', 'alibaba-cn', 'moonshotai', 'moonshotai-cn',
  'minimax', 'minimax-cn', 'xiaomi', 'mistral', 'zai', 'zhipuai', 'volcengine',
  'stepfun', 'meta',
]);

function syncOptions() {
  const providerArg = process.argv.slice(2).find((arg) => arg.startsWith('--providers='));
  const addOnly = process.argv.includes('--add-only');
  if (!providerArg) return { addOnly, providers: SCOPED_PROVIDERS };

  const providers = new Set(
    providerArg.slice('--providers='.length).split(',').map((provider) => provider.trim()).filter(Boolean),
  );
  if (providers.size === 0) throw new Error('--providers requires at least one provider id');
  const unsupported = [...providers].filter((provider) => !SCOPED_PROVIDERS.has(provider));
  if (unsupported.length) {
    throw new Error(`unsupported provider(s): ${unsupported.join(', ')}`);
  }
  return { addOnly, providers };
}

// Manual overrides for models.dev prices that are known to be wrong / stale.
// key = `provider/model`, value = rates to pin. Empty for now.
const OVERRIDES = {};

// Only a model's own vendor's official channel is kept. Cloud-partnership
// channels (google-vertex / google-vertex-anthropic) and cross-vendor hosting
// (e.g. `alibaba-cn/glm-5`, `volcengine/deepseek-*`) are excluded.
const OFFICIAL_PROVIDERS = {
  claude: ['anthropic'],
  gpt: ['openai'], o1: ['openai'], o3: ['openai'], o4: ['openai'], codex: ['openai'],
  gemini: ['google'], deepResearch: ['google'],
  grok: ['xai'],
  deepseek: ['deepseek'],
  qwen: ['alibaba', 'alibaba-cn'], qvq: ['alibaba', 'alibaba-cn'], qwq: ['alibaba', 'alibaba-cn'],
  tongyi: ['alibaba', 'alibaba-cn'],
  kimi: ['moonshotai', 'moonshotai-cn'], moonshot: ['moonshotai', 'moonshotai-cn'], k2p6: ['moonshotai', 'moonshotai-cn'],
  minimax: ['minimax', 'minimax-cn'],
  mimo: ['xiaomi'],
  mistral: ['mistral'], codestral: ['mistral'], devstral: ['mistral'], ministral: ['mistral'],
  magistral: ['mistral'], openMistral: ['mistral'], openMixtral: ['mistral'],
  pixtral: ['mistral'], voxtral: ['mistral'],
  glm: ['zai', 'zhipuai'],
  doubao: ['volcengine'],
  step: ['stepfun'],
  muse: ['meta'], llama: ['meta'],
  hy3: ['tencent'], ling: ['inclusionai'], ring: ['inclusionai'],
  agnes: ['sapiens'], longcat: ['meituan'],
};
const FAMILY_PATTERNS = [
  ['claude', /^claude-/], ['gpt', /^gpt-/], ['o1', /^o1(?:$|-)/], ['o3', /^o3(?:$|-)/], ['o4', /^o4-/],
  ['codex', /^codex-/], ['gemini', /^gemini-/], ['deepResearch', /^deep-research/],
  ['grok', /^grok-/], ['deepseek', /^deepseek-/],
  ['qwen', /^qwen/], ['qvq', /^qvq-/], ['qwq', /^qwq-/], ['tongyi', /^tongyi-/],
  ['kimi', /^kimi-/], ['moonshot', /^moonshot-/], ['k2p6', /^k2p6/],
  ['minimax', /^minimax-/], ['mimo', /^mimo-/],
  ['mistral', /^mistral-/], ['codestral', /^codestral-/], ['devstral', /^devstral-/],
  ['ministral', /^ministral-/], ['magistral', /^magistral-/], ['openMistral', /^open-mistral-/],
  ['openMixtral', /^open-mixtral-/], ['pixtral', /^pixtral-/], ['voxtral', /^voxtral-/],
  ['glm', /^(?:zai-glm|glm)-/], ['doubao', /^doubao-/], ['step', /^step-/],
  ['muse', /^muse-/], ['llama', /^llama-/],
  ['hy3', /^hy3(?:$|-)/], ['ling', /^ling-/], ['ring', /^ring-/], ['agnes', /^agnes-/], ['longcat', /^longcat-/],
];

function isOfficialKey(key) {
  const parts = key.split('/');
  const provider = parts[0];
  const model = parts[parts.length - 1].toLowerCase();
  if (provider === 'cursor') return true; // Cursor's own bundled-model pricing
  for (const [family, re] of FAMILY_PATTERNS) {
    if (re.test(model)) {
      return (OFFICIAL_PROVIDERS[family] ?? []).includes(provider);
    }
  }
  return true; // unknown family: keep (permissive)
}

// Match the bundle's scoping note: exclude audio / video / image / embedding /
// tts / stt / realtime / transcription / moderation models.
const EXCLUDE_FAMILY = /embedding|rerank|moderation|tts|stt|audio|speech|video|realtime|live|transcription|midi/i;
const EXCLUDE_ID = /embedding|rerank|moderation|tts|stt|lyria|-image\b|image-|-live\b|live-|realtime|transcription|speech|robotics|midi/i;

function isTextModel(model) {
  const family = model?.family ?? '';
  const id = model?.id ?? '';
  if (EXCLUDE_FAMILY.test(family)) return false;
  if (EXCLUDE_ID.test(id)) return false;
  const mod = model?.modalities;
  if (mod) {
    const input = mod.input ?? [];
    const output = mod.output ?? [];
    if (!input.includes('text')) return false;
    if (!output.includes('text')) return false;
  }
  return true;
}

function toRates(cost) {
  const rates = {};
  if (typeof cost.input === 'number') rates.input = cost.input;
  if (typeof cost.output === 'number') rates.output = cost.output;
  if (typeof cost.cache_read === 'number') rates.cache_read = cost.cache_read;
  if (typeof cost.cache_write === 'number') rates.cache_write = cost.cache_write;
  return rates;
}

async function main() {
  const { addOnly, providers } = syncOptions();
  const current = JSON.parse(readFileSync(PRICING_PATH, 'utf8'));
  const res = await fetch(MODELS_DEV_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`models.dev fetch failed: HTTP ${res.status}`);
  const catalog = await res.json();

  // 1. Build the fresh exact table from models.dev (scoped providers, text models with cost).
  const fresh = {};
  for (const [provider, entry] of Object.entries(catalog)) {
    if (!providers.has(provider)) continue;
    for (const [modelId, model] of Object.entries(entry?.models ?? {})) {
      if (!model?.cost || typeof model.cost.input !== 'number' || typeof model.cost.output !== 'number') continue;
      if (!isTextModel(model)) continue;
      const key = `${provider}/${modelId}`;
      // Add-only runs do not execute the cleanup pass below, so filter before
      // merging to avoid recording marketplace-hosted models as official rates.
      if (!isOfficialKey(key)) continue;
      fresh[key] = toRates(model.cost);
    }
  }

  // 2. Merge: keep current entries models.dev does not cover, refresh the rest.
  const exact = {};
  for (const [key, rate] of Object.entries(current.exact ?? {})) {
    exact[key] = addOnly ? rate : (OVERRIDES[key] ?? fresh[key] ?? rate);
  }

  // 3. Add models.dev entries that are new to the table.
  let added = 0;
  for (const [key, rate] of Object.entries(fresh)) {
    if (!(key in exact)) {
      exact[key] = rate;
      added += 1;
    }
  }
  // 4. Apply overrides to keys that may not exist yet. In add-only mode, an
  // existing entry must remain byte-for-byte unchanged.
  for (const [key, rate] of Object.entries(OVERRIDES)) {
    if (!(key in exact)) {
      exact[key] = rate;
      added += 1;
    }
  }

  // 5. Keep only each model's own vendor's official pricing. Cross-vendor
  // hosting (`alibaba-cn/glm-5`, `volcengine/deepseek-*`) and cloud channels
  // (`google-vertex/*`, `google-vertex-anthropic/*`) are dropped.
  const dropped = addOnly ? [] : Object.keys(exact).filter((k) => !isOfficialKey(k));
  for (const k of dropped) delete exact[k];

  // Diff summary for review.
  const changes = [];
  for (const [key, rate] of Object.entries(exact)) {
    const prev = current.exact?.[key];
    if (prev && JSON.stringify(prev) !== JSON.stringify(rate)) {
      changes.push([key, prev, rate]);
    }
  }
  const removed = Object.keys(current.exact ?? {}).filter((k) => !(k in exact));

  const next = {
    ...current,
    exact,
    _meta: {
      ...(current._meta ?? {}),
      generated_at: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
      note: `${current._meta?.note ?? ''} Incremental models.dev ${addOnly ? 'add-only ' : ''}sync on ${new Date().toISOString().slice(0, 10)} ` +
        `for ${[...providers].join(',')}: ` +
        `kept=${Object.keys(exact).length} (added=${added}, changed=${changes.length}, removed=${removed.length}). ` +
        `Official-only: cross-vendor hosting and cloud-partnership channels dropped.`,
    },
  };

  writeFileSync(PRICING_PATH, `${JSON.stringify(next, null, 2)}\n`);

  console.log(`providers: ${[...providers].join(', ')}${addOnly ? ' (add-only)' : ''}`);
  console.log(`exact: ${Object.keys(current.exact ?? {}).length} -> ${Object.keys(exact).length}`);
  console.log(`added: ${added}, changed: ${changes.length}, removed: ${removed.length} (incl. ${dropped.length} non-official)`);
  for (const [key, prev, rate] of changes) {
    console.log(`  CHANGED ${key}: ${JSON.stringify(prev)} -> ${JSON.stringify(rate)}`);
  }
  for (const key of removed) {
    console.log(`  REMOVED ${key} (was ${JSON.stringify(current.exact[key])})`);
  }
  if (added === 0 && changes.length === 0 && removed.length === 0) {
    console.log('(no price changes — table is already up to date)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
