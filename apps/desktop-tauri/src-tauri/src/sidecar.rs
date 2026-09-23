//! Node sidecar lifecycle (P1 — the data core).
//!
//! The Tauri app spawns a Node process running the compiled CLI desktop-host
//! entry (`packages/cli/dist/desktop-host.js`, embedded in the CLI package
//! `@juejin-opensource/jusage`). That process owns the local
//! Core runtime (owner `kind: 'desktop'`) and serves the loopback local-api
//! (`/health` + `/functions/tud-*`). This module only manages the process:
//!
//!   - spawn: node binary + sidecar script
//!   - stdout: read `PORT=<n>` (bound port) and `SYNCED` / `RUNTIME_NOTICE=` markers
//!   - on `SYNCED`: emit `tud:data-synced` to every webview
//!   - on `RUNTIME_NOTICE=CONFIG_RESET:<bool>`: emit `app:runtime-notice`
//!     (`{ kind: "config-reset", tokenSalvaged }`) — the UI toast for a corrupt
//!     config that had to be recovered (port of Electron's `broadcastConfigResetNotice`)
//!   - on exit: kill the child
//!
//! Dev-time path resolution is wired through env so `tauri dev` works out of
//! the box:
//!   - `TUD_NODE_BIN`       node executable (default: `node` on PATH)
//!   - `TUD_SIDECAR_SCRIPT` path to the compiled sidecar entry
//!
//! Bundling the Node binary as a resource for release builds is a later step;
//! the command surface (`sidecar_url`) is identical either way.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};

/// Default desktop sidecar port (CLI owns 8452, so we use 8462).
pub const DEFAULT_DESKTOP_PORT: u16 = 8462;

/// Shared, managed across Tauri. `port` is an `Arc` so the stdout-reading
/// thread and the Tauri state can both observe it.
pub struct SidecarState {
    /// The port the sidecar actually bound, once its `PORT=` line has been read.
    pub port: Arc<Mutex<Option<u16>>>,
    /// The live child handle, used to kill it on app exit.
    pub child: Mutex<Option<Child>>,
    /// Guards against double-spawn.
    pub started: AtomicBool,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            child: Mutex::new(None),
            started: AtomicBool::new(false),
        }
    }
}

/// Resolve the Node executable to spawn.
///
/// Priority: the `TUD_NODE_BIN` env (dev / testing a specific runtime), then
/// the app-sibling `node-app/node/node` (a staged runtime next to the binary,
/// see `scripts/stage-node-app.mjs`), then the bundled `node-app/node/node`
/// resource (packaged `.app`), then `node` on the PATH (last resort).
///
/// The app-sibling slot exists because Tauri `resolve(..., BaseDirectory::Resource)`
/// on macOS walks up from the *main binary* to find the app bundle — if the
/// binary lives outside a `.app` (e.g. a bare `target/release` build in dev)
/// it resolves to a directory that lacks `Resources/node-app`, while a
/// *staged* sibling copy may well exist. Checking the sibling first keeps both
/// layouts working with one path.
fn node_bin(app: &AppHandle) -> Option<String> {
    if let Ok(custom) = std::env::var("TUD_NODE_BIN") {
        return Some(custom);
    }
    if let Some(candidate) = app_sibling_runtime("node-app/node/node") {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    if let Ok(bundled) = app.path().resolve("node-app/node/node", BaseDirectory::Resource) {
        if bundled.exists() {
            return Some(bundled.to_string_lossy().into_owned());
        }
    }
    Some("node".to_string())
}

/// Locate a staged runtime file in `node-app/` next to the *current executable*
/// (i.e. `<exe-dir>/node-app/...`). Returns `None` when the file is absent or
/// the exe dir is unresolvable.
fn app_sibling_runtime(rel: &str) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    Some(exe_dir.join(rel))
}

/// Resolve the compiled sidecar entry to run.
///
/// Priority: the `TUD_SIDECAR_SCRIPT` env (dev override), then the app-sibling
/// `node-app/app/dist/index.js` (see `node_bin`), then the bundled resource
/// copy, then a repo-relative fallback for dev.
fn sidecar_script(app: &AppHandle) -> Option<String> {
    if let Ok(custom) = std::env::var("TUD_SIDECAR_SCRIPT") {
        return Some(custom);
    }
    if let Some(candidate) = app_sibling_runtime("node-app/app/dist/index.js") {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    if let Ok(bundled) = app.path().resolve("node-app/app/dist/index.js", BaseDirectory::Resource) {
        if bundled.exists() {
            return Some(bundled.to_string_lossy().into_owned());
        }
    }
    // Dev fallback: locate the compiled CLI desktop-host entry relative to the
    // cargo crate dir. CARGO_MANIFEST_DIR = <repo>/apps/desktop-tauri/src-tauri,
    // so go up three to the workspace root, then into the CLI's dist.
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = crate_dir
        .parent() // apps/desktop-tauri
        .and_then(|d| d.parent()) // apps
        .and_then(|a| a.parent()); // <repo>
    let path = repo_root?.join("packages/cli/dist/desktop-host.js");
    Some(path.to_string_lossy().into_owned())
}

/// Spawn the sidecar and start reading its stdout. No-op if already started.
pub fn start(state: &SidecarState, app: AppHandle) -> Result<(), String> {
    if state.started.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let script = sidecar_script(&app)
        .ok_or_else(|| "could not resolve a sidecar script path".to_string())?;
    if !std::path::Path::new(&script).exists() {
        return Err(format!(
            "sidecar script not found at {script} (build it with `pnpm build:cli`)"
        ));
    }

    let node = node_bin(&app).ok_or_else(|| "no Node runtime resolvable".to_string())?;
    let mut child = Command::new(&node)
        .arg(&script)
        // Pin the port up-front so the main window (created by Tauri from
        // tauri.conf.json before `setup` runs) can be addressed by a static
        // URL. `resolveDesktopHostPort()` in desktop-host.ts still honors
        // `TUD_SIDECAR_PORT` if the caller wants a different value; only the
        // Tauri-hosted case hardcodes the DEFAULT_DESKTOP_PORT so
        // `http://127.0.0.1:{DEFAULT_DESKTOP_PORT}/` always resolves to this
        // child — the random-port fallback (only hit on bind failure) is a
        // separate edge case we surface via the `PORT=` line as before.
        .env("TUD_SIDECAR_PORT", DEFAULT_DESKTOP_PORT.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn node sidecar ({node} {script}): {e}"))?;

    // Pull the pipes out first (leaving the child with `None` fields), then
    // store the child itself for `kill()`. `kill` only needs the pid, so the
    // child stays a valid process handle even after its pipes are taken.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout from sidecar".to_string())?;
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(child);

    // The stdout thread shares the port with the Tauri state via the Arc.
    let port = Arc::clone(&state.port);
    std::thread::spawn(move || {
        read_stdout(stdout, stderr, port, app);
    });

    Ok(())
}

/// Read stdout line-by-line: capture `PORT=`, emit on `SYNCED`; drain stderr.
fn read_stdout(
    stdout: std::process::ChildStdout,
    stderr: Option<std::process::ChildStderr>,
    port: Arc<Mutex<Option<u16>>>,
    app: AppHandle,
) {
    if let Some(se) = stderr {
        // Drain stderr so the pipe never fills and blocks the child.
        std::thread::spawn(move || {
            for _ in BufReader::new(se).lines() {
                // Dev: swallow. Later: forward to the tauri logger.
            }
        });
    }

    for line in BufReader::new(stdout).lines().flatten() {
        if let Some(p) = line.strip_prefix("PORT=") {
            if let Ok(n) = p.trim().parse::<u16>() {
                *port.lock().unwrap() = Some(n);
                eprintln!("[tud-desktop] sidecar bound to PORT={n}");
                // Verify the main webview (now the bundled dashboard, not the
                // loopback sidecar) actually mounted: probe its URL, the
                // injected `window.tud` bridge, and whether the dashboard
                // `#root` has children. Done a few seconds after the sidecar
                // binds so the dashboard's first data fetch has fired.
                let app_probe = app.clone();
                std::thread::spawn(move || {
                    use tauri::Manager as _;
                    for i in 1..=4u32 {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        let secs = i as u64 * 3;
                        match app_probe.get_webview_window("main") {
                            Some(win) => {
                                let js = r#"JSON.stringify({
  href: location.href,
  ready: document.readyState,
  title: document.title,
  rootKids: document.getElementById("root") ? document.getElementById("root").children.length : -1,
  hasTud: typeof window.tud !== "undefined",
  hasTudApi: !!(window.tud && window.tud.api && window.tud.api.request),
  bodyLen: document.body ? document.body.innerText.length : -1
})"#;
                                match win.eval_with_callback(js, move |out| {
                                    eprintln!("[tud-desktop] main-webview(t+{secs}s): {out}")
                                }) {
                                    Ok(()) => {}
                                    Err(e) => {
                                        eprintln!("[tud-desktop] main-webview(t+{secs}s): eval failed: {e}")
                                    }
                                }
                            }
                            None => {
                                eprintln!("[tud-desktop] main-webview(t+{}s): main window gone", secs)
                            }
                        }
                    }
                });
            }
        } else if line.trim() == "SYNCED" {
            let _ = app.emit("tud:data-synced", ());
        } else if let Some(p) = line.strip_prefix("RUNTIME_NOTICE=") {
            // `CONFIG_RESET:<true|false>` — a corrupt config was recovered.
            // Forward to the webviews as `app:runtime-notice`; the renderer's
            // `onRuntimeNotice` filters to `kind: 'config-reset'`.
            let payload = parse_runtime_notice(p);
            if let Some(payload) = payload {
                let _ = app.emit("app:runtime-notice", &payload);
            }
        }
    }
}

/// Turn a `RUNTIME_NOTICE=` payload (currently only `CONFIG_RESET:<bool>`) into
/// the camelCase `app:runtime-notice` detail the renderer expects. Returns
/// `None` for unknown notice kinds so a future marker never misfires the UI.
fn parse_runtime_notice(payload: &str) -> Option<serde_json::Value> {
    let (kind, token_salvaged) = match payload {
        p if p.starts_with("CONFIG_RESET:") => {
            ("config-reset", p["CONFIG_RESET:".len()..].trim() == "true")
        }
        _ => return None,
    };
    Some(serde_json::json!({ "kind": kind, "tokenSalvaged": token_salvaged }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_config_reset_notice() {
        let v = parse_runtime_notice("CONFIG_RESET:true").unwrap();
        assert_eq!(v["kind"], "config-reset");
        assert_eq!(v["tokenSalvaged"], true);

        let v = parse_runtime_notice("CONFIG_RESET:false").unwrap();
        assert_eq!(v["tokenSalvaged"], false);
    }

    #[test]
    fn unknown_notice_kinds_return_none() {
        assert!(parse_runtime_notice("SOMETHING_ELSE").is_none());
        assert!(parse_runtime_notice("").is_none());
        // A bare `CONFIG_RESET:` prefix with no value is still a valid notice
        // (no token salvaged), just with the flag defaulting to false.
        let v = parse_runtime_notice("CONFIG_RESET:").unwrap();
        assert_eq!(v["tokenSalvaged"], false);
    }
}

/// Kill the sidecar child on app exit.
pub fn stop(state: &SidecarState) {
    let mut child = state.child.lock().unwrap();
    if let Some(c) = child.as_mut() {
        let _ = c.kill();
    }
    *child = None;
}

/// Return the loopback URL of the sidecar. Uses the bound port once known,
/// otherwise the desktop default — the frontend bridge falls back the same way
/// so the dashboard shows "recovering" until the sidecar reports its port.
#[tauri::command]
pub fn sidecar_url(state: State<'_, SidecarState>) -> String {
    let port = state.port.lock().unwrap().unwrap_or(DEFAULT_DESKTOP_PORT);
    format!("http://127.0.0.1:{port}")
}

/// Fire a sync on the sidecar (tray "同步数据" menu item → `POST /functions/tud-trigger-sync`).
///
/// Uses a raw loopback TCP connection with a minimal hand-written HTTP/1.1
/// request body rather than an HTTP client crate, so this stays dependency-free
/// (and works in the offline build). Failures are swallowed: the sync is
/// fire-and-forget from a menu click, exactly like Electron's `triggerSync`.
pub fn trigger_sync(state: &SidecarState) {
    let port = state.port.lock().unwrap().unwrap_or(DEFAULT_DESKTOP_PORT);
    let addr = std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), port);
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        let mut stream = match std::net::TcpStream::connect_timeout(
            &addr,
            std::time::Duration::from_secs(2),
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let req = format!(
            "POST /functions/tud-trigger-sync HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: 2\r\n\
             Connection: close\r\n\r\n\
             {{}}"
        );
        if stream.write_all(req.as_bytes()).is_err() {
            return;
        }
        // Drain the response so the server can close cleanly.
        let mut _resp = [0u8; 4096];
        let _ = stream.read(&mut _resp);
    });
}
