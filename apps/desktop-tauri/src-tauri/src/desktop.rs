use crate::sidecar::Sidecar;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn install_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示用量面板", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let subscriptions = MenuItem::with_id(app, "subscriptions", "订阅渠道", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "立即同步", true, None::<&str>)?;
    let divider = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Juejin Usage Tauri", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &settings, &subscriptions, &sync, &divider, &quit],
    )?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("Juejin Usage Tauri")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "settings" | "subscriptions" => {
                show_main(app);
                let tab = if event.id.as_ref() == "subscriptions" {
                    "subscription"
                } else {
                    "sync"
                };
                let _ = app.emit("app:open-settings", serde_json::json!({"tab":tab}));
            }
            "sync" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let sidecar = app.state::<Sidecar>();
                        let port = sidecar.port().await?;
                        let response = app
                            .state::<reqwest::Client>()
                            .post(format!(
                                "http://127.0.0.1:{port}/functions/tud-trigger-sync"
                            ))
                            .json(&serde_json::json!({}))
                            .send()
                            .await
                            .map_err(|e| e.to_string())?;
                        let status = response.status().as_u16();
                        let body: serde_json::Value =
                            response.json().await.map_err(|e| e.to_string())?;
                        if !sync_succeeded(status, &body) {
                            return Err("同步失败，请在面板中重试".to_string());
                        }
                        Ok::<(), String>(())
                    }
                    .await;
                    let _ = app.emit(
                        "app:sync-result",
                        serde_json::json!({"ok":result.is_ok(), "message": result.err()}),
                    );
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn window_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window unavailable")?;
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "hide" => window.hide(),
        "show" => {
            show_main(&app);
            return Ok(());
        }
        "quit" => {
            app.exit(0);
            return Ok(());
        }
        _ => return Err("Unknown window action".into()),
    }
    .map_err(|e| e.to_string())
}

fn sync_succeeded(status: u16, body: &serde_json::Value) -> bool {
    (200..300).contains(&status) && body["success"] == true && body["data"]["ok"] == true
}

pub fn parse_theme(mode: &str) -> Result<Option<tauri::Theme>, String> {
    match mode {
        "light" => Ok(Some(tauri::Theme::Light)),
        "dark" => Ok(Some(tauri::Theme::Dark)),
        "system" => Ok(None),
        _ => Err("Invalid theme mode".into()),
    }
}

#[tauri::command]
pub fn theme_set(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window unavailable")?;
    window
        .set_theme(parse_theme(&mode)?)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_theme, sync_succeeded};
    #[test]
    fn tray_does_not_report_failed_sync_as_success() {
        assert!(sync_succeeded(
            200,
            &serde_json::json!({"success":true,"data":{"ok":true}})
        ));
        assert!(!sync_succeeded(
            200,
            &serde_json::json!({"success":true,"data":{"ok":false}})
        ));
        assert!(!sync_succeeded(
            500,
            &serde_json::json!({"success":true,"data":{"ok":true}})
        ));
    }

    #[test]
    fn system_mode_releases_native_override() {
        assert!(parse_theme("system").unwrap().is_none());
        assert_eq!(parse_theme("dark").unwrap(), Some(tauri::Theme::Dark));
        assert_eq!(parse_theme("light").unwrap(), Some(tauri::Theme::Light));
        assert!(parse_theme("auto").is_err());
    }
}
