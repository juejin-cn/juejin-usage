#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod desktop;
mod pet;
mod sidecar;
mod supervisor;
mod tray_popover;
mod updater;
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
    url.origin().ascii_serialization() == "https://juejin.cn"
        && url.username().is_empty()
        && url.password().is_none()
        && (url.path() == "/aiusage" || url.path().starts_with("/aiusage/"))
        && url.query_pairs().any(|(key, _)| key == "login_from_client")
}

#[tauri::command]
async fn open_external(
    app: tauri::AppHandle,
    href: String,
    sidecar: State<'_, Sidecar>,
    client: State<'_, reqwest::Client>,
) -> Result<(), String> {
    let mut url = url::Url::parse(&href).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("Unsupported URL scheme".into());
    }
    if is_association_url(&url) {
        let port = sidecar.port().await?;
        let response = client
            .post(format!(
                "http://127.0.0.1:{port}/functions/tud-desktop-login"
            ))
            .query(&[("target", url.as_str())])
            .header("x-tud-host-key", &sidecar.host_key)
            .send()
            .await
            .map_err(|_| "无法启动账号关联".to_string())?;
        if !response.status().is_success() {
            return Err("无法启动账号关联".into());
        }
        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|_| "关联响应无效".to_string())?;
        url = url::Url::parse(result["url"].as_str().ok_or("关联地址缺失")?)
            .map_err(|_| "关联地址无效".to_string())?;
        if url.host_str() != Some("127.0.0.1")
            || url.port() != Some(port)
            || url.path() != "/desktop-login/start"
        {
            return Err("关联地址无效".into());
        }
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["tray-popover", "pet"])
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(tray_popover::PopoverState::default())
        .manage(Sidecar::default())
        .manage(updater::UpdateState::default())
        .manage(pet::PetState::default())
        .manage(
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(120))
                .build()
                .expect("HTTP client"),
        )
        .invoke_handler(tauri::generate_handler![
            api_request,
            open_external,
            desktop::window_action,
            tray_popover::tray_resize,
            desktop::theme_set,
            sidecar::runtime_status,
            sidecar::runtime_notice,
            sidecar::runtime_ack_notice,
            sidecar::runtime_retry,
            pet::pet_get,
            pet::pet_drag,
            updater::update_status,
            updater::update_check,
            updater::update_install
        ])
        .on_window_event(|window, event| {
            if window.label() == "tray-popover" {
                match event {
                    tauri::WindowEvent::Focused(false) => tray_popover::hide(window.app_handle()),
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        tray_popover::hide(window.app_handle());
                    }
                    _ => {}
                }
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            app.state::<pet::PetState>()
                .load(app.path().app_config_dir()?.join("desktop-ui.json"));
            app.state::<Sidecar>()
                .start(app.handle().clone())
                .map_err(std::io::Error::other)?;
            updater::initialize(app.handle()).map_err(|e| std::io::Error::other(e.to_string()))?;
            desktop::install_tray(app.handle())?;
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Juejin Usage Tauri")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(900.0, 600.0)
                    .initialization_script(include_str!("bridge.js"))
                    .on_navigation(|url| {
                        matches!(url.host_str(), Some("tauri.localhost" | "localhost"))
                    });
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            #[cfg(not(target_os = "macos"))]
            let builder = builder.decorations(false);
            builder.build()?;
            tray_popover::create(app.handle())?;
            pet::sync_window(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to start Juejin Usage Tauri");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Sidecar>().stop();
        }
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            desktop::show_main(app);
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
