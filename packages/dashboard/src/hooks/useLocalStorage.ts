import { getTauriDesktopBridge } from '@/lib/tauri-desktop';
import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

function readStoredValue<T>(
  key: string,
  defaultValue: T,
  isValid?: (value: unknown) => value is T,
): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return defaultValue;
    const parsed: unknown = JSON.parse(raw);
    if (isValid && !isValid(parsed)) return defaultValue;
    return parsed as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Persist a JSON-serializable value in localStorage.
 *
 * Reads once on mount; writes after each change. Private mode / quota errors
 * are ignored so the in-memory state still works.
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  isValid?: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    readStoredValue(key, defaultValue, isValid),
  );

  useEffect(() => {
    try {
      const raw = JSON.stringify(value);
      if (localStorage.getItem(key) !== raw) {
        localStorage.setItem(key, raw);
        if (getTauriDesktopBridge()) window.dispatchEvent(new CustomEvent('tud:storage-updated', {detail:{key}}));
      }
    } catch {
      // ignore private mode / quota
    }
  }, [key, value]);

  useEffect(() => {
    if (!getTauriDesktopBridge()) return;
    const reload = (event: Event) => {
      const changed = event instanceof StorageEvent ? event.key : (event as CustomEvent<{key:string}>).detail.key;
      if (changed === key || changed === null) setValue(readStoredValue(key, defaultValue, isValid));
    };
    window.addEventListener('storage', reload);
    window.addEventListener('tud:storage-updated', reload);
    return () => {window.removeEventListener('storage', reload);window.removeEventListener('tud:storage-updated', reload);};
  }, [key, defaultValue, isValid]);
  return [value, setValue];
}
