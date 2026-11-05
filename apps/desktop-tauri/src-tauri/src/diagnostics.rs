//! Intentionally omit URLs' query strings, error messages and stacks: account
//! callbacks and provider errors may contain credentials.
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Default)]
pub struct LoadState(Mutex<HashMap<String, (u64, bool)>>);

pub fn record(app: &tauri::AppHandle, window: &str, kind: &str, path: &str, error_type: &str) {
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let entry = serde_json::json!({
        "at": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        "window": window, "kind": kind,
        "path": path.chars().take(240).collect::<String>(),
        "errorType": error_type.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect::<String>(),
    });
    eprintln!("[webview] {entry}");
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let file = dir.join("webview.jsonl");
    if fs::metadata(&file).is_ok_and(|m| m.len() > 1_000_000) {
        let _ = fs::rename(&file, dir.join("webview.previous.jsonl"));
    }
    if let Ok(mut out) = OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(out, "{entry}");
    }
}

pub fn page_load(window: tauri::WebviewWindow, payload: tauri::webview::PageLoadPayload<'_>) {
    let kind = match payload.event() {
        tauri::webview::PageLoadEvent::Started => "load-started",
        tauri::webview::PageLoadEvent::Finished => "load-finished",
    };
    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
        if let Some(entry) = window
            .state::<LoadState>()
            .0
            .lock()
            .unwrap()
            .get_mut(window.label())
        {
            entry.1 = true;
        }
    }
    record(
        window.app_handle(),
        window.label(),
        kind,
        payload.url().path(),
        "",
    );
}

pub fn navigation(app: &tauri::AppHandle, window: &str, url: &url::Url) -> bool {
    // Windows maps the custom protocol to http(s)://tauri.localhost;
    // macOS/Linux use tauri://localhost. Neither uses a loopback HTTP server.
    let allowed = allowed_navigation(url, cfg!(windows));
    record(
        app,
        window,
        if allowed {
            "navigation"
        } else {
            "navigation-blocked"
        },
        url.path(),
        "",
    );
    if allowed {
        let state = app.state::<LoadState>();
        let mut loads = state.0.lock().unwrap();
        let entry = loads.entry(window.to_string()).or_insert((0, false));
        entry.0 += 1;
        entry.1 = false;
        let sequence = entry.0;
        drop(loads);
        let app = app.clone();
        let label = window.to_string();
        let path = url.path().to_string();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let stalled =
                app.state::<LoadState>().0.lock().unwrap().get(&label) == Some(&(sequence, false));
            if stalled && app.get_webview_window(&label).is_some() {
                record(&app, &label, "load-timeout", &path, "");
            }
        });
    }
    allowed
}

fn allowed_navigation(url: &url::Url, windows: bool) -> bool {
    if windows {
        matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    }
}

#[tauri::command]
pub fn frontend_diagnostic(
    window: tauri::WebviewWindow,
    kind: String,
    path: String,
    error_type: String,
) -> Result<(), String> {
    if ![
        "bridge-ready",
        "dom-ready",
        "app-mounted",
        "script-error",
        "resource-error",
        "unhandled-rejection",
        "mount-timeout",
    ]
    .contains(&kind.as_str())
    {
        return Err("Unsupported diagnostic".into());
    }
    record(
        window.app_handle(),
        window.label(),
        &kind,
        &path,
        &error_type,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_platform_custom_protocol_origins_can_navigate() {
        for href in [
            "http://localhost:5194",
            "http://127.0.0.1:8452",
            "https://example.com",
            "http://tauri.localhost.evil.test",
        ] {
            let url = url::Url::parse(href).unwrap();
            assert!(!super::allowed_navigation(&url, true));
            assert!(!super::allowed_navigation(&url, false));
        }
        assert!(super::allowed_navigation(
            &url::Url::parse("tauri://localhost/index.html").unwrap(),
            false
        ));
        assert!(!super::allowed_navigation(
            &url::Url::parse("http://tauri.localhost").unwrap(),
            false
        ));
        assert!(super::allowed_navigation(
            &url::Url::parse("http://tauri.localhost/index.html").unwrap(),
            true
        ));
    }
    #[test]
    fn custom_protocol_feature_is_required_even_in_debug() {
        // Execute with --features custom-protocol; debug_assertions do not
        // control asset embedding in Tauri.
        assert!(!tauri::is_dev(), "Use --features custom-protocol");
    }
}
