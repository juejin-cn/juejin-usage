/**
 * Online Web multi-device usage filter (localStorage + broadcast).
 * Empty selection = all devices.
 *
 * Storage is keyed by stable Juejin `originUserId` (not the rotating `jau.`
 * encrypted bearer), so selections survive reload / re-login.
 */
const STORAGE_PREFIX = 'tud:deviceFilter:';
const OWNER_STORAGE_KEY = 'tud.deviceFilterOwner';
export const DEVICE_FILTER_CHANGED_EVENT = 'tud:device-filter-changed';
export const DEVICE_FILTER_OWNER_CHANGED_EVENT = 'tud:device-filter-owner-changed';

const DEVICE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deviceFilterStorageKey(userKey: string): string {
  return `${STORAGE_PREFIX}${userKey || 'anon'}`;
}

/** Persist the stable account id used as the device-filter storage owner. */
export function setDeviceFilterOwner(originUserId: string | null): void {
  try {
    const trimmed = originUserId?.trim() || '';
    if (trimmed) {
      localStorage.setItem(OWNER_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(OWNER_STORAGE_KEY);
    }
  } catch {
    // private mode
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(DEVICE_FILTER_OWNER_CHANGED_EVENT, {
        detail: { originUserId: originUserId?.trim() || null },
      }),
    );
  }
}

export function getDeviceFilterOwner(): string | null {
  try {
    const raw = localStorage.getItem(OWNER_STORAGE_KEY)?.trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Prefer explicit originUserId, then last persisted owner, else anon. */
export function resolveDeviceFilterUserKey(originUserId?: string | null): string {
  const fromArg = originUserId?.trim();
  if (fromArg) return fromArg;
  return getDeviceFilterOwner() || 'anon';
}

export function loadDeviceFilter(userKey: string): string[] {
  try {
    const raw = localStorage.getItem(deviceFilterStorageKey(userKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id): id is string => typeof id === 'string' && DEVICE_ID_RE.test(id),
    );
  } catch {
    return [];
  }
}

export function saveDeviceFilter(userKey: string, deviceIds: string[]): void {
  const cleaned = [...new Set(deviceIds.map((id) => id.toLowerCase()))];
  const key = userKey.trim() || 'anon';
  try {
    if (cleaned.length === 0) {
      localStorage.removeItem(deviceFilterStorageKey(key));
    } else {
      localStorage.setItem(
        deviceFilterStorageKey(key),
        JSON.stringify(cleaned),
      );
    }
  } catch {
    // private mode
  }
  window.dispatchEvent(
    new CustomEvent(DEVICE_FILTER_CHANGED_EVENT, {
      detail: { deviceIds: cleaned, userKey: key },
    }),
  );
}

/** Active filter for API reads — empty means all devices. */
let activeDeviceIds: string[] = [];

export function getActiveDeviceIds(): string[] {
  return activeDeviceIds;
}

export function setActiveDeviceIds(deviceIds: string[]): void {
  activeDeviceIds = [...deviceIds];
}

export function hydrateActiveDeviceIds(userKey: string): string[] {
  const ids = loadDeviceFilter(userKey);
  activeDeviceIds = ids;
  return ids;
}

export function appendDeviceIdsQuery(url: string): string {
  if (activeDeviceIds.length === 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}deviceIds=${encodeURIComponent(activeDeviceIds.join(','))}`;
}
