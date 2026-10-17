import { useCallback, useEffect, useState } from 'react';
import {
  SUBSCRIPTION_CHANNELS,
  SUBSCRIPTION_CHANNEL_VISIBILITY_EVENT,
  isSubscriptionChannelEnabled,
  readSubscriptionChannelVisibility,
  writeSubscriptionChannelVisibility,
  type SubscriptionChannelId,
  type SubscriptionChannelVisibility,
} from '@juejin-opensource/jusage-core/subscription/shared/subscription-channels';

/**
 * Persist which subscription channels may appear on the dashboard / tray.
 * Missing keys stay enabled; empty or unrecognized installs still auto-hide.
 */
export function useSubscriptionChannelVisibility(): {
  visibility: SubscriptionChannelVisibility;
  isEnabled: (id: SubscriptionChannelId) => boolean;
  setChannelEnabled: (id: SubscriptionChannelId, enabled: boolean) => void;
  setAllEnabled: (enabled: boolean) => void;
} {
  const [visibility, setVisibility] = useState<SubscriptionChannelVisibility>(
    () => readSubscriptionChannelVisibility(),
  );

  useEffect(() => {
    const sync = () => setVisibility(readSubscriptionChannelVisibility());
    window.addEventListener(SUBSCRIPTION_CHANNEL_VISIBILITY_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SUBSCRIPTION_CHANNEL_VISIBILITY_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setChannelEnabled = useCallback(
    (id: SubscriptionChannelId, enabled: boolean) => {
      setVisibility((current) => {
        const next = { ...current, [id]: enabled };
        writeSubscriptionChannelVisibility(next);
        return next;
      });
    },
    [],
  );

  const setAllEnabled = useCallback((enabled: boolean) => {
    const next: SubscriptionChannelVisibility = {};
    for (const channel of SUBSCRIPTION_CHANNELS) {
      next[channel.id] = enabled;
    }
    writeSubscriptionChannelVisibility(next);
    setVisibility(next);
  }, []);

  const isEnabled = useCallback(
    (id: SubscriptionChannelId) =>
      isSubscriptionChannelEnabled(visibility, id),
    [visibility],
  );

  return { visibility, isEnabled, setChannelEnabled, setAllEnabled };
}
