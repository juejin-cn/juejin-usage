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

/** 设置中的更新提示；无新版本时不显示额外说明。 */
export function updateStatusMessage(state: AutoUpdateState | null): string {
  if (!state) return '正在读取更新状态…';
  switch (state.status) {
    case 'unsupported':
      return state.message ?? '开发环境不支持自动更新';
    case 'checking':
      return '正在检查新版本…';
    case 'available':
    case 'skipped':
      return state.version ? `最新版本：v${state.version}` : '';
    case 'downloading':
      return `正在下载 v${state.version ?? ''}，完成后将自动重启安装`;
    case 'downloaded':
      return state.message
        ? `v${state.version ?? ''} 已下载，可手动重启安装`
        : `v${state.version ?? ''} 已下载，安装前不会中断服务`;
    case 'installing':
      return `v${state.version ?? ''} 已下载，正在重启并安装…`;
    case 'not-available':
      return '';
    case 'error':
      return '未能完成更新检查，可稍后重试';
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
