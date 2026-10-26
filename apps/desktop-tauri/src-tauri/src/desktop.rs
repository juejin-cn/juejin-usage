use crate::sidecar::Sidecar;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
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
    let prefs = app.state::<crate::pet::PetState>().snapshot();
    let pet_enabled = CheckMenuItem::with_id(
        app,
        "pet-enabled",
        "显示桌宠",
        true,
        prefs.enabled,
        None::<&str>,
    )?;
    let hawking = CheckMenuItem::with_id(
        app,
        "pet-hawking",
        "Hawking",
        true,
        prefs.selected_pet_id == "hawking",
        None::<&str>,
    )?;
    let yoyo = CheckMenuItem::with_id(
        app,
        "pet-yoyo",
        "Yoyo",
        true,
        prefs.selected_pet_id == "yoyo",
        None::<&str>,
    )?;
    let click = CheckMenuItem::with_id(
        app,
        "pet-click",
        "Click",
        true,
        prefs.selected_pet_id == "click",
        None::<&str>,
    )?;
    let pet_menu =
        Submenu::with_items(app, "桌宠", true, &[&pet_enabled, &hawking, &yoyo, &click])?;
    let notifications = CheckMenuItem::with_id(
        app,
        "notifications",
        "系统通知",
        true,
        prefs.notifications_enabled,
        None::<&str>,
    )?;
    let retry = MenuItem::with_id(app, "runtime-retry", "重试本地服务", true, None::<&str>)?;
    let updates = MenuItem::with_id(
        app,
        "updates",
        "检查更新",
        crate::updater::supported(app),
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &settings,
            &subscriptions,
            &sync,
            &pet_menu,
            &notifications,
            &retry,
            &updates,
            &divider,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("Juejin Usage Tauri")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "pet-enabled" => {
                let enabled = !app.state::<crate::pet::PetState>().snapshot().enabled;
                if let Err(message) = crate::pet::set_enabled(app, enabled) {
                    let _ = app.emit("app:shell-error", message);
                }
                let _ =
                    pet_enabled.set_checked(app.state::<crate::pet::PetState>().snapshot().enabled);
            }
            "pet-hawking" | "pet-yoyo" | "pet-click" => {
                let id = event.id.as_ref().strip_prefix("pet-").unwrap();
                if let Err(message) = crate::pet::select(app, id) {
                    let _ = app.emit("app:shell-error", message);
                }
                let selected = app
                    .state::<crate::pet::PetState>()
                    .snapshot()
                    .selected_pet_id;
                let _ = hawking.set_checked(selected == "hawking");
                let _ = yoyo.set_checked(selected == "yoyo");
                let _ = click.set_checked(selected == "click");
            }
            "notifications" => {
                let enabled = !app
                    .state::<crate::pet::PetState>()
                    .snapshot()
                    .notifications_enabled;
                if let Err(message) = crate::pet::set_notifications(app, enabled) {
                    let _ = app.emit("app:shell-error", message);
                }
                let _ = notifications.set_checked(
                    app.state::<crate::pet::PetState>()
                        .snapshot()
                        .notifications_enabled,
                );
            }
            "updates" => {
                show_main(app);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::updater::update_check(
                        app.clone(),
                        app.state::<crate::updater::UpdateState>(),
                    )
                    .await;
                });
            }
            "runtime-retry" => {
                show_main(app);
                if let Err(message) = app.state::<Sidecar>().retry(app.clone()) {
                    let _ = app.emit("app:shell-error", message);
                }
            }
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
                    if result.is_err() {
                        crate::pet::notify(
                            &app,
                            "同步失败",
                            "请打开面板检查本地服务或数据源状态。",
                        );
                    }
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
