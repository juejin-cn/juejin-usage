import type { TauriUpdateSnapshot } from './tauri-desktop';

/** Match the Electron toolbar while using Tauri's verified download/check flow. */
export function getTauriUpdateToolbarAction(state: TauriUpdateSnapshot | null): {
  label: string;
  request: 'install' | 'check' | null;
} | null {
  switch (state?.status) {
    case 'available':
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
