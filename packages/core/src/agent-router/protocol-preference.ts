import type { Protocol } from './config.js';

export const CLIENT_PROTOCOL_PRIORITY = ['messages', 'responses', 'chat'] as const;
/** Pick only from capabilities the caller actually supports. */
export function preferredClientProtocol<T extends Protocol>(supported: readonly T[]): T {
  for (const protocol of CLIENT_PROTOCOL_PRIORITY) {
    const found = supported.find(value => value === protocol); if (found) return found;
  }
  if (supported[0]) return supported[0];
  throw new Error('No supported protocol');
}
