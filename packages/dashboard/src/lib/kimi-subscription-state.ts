import type { KimiSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/kimi-subscription';

/** One Kimi plan, using a complete reading without mixing source accounts or pools. */
export function selectKimiSubscription(snapshots: KimiSubscriptionSnapshot[]): KimiSubscriptionSnapshot | null {
  const visible = snapshots.filter(isKimiSubscriptionVisible);
  let candidates = visible.filter((snapshot) => snapshot.status === 'ready');
  if (candidates.length === 0) {
    return visible.find((snapshot) => snapshot.planLabel === 'Free')
      ?? visible.find((snapshot) => snapshot.status === 'custom-provider')
      ?? visible[0] ?? null;
  }
  // Prefer fresh, useful readings. Code can provide both the shared pool and
  // its rolling limits; otherwise retain the confirmed subscription allowance.
  const priorities: Array<(snapshot: KimiSubscriptionSnapshot) => boolean> = [
    (snapshot) => !snapshot.stale,
    (snapshot) => snapshot.limits.length > 0,
    (snapshot) => snapshot.planLabel !== null,
    (snapshot) => snapshot.limits.some((limit) => limit.id === 'subscription' || limit.id === 'limit_month_total'),
    (snapshot) => snapshot.source === 'code',
  ];
  for (const prefer of priorities) {
    const preferred = candidates.filter(prefer);
    if (preferred.length > 0) candidates = preferred;
  }
  return candidates[0]!;
}

export function isKimiSubscriptionVisible(
  snapshot: KimiSubscriptionSnapshot | null,
): snapshot is KimiSubscriptionSnapshot {
  if (!snapshot || snapshot.status === 'not-installed'
    || snapshot.status === 'not-signed-in' || snapshot.status === 'expired') return false;
  // A failed first lookup has no paid plan or allowance to show. Keep confirmed
  // Free metadata, successful readings and custom-provider feedback.
  return snapshot.status !== 'temporarily-unavailable'
    || snapshot.fetchedAt !== null
    || snapshot.planLabel === 'Free';
}
