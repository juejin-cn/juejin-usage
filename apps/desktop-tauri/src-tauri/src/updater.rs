//! Updates are disabled unless a release build embeds an explicit key/feed.
//! Checks and installation are separate user actions; the plugin verifies bytes.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: String,
    pub current_version: String,
    pub available_version: Option<String>,
    pub message: Option<String>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            status: "disabled".into(),
            current_version: env!("CARGO_PKG_VERSION").into(),
            available_version: None,
            message: None,
        }
    }
}
#[derive(Default)]
pub struct UpdateState {
    snapshot: Mutex<Snapshot>,
    pending: Mutex<Option<tauri_plugin_updater::Update>>,
    busy: AtomicBool,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl UpdateState {
    fn enter(&self) -> Result<Busy<'_>, String> {
        if self.busy.swap(true, Ordering::SeqCst) {
            Err("更新操作正在进行".into())
        } else {
            Ok(Busy(&self.busy))
        }
    }
    fn publish(
        &self,
        app: &tauri::AppHandle,
        status: &str,
        version: Option<String>,
        message: Option<&str>,
    ) -> Snapshot {
        let mut snapshot = self.snapshot.lock().unwrap();
        snapshot.status = status.into();
        snapshot.available_version = version;
        snapshot.message = message.map(String::from);
        let next = snapshot.clone();
        let _ = app.emit("app:update-state", &next);
        next
    }
}
pub fn supported(app: &tauri::AppHandle) -> bool {
    !cfg!(debug_assertions)
        && app.config().plugins.0.contains_key("updater")
        && (!cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some())
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if app.config().plugins.0.contains_key("updater") {
        app.plugin(tauri_plugin_updater::Builder::new().build())?;
    }
    if supported(app) {
        app.state::<UpdateState>().snapshot.lock().unwrap().status = "idle".into();
    }
    Ok(())
}
#[tauri::command]
pub fn update_status(state: State<'_, UpdateState>) -> Snapshot {
    state.snapshot.lock().unwrap().clone()
}
#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Snapshot, String> {
    if !supported(&app) {
        return Err("此安装包未启用自动更新".into());
    }
    let _busy = state.enter()?;
    state.pending.lock().unwrap().take();
    state.publish(&app, "checking", None, None);
    let exit_app = app.clone();
    let result: Result<Snapshot, String> = async {
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(120))
            .on_before_exit(move || exit_app.state::<crate::sidecar::Sidecar>().stop())
            .build()
            .map_err(|e| e.to_string())?;
        let update = updater.check().await.map_err(|e| e.to_string())?;
        if let Some(update) = update {
            if update.download_url.scheme() != "https" {
                return Err("更新文件地址必须使用 HTTPS".into());
            }
            let version = update.version.clone();
            *state.pending.lock().unwrap() = Some(update);
            Ok(state.publish(&app, "available", Some(version), None))
        } else {
            Ok(state.publish(&app, "notAvailable", None, None))
        }
    }
    .await;
    if result.is_err() {
        state.publish(&app, "error", None, Some("检查更新失败，请稍后重试。"));
    }
    result.map_err(|_| "检查更新失败，请稍后重试。".into())
}
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    if !supported(&app) {
        return Err("此安装包未启用自动更新".into());
    }
    let _busy = state.enter()?;
    let update = state
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or("请先检查更新")?;
    let version = Some(update.version.clone());
    state.publish(&app, "downloading", version.clone(), None);
    let result = async {
        // download() verifies the minisign signature before the runtime stops.
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        state.publish(&app, "installing", version.clone(), None);
        let stop = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            stop.state::<crate::sidecar::Sidecar>().stop()
        })
        .await
        .map_err(|e| e.to_string())?;
        let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| e.to_string())?;
        installed.map_err(|e| e.to_string())?;
        app.restart();
        #[allow(unreachable_code)]
        Ok::<(), String>(())
    }
    .await;
    if result.is_err() {
        let sidecar = app.state::<crate::sidecar::Sidecar>();
        if sidecar.snapshot().phase == "stopped" {
            let _ = sidecar.start(app.clone());
        }
        state.publish(
            &app,
            "error",
            version,
            Some("更新失败，请重试或下载新安装包。"),
        );
    }
    result.map_err(|_| "更新失败，请重试或下载新安装包。".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_operations_are_single_flight_and_guard_resets() {
        let state = UpdateState::default();
        let guard = state.enter().unwrap();
        assert!(state.enter().is_err());
        drop(guard);
        assert!(state.enter().is_ok());
        assert_eq!(state.snapshot.lock().unwrap().status, "disabled");
    }
}
