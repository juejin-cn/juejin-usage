import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { useTheme as useHeroUITheme } from '@heroui/react';
import {
  isThemeMode,
  type Theme,
  type ThemeMode,
} from '@/lib/theme';

interface ThemeContextValue {
  /** Resolved theme actually rendered (follows the OS when mode is `system`). */
  theme: Theme;
  /** User's persisted preference. */
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function shouldAnimateThemeChange(): boolean {
  return typeof document !== 'undefined'
    && typeof document.startViewTransition === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Single-button cycle order. Kept explicit (not derived from THEME_MODES) so
 * reordering the shared mode list can never silently change the UI cycle.
 */
const THEME_MODE_CYCLE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const {
    theme: heroUITheme,
    setTheme: setHeroUITheme,
  } = useHeroUITheme('light');
  const theme: Theme = heroUITheme === 'dark' ? 'dark' : 'light';
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const themeModeRef = useRef<ThemeMode>('system');
  const themeRef = useRef<Theme>(theme);

  const applyTheme = useCallback((next: Theme): boolean => {
    if (next === themeRef.current) return false;
    themeRef.current = next;

    if (!shouldAnimateThemeChange()) {
      setHeroUITheme(next);
      return true;
    }

    document.startViewTransition(() => {
      flushSync(() => {
        setHeroUITheme(next);
      });
    });
    return true;
  }, [setHeroUITheme]);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    const syncInitialTheme = async () => {
      const state = await window.tud?.getTheme?.();
      if (!disposed && state && isThemeMode(state.mode)) {
        themeModeRef.current = state.mode;
        setThemeModeState(state.mode);
        applyTheme(state.resolved === 'dark' ? 'dark' : 'light');
      }
    };

    void syncInitialTheme();
    // Main broadcasts the full theme state ({ mode, resolved }) whenever either
    // changes — on explicit mode switches and on live OS appearance changes
    // while in `system` mode. mode keeps the selector highlight in sync across
    // every window (main window + tray popover).
    const unsubscribe = window.tud?.onThemeChanged?.((state) => {
      themeModeRef.current = state.mode;
      setThemeModeState(state.mode);
      applyTheme(state.resolved);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [applyTheme]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    // Keep the ref current so a rapid burst of clicks cycles forward instead
    // of every click reading the same stale state.
    themeModeRef.current = mode;
    setThemeModeState(mode);
    // light/dark need no system info and apply instantly. `system` is left to
    // main's broadcast: local matchMedia reflects the current themeSource, not
    // the real OS appearance, while a fixed mode is active — applying it here
    // would briefly render the wrong theme before main corrects it.
    if (mode !== 'system') {
      applyTheme(mode);
    }
    window.tud?.setThemeMode?.(mode);
  }, [applyTheme]);

  const toggleTheme = useCallback(() => {
    // Reads the ref so rapid consecutive presses advance one step each instead
    // of all landing on the same next mode.
    setThemeMode(THEME_MODE_CYCLE[themeModeRef.current]);
  }, [setThemeMode]);

  const value = useMemo(
    () => ({ theme, themeMode, setThemeMode, toggleTheme }),
    [theme, themeMode, setThemeMode, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
