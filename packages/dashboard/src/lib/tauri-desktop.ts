export interface TauriPetPreferences {showTrayUsage:boolean;trayUsageMode:'both'|'tokens'|'cost';enabled:boolean;selectedPetId:string;scale:number;frameIntervalMs:number;autoMoveEnabled:boolean;autoMoveIntervalMinutes:number;syncFeedbackEnabled:boolean;syncFeedbackDurationSec:number;}
export interface TauriStartupSettings { supported: boolean; openAtLogin: boolean; launchHidden: boolean; }
export interface TauriUpdateSnapshot {status:'disabled'|'idle'|'checking'|'available'|'downloaded'|'notAvailable'|'downloading'|'installing'|'error';currentVersion:string;downloadedBytes?:number;totalBytes?:number|null;completedVersion?:string|null;availableVersion:string|null;message:string|null;}
export interface TauriRuntimeSnapshot { phase: 'starting' | 'ready' | 'recovering' | 'failed' | 'stopped'; attempt: number; reason: string | null; }
/** Optional native surface. Browser/CLI and Electron retain their own behavior. */
export interface TauriDesktopBridge {
  runtime: 'tauri';
  takePendingSettings: () => Promise<string | null>;
  getPetPreferences: () => Promise<TauriPetPreferences>;
  setPetPreferences: (changes: Partial<TauriPetPreferences>) => Promise<TauriPetPreferences>;
  onPetPreferences: (callback: (value:TauriPetPreferences) => void) => () => void;
  openPetDirectory: () => Promise<void>;
  getStartupSettings: () => Promise<TauriStartupSettings>;
  setStartupSettings: (changes: {openAtLogin?: boolean; launchHidden?: boolean}) => Promise<TauriStartupSettings>;
  onStartupSettings: (callback: (value: TauriStartupSettings) => void) => () => void;
  copyImageToClipboard: (dataUrl: string) => Promise<boolean>;
  platform: 'darwin' | 'win32' | 'linux';
  showMainWindow: () => Promise<void>;
  resizeTrayPopover: (height: number) => Promise<void>;
  startDragging: () => Promise<void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onMaximized: (callback: (maximized: boolean) => void) => () => void;
  acknowledgeUpdateCompleted: () => Promise<void>;
  getUpdateStatus: () => Promise<TauriUpdateSnapshot>;
  checkForUpdates: () => Promise<TauriUpdateSnapshot>;
  installUpdate: () => Promise<void>;
  onUpdateStatus: (callback:(status:TauriUpdateSnapshot)=>void) => () => void;
  getRuntimeStatus: () => Promise<TauriRuntimeSnapshot>;
  retryRuntime: () => Promise<void>;
  getRuntimeNotice: () => Promise<{id:number;tokenSalvaged:boolean} | null>;
  acknowledgeRuntimeNotice: (id:number) => Promise<void>;
  onRuntimeStatus: (callback: (status: TauriRuntimeSnapshot) => void) => () => void;
  onRuntimeNotice: (callback: () => void) => () => void;
  onShellError: (callback: (message: string) => void) => () => void;
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
