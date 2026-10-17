import type {
  SubscriptionChannelId,
  SubscriptionReadOptions,
  SubscriptionSnapshotByChannel,
} from '@juejin-opensource/jusage-core/subscription';

/** Kept independent of Vite env so the server-mode boundary is testable. */
export function createSubscriptionClient(cliMode: boolean, fetcher: typeof fetch = fetch) {
  return async <K extends SubscriptionChannelId>(
    channel: K,
    options: SubscriptionReadOptions = {},
  ): Promise<SubscriptionSnapshotByChannel[K]> => {
    if (!cliMode) throw new Error('LOCAL_SUBSCRIPTIONS_UNAVAILABLE');
    const suffix = options.forceRefresh ? '?forceRefresh=1' : '';
    const response = await fetcher(`/functions/tud-subscription/${channel}${suffix}`);
    const body: unknown = await response.json();
    if (!response.ok || body === null || typeof body !== 'object'
      || !('success' in body) || body.success !== true
      || !('data' in body) || body.data === null || body.data === undefined) {
      throw new Error(body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message : 'SUBSCRIPTION_READ_FAILED');
    }
    return body.data as SubscriptionSnapshotByChannel[K];
  };
}
