import type { TauriDesktopBridge, TauriUpdateSnapshot } from './tauri-desktop';

type UpdateBridge = Pick<
  TauriDesktopBridge,
  'acknowledgeUpdateCompleted' | 'checkForUpdates' | 'getUpdateStatus' | 'installUpdate' | 'onUpdateStatus'
>;

const CURRENT_VERSION = '1.1.15';
const NEXT_VERSION = '1.1.16';
const TOTAL_BYTES = 48 * 1024 * 1024;
const INITIAL_STATUSES = ['disabled', 'idle', 'checking', 'available', 'downloading', 'downloaded', 'installing', 'notAvailable', 'error'] as const;

/**
 * `VITE_MOCK_TAURI_UPDATE=1` starts idle and walks the real flow on click.
 * A status name (e.g. `downloaded`, `error`) starts there; `fail` makes the
 * restart step fail so the retry UI can be checked.
 */
export function readTauriUpdateMockMode(): string | null {
  const value = import.meta.env.VITE_MOCK_TAURI_UPDATE?.trim();
  return value && value !== '0' && value !== 'false' ? value : null;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function initialSnapshot(mode: string): TauriUpdateSnapshot {
  const base: TauriUpdateSnapshot = {
    status: 'idle', currentVersion: CURRENT_VERSION, availableVersion: null, message: null,
  };
  const status = (INITIAL_STATUSES as readonly string[]).includes(mode)
    ? mode as TauriUpdateSnapshot['status'] : 'idle';
  switch (status) {
    case 'available':
    case 'downloaded':
    case 'installing':
      return { ...base, status, availableVersion: NEXT_VERSION };
    case 'downloading':
      return { ...base, status, availableVersion: NEXT_VERSION, downloadedBytes: TOTAL_BYTES * 0.45, totalBytes: TOTAL_BYTES };
    case 'error':
      return { ...base, status, message: '检查更新失败，请稍后重试。' };
    case 'disabled':
      return { ...base, status, message: '此安装包未启用自动更新' };
    default:
      return { ...base, status };
  }
}

let mockBridge: UpdateBridge | null = null;

function createMockBridge(mode: string): UpdateBridge {
  let snapshot = initialSnapshot(mode);
  const listeners = new Set<(value: TauriUpdateSnapshot) => void>();
  const publish = (next: Partial<TauriUpdateSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  };
  let busy = false;

  const download = async () => {
    for (let percent = 0; percent <= 100; percent += 5) {
      publish({ status: 'downloading', availableVersion: NEXT_VERSION, downloadedBytes: TOTAL_BYTES * percent / 100, totalBytes: TOTAL_BYTES });
      await delay(150);
    }
  };

  return {
    getUpdateStatus: async () => snapshot,
    onUpdateStatus: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
    checkForUpdates: async () => {
      if (busy) throw new Error('更新操作正在进行');
      busy = true;
      try {
        publish({ status: 'checking', availableVersion: null, message: null, downloadedBytes: 0, totalBytes: null });
        await delay(1200);
        await download();
        return publish({ status: 'downloaded', availableVersion: NEXT_VERSION });
      } finally {
        busy = false;
      }
    },
    installUpdate: async () => {
      if (busy) throw new Error('更新操作正在进行');
      busy = true;
      try {
        publish({ status: 'installing', availableVersion: NEXT_VERSION, message: null });
        await delay(1800);
        if (mode === 'fail') {
          publish({ status: 'error', message: '更新失败，请重试或下载新安装包。' });
          throw new Error('更新失败，请重试或下载新安装包。');
        }
        // Simulate the relaunch: the new version reports a one-time completion.
        publish({
          status: 'idle', currentVersion: NEXT_VERSION, availableVersion: null,
          completedVersion: NEXT_VERSION, downloadedBytes: 0, totalBytes: null,
        });
      } finally {
        busy = false;
      }
    },
    acknowledgeUpdateCompleted: async () => {
      publish({ completedVersion: null });
    },
  };
}

/** Returns the real bridge unless the update mock is enabled. */
export function withTauriUpdateMock<T extends UpdateBridge>(bridge: T): T {
  const mode = readTauriUpdateMockMode();
  if (!mode) return bridge;
  if (!mockBridge) {
    const created = createMockBridge(mode);
    mockBridge = created;
    // Mirror the native startup check, which only runs from an idle snapshot.
    if (initialSnapshot(mode).status === 'idle') {
      setTimeout(() => { void created.checkForUpdates().catch(() => {}); }, 2000);
    }
  }
  return { ...bridge, ...mockBridge };
}
