import type { Theme } from '@/lib/theme';

const storageKey = 'juejin_2608_theme';
const systemQuery = '(prefers-color-scheme: dark)';

export function readJuejinTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const preference = raw && JSON.parse(raw);
    if (preference?.isFollowSystem === false &&
        (preference.theme === 'light' || preference.theme === 'dark')) {
      return preference.theme;
    }
  } catch {
    // Private browsing or invalid JSON: use the system preference.
  }
  return window.matchMedia(systemQuery).matches ? 'dark' : 'light';
}

export function subscribeJuejinTheme(update: () => void) {
  const media = window.matchMedia(systemQuery);
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) update();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', update);
  media.addEventListener('change', update);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', update);
    media.removeEventListener('change', update);
  };
}
