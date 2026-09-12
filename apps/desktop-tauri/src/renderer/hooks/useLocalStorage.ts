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
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore private mode / quota
    }
  }, [key, value]);

  return [value, setValue];
}
