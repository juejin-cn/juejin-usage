export type AutoUpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
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

/** 发现新版本或正在下载：顶栏展示进度，而不是重启按钮。 */
export function isUpdateDownloadInProgress(status: AutoUpdateStatus): boolean {
  return status === 'available' || status === 'downloading';
}

export function updateDownloadPercent(percent: number | undefined): number {
  return Math.round(Math.max(0, Math.min(100, percent ?? 0)));
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
