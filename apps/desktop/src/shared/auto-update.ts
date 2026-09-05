export type AutoUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'skipped'
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
export const AUTO_UPDATE_START_CHANNEL = 'auto-update:start';
export const AUTO_UPDATE_SKIP_CHANNEL = 'auto-update:skip';
export const AUTO_UPDATE_INSTALL_CHANNEL = 'auto-update:install';
export const AUTO_UPDATE_ACK_COMPLETED_CHANNEL = 'auto-update:ack-completed';
export const AUTO_UPDATE_STATE_CHANGED_CHANNEL = 'auto-update:state-changed';

/** 已下载可重试，或正在安装（按钮可见但禁用，超时回退后可点）。 */
export function shouldOfferUpdateRestart(status: AutoUpdateStatus): boolean {
  return status === 'downloaded' || status === 'installing';
}

/** 只有真正开始下载后才展示进度；available 状态要留给用户选择。 */
export function isUpdateDownloadInProgress(status: AutoUpdateStatus): boolean {
  return status === 'downloading';
}

export function shouldOfferUpdateDownload(status: AutoUpdateStatus): boolean {
  return status === 'available';
}

export function shouldOfferUpdateSkip(status: AutoUpdateStatus): boolean {
  return status === 'available' || status === 'downloaded';
}

export function updateDownloadPercent(percent: number | undefined): number {
  return Math.round(Math.max(0, Math.min(100, percent ?? 0)));
}

export function getUpdateToolbarAction(state: AutoUpdateState | null): {
  label: string;
  request: 'download' | 'install' | 'check' | null;
} | null {
  switch (state?.status) {
    case 'available':
      return { label: '下载并更新', request: 'download' };
    case 'downloading':
      return {
        label: state.percent == null
          ? '正在下载…'
          : `下载 ${updateDownloadPercent(state.percent)}%`,
        request: null,
      };
    case 'downloaded':
      return { label: '重启并更新', request: 'install' };
    case 'installing':
      return { label: '正在重启…', request: null };
    case 'error':
      return { label: '重试更新', request: 'check' };
    default:
      return null;
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

export function createSkippedUpdateState(
  currentVersion: string,
  version: string,
  checkedAt?: string,
): AutoUpdateState {
  return {
    status: 'skipped',
    currentVersion,
    version,
    checkedAt,
  };
}

export function isSkippedUpdateVersion(
  version: string,
  skippedVersion: string | undefined,
): boolean {
  return Boolean(skippedVersion) && version === skippedVersion;
}
