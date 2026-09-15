//! Juejin Usage — Tauri backend (P0: scaffold + data-core command surface).
//!
//! The renderer was copied from the Electron app and still talks to a
//! `window.tud` bridge (see src/renderer/bridge.ts). That bridge translates
//! every member into a Tauri command of the same snake_case name plus Tauri
//! events. This module registers that command surface.
//!
//! P0 implements the commands needed to render the dashboard and to hold the
//! UI's chrome state (theme, dashboard range, window controls). Commands that
//! belong to later phases (sidecar lifecycle, tray, desktop pet, auto-update,
//! deep-link, autostart) are registered with safe defaults so the whole bridge
//! resolves without "command not found"; their real behavior lands in P1+.

use tauri::{AppHandle, Emitter, Manager, State, Window};

mod dashboard_range;
mod clipboard;
mod deeplink;
mod instance;
mod pet;
mod prefs;
mod sidecar;
mod theme;
mod tray;
mod updater;

use crate::dashboard_range::DashboardRangeState;
use crate::pet::PetState;
use crate::prefs::PrefsState;
use crate::sidecar::{sidecar_url, SidecarState};
use crate::theme::ThemeState;
use crate::updater::UpdaterState;
use std::sync::Arc;

// ---- platform / version -----------------------------------------------------

/// Last foreground poke-sync, as unix epoch seconds; used to debounce the
/// "restore fast poll + refresh stale data" poke when the main window regains
/// focus (port of Electron's `pokeSyncOnForeground`, 30s debounce).
static LAST_POKE_SYNC: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn unix_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Emit the main window's maximize state on `window:is-maximized` — the
/// channel the renderer's title-bar maximize indicator listens on. Tauri's
/// `WindowEvent` has no "maximized" variant, so we recompute on toggle/resize/
/// focus and re-emit (port of Electron's `maximize`/`unmaximize` handlers).
fn emit_main_maximized(window: &Window) {
    let app = window.app_handle();
    let maximized = window.is_maximized().unwrap_or(false);
    let _ = app.emit("window:is-maximized", maximized);
}

/// Debounced foreground poke-sync: when the main window regains focus and the
/// last poke was >30s ago, kick the sidecar so data catches up (port of
/// Electron's `browser-window-focus` → `pokeSyncOnForeground`).
fn poke_sync_on_foreground(app: &AppHandle) {
    let now = unix_epoch_secs();
    let last = LAST_POKE_SYNC.load(std::sync::atomic::Ordering::SeqCst);
    if now.saturating_sub(last) < 30 {
        return;
    }
    LAST_POKE_SYNC.store(now, std::sync::atomic::Ordering::SeqCst);
    let state = app.state::<SidecarState>();
    sidecar::trigger_sync(&state);
}

/// True when the process was launched with `--hidden` (the autostart
/// tray-only start flag; see `apply_os_autostart`). Port of Electron's
/// `process.argv.includes('--hidden')` `launchHidden` detection.
fn has_hidden_arg() -> bool {
    std::env::args().any(|a| a == "--hidden")
}

fn map_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

#[tauri::command]
fn platform() -> &'static str {
    map_platform()
}

#[tauri::command]
fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ---- window chrome ----------------------------------------------------------

#[tauri::command]
fn window_minimize(window: Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn window_toggle_maximize(window: Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

/// P0: `window_close` hides to a (not-yet-existing) tray. The real
/// close-to-tray / quit-on-true-exit logic lands in P2 (window.rs).
#[tauri::command]
fn window_close(window: Window) {
    let _ = window.hide();
}

#[tauri::command]
fn window_show_main(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

#[tauri::command]
fn app_quit(app: AppHandle, sidecar: State<'_, SidecarState>) {
    // Stop the Node sidecar before the app exits so the loopback server goes
    // down with us. (The OS also reaps the child on process exit.)
    sidecar::stop(&sidecar);
    app.exit(0);
}

// ---- external links / clipboard --------------------------------------------

/// Result shape of `open_external`, mirroring Electron's `shell:open-external`
/// IPC (`{ ok, message? }`). The renderer's `openExternal` promise resolves to
/// this object and reads `.ok` — returning a bare `Result<(), String>` would
/// make every success read as `ok: undefined` (falsy).
#[derive(serde::Serialize)]
struct OpenExternalResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// Open an http(s) URL in the OS default browser, validating the protocol so
/// `juejin-usage://` or `file://` can't leak through. Mirrors
/// `registerOpenExternalIpc` in Electron's `DesktopWindow.ts`.
#[tauri::command]
fn open_external(url: String, app: AppHandle) -> OpenExternalResult {
    let Ok(parsed) = url::Url::parse(&url) else {
        return OpenExternalResult { ok: false, message: Some("INVALID_URL".to_string()) };
    };
    if !(parsed.scheme() == "http" || parsed.scheme() == "https") {
        return OpenExternalResult { ok: false, message: Some("INVALID_PROTOCOL".to_string()) };
    }
    use tauri_plugin_opener::OpenerExt;
    let target = parsed.to_string();
    match app.opener().open_url(&target, None::<&str>) {
        Ok(()) => OpenExternalResult { ok: true, message: None },
        Err(e) => OpenExternalResult { ok: false, message: Some(e.to_string()) },
    }
}

// ---- tray popover -----------------------------------------------------------
// `resize_tray_popover` now lives in `tray.rs` (P2) and is registered below.

// ---- theme ------------------------------------------------------------------
// See crate::theme for the state type + emit helpers.

#[tauri::command]
fn theme_get(state: State<'_, ThemeState>) -> Result<theme::ThemeSnapshot, String> {
    Ok(state.snapshot())
}

#[tauri::command]
fn theme_set(
    app: AppHandle,
    state: State<'_, ThemeState>,
    prefs: State<'_, PrefsState>,
    mode: String,
) {
    if !theme::is_theme_mode(&mode) {
        return;
    }
    let next = state.set_mode(&mode);
    // P2: persist the choice so the next launch restores it.
    let _ = prefs.patch(|p| p.theme_mode = Some(mode.clone()));
    let _ = app.emit("theme:changed", theme::ThemeSnapshot {
        mode: next.mode.clone(),
        resolved: next.resolved.clone(),
    });
}

// ---- dashboard range --------------------------------------------------------

#[tauri::command]
fn dashboard_range_get(state: State<'_, DashboardRangeState>) -> String {
    state.current()
}

#[tauri::command]
fn dashboard_range_set(
    app: AppHandle,
    state: State<'_, DashboardRangeState>,
    prefs: State<'_, PrefsState>,
    range: String,
) -> String {
    let next = state.set(&range);
    // P2: persist so the pet / tray-popover window (separate origin) can follow.
    let _ = prefs.patch(|p| p.dashboard_range = Some(next.clone()));
    let _ = app.emit("dashboard-range:changed", next.clone());
    next
}

// ---- autostart (P2) ---------------------------------------------------------
// Real behavior: the OS login-item is managed by `tauri-plugin-autostart`
// (its `AutoLaunchManager` is `manage`d by the plugin at init); the prefs
// (open_at_login / launch_hidden) persist to `desktop-prefs.json`. This mirrors
// Electron's `autostart.ts` — the stored pref and the OS registration move
// together so a relaunch restores the last choice.

use tauri_plugin_autostart::ManagerExt;

/// Apply the OS login item to match `open_at_login` (+ `launch_hidden` arg).
fn apply_os_autostart(
    app: &AppHandle,
    open_at_login: bool,
    launch_hidden: bool,
) {
    let autostart = app.autolaunch();
    // Pass `--hidden` when we should launch silent; Tauri forwards it so a
    // tray-only start can be detected on next launch (P2 launchHidden).
    if open_at_login {
        let _ = autostart.enable();
    } else {
        let _ = autostart.disable();
    }
    let _ = launch_hidden; // arg wiring lands with P3 launch-hidden detection
}

#[tauri::command]
fn autostart_get(app: AppHandle, state: State<'_, PrefsState>) -> bool {
    let prefs = state.get();
    apply_os_autostart(&app, prefs.open_at_login, prefs.launch_hidden);
    prefs.open_at_login
}

#[tauri::command]
fn autostart_set(app: AppHandle, state: State<'_, PrefsState>, enabled: bool) -> bool {
    let next = state.patch(|p| p.open_at_login = enabled);
    apply_os_autostart(&app, next.open_at_login, next.launch_hidden);
    enabled
}

#[tauri::command]
fn autostart_get_hidden(state: State<'_, PrefsState>) -> bool {
    state.get().launch_hidden
}

#[tauri::command]
fn autostart_set_hidden(
    app: AppHandle,
    state: State<'_, PrefsState>,
    hidden: bool,
) -> bool {
    let next = state.patch(|p| p.launch_hidden = hidden);
    apply_os_autostart(&app, next.open_at_login, next.launch_hidden);
    hidden
}

// ---- desktop pet (P3) -------------------------------------------------------
// Real behavior lives in `pet.rs` (transparent always-on-top window + cursor
// follow + Bézier auto-move + prefs sync). The command surface matches the
// `window.tud` bridge; `pet_show_context_menu` is the renderer's right-click
// hook (Tauri's `WebviewEvent` has no context-menu variant, so the pet renderer
// pops the native menu via this command).

// ---- auto update (P4) -------------------------------------------------------
// Real behavior lives in `updater.rs` (tauri-plugin-updater state machine +
// marker rollback + install watchdog). The `auto_update_*` commands and the
// `UpdaterState` are re-exported via `crate::updater` and registered below.

// ---- entry ------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // P4: auto-update + process control (restart after install). The
        // updater reads its endpoint/pubkey from `plugins.updater` in
        // `tauri.conf.json`; process provides `request_restart`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ThemeState::default())
        .manage(DashboardRangeState::default())
        .manage(PrefsState::default())
        .manage(SidecarState::default())
        .manage(Arc::new(PetState::default()))
        .manage(UpdaterState::default())
        // P3: dispatch the desktop-pet context-menu items (shown via
        // `pet_show_context_menu`).
        .on_menu_event(|app, event| pet::on_pet_menu_event(app, &event))
        .setup(|app| {
            // Single-instance guard: a second launch must not collide with the
            // first on the runtime owner. On failure (another instance holds
            // the lock) log and exit — we are the second instance.
            if let Err(msg) = instance::acquire(app.handle()) {
                eprintln!("[tud-desktop] single-instance: {msg}");
                std::process::exit(0);
            }

            // P2: load the on-disk prefs and hydrate the in-memory theme /
            // dashboard-range state from them (Electron restores the persisted
            // theme mode before any window is registered).
            let prefs = {
                let file = app
                    .path()
                    .resolve("desktop-prefs.json", tauri::path::BaseDirectory::AppConfig)
                    .unwrap_or_default();
                if let Some(dir) = file.parent() {
                    app.state::<PrefsState>().load_from(dir.to_path_buf());
                    app.state::<PrefsState>().get()
                } else {
                    PrefsState::default().get()
                }
            };

            if let Some(mode) = &prefs.theme_mode {
                app.state::<ThemeState>().set_mode(mode);
            }
            if let Some(range) = &prefs.dashboard_range {
                app.state::<DashboardRangeState>().set(range);
            }

            // P1: spawn the Node sidecar (data core). Failures are non-fatal —
            // the frontend shows "recovering" until the sidecar reports its port.
            let state = app.state::<SidecarState>();
            let handle = app.handle().clone();
            let _ = sidecar::start(&state, handle);

            // P2: create the tray icon + popover (keeps the app alive after the
            // main window closes; quit goes through the tray "退出").
            tray::create(app.handle());

            // P3: reconcile the desktop-pet window with the persisted pref and
            // start the wander (if auto-move is on).
            pet::create(app.handle());

            // P4: restore the completed-update flag from the marker and kick
            // off the initial check (skipped in dev).
            updater::create(app.handle());

            // P5: apply a cold-start `juejin-usage://` process arg (Windows
            // parity); the definitive result is delivered to the renderer on
            // `app:juejin-link-result`.
            deeplink::create(app.handle());

            // P2: `--hidden` (tray-only launch) — the autostart pref launches the
            // app silent. Tauri already auto-created the `main` window (and the
            // pet, if enabled) before setup finished, so hide them here to
            // match Electron's `launchHidden` (a real user click on the tray
            // brings the main window back).
            if has_hidden_arg() {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
                if let Some(pet_win) = app.get_webview_window(pet::PET_LABEL) {
                    let _ = pet_win.hide();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // P0: closing the last window keeps the app alive (tray-resident
            // model). P2 wires the real close-to-tray + quit behavior.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
                return;
            }
            // Only drive maximize/focus emission for the main window (the
            // tray-popover and pet windows never maximize and have no
            // title-bar indicator).
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true) => {
                    emit_main_maximized(window);
                    if let tauri::WindowEvent::Focused(true) = event {
                        poke_sync_on_foreground(window.app_handle());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            platform,
            version,
            sidecar_url,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_show_main,
            app_quit,
            open_external,
            clipboard::copy_image_to_clipboard,
            tray::resize_tray_popover,
            theme_get,
            theme_set,
            dashboard_range_get,
            dashboard_range_set,
            autostart_get,
            autostart_set,
            autostart_get_hidden,
            autostart_set_hidden,
            pet::desktop_pet_get,
            pet::desktop_pet_set_enabled,
            pet::desktop_pet_set_selected,
            pet::desktop_pet_set_preferences,
            pet::desktop_pet_set_mouse_ignored,
            pet::desktop_pet_begin_drag,
            pet::desktop_pet_end_drag,
            pet::pet_show_context_menu,
            updater::auto_update_get_state,
            updater::auto_update_check,
            updater::auto_update_install,
            updater::auto_update_ack_completed,
            deeplink::deeplink_apply
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
