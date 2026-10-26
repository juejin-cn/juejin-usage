//! Tauri adapter for the tested subprocess supervisor.
use crate::supervisor::{ConfigNotice, Event, ProcessSpec, Snapshot, Supervisor};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Sidecar {
    pub host_key: String,
    control: Mutex<()>,
    state: Arc<Supervisor>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Default for Sidecar {
    fn default() -> Self {
        Self {
            host_key: uuid::Uuid::new_v4().to_string(),
            control: Mutex::new(()),
            state: Arc::new(Supervisor::default()),
            worker: Mutex::new(None),
        }
    }
}

fn runtime_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("node-app");
    let root = if bundled.is_dir() {
        bundled
    } else if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("node-app")
    } else {
        return Err("Bundled Node runtime is missing".into());
    };
    let name = if cfg!(windows) {
        "jusage-node.exe"
    } else {
        "jusage-node"
    };
    let bundled_node = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Executable directory unavailable")?
        .join(name);
    let node = if bundled_node.is_file() {
        bundled_node
    } else if cfg!(debug_assertions) {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "jusage-node-{}{suffix}",
                env!("TAURI_ENV_TARGET_TRIPLE")
            ))
    } else {
        return Err("Bundled Node sidecar is missing".into());
    };
    let script = root.join("app/dist/host/index.js");
    if !node.is_file() || !script.is_file() {
        return Err(format!(
            "Missing staged runtime at {}. Run pnpm prepare:app",
            root.display()
        ));
    }
    Ok((node, script))
}

impl Sidecar {
    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let _guard = self.control.lock().unwrap();
        self.start_locked(app)
    }
    fn start_locked(&self, app: AppHandle) -> Result<(), String> {
        let mut worker = self.worker.lock().unwrap();
        if worker.as_ref().is_some_and(|w| !w.is_finished()) {
            return Ok(());
        }
        if let Some(old) = worker.take() {
            let _ = old.join();
        }
        let (node, script) = runtime_paths(&app)?;
        self.state.prepare();
        let state = Arc::clone(&self.state);
        let spec = ProcessSpec {
            binary: node,
            args: vec![script.to_string_lossy().into_owned()],
            host_key: self.host_key.clone(),
        };
        *worker = Some(std::thread::spawn(move || {
            state.run(
                spec,
                Arc::new(move |event| match event {
                    Event::Status(snapshot) => {
                        let _ = app.emit("tud:runtime-status", &snapshot);
                        if snapshot.phase == "ready" && snapshot.attempt > 0 {
                            let _ = app.emit("tud:data-synced", ());
                        }
                        if snapshot.phase == "failed" {
                            crate::pet::notify(
                                &app,
                                "本地服务已停止",
                                "请在托盘中重试本地服务，或退出占用运行时的其他桌面客户端。",
                            );
                        }
                    }
                    Event::Linked => {
                        let _ = app.emit("app:juejin-link-result", serde_json::json!({"ok":true}));
                        crate::desktop::show_main(&app);
                    }
                    Event::Synced => {
                        crate::desktop::refresh_usage(app.clone());
                        let _ = app.emit("tud:data-synced", ());
                    }
                    Event::ConfigReset(_) => {
                        let _ = app.emit("app:runtime-notice", ());
                    }
                }),
            )
        }));
        Ok(())
    }
    pub fn snapshot(&self) -> Snapshot {
        self.state.status.lock().unwrap().clone()
    }
    pub async fn port(&self) -> Result<u16, String> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(port) = *self.state.endpoint.lock().unwrap() {
                return Ok(port);
            }
            let status = self.snapshot();
            if status.phase == "failed" || status.phase == "stopped" {
                return Err("本地服务已停止，请从托盘重试".into());
            }
            if Instant::now() >= deadline {
                return Err("本地服务正在恢复，请稍后重试".into());
            }
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    pub fn stop(&self) {
        let _guard = self.control.lock().unwrap();
        self.stop_locked();
    }
    fn stop_locked(&self) {
        self.state.stop();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
        self.state.status.lock().unwrap().phase = "stopped".into();
    }
    pub fn retry(&self, app: AppHandle) -> Result<(), String> {
        let _guard = self.control.lock().unwrap();
        if self.snapshot().phase != "failed" {
            return Ok(());
        }
        self.stop_locked();
        self.start_locked(app)
    }
}
impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}
#[tauri::command]
pub fn runtime_status(sidecar: State<'_, Sidecar>) -> Snapshot {
    sidecar.snapshot()
}
#[tauri::command]
pub fn runtime_notice(sidecar: State<'_, Sidecar>) -> Option<ConfigNotice> {
    sidecar.state.notice()
}
#[tauri::command]
pub fn runtime_ack_notice(sidecar: State<'_, Sidecar>, id: u64) {
    sidecar.state.acknowledge_notice(id);
}
#[tauri::command]
pub fn runtime_retry(app: AppHandle, sidecar: State<'_, Sidecar>) -> Result<(), String> {
    sidecar.retry(app)
}
