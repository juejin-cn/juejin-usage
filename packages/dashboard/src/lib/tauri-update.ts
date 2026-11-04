import type { TauriUpdateSnapshot } from './tauri-desktop';

/** Match the Electron toolbar while using Tauri's verified download/check flow. */
export function getTauriUpdateToolbarAction(state: TauriUpdateSnapshot | null): {
  label: string;
  request: 'install' | 'check' | null;
} | null {
  switch (state?.status) {
    case 'available':
      // Tauri has no portable channel; click resumes the native check+download flow.
      return { label: '发现新版本', request: 'check' };
    case 'downloading': {
      const total = state.totalBytes;
      const transferred = state.downloadedBytes;
      const percent = total != null && Number.isFinite(total) && total > 0
        && transferred != null && Number.isFinite(transferred)
        ? Math.round(Math.max(0, Math.min(100, transferred / total * 100)))
        : null;
      return { label: percent === null ? '正在下载…' : `下载 ${percent}%`, request: null };
    }
    case 'downloaded':
      return { label: '更新并重启', request: 'install' };
    case 'installing':
      return { label: '正在重启…', request: null };
    case 'error':
      // Recheck and download again after failure, including stale install state.
      return { label: '重试更新', request: 'check' };
    default:
      return null;
  }
}

/** Same as Electron: only show the latest-version row while an update is in flight. */
export function getTauriLatestUpdateVersion(state: TauriUpdateSnapshot | null): string | null {
  if (!state || !['available', 'downloading', 'downloaded', 'installing'].includes(state.status)) {
    return null;
  }
  return state.availableVersion || null;
}

/**
 * Settings copy aligned with Electron's updateStatusMessage.
 * Download / restart progress stay on the action button, not in this line.
 */
export function getTauriUpdateStatusMessage(state: TauriUpdateSnapshot | null): string {
  if (!state) return '正在读取更新状态…';
  switch (state.status) {
    case 'disabled':
      return state.message ?? '此安装包未启用自动更新';
    case 'checking':
      return '正在检查新版本…';
    case 'available':
      return state.message ?? '发现新版本';
    case 'downloading':
    case 'downloaded':
    case 'installing':
    case 'notAvailable':
      return '';
    case 'error':
      return '未能完成更新，可稍后重试';
    default:
      return '应用启动后会自动检查更新';
  }
}
