/**
 * Tauri implementation of the `window.tud` bridge.
 *
 * The Electron app exposes `window.tud` via a preload script
 * (apps/desktop/src/preload/index.ts). The renderer was copied verbatim and
 * still reads `window.tud` — so instead of touching every call site, we inject
 * a Tauri-backed object with the exact same shape at startup (see main.tsx /
 * pet.tsx calling `initTudBridge()` before render).
 *
 * Mapping:
 *  - `tud.api.request` → fetch() against the loopback Node sidecar (P1). P0
 *    points at a placeholder port so the dashboard shows "recovering".
 *  - events (`onDataSynced`, `onThemeChanged`, …) → Tauri `listen` on the same
 *    channel names preload used; Rust `emit`s them.
 *  - everything else → `invoke` on a Rust command of the same name.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isThemeMode,
  type Theme,
  type ThemeMode,
} from "../shared/theme";
import {
  isDashboardRange,
  type DashboardRange,
} from "../shared/dashboard-range";
import { type AutoUpdateState } from "../shared/auto-update";

type PetAnimation = "idle" | "running-left" | "running-right";

interface PetPreferences {
  enabled: boolean;
  selectedPetId: string;
  position?: { x: number; y: number };
  scale: number;
  frameIntervalMs: number;
  autoMoveEnabled: boolean;
  autoMoveIntervalMinutes: number;
}

/**
 * Loopback base URL of the Node sidecar. P0 uses a fixed placeholder port so
 * requests fail gracefully; P1 resolves it from the `sidecar_url` command once
 * the sidecar is actually spawned.
 */
let sidecarUrl: string | null = null;

async function resolveSidecarUrl(): Promise<string> {
  if (sidecarUrl) return sidecarUrl;
  try {
    sidecarUrl = (await invoke<string>("sidecar_url")) ?? "";
  } catch {
    sidecarUrl = "http://127.0.0.1:8462";
  }
  return sidecarUrl;
}

/** Generic listener wiring for Tauri events that just forward a typed payload. */
function listenOnce(
  channel: string,
  validate: (payload: unknown) => boolean,
  callback: (payload: unknown) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
  };
  listen<unknown>(channel, (event) => {
    if (validate(event.payload)) {
      callback(event.payload);
    }
  }).then((fn) => {
    unlisten = fn;
    settle();
  });
  return () => {
    settle();
    void unlisten?.();
  };
}

function listenRaw(channel: string, callback: () => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
  };
  listen<unknown>(channel, () => callback()).then((fn) => {
    unlisten = fn;
    settle();
  });
  return () => {
    settle();
    void unlisten?.();
  };
}

function createTudBridge() {
  const tud = {
    version: () => invoke<string>("version"),
    // Synchronous in preload (a property); keep it a property reading a cached
    // value is not possible without async, so callers that read it synchronously
    // (WindowTitleControls) fall back to the awaited value below. Renderer code
    // reads `window.tud.platform` synchronously, so we must give a value now:
    platform: "win32" as const,

    minimize: () => invoke("window_minimize"),
    toggleMaximize: () => invoke("window_toggle_maximize"),
    close: () => invoke("window_close"),
    showMainWindow: () => invoke("window_show_main"),
    quit: () => invoke("app_quit"),

    getAutoUpdateState: (): Promise<AutoUpdateState> =>
      invoke<AutoUpdateState>("auto_update_get_state"),
    checkForUpdates: (): Promise<AutoUpdateState> =>
      invoke<AutoUpdateState>("auto_update_check"),
    installDownloadedUpdate: (): Promise<AutoUpdateState> =>
      invoke<AutoUpdateState>("auto_update_install"),
    acknowledgeUpdateCompleted: (): Promise<void> =>
      invoke<void>("auto_update_ack_completed"),
    onAutoUpdateStateChanged: (
      callback: (state: AutoUpdateState) => void,
    ) =>
      listenOnce("auto-update:state-changed", (p) => p != null && typeof p === "object", (p) =>
        callback(p as AutoUpdateState),
      ),

    copyImageToClipboard: (dataUrl: string): Promise<boolean> =>
      invoke<boolean>("copy_image_to_clipboard", { dataUrl }),

    openExternal: (url: string): Promise<{ ok: boolean; message?: string }> =>
      invoke("open_external", { url }),

    resizeTrayPopover: (height: number) =>
      invoke("resize_tray_popover", { height }),

    getDashboardRange: (): Promise<DashboardRange> =>
      invoke<DashboardRange>("dashboard_range_get"),
    setDashboardRange: (range: DashboardRange): Promise<DashboardRange> =>
      invoke("dashboard_range_set", { range }),
    onDashboardRange: (callback: (range: DashboardRange) => void) =>
      listenOnce("dashboard-range:changed", (p) => isDashboardRange(p), (p) =>
        callback(p as DashboardRange),
      ),

    getTheme: (): Promise<{ mode: ThemeMode; resolved: Theme }> =>
      invoke("theme_get"),
    setThemeMode: (mode: ThemeMode) => invoke("theme_set", { mode }),
    onThemeChanged: (
      callback: (state: { mode: ThemeMode; resolved: Theme }) => void,
    ) =>
      listenOnce(
        "theme:changed",
        (p) =>
          p != null &&
          typeof p === "object" &&
          isThemeMode((p as { mode?: unknown }).mode),
        (p) => callback(p as { mode: ThemeMode; resolved: Theme }),
      ),

    getOpenAtLogin: (): Promise<boolean> => invoke("autostart_get"),
    setOpenAtLogin: (enabled: boolean): Promise<boolean> =>
      invoke("autostart_set", { enabled }),
    getLaunchHidden: (): Promise<boolean> => invoke("autostart_get_hidden"),
    setLaunchHidden: (hidden: boolean): Promise<boolean> =>
      invoke("autostart_set_hidden", { hidden }),

    getDesktopPet: (): Promise<PetPreferences> =>
      invoke("desktop_pet_get"),
    setDesktopPetEnabled: (enabled: boolean): Promise<boolean> =>
      invoke("desktop_pet_set_enabled", { enabled }),
    setSelectedDesktopPet: (selectedPetId: string): Promise<PetPreferences> =>
      invoke("desktop_pet_set_selected", { selectedPetId }),
    setDesktopPetPreferences: (changes: {
      scale?: number;
      frameIntervalMs?: number;
      autoMoveEnabled?: boolean;
      autoMoveIntervalMinutes?: number;
    }): Promise<PetPreferences> =>
      invoke("desktop_pet_set_preferences", { changes }),
    setDesktopPetMouseIgnored: (ignored: boolean) =>
      invoke("desktop_pet_set_mouse_ignored", { ignored }),
    beginDesktopPetDrag: () => invoke("desktop_pet_begin_drag"),
    endDesktopPetDrag: () => invoke("desktop_pet_end_drag"),
    // Tauri's webview has no `context-menu` event (Electron's main did it
    // automatically); the renderer reports a right-click and Rust pops the
    // native menu at the cursor.
    showPetContextMenu: (x: number, y: number) =>
      invoke("pet_show_context_menu", { x, y }),
    onDesktopPetAnimation: (callback: (animation: PetAnimation) => void) =>
      listenOnce(
        "desktop-pet:animation",
        (p) =>
          p === "idle" || p === "running-left" || p === "running-right",
        (p) => callback(p as PetAnimation),
      ),
    onDesktopPetPreferences: (callback: (preferences: PetPreferences) => void) =>
      listenOnce(
        "desktop-pet:preferences",
        (p) => p != null && typeof p === "object",
        (p) => callback(p as PetPreferences),
      ),

    onMaximized: (callback: (isMaximized: boolean) => void) =>
      listenOnce("window:is-maximized", (p) => typeof p === "boolean", (p) =>
        callback(Boolean(p)),
      ),

    api: {
      request: async (
        path: string,
        init?: {
          method?: string;
          body?: string;
          headers?: Record<string, string>;
        },
      ): Promise<{ status: number; body: unknown }> => {
        const base = await resolveSidecarUrl();
        const url = base + path;
        const res = await fetch(url, {
          method: init?.method,
          body: init?.body,
          headers: init?.headers,
        });
        let body: unknown;
        const text = await res.text();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        return { status: res.status, body };
      },
    },

    onDataSynced: (callback: () => void) =>
      listenRaw("tud:data-synced", callback),

    onOpenSettings: (
      callback: (detail?: {
        tab?: "sync" | "pet" | "app";
        reloadConfig?: boolean;
        loginSuccess?: boolean;
        loginError?: string;
      }) => void,
    ) =>
      listenOnce("app:open-settings", (p) => p == null || typeof p === "object", (p) =>
        callback(
          p && typeof p === "object"
            ? (p as {
                tab?: "sync" | "pet" | "app";
                reloadConfig?: boolean;
                loginSuccess?: boolean;
                loginError?: string;
              })
            : undefined,
        ),
      ),

    onJuejinLinkResult: (
      callback: (detail: { ok: boolean; message?: string }) => void,
    ) =>
      listenOnce("app:juejin-link-result", (p) => p == null || typeof p === "object", (p) => {
        const raw = (p ?? {}) as { ok?: unknown; message?: unknown };
        callback({
          ok: raw.ok === true,
          message:
            typeof raw.message === "string" && raw.message.trim()
              ? raw.message.trim()
              : undefined,
        });
      }),

    onRuntimeNotice: (
      callback: (detail: { kind: "config-reset"; tokenSalvaged: boolean }) => void,
    ) =>
      listenOnce("app:runtime-notice", (p) => p != null && typeof p === "object", (p) => {
        const raw = p as { kind?: unknown; tokenSalvaged?: unknown };
        if (raw.kind !== "config-reset") return;
        callback({ kind: "config-reset", tokenSalvaged: raw.tokenSalvaged === true });
      }),
  };

  return tud;
}

let initialized = false;

/**
 * Install the Tauri-backed `window.tud`. Must run before the first render so
 * the copied renderer finds the bridge it expects. Idempotent.
 */
export function initTudBridge(): void {
  if (initialized) return;
  initialized = true;
  (window as unknown as { tud: unknown }).tud = createTudBridge();

  // `platform` is read synchronously by the renderer; fetch the real value from
  // Rust and patch the property as soon as it resolves.
  void invoke<string>("platform")
    .then((p) => {
      const target = (window as unknown as { tud?: { platform?: string } }).tud;
      if (target) target.platform = p;
    })
    .catch(() => {
      /* leave the "win32" default; renderers guard with optional chaining */
    });
}
