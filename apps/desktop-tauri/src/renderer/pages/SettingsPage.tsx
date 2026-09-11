import { useEffect } from 'react';
import { dispatchOpenSettings } from '@/lib/shell-events';

/** Deep-link fallback: AppShell opens the settings modal and redirects away. */
export function SettingsPage() {
  useEffect(() => {
    dispatchOpenSettings();
  }, []);

  return null;
}
