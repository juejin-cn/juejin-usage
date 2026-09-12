export type AutoUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error';

export type AutoUpdateState = {
  status: AutoUpdateStatus;
  currentVersion: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message?: string;
  checkedAt?: string;
  completedVersion?: string;
};

export const AUTO_UPDATE_GET_STATE_CHANNEL = 'auto-update:get-state';
export const AUTO_UPDATE_CHECK_CHANNEL = 'auto-update:check';
export const AUTO_UPDATE_INSTALL_CHANNEL = 'auto-update:install';
export const AUTO_UPDATE_ACK_COMPLETED_CHANNEL = 'auto-update:ack-completed';
export const AUTO_UPDATE_STATE_CHANGED_CHANNEL = 'auto-update:state-changed';

/** 已下载可重试，或正在安装（按钮可见但禁用，超时回退后可点）。 */
export function shouldOfferUpdateRestart(status: AutoUpdateStatus): boolean {
  return status === 'downloaded' || status === 'installing';
}

/** 发现新版本后立即进入自动下载状态。 */
export function isUpdateDownloadInProgress(status: AutoUpdateStatus): boolean {
  return status === 'downloading';
}

export function updateDownloadPercent(percent: number | undefined): number {
  return Math.round(Math.max(0, Math.min(100, percent ?? 0)));
}

export function getUpdateToolbarAction(state: AutoUpdateState | null): {
  label: string;
  request: 'install' | 'check' | null;
} | null {
  switch (state?.status) {
    case 'downloading':
      return {
        label: state.percent == null
          ? '正在下载…'
          : `下载 ${updateDownloadPercent(state.percent)}%`,
        request: null,
      };
    case 'downloaded':
      return { label: '更新并重启', request: 'install' };
    case 'installing':
      return { label: '正在重启…', request: null };
    case 'error':
      return { label: '重试更新', request: 'check' };
    default:
      return null;
  }
}

/** 有可用更新时返回独立版本行的值，无新版本时隐藏该行。 */
export function getLatestUpdateVersion(state: AutoUpdateState | null): string | null {
  if (!state || !['downloading', 'downloaded', 'installing'].includes(state.status)) return null;
  return state.version || null;
}

/** 版本号单独对齐展示，下载和重启进度只在操作按钮中呈现。 */
export function updateStatusMessage(state: AutoUpdateState | null): string {
  if (!state) return '正在读取更新状态…';
  switch (state.status) {
    case 'unsupported':
      return state.message ?? '开发环境不支持自动更新';
    case 'checking':
      return '正在检查新版本…';
    case 'downloading':
    case 'downloaded':
    case 'installing':
    case 'not-available':
      return '';
    case 'error':
      return '未能完成更新，可稍后重试';
    default:
      return '应用启动后会自动检查更新';
  }
}

/** 构建自动重启失败和手动重试共用的“已下载”可恢复状态。 */
export function createDownloadedUpdateState(
  currentVersion: string,
  version: string,
  checkedAt?: string,
  message?: string,
): AutoUpdateState {
  return {
    status: 'downloaded',
    currentVersion,
    version,
    percent: 100,
    checkedAt,
    ...(message ? { message } : {}),
  };
}
