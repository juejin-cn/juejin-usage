/** Optional native surface. Browser/CLI and Electron retain their own behavior. */
export interface TauriDesktopBridge {
  runtime: 'tauri';
  setThemeMode: (mode: 'system' | 'light' | 'dark') => Promise<void>;
  onJuejinLinkResult: (callback: (result: { ok: boolean; message?: string }) => void) => () => void;
}

export function getTauriDesktopBridge(): TauriDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { tud?: TauriDesktopBridge }).tud;
  return bridge?.runtime === 'tauri' ? bridge : null;
}

export function localJuejinIdentity(config: { juejin: {
  userId: string | null; originUserId: string | null;
  userName: string | null; avatarLarge: string | null;
} }) {
  const linked = Boolean(config.juejin.userId);
  return {
    authStatus: linked ? 'authenticated' as const : 'unauthenticated' as const,
    userId: linked ? config.juejin.originUserId || config.juejin.userId : null,
    userName: linked ? config.juejin.userName ?? '' : '',
    avatarLarge: linked ? config.juejin.avatarLarge ?? '' : '',
  };
}
