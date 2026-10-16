/**
 * Theme domain shared by main / preload / renderer.
 *
 * ThemeMode is the user's preference (persisted); Theme is the resolved
 * theme actually rendered. `system` resolves against the OS dark-mode
 * preference and follows it live.
 */

export type Theme = 'light' | 'dark';

export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Resolve a ThemeMode into the theme to render for a given OS appearance. */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): Theme {
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}
