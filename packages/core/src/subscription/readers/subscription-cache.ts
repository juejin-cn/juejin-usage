/** One minute cache shared by tray and main window; credentials never leave the caller. */
export function createSubscriptionCache<T extends { status: string; stale: boolean; message: string | null }>(now = Date.now) {
  let identity: string | null = null;
  let generation = 0;
  let lastSuccess: T | null = null;
  let cached: { at: number; value: T } | null = null;
  let pending: { identity: string; promise: Promise<T> } | null = null;
  return async (key: string, read: () => Promise<T>, force = false): Promise<T> => {
    if (identity !== key) { identity = key; generation++; lastSuccess = null; cached = null; pending = null; }
    if (pending?.identity === key) return pending.promise;
    if (!force && cached && now() - cached.at < 60_000) return cached.value;
    const readingGeneration = generation;
    const promise = (async () => {
      const fresh = await read();
      let value = fresh;
      if (identity === key && generation === readingGeneration) {
        if (fresh.status === 'ready') lastSuccess = fresh;
        else if (fresh.status === 'unavailable' || fresh.status === 'temporarily-unavailable') {
          if (lastSuccess) value = { ...lastSuccess, stale: true, message: fresh.message };
        } else lastSuccess = null;
        cached = { at: now(), value };
      }
      return value;
    })();
    pending = { identity: key, promise };
    try { return await promise; }
    finally { if (pending?.promise === promise) pending = null; }
  };
}
