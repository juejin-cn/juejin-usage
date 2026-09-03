import { createHash } from 'node:crypto';

import type { IngestBucket } from '../types.js';
import { ingestBucketKey } from '../queue/keys.js';

const SOURCE_TO_INTEGRATION: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  qoder: 'qoder',
  trae: 'trae',
  gemini: 'gemini',
  opencode: 'opencode',
  copilot: 'copilot',
  antigravity: 'antigravity',
  openclaw: 'openclaw',
  hermes: 'hermes',
  zcode: 'zcode',
  dsh: 'dsh',
  pi: 'pi',
  kimi: 'kimi',
  roocode: 'roocode',
  droid: 'droid',
  kiro: 'kiro',
  cline: 'cline',
  amp: 'amp',
  qwen: 'qwen-code',
  codebuddy: 'codebuddy',
  workbuddy: 'workbuddy',
  grok: 'grok',
  mimo: 'mimo',
  'every-code': 'every-code',
  omp: 'omp',
  'kilo-cli': 'kilo-cli',
  kilocode: 'kilocode',
  goose: 'goose',
  zed: 'zed',
  warp: 'warp',
};

/** Fallback when QueueBucket/IngestBucket has no collector set (legacy rows). */
const INTEGRATION_TO_COLLECTOR: Record<string, string> = {
  'claude-code': 'claude-code-cli',
  codex: 'codex-cli',
  cursor: 'cursor-composer',
  qoder: 'qoder-ide',
  trae: 'trae-ide',
  gemini: 'gemini-cli',
  opencode: 'opencode',
  copilot: 'copilot-cli',
  antigravity: 'antigravity-app',
  openclaw: 'openclaw',
  hermes: 'hermes',
  zcode: 'zcode',
  dsh: 'dsh',
  pi: 'pi',
  kimi: 'kimi-code',
  roocode: 'roo-code',
  droid: 'droid',
  kiro: 'kiro-cli',
  cline: 'cline',
  amp: 'amp',
  'qwen-code': 'qwen-code',
  codebuddy: 'codebuddy',
  workbuddy: 'workbuddy',
  grok: 'grok-build',
  mimo: 'mimocode',
  'every-code': 'every-code',
  omp: 'omp',
  'kilo-cli': 'kilo-cli',
  kilocode: 'kilo-code',
  'kilo-code': 'kilo-code',
  goose: 'goose',
  zed: 'zed',
  warp: 'warp',
};

const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidV5(name: string): string {
  const namespaceBytes = Buffer.from(NAMESPACE_DNS.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface IngestEventPayload {
  event_id: string;
  occurred_at: string;
  integration: string;
  collector: string;
  model: string;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  };
  conversation_ref?: string;
  conversations_count?: number;
  reported_cost_usd?: number;
}

/**
 * Stable per-(device, source, collector, model, hour) event id so multi-device
 * uploads of the same hour do not collide on (user_id, event_id).
 */
export function ingestEventId(deviceId: string, bucket: IngestBucket): string {
  const key = ingestBucketKey(bucket);
  return uuidV5(`ingest-${deviceId}|${key}`);
}

export function bucketToIngestEvent(
  bucket: IngestBucket,
  deviceId: string,
): IngestEventPayload | null {
  const integration = SOURCE_TO_INTEGRATION[bucket.source];
  if (!integration || !bucket.hour_start || !bucket.model || !deviceId) return null;

  const key = ingestBucketKey(bucket);
  const eventId = ingestEventId(deviceId, bucket);
  const conversationRef = createHash('sha256')
    .update(`${deviceId}|${key}`)
    .digest('hex');
  const reported =
    bucket.reported_cost_usd != null &&
    Number.isFinite(bucket.reported_cost_usd) &&
    bucket.reported_cost_usd > 0
      ? bucket.reported_cost_usd
      : undefined;

  const collector =
    bucket.collector?.trim() ||
    INTEGRATION_TO_COLLECTOR[integration] ||
    integration;

  return {
    event_id: eventId,
    occurred_at: bucket.hour_start,
    integration,
    collector,
    model: bucket.model,
    usage: {
      input_tokens: bucket.input_tokens,
      cached_input_tokens: bucket.cached_input_tokens,
      cache_creation_input_tokens: bucket.cache_creation_input_tokens,
      output_tokens: bucket.output_tokens,
      reasoning_output_tokens: bucket.reasoning_output_tokens,
    },
    conversation_ref: conversationRef,
    conversations_count: Math.max(1, bucket.conversation_count),
    ...(reported != null ? { reported_cost_usd: reported } : {}),
  };
}
