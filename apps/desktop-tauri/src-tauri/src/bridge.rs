//! `window.tud` bridge injection for the main dashboard window + the Rust-side
//! data proxy.
//!
//! The main window now loads the bundled dashboard dist
//! (`WebviewUrl::App("dashboard/index.html")`) instead of the Node sidecar's
//! loopback HTTP server. The dashboard is a standalone build (its own
//! `main.tsx`), so it cannot call the renderer's `initTudBridge()` the way the
//! tray/pet windows do — the shell must provide `window.tud` itself.
//!
//! Two pieces:
//!
//! 1. **Bridge injection** — `create_main_window` attaches
//!    `initialization_script(TUD_BRIDGE_INIT_SCRIPT)` so `window.tud` exists
//!    before the dashboard's scripts run. The script installs just the members
//!    the dashboard data layer + chrome need (`api.request`, sync events,
//!    theme/range, window controls), wiring each to a Tauri command.
//!
//! 2. **Data proxy** — `tud_api_request` is the Tauri command behind
//!    `tud.api.request`. It forwards to the Node sidecar's loopback local-api
//!    (`/functions/tud-*`, `/health`), i.e. the "transparent proxy to 8462"
//!    from the migration plan, so the dashboard's relative fetches land on the
//!    sidecar regardless of which origin the page is served from.

/// A single forwarded request, mirroring `bridge.ts`'s `tud.api.request`
/// shape.
#[derive(serde::Deserialize)]
pub struct ApiRequest {
    /// Path such as `/functions/tud-account-usage-summary`.
    pub path: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

/// Response envelope matching `bridge.ts`: `{ status, body }` where `body` is
/// the parsed JSON (or raw text when the response is not JSON).
#[derive(serde::Serialize)]
pub struct ApiRequestResult {
    pub status: u16,
    pub body: serde_json::Value,
}

/// The `window.tud` bridge script injected into the main dashboard webview via
/// `initialization_script`. It runs before the page's own scripts, so the
/// dashboard's `hasDesktopApi()` check (`window.tud?.api?.request`) is already
/// true by the time its data layer loads.
///
/// The main window is a standalone dashboard build, so it does not run the
/// Tauri renderer's `bridge.ts`. This script installs just enough of the
/// `window.tud` surface that the dashboard data layer + chrome need, wiring
/// each member to a Tauri command. Command names match `bridge.ts` exactly so
/// the same `invoke_handler!` registration serves both.
///
/// Tauri 2 injects the `__TAURI_INTERNALS__.transformCallback` helper into
/// every webview; it is the transport for command invoke + event listen. The
/// helpers below mirror the runtime shape of `@tauri-apps/api` so the script
/// stays dependency-free and inlined into the binary.
pub const TUD_BRIDGE_INIT_SCRIPT: &str = r#"
(function () {
  if (window.tud) { return; }
  var internals = window.__TAURI_INTERNALS__;
  if (!internals || !internals.invoke) {
    // No IPC channel yet — log to console so a white-screen is diagnosable
    // without requiring the IPC round-trip to succeed.
    console.error("[tud-desktop] tud bridge: no __TAURI_INTERNALS__ (href=" + location.href + ")");
    return;
  }

  // The bundled dashboard lives under `dashboard/index.html` so its relative
  // assets do not collide with the shell entry. Normalize the document URL
  // before the browser-history router starts matching routes.
  if (/\/dashboard\/index\.html\/?$/.test(location.pathname)) {
    history.replaceState(null, "", "/dashboard");
  }

  // --- invoke (mirror of @tauri-apps/api/core invoke) ---------------------
  var invokeCmds = new Set([
    "version", "platform",
    "window_minimize", "window_toggle_maximize", "window_close", "window_show_main",
    "app_quit", "open_external", "copy_image_to_clipboard", "resize_tray_popover",
    "auto_update_get_state", "auto_update_check", "auto_update_install", "auto_update_ack_completed",
    "theme_get", "theme_set",
    "dashboard_range_get", "dashboard_range_set",
    "autostart_get", "autostart_set", "autostart_get_hidden", "autostart_set_hidden",
    "desktop_pet_get", "desktop_pet_set_enabled", "desktop_pet_set_selected",
    "desktop_pet_set_preferences", "desktop_pet_set_mouse_ignored",
    "desktop_pet_begin_drag", "desktop_pet_end_drag", "pet_show_context_menu",
    "tud_api_request", "tud_bridge_ready",
  ]);
  function invoke(cmd, args) {
    // Tauri v2 invoke signature: invoke(cmd, args, cargoCmd, coreFeature?, resolveFn?)
    return internals.invoke(cmd, args || {}, undefined, cmd, invokeCmds.has(cmd));
  }

  // --- listen (mirror of @tauri-apps/api/event listen) --------------------
  function listen(channel, cb) {
    return internals
      .transformCallback(function (event) {
        cb(event);
      })
      .then(function (cbId) {
        return internals
          .invoke("tauri://listen", { event: channel, target: { kind: "Any" }, handler: cbId })
          .then(function () {
            return function () {
              internals.handleCallback(cbId);
              return internals.invoke("tauri://unlisten", { event: channel, handler: cbId });
            };
          });
      });
  }

  function listenOnce(channel, validate, callback) {
    var unlisten = null;
    var settled = false;
    function settle() { if (settled) return; settled = true; }
    listen(channel, function (event) {
      if (validate(event.payload)) { callback(event.payload); }
    }).then(function (fn) { unlisten = fn; settle(); });
    return function () { settle(); if (unlisten) { unlisten(); } };
  }
  function listenRaw(channel, callback) {
    var unlisten = null;
    var settled = false;
    function settle() { if (settled) return; settled = true; }
    listen(channel, function () { callback(); }).then(function (fn) { unlisten = fn; settle(); });
    return function () { settle(); if (unlisten) { unlisten(); } };
  }

  var tud = {
    platform: "win32",
    version: function () { return invoke("version"); },
    minimize: function () { return invoke("window_minimize"); },
    toggleMaximize: function () { return invoke("window_toggle_maximize"); },
    close: function () { return invoke("window_close"); },
    showMainWindow: function () { return invoke("window_show_main"); },
    quit: function () { return invoke("app_quit"); },

    getAutoUpdateState: function () { return invoke("auto_update_get_state"); },
    checkForUpdates: function () { return invoke("auto_update_check"); },
    installDownloadedUpdate: function () { return invoke("auto_update_install"); },
    acknowledgeUpdateCompleted: function () { return invoke("auto_update_ack_completed"); },
    onAutoUpdateStateChanged: function (cb) {
      return listenOnce("auto-update:state-changed", function (p) { return p != null && typeof p === "object"; }, function (p) { cb(p); });
    },

    copyImageToClipboard: function (dataUrl) { return invoke("copy_image_to_clipboard", { dataUrl: dataUrl }); },
    openExternal: function (url) { return invoke("open_external", { url: url }); },
    resizeTrayPopover: function (height) { return invoke("resize_tray_popover", { height: height }); },

    getDashboardRange: function () { return invoke("dashboard_range_get"); },
    setDashboardRange: function (range) { return invoke("dashboard_range_set", { range: range }); },
    onDashboardRange: function (cb) {
      return listenOnce("dashboard-range:changed", function (p) { return p != null && typeof p === "string"; }, function (p) { cb(p); });
    },

    getTheme: function () { return invoke("theme_get"); },
    setThemeMode: function (mode) { return invoke("theme_set", { mode: mode }); },
    onThemeChanged: function (cb) {
      return listenOnce("theme:changed", function (p) { return p != null && typeof p === "object"; }, function (p) { cb(p); });
    },

    getOpenAtLogin: function () { return invoke("autostart_get"); },
    setOpenAtLogin: function (enabled) { return invoke("autostart_set", { enabled: enabled }); },
    getLaunchHidden: function () { return invoke("autostart_get_hidden"); },
    setLaunchHidden: function (hidden) { return invoke("autostart_set_hidden", { hidden: hidden }); },

    getDesktopPet: function () { return invoke("desktop_pet_get"); },
    setDesktopPetEnabled: function (enabled) { return invoke("desktop_pet_set_enabled", { enabled: enabled }); },
    setSelectedDesktopPet: function (id) { return invoke("desktop_pet_set_selected", { selectedPetId: id }); },
    setDesktopPetPreferences: function (changes) { return invoke("desktop_pet_set_preferences", { changes: changes }); },
    setDesktopPetMouseIgnored: function (ignored) { return invoke("desktop_pet_set_mouse_ignored", { ignored: ignored }); },
    beginDesktopPetDrag: function () { return invoke("desktop_pet_begin_drag"); },
    endDesktopPetDrag: function () { return invoke("desktop_pet_end_drag"); },
    showPetContextMenu: function (x, y) { return invoke("pet_show_context_menu", { x: x, y: y }); },
    onDesktopPetAnimation: function (cb) {
      return listenOnce("desktop-pet:animation", function (p) { return p === "idle" || p === "running-left" || p === "running-right"; }, function (p) { cb(p); });
    },
    onDesktopPetPreferences: function (cb) {
      return listenOnce("desktop-pet:preferences", function (p) { return p != null && typeof p === "object"; }, function (p) { cb(p); });
    },

    onMaximized: function (cb) {
      return listenOnce("window:is-maximized", function (p) { return typeof p === "boolean"; }, function (p) { cb(p); });
    },

    onDataSynced: function (cb) { return listenRaw("tud:data-synced", cb); },
    onOpenSettings: function (cb) {
      return listenOnce("app:open-settings", function (p) { return p == null || typeof p === "object"; }, function (p) { cb(p && typeof p === "object" ? p : undefined); });
    },
    onJuejinLinkResult: function (cb) {
      return listenOnce("app:juejin-link-result", function (p) { return p == null || typeof p === "object"; }, function (p) {
        var raw = (p == null ? {} : p);
        cb({ ok: raw.ok === true, message: (typeof raw.message === "string" && raw.message.trim()) ? raw.message.trim() : undefined });
      });
    },
    onRuntimeNotice: function (cb) {
      return listenOnce("app:runtime-notice", function (p) { return p != null && typeof p === "object"; }, function (p) {
        var raw = p;
        if (raw.kind !== "config-reset") { return; }
        cb({ kind: "config-reset", tokenSalvaged: raw.tokenSalvaged === true });
      });
    },

    // Data access: forward to the Node sidecar's local-api via the Rust
    // `tud_api_request` command (the "transparent proxy to 8462"). The path
    // stays relative (`/functions/tud-*`) so the dashboard code is unaware of
    // the sidecar; only the transport crosses the process boundary.
    api: {
      request: function (path, init) {
        init = init || {};
        var res = invoke("tud_api_request", {
          req: {
            path: path,
            method: init.method || undefined,
            body: init.body || undefined,
            headers: init.headers || undefined,
          },
        });
        // dashboard's request() expects { status, body }; the Tauri command
        // already returns that shape.
        return res;
      },
    },
  };

  window.tud = tud;
  // Prove the bridge installed in this webview (observable in the Tauri log,
  // independent of eval callbacks which have been flaky).
  invoke("tud_bridge_ready", { detail: location.href || "about:blank" }).catch(function () {});

  // Patch `platform` with the real OS once resolved (the dashboard reads it
  // synchronously, so the "win32" default is only a brief placeholder).
  invoke("platform").then(function (p) {
    if (window.tud && p) { window.tud.platform = p; }
  }).catch(function () {});
})();
"#;

/// Ping command the injected bridge calls once, proving `window.tud` exists in
/// the main webview (independent of eval callbacks, which have been flaky).
#[tauri::command]
pub fn tud_bridge_ready(detail: String) {
    eprintln!("[tud-desktop] main-webview bridge ready at {detail}");
}

/// Tauri command: forward a dashboard `/functions/tud-*` (or `/health`)
/// request to the Node sidecar. Returns `{ status, body }` — the exact shape
/// `bridge.ts`'s `tud.api.request` resolves with, so the injected bridge
/// script can return it straight to the dashboard.
///
/// This is the Rust half of the "data proxy" — the dashboard page is served
/// from Tauri's static origin, so a bare relative `fetch('/functions/...')`
/// would 404 there. Instead the dashboard's data layer routes through
/// `window.tud.api.request`, which lands here; we proxy to the sidecar's
/// loopback port and hand back the parsed body with its HTTP status.
#[tauri::command]
pub fn tud_api_request(
    req: ApiRequest,
    state: tauri::State<'_, crate::sidecar::SidecarState>,
) -> Result<ApiRequestResult, String> {
    eprintln!("[tud-desktop] tud_api_request ← {} {:?}", req.path, req.method);
    let sidecar_url = sidecar_url_string(&state);
    let target = format!("{}{}", sidecar_url, req.path);

    let method = req.method.clone().unwrap_or_else(|| "GET".to_string());
    let body = req.body.clone();

    let mut call = fetch_call(&target, &method, body.as_deref(), req.headers.as_ref());

    // Retry a few times while the sidecar is still booting (it binds 8462
    // shortly after spawn; the first request can land before the listen).
    const RETRIES: u32 = 12;
    const GAP_MS: u64 = 500;
    let mut last_err = String::new();
    for attempt in 0..=RETRIES {
        match call {
            Ok((status, text)) => {
                let parsed = if text.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text.clone()))
                };
                return Ok(ApiRequestResult { status, body: parsed });
            }
            Err(ref e) => {
                last_err = e.clone();
                if attempt < RETRIES {
                    std::thread::sleep(std::time::Duration::from_millis(GAP_MS));
                    call = fetch_call(&target, &method, body.as_deref(), req.headers.as_ref());
                }
            }
        }
    }
    Err(format!("tud sidecar unreachable at {sidecar_url} ({last_err})"))
}

fn sidecar_url_string(state: &crate::sidecar::SidecarState) -> String {
    let port = state.port.lock().unwrap().unwrap_or(crate::sidecar::DEFAULT_DESKTOP_PORT);
    format!("http://127.0.0.1:{port}")
}

/// Minimal blocking HTTP call to the loopback sidecar (dependency-free, matching
/// `sidecar.rs::trigger_sync`'s hand-rolled approach so the offline build stays
/// clean). Returns `(status, body_text)`.
fn fetch_call(
    url: &str,
    method: &str,
    body: Option<&str>,
    headers: Option<&std::collections::HashMap<String, String>>,
) -> Result<(u16, String), String> {
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    // `url` is `http://127.0.0.1:{port}{path}` — split host/port from the path.
    let after_scheme = url
        .strip_prefix("http://127.0.0.1")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let (authority, path_and_query) = match after_scheme.find('/') {
        Some(i) => (&after_scheme[..i], &after_scheme[i..]),
        None => (after_scheme, "/"),
    };
    let port: u16 = authority
        .split_once(':')
        .map(|(_, p)| p.parse::<u16>())
        .and_then(|r| r.ok())
        .unwrap_or(crate::sidecar::DEFAULT_DESKTOP_PORT);
    let path = if path_and_query.is_empty() { "/" } else { path_and_query };

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);

    let body_bytes: &[u8] = body.map(|b| b.as_bytes()).unwrap_or(&[]);

    let mut stream = std::net::TcpStream::connect_timeout(
        &addr,
        std::time::Duration::from_secs(5),
    )
    .map_err(|e| format!("connect sidecar {addr}: {e}"))?;

    let headers_block = headers
        .map(|h| {
            h.iter()
                .map(|(k, v)| format!("{k}: {v}\r\n"))
                .collect::<String>()
        })
        .unwrap_or_default();

    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Content-Length: {}\r\n{headers_block}Connection: close\r\n\r\n{}",
        body_bytes.len(),
        body.unwrap_or("")
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write sidecar request: {e}"))?;

    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("read sidecar response: {e}"))?;
    let raw = String::from_utf8_lossy(&buf).into_owned();

    let (head, body_text) = match raw.find("\r\n\r\n") {
        Some(i) => (raw[..i].to_string(), raw[i + 4..].to_string()),
        None => (raw.clone(), String::new()),
    };

    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    Ok((status, body_text))
}
