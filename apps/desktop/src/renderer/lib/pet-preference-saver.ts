export interface PetPreferenceChanges {
  scale?: number;
  frameIntervalMs?: number;
  autoMoveEnabled?: boolean;
  autoMoveIntervalMinutes?: number;
  syncFeedbackEnabled?: boolean;
  syncFeedbackDurationSec?: number;
}

/** Serialize native writes and never apply a response over a newer local edit. */
export function createPetPreferenceSaver<T>(
  write: (changes: PetPreferenceChanges) => Promise<T>,
  apply: (saved: T) => void,
  onError: (reason: unknown) => void,
  hasLocalEdits: () => boolean,
) {
  let pending: PetPreferenceChanges | null = null;
  let running = false;
  let revision = 0;
  let active = true;

  async function drain() {
    running = true;
    try {
      while (pending) {
        const changes = pending;
        const requestRevision = revision;
        pending = null;
        try {
          const saved = await write(changes);
          if (active && requestRevision === revision && !hasLocalEdits()) apply(saved);
        } catch (reason) {
          if (active) onError(reason);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    invalidate() { revision++; },
    save(changes: PetPreferenceChanges) {
      if (Object.keys(changes).length === 0) return;
      revision++;
      pending = { ...pending, ...changes };
      if (!running) void drain();
    },
    get busy() { return running || pending !== null || hasLocalEdits(); },
    // Committed writes finish after unmount, without updating the closed panel.
    setActive(value: boolean) { active = value; },
  };
}
