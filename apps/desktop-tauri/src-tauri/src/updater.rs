//! Auto-update (P4) via `tauri-plugin-updater`.
//!
//! Port of the Electron `auto-update.ts` state machine onto Tauri's updater
//! plugin. Tauri's updater speaks a minisigned JSON manifest (not
//! electron-updater's generic `.yml` feed), so the endpoints + pubkey are
//! release-time configuration in `tauri.conf.json > plugins.updater`; the
//! runtime logic here mirrors Electron:
//!
//!   check → auto-download → install + restart, with an on-disk marker
//!   (`auto-update.json`) recording the pending version and a watchdog that
//!   falls the "installing" state back to a retryable "downloaded" if the
//!   restart never happens. On the next launch, if the marker's pending
//!   version matches the running version, `completedVersion` is set so the
//!   UI can acknowledge a finished update.
//!
//! In development (`tauri dev`, `cfg!(dev)`) the whole thing degrades to
//! `unsupported`, matching Electron's `app.isPackaged` guard.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, Emitter, Manager, State, AppHandle};
use tauri_plugin_updater::{Error as UpdaterError, UpdaterExt};

const STATE_CHANGED: &str = "auto-update:state-changed";
const MARKER_FILE: &str = "auto-update.json";
const INSTALL_WATCHDOG_MS: u64 = 30_000;

/// Update status — mirrors `shared/auto-update.ts`'s `AutoUpdateStatus`.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    Unsupported,
    Idle,
    Checking,
    Downloading,
    Downloaded,
    Installing,
    NotAvailable,
    Error,
}

/// The state payload emitted on `auto-update:state-changed` and returned by
/// the `auto_update_*` commands. camelCase to match `AutoUpdateState`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateState {
    pub status: UpdateStatus,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_version: Option<String>,
}

fn dev_default_state() -> AutoUpdateState {
    AutoUpdateState {
        status: if cfg!(dev) {
            UpdateStatus::Unsupported
        } else {
            UpdateStatus::Idle
        },
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        version: None,
        percent: None,
        // Dev build degrades to "unsupported" like Electron's isPackaged guard.
        message: if cfg!(dev) {
            Some("开发环境不检查更新，请安装正式构建包后测试".to_string())
        } else {
            None
        },
        checked_at: None,
        completed_version: None,
    }
}

/// Tauri-managed updater control state.
pub struct UpdaterState {
    pub current: Mutex<AutoUpdateState>,
    /// A check/download/install cycle is in flight.
    pub busy: AtomicBool,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            current: Mutex::new(dev_default_state()),
            busy: AtomicBool::new(false),
        }
    }
}

// ---- marker (auto-update.json) --------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct UpdateMarker {
    pending_version: String,
}

fn marker_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve(MARKER_FILE, BaseDirectory::AppConfig)
        .ok()
}

fn write_marker(app: &AppHandle, version: &str) {
    let Some(path) = marker_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let marker = UpdateMarker {
        pending_version: version.to_string(),
    };
    let _ = std::fs::write(
        &path,
        format!("{}\n", serde_json::to_string(&marker).unwrap_or_default()),
    );
}

fn clear_marker(app: &AppHandle) {
    if let Some(path) = marker_path(app) {
        let _ = std::fs::remove_file(&path);
    }
}

/// Read back a completed update: the marker's pending version that now equals
/// the running version means the previous install took effect.
fn read_completed_version(app: &AppHandle) -> Option<String> {
    let Some(path) = marker_path(app) else {
        return None;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return None;
    };
    let marker: UpdateMarker = serde_json::from_str(&raw).ok()?;
    if marker.pending_version == env!("CARGO_PKG_VERSION") {
        Some(marker.pending_version)
    } else {
        clear_marker(app);
        None
    }
}

// ---- state helpers ----------------------------------------------------------

/// Mutate the managed updater state and (optionally) emit a snapshot to all
/// windows. State is resolved from `app` on each call so it never outlives a
/// `&AppHandle` (important when called from owned/async contexts).
fn with_state(app: &AppHandle, f: impl FnOnce(&mut AutoUpdateState), emit: bool) {
    let st: State<'_, UpdaterState> = app.state();
    let mut cur = st.current.lock().unwrap();
    f(&mut cur);
    let snapshot = cur.clone();
    drop(cur);
    if emit {
        let _ = app.emit(STATE_CHANGED, &snapshot);
    }
}

fn is_dev() -> bool {
    cfg!(dev)
}

/// Read-only snapshot of the download percent (0 when unset).
fn current_percent(app: &AppHandle) -> u32 {
    let st: State<'_, UpdaterState> = app.state();
    let guard = st.current.lock().unwrap();
    guard.percent.unwrap_or(0)
}
// ---- the check → download → install cycle ---------------------------------

/// Run the whole update cycle on the async runtime so the invoking command
/// returns immediately (progress arrives via `auto-update:state-changed`).
/// Idempotent while busy (a second call is a no-op).
fn spawn_update_cycle(app: AppHandle) {
    let st: State<'_, UpdaterState> = app.state();
    if st.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let busy_app = app.clone();
        run_cycle(app).await;
        let st: State<'_, UpdaterState> = busy_app.state();
        st.busy.store(false, Ordering::SeqCst);
    });
}

async fn run_cycle(app: AppHandle) {
    with_state(&app, |c| {
        c.status = UpdateStatus::Checking;
        c.percent = None;
        c.message = None;
        c.checked_at = Some(utc_now());
    }, true);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            with_state(&app, |c| {
                c.status = UpdateStatus::Error;
                c.message = Some(update_error_message(&e.to_string()));
            }, true);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            with_state(&app, |c| {
                c.status = UpdateStatus::Downloading;
                c.version = Some(version.clone());
                c.checked_at = Some(utc_now());
            }, true);

            let downloaded = Arc::new(Mutex::new(0u64));
            let app_clone = app.clone();
            let download_result: Result<(), UpdaterError> = update
                .download_and_install(
                    move |chunk, total| {
                        let mut dl = downloaded.lock().unwrap();
                        *dl += chunk as u64;
                        if let Some(total) = total {
                            if total == 0 {
                                return;
                            }
                            let pct = ((*dl).saturating_mul(100) / total) as u32;
                            let cur_now = current_percent(&app_clone);
                            if pct > cur_now {
                                with_state(&app_clone, |c| c.percent = Some(pct), true);
                            }
                        }
                    },
                    move || {
                        // Download finished; install happens inside the same call.
                    },
                )
                .await;

            match download_result {
                Ok(()) => {
                    // Install succeeded: record the pending version, mark
                    // installing, and request a restart. A watchdog rolls the
                    // state back to "downloaded" (retryable) if the restart
                    // does not happen in time.
                    write_marker(&app, &version);
                    with_state(&app, |c| {
                        c.status = UpdateStatus::Installing;
                        c.version = Some(version.clone());
                        c.percent = Some(100);
                        c.message = None;
                    }, true);
                    spawn_install_watchdog(app.clone());
                    app.request_restart();
                }
                Err(e) => {
                    with_state(&app, |c| {
                        c.status = UpdateStatus::Error;
                        c.version = Some(version.clone());
                        c.message = Some(update_error_message(&e.to_string()));
                    }, true);
                }
            }
        }
        Ok(None) => {
            with_state(&app, |c| {
                c.status = UpdateStatus::NotAvailable;
                c.checked_at = Some(utc_now());
            }, true);
        }
        Err(e) => {
            with_state(&app, |c| {
                c.status = UpdateStatus::Error;
                c.message = Some(update_error_message(&e.to_string()));
                c.checked_at = Some(utc_now());
            }, true);
        }
    }
}

/// If the process is still alive 30s after requesting the restart, the update
/// did not actually take — fall back to a retryable "downloaded" state.
/// Runs on the blocking pool (`tauri::async_runtime` has no `sleep`).
fn spawn_install_watchdog(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(INSTALL_WATCHDOG_MS));
        // Reaching here means the restart never happened in time.
        clear_marker(&app);
        with_state(&app, |c| {
            c.status = UpdateStatus::Downloaded;
            c.message = Some("自动重启未完成，请点击“更新并重启”再次尝试。".to_string());
        }, true);
    });
}

fn utc_now() -> String {
    // Coarse UTC timestamp without pulling in a date crate; used only as
    // `checkedAt` metadata.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

fn update_error_message(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "检查更新失败，请稍后重试".to_string()
    } else {
        trimmed.to_string()
    }
}

// ---- Tauri commands (the `window.tud` auto-update surface) -----------------

#[tauri::command]
pub fn auto_update_get_state(state: State<'_, UpdaterState>) -> AutoUpdateState {
    state.current.lock().unwrap().clone()
}

/// Kick off a check (+ auto-download + install). In dev this is a no-op.
#[tauri::command]
pub fn auto_update_check(app: AppHandle, state: State<'_, UpdaterState>) -> AutoUpdateState {
    if is_dev() {
        return state.current.lock().unwrap().clone();
    }
    spawn_update_cycle(app);
    state.current.lock().unwrap().clone()
}

/// Retry / install: re-runs the cycle (re-check + download + install +
/// restart). Guarded to retryable states, like Electron's `installDownloadedUpdate`.
#[tauri::command]
pub fn auto_update_install(app: AppHandle, state: State<'_, UpdaterState>) -> AutoUpdateState {
    if is_dev() {
        return state.current.lock().unwrap().clone();
    }
    let retryable = {
        let c = state.current.lock().unwrap();
        matches!(
            c.status,
            UpdateStatus::Downloaded | UpdateStatus::Installing | UpdateStatus::Error
        )
    };
    if retryable {
        spawn_update_cycle(app);
    }
    state.current.lock().unwrap().clone()
}

/// The renderer acknowledges a completed update; clear the marker + flag.
#[tauri::command]
pub fn auto_update_ack_completed(app: AppHandle) {
    clear_marker(&app);
    with_state(&app, |c| c.completed_version = None, false);
}

/// Wire up on launch: restore a completed-version flag from the marker, then
/// kick off the initial check when not in dev. Called from `setup`.
pub fn create(app: &AppHandle) {
    if let Some(completed) = read_completed_version(app) {
        with_state(app, |c| c.completed_version = Some(completed), false);
    }
    if !is_dev() {
        spawn_update_cycle(app.clone());
    }
}
