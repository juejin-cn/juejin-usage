import type { AutoUpdateState } from '../../shared/auto-update';

/** Preview-only portable update state for `pnpm dev:desktop` styling checks. */
const MOCK_PORTABLE_AVAILABLE_STATE: AutoUpdateState = {
  status: 'available',
  currentVersion: '0.1.12',
  version: '0.1.13',
  message: '点击前往 Gitee Release 下载便携版',
  checkedAt: new Date().toISOString(),
};

/**
 * When `VITE_MOCK_PORTABLE_UPDATE=1` (dev only), force the portable “有新版本”
 * UI so Settings / toolbar styles can be checked without a packaged build.
 */
export function resolveAutoUpdateStateForUi(
  state: AutoUpdateState | null,
): AutoUpdateState | null {
  if (!import.meta.env.DEV) return state;
  if (import.meta.env.VITE_MOCK_PORTABLE_UPDATE !== '1') return state;
  return MOCK_PORTABLE_AVAILABLE_STATE;
}
