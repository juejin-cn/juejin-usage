/** Stable IDs keep saved choices independent of translated labels and layout. */
export const TRAY_OVERVIEW_MODULES = [
  { id: 'subscriptions', label: '订阅额度' },
  { id: 'cost', label: '预估费用' },
  { id: 'totalTokens', label: '总 Token' },
  { id: 'inputTokens', label: '输入 Token' },
  { id: 'outputTokens', label: '输出 Token' },
  { id: 'trend', label: '用量趋势' },
  { id: 'tools', label: '工具分布' },
  { id: 'models', label: '模型分布' },
] as const;

export type TrayOverviewModuleId = typeof TRAY_OVERVIEW_MODULES[number]['id'];
export type TrayOverviewVisibility = Record<TrayOverviewModuleId, boolean>;
export type TrayOverviewStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const TRAY_OVERVIEW_STORAGE_KEY = 'jusage:tray-overview';

/** A fresh object also lets callers restore defaults without shared mutation. */
export function defaultTrayOverviewVisibility(): TrayOverviewVisibility {
  return Object.fromEntries(
    TRAY_OVERVIEW_MODULES.map(({ id }) => [id, true]),
  ) as TrayOverviewVisibility;
}

function localStorageOrNull(): TrayOverviewStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readTrayOverviewVisibility(
  storage: TrayOverviewStorage | null = localStorageOrNull(),
): TrayOverviewVisibility {
  const result = defaultTrayOverviewVisibility();
  try {
    const raw = storage?.getItem(TRAY_OVERVIEW_STORAGE_KEY);
    if (!raw) return result;
    const saved: unknown = JSON.parse(raw);
    if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.visibility)) {
      return result;
    }
    for (const { id } of TRAY_OVERVIEW_MODULES) {
      const value = saved.visibility[id];
      if (typeof value === 'boolean') result[id] = value;
    }
  } catch {
    // Corrupt or unavailable storage must never prevent opening the tray.
  }
  return result;
}

export function writeTrayOverviewVisibility(
  visibility: TrayOverviewVisibility,
  storage: TrayOverviewStorage | null = localStorageOrNull(),
): boolean {
  if (!storage) return false;
  try {
    // Persist only recognized keys; new modules remain visible on older saves.
    const normalized = defaultTrayOverviewVisibility();
    for (const { id } of TRAY_OVERVIEW_MODULES) {
      if (typeof visibility[id] === 'boolean') normalized[id] = visibility[id];
    }
    storage.setItem(
      TRAY_OVERVIEW_STORAGE_KEY,
      JSON.stringify({ version: 1, visibility: normalized }),
    );
    return true;
  } catch {
    return false;
  }
}
