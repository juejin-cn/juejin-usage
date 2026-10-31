import { useCallback, useEffect, useState } from 'react';
import {
  defaultTrayOverviewVisibility,
  readTrayOverviewVisibility,
  writeTrayOverviewVisibility,
  TRAY_OVERVIEW_STORAGE_KEY,
  type TrayOverviewModuleId,
  type TrayOverviewVisibility,
} from '../lib/tray-overview-preferences';

export function useTrayOverviewVisibility() {
  // Read before the first render, so hidden cards do not flash on reopening.
  const [visibility, setVisibility] = useState(readTrayOverviewVisibility);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === TRAY_OVERVIEW_STORAGE_KEY || event.key === null) {
        setVisibility(readTrayOverviewVisibility());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const save = useCallback((next: TrayOverviewVisibility) => {
    setVisibility(next);
    setSaveFailed(!writeTrayOverviewVisibility(next));
  }, []);
  const setEnabled = (id: TrayOverviewModuleId, enabled: boolean) => {
    save({ ...visibility, [id]: enabled });
  };
  const reset = () => save(defaultTrayOverviewVisibility());
  return { visibility, setEnabled, reset, saveFailed };
}
