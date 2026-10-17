/** Runtime transport. Desktop injects Chromium; CLI uses Node fetch. */
let subscriptionFetch: typeof fetch = (...args) => globalThis.fetch(...args);
export function setSubscriptionFetch(fetcher: typeof fetch): void {
  subscriptionFetch = fetcher;
}
export const fetchSubscription: typeof fetch = (...args) => subscriptionFetch(...args);
