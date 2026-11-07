/** Browser-safe configuration defaults; no Node or transport dependencies. */
export interface QueueLimits { maxConcurrent: number; maxQueued: number; queueTimeoutMs: number }
export interface GatewayLimits extends QueueLimits { firstResponseTimeoutMs: number; requestTimeoutMs: number; drainTimeoutMs: number }
export const DEFAULT_PROVIDER_LIMITS: QueueLimits = { maxConcurrent: 2, maxQueued: 20, queueTimeoutMs: 15000 };
export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = { maxConcurrent: 16, maxQueued: 20, queueTimeoutMs: 15000, firstResponseTimeoutMs: 30000, requestTimeoutMs: 180000, drainTimeoutMs: 2000 };
