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
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub completed_version: Option<String>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            status: "disabled".into(),
            current_version: env!("CARGO_PKG_VERSION").into(),
            available_version: None,
            message: None,
            downloaded_bytes: 0,
            total_bytes: None,
            completed_version: None,
        }
    }
}
#[derive(Default)]
pub struct UpdateState {
    snapshot: Mutex<Snapshot>,
    pending: Mutex<Option<tauri_plugin_updater::Update>>,
    busy: AtomicBool,
    downloaded: Mutex<Option<Vec<u8>>>,
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
        if status == "checking" {
            snapshot.downloaded_bytes = 0;
            snapshot.total_bytes = None;
        }
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
    let marker = app.path().app_config_dir()?.join("pending-update.json");
    if let Ok(bytes) = std::fs::read(marker) {
        app.state::<UpdateState>()
            .snapshot
            .lock()
            .unwrap()
            .completed_version = completed_from_bytes(&bytes, env!("CARGO_PKG_VERSION"));
    }
    if supported(app) {
        app.state::<UpdateState>().snapshot.lock().unwrap().status = "idle".into();
        let handle = app.clone();
        std::thread::spawn(move || loop {
            let status = handle
                .state::<UpdateState>()
                .snapshot
                .lock()
                .unwrap()
                .status
                .clone();
            if matches!(status.as_str(), "idle" | "error" | "notAvailable") {
                let _ = tauri::async_runtime::block_on(update_check(
                    handle.clone(),
                    handle.state::<UpdateState>(),
                ));
            }
            std::thread::sleep(Duration::from_secs(6 * 60 * 60));
        });
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
            state.publish(&app, "downloading", Some(version.clone()), None);
            let update = state.pending.lock().unwrap().clone().unwrap();
            let bytes = download_verified(&app, &state, &update).await?;
            *state.downloaded.lock().unwrap() = Some(bytes);
            Ok(state.publish(&app, "downloaded", Some(version), None))
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
        let cached = state.downloaded.lock().unwrap().take();
        let bytes = if let Some(bytes) = cached {
            bytes
        } else {
            download_verified(&app, &state, &update).await?
        };
        let marker = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("pending-update.json");
        std::fs::create_dir_all(marker.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(
            &marker,
            serde_json::to_vec(&serde_json::json!({"version":update.version}))
                .map_err(|e| e.to_string())?,
        )
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
        if let Ok(directory) = app.path().app_config_dir() {
            let _ = std::fs::remove_file(directory.join("pending-update.json"));
        }
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

async fn download_verified(
    app: &tauri::AppHandle,
    state: &UpdateState,
    update: &tauri_plugin_updater::Update,
) -> Result<Vec<u8>, String> {
    let mut transferred = 0u64;
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    update
        .download(
            |chunk, total| {
                transferred = transferred.saturating_add(chunk as u64);
                if last.elapsed() >= Duration::from_millis(150) {
                    last = std::time::Instant::now();
                    let mut snapshot = state.snapshot.lock().unwrap();
                    snapshot.downloaded_bytes = transferred;
                    snapshot.total_bytes = total;
                    let _ = app.emit("app:update-state", snapshot.clone());
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn update_ack_completed(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    let file = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("pending-update.json");
    match std::fs::remove_file(file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法确认更新完成提示".into()),
    };
    let mut snapshot = state.snapshot.lock().unwrap();
    snapshot.completed_version = None;
    let _ = app.emit("app:update-state", snapshot.clone());
    Ok(())
}

fn completed_from_bytes(bytes: &[u8], current: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    (value["version"].as_str() == Some(current)).then(|| current.to_string())
}
#[cfg(test)]
mod completion_tests {
    use super::*;
    #[test]
    fn completion_requires_actual_new_version_and_rejects_failed_install_marker() {
        assert_eq!(
            completed_from_bytes(br#"{"version":"0.2.0"}"#, "0.2.0"),
            Some("0.2.0".into())
        );
        assert_eq!(
            completed_from_bytes(br#"{"version":"0.2.0"}"#, "0.1.0"),
            None
        );
        assert_eq!(completed_from_bytes(b"invalid", "0.2.0"), None);
    }
}
