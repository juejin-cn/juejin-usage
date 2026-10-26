//! Local Node/Core runtime. stdin EOF shuts it down even after a host crash.
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

pub struct Sidecar {
    child: Mutex<Option<Child>>,
    pub host_key: String,
    pub endpoint: Arc<Mutex<Result<Option<u16>, String>>>,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            host_key: uuid::Uuid::new_v4().to_string(),
            endpoint: Arc::new(Mutex::new(Ok(None))),
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
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = root.join("node").join(name);
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
        let (node, script) = runtime_paths(&app)?;
        let mut command = Command::new(node);
        command
            .arg(script)
            .env("TUD_HOST_KEY", &self.host_key)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        // A GUI build must not flash a console on Windows.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("Sidecar stdout unavailable")?;
        *self.child.lock().unwrap() = Some(child);
        let endpoint = Arc::clone(&self.endpoint);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(port) = line
                    .strip_prefix("PORT=")
                    .and_then(|p| p.parse::<u16>().ok())
                    .filter(|p| *p > 0)
                {
                    *endpoint.lock().unwrap() = Ok(Some(port));
                } else if line == "JUEJIN_LINKED" {
                    let _ = app.emit("app:juejin-link-result", serde_json::json!({"ok":true}));
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                } else if line == "SYNCED" {
                    let _ = app.emit("tud:data-synced", ());
                } else {
                    eprintln!("[desktop-tauri] {line}");
                }
            }
            *endpoint.lock().unwrap() = Err("本地服务已退出，请重新启动 Tauri 客户端".into());
            let _ = app.emit("tud:runtime-stopped", ());
        });
        Ok(())
    }

    pub async fn port(&self) -> Result<u16, String> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(port) = self.endpoint.lock().unwrap().clone()? {
                return Ok(port);
            }
            if Instant::now() >= deadline {
                return Err("本地服务启动超时，请检查终端日志".into());
            }
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    pub fn stop(&self) {
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"shutdown\n");
        }
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => break,
                _ if Instant::now() >= deadline => break,
                _ => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}
