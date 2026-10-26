#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod sidecar;
use serde::{Deserialize, Serialize};
use sidecar::Sidecar;
use std::time::Duration;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[derive(Deserialize)]
struct ApiRequest {
    path: String,
    method: String,
    body: Option<String>,
}
#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
}

// Accept only the existing local API contract, never an arbitrary proxy URL.
fn validate_path(path: &str) -> bool {
    let pathname = path.split('?').next().unwrap_or_default();
    (pathname == "/health" || pathname.starts_with("/functions/tud-"))
        && !path.contains(['\\', '#', '\r', '\n'])
        && !pathname.contains("..")
        && !pathname.contains("//")
        && !pathname.contains('%')
        && !pathname.split('/').any(|part| part == ".." || part == ".")
}

#[tauri::command]
async fn api_request(
    request: ApiRequest,
    sidecar: State<'_, Sidecar>,
    client: State<'_, reqwest::Client>,
) -> Result<ApiResponse, String> {
    if !validate_path(&request.path) {
        return Err("Unsupported local API path".into());
    }
    let method = match request.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        _ => return Err("Unsupported local API method".into()),
    };
    let port = sidecar.port().await?;
    let mut req = client.request(method, format!("http://127.0.0.1:{port}{}", request.path));
    if let Some(body) = request.body {
        req = req.header("content-type", "application/json").body(body);
    }
    let response = req.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(ApiResponse { status, body })
}

fn is_association_url(url: &url::Url) -> bool {
    url.host_str() == Some("juejin.cn")
        && (url.path() == "/aiusage" || url.path().starts_with("/aiusage/"))
        && url.query_pairs().any(|(key, _)| key == "login_from_client")
}

#[tauri::command]
async fn open_external(
    app: tauri::AppHandle,
    href: String,
    sidecar: State<'_, Sidecar>,
) -> Result<(), String> {
    let mut url = url::Url::parse(&href).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("Unsupported URL scheme".into());
    }
    // Phase 1 uses the existing loopback CLI association callback. Do not
    // register Electron's protocol handler or consume its deep links.
    if is_association_url(&url) {
        let port = sidecar.port().await?;
        url.query_pairs_mut()
            .clear()
            .append_pair("login_from_client", "cli")
            .append_pair("port", &port.to_string());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar::default())
        .manage(
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(120))
                .build()
                .expect("HTTP client"),
        )
        .invoke_handler(tauri::generate_handler![api_request, open_external])
        .setup(|app| {
            app.state::<Sidecar>()
                .start(app.handle().clone())
                .map_err(std::io::Error::other)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Juejin Usage Tauri")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(include_str!("bridge.js"))
                .on_navigation(|url| {
                    matches!(url.host_str(), Some("tauri.localhost" | "localhost"))
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to start Juejin Usage Tauri");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Sidecar>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{is_association_url, validate_path};
    #[test]
    fn recognizes_dashboard_association_without_taking_electron_protocol() {
        for path in ["/aiusage", "/aiusage/", "/aiusage/dashboard"] {
            assert!(is_association_url(
                &url::Url::parse(&format!(
                    "https://juejin.cn{path}?login_from_client=desktop"
                ))
                .unwrap()
            ));
        }
        assert!(!is_association_url(
            &url::Url::parse("https://example.com/aiusage/dashboard?login_from_client=desktop")
                .unwrap()
        ));
        assert!(!is_association_url(
            &url::Url::parse("https://juejin.cn/aiusage/dashboard").unwrap()
        ));
    }

    #[test]
    fn proxy_stays_inside_local_contract() {
        assert!(validate_path("/health"));
        assert!(validate_path("/functions/tud-usage-daily?days=30"));
        for path in [
            "https://evil.test",
            "//evil.test",
            "/functions/tud-../other",
            "/functions/tud-x/../../admin",
            "/functions/tud-%2e%2e/admin",
            "/functions/tud-x\\x",
            "/other",
            "/health#x",
        ] {
            assert!(!validate_path(path), "{path}");
        }
    }
}
