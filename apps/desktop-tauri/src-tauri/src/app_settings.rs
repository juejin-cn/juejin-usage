use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSettings {
    supported: bool,
    open_at_login: bool,
    launch_hidden: bool,
}

pub fn hidden_launch(autostart: bool, hidden: bool) -> bool {
    autostart && hidden
}

fn apply_registration(
    enabled: bool,
    register: impl FnOnce(bool) -> Result<(), String>,
    read: impl FnOnce() -> Result<bool, String>,
) -> Result<(), String> {
    // Reapply even when already enabled: an update or move can leave an old
    // executable path in the OS entry. The plugin's is_enabled only checks
    // whether the entry exists on macOS.
    register(enabled)?;
    if read()? != enabled {
        return Err("系统未应用开机自启设置，请检查系统登录项权限".into());
    }
    Ok(())
}

fn register(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    apply_registration(
        enabled,
        |enabled| {
            let manager = app.autolaunch();
            if enabled {
                manager.enable()
            } else {
                manager.disable()
            }
            .map_err(|e| e.to_string())
        },
        || app.autolaunch().is_enabled().map_err(|e| e.to_string()),
    )
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    register(
        app,
        app.state::<crate::pet::PetState>().snapshot().open_at_login,
    )
}

#[tauri::command]
pub fn startup_get(app: tauri::AppHandle) -> Result<StartupSettings, String> {
    Ok(StartupSettings {
        // Never register cargo/tauri dev executables as login items.
        supported: !cfg!(debug_assertions),
        open_at_login: if cfg!(debug_assertions) {
            false
        } else {
            app.autolaunch().is_enabled().map_err(|e| e.to_string())?
        },
        launch_hidden: app.state::<crate::pet::PetState>().snapshot().launch_hidden,
    })
}

#[tauri::command]
pub fn startup_set(
    app: tauri::AppHandle,
    open_at_login: Option<bool>,
    launch_hidden: Option<bool>,
) -> Result<StartupSettings, String> {
    if let Some(enabled) = open_at_login {
        if cfg!(debug_assertions) {
            return Err("开机自启仅在 release 应用中可配置".into());
        }
        register(&app, enabled)?;
    }
    if open_at_login.is_some() || launch_hidden.is_some() {
        app.state::<crate::pet::PetState>().update(|p| {
            if let Some(enabled) = open_at_login {
                p.open_at_login = enabled;
            }
            if let Some(hidden) = launch_hidden {
                p.launch_hidden = hidden;
            }
        })?;
    }
    let state = startup_get(app.clone())?;
    let _ = app.emit("app:startup-settings", &state);
    Ok(state)
}

fn decode_png(data_url: &str) -> Result<Vec<u8>, String> {
    let data = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("仅支持 PNG 分享图片")?;
    if data.len() > 20_000_000 {
        return Err("分享图片过大".into());
    }
    let bytes = STANDARD.decode(data).map_err(|_| "图片编码无效")?;
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("PNG 图片无效".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || (width as u64) * (height as u64) > 16_000_000 {
        return Err("图片尺寸超出限制".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub fn clipboard_copy_image(app: tauri::AppHandle, data_url: String) -> Result<bool, String> {
    let bytes = decode_png(&data_url)?;
    let image = tauri::image::Image::from_bytes(&bytes).map_err(|_| "PNG 图片无效")?;
    app.clipboard()
        .write_image(&image)
        .map_err(|_| "复制图片到系统剪贴板失败")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_preference_defaults_on_and_preserves_explicit_opt_out() {
        let old: crate::pet::Preferences =
            serde_json::from_str(r#"{"launchHidden":false}"#).unwrap();
        assert!(old.open_at_login);
        assert!(!old.launch_hidden);

        let dir = std::env::temp_dir().join(format!("jusage-startup-{}", uuid::Uuid::new_v4()));
        let path = dir.join("desktop-ui.json");
        let prefs = crate::pet::PetState::default();
        prefs.load(path.clone());
        prefs.update(|p| p.open_at_login = false).unwrap();
        let reloaded = crate::pet::PetState::default();
        reloaded.load(path);
        assert!(!reloaded.snapshot().open_at_login);
        assert!(reloaded.snapshot().launch_hidden);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reapplies_registration_and_checks_the_os_result() {
        let called = std::cell::Cell::new(false);
        apply_registration(
            true,
            |enabled| {
                called.set(enabled);
                Ok(())
            },
            || Ok(true),
        )
        .unwrap();
        assert!(called.get());
        apply_registration(
            false,
            |enabled| {
                assert!(!enabled);
                Ok(())
            },
            || Ok(false),
        )
        .unwrap();
        assert!(apply_registration(true, |_| Ok(()), || Ok(false)).is_err());
        assert!(apply_registration(false, |_| Ok(()), || Ok(true)).is_err());
        let error = apply_registration(
            true,
            |_| Err("permission denied".into()),
            || panic!("registration failed"),
        );
        assert_eq!(error.unwrap_err(), "permission denied");
        assert!(apply_registration(true, |_| Ok(()), || Err("read failed".into())).is_err());
    }

    #[test]
    fn normal_launch_is_visible_even_with_hidden_login_preference() {
        assert!(!hidden_launch(false, true));
        assert!(!hidden_launch(true, false));
        assert!(hidden_launch(true, true));
    }
    #[test]
    fn rejects_wrong_format_and_oversized_decoded_images_before_allocation() {
        assert!(decode_png("data:text/plain;base64,SGk=").is_err());
        assert!(decode_png("data:image/png;base64,aA==").is_err());
        let mut bytes = vec![0; 24];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&10000_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&10000_u32.to_be_bytes());
        assert!(decode_png(&format!("data:image/png;base64,{}", STANDARD.encode(bytes))).is_err());
    }
}
