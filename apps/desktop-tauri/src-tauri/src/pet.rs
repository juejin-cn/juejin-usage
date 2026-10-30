//! Opt-in builtin pet and notification preferences, separate from Core identity.
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub position: Option<(i32, i32)>,
    pub scale: f64,
    pub frame_interval_ms: u64,
    pub auto_move_enabled: bool,
    pub auto_move_interval_minutes: u64,
    pub sync_feedback_enabled: bool,
    pub sync_feedback_duration_sec: u64,
    pub launch_hidden: bool,
    pub selected_pet_id: String,
    pub notifications_enabled: bool,
    pub show_tray_usage: bool,
    pub tray_usage_mode: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: false,
            position: None,
            scale: 0.5,
            frame_interval_ms: 180,
            auto_move_enabled: true,
            auto_move_interval_minutes: 2,
            sync_feedback_enabled: false,
            sync_feedback_duration_sec: 3,
            launch_hidden: true,
            selected_pet_id: "hawking".into(),
            notifications_enabled: false,
            show_tray_usage: false,
            tray_usage_mode: "both".into(),
        }
    }
}
pub fn is_builtin(id: &str) -> bool {
    matches!(id, "hawking" | "yoyo" | "click")
}
#[derive(Default)]
pub struct PetState {
    prefs: Mutex<Preferences>,
    path: Mutex<Option<PathBuf>>,
}
impl PetState {
    pub fn load(&self, path: PathBuf) {
        if let Ok(raw) = std::fs::read(&path) {
            if let Ok(mut prefs) = serde_json::from_slice::<Preferences>(&raw) {
                if !valid_id(&prefs.selected_pet_id) {
                    prefs.selected_pet_id = "hawking".into();
                }
                let defaults = Preferences::default();
                if !(0.35..=0.75).contains(&prefs.scale) {
                    prefs.scale = defaults.scale;
                }
                if !(120..=320).contains(&prefs.frame_interval_ms) {
                    prefs.frame_interval_ms = defaults.frame_interval_ms;
                }
                if !(1..=120).contains(&prefs.auto_move_interval_minutes) {
                    prefs.auto_move_interval_minutes = defaults.auto_move_interval_minutes;
                }
                if !(1..=10).contains(&prefs.sync_feedback_duration_sec) {
                    prefs.sync_feedback_duration_sec = defaults.sync_feedback_duration_sec;
                }
                if !matches!(prefs.tray_usage_mode.as_str(), "both" | "tokens" | "cost") {
                    prefs.tray_usage_mode = defaults.tray_usage_mode;
                }
                *self.prefs.lock().unwrap() = prefs;
            }
        }
        *self.path.lock().unwrap() = Some(path);
    }
    pub fn snapshot(&self) -> Preferences {
        self.prefs.lock().unwrap().clone()
    }
    pub(crate) fn update(
        &self,
        change: impl FnOnce(&mut Preferences),
    ) -> Result<Preferences, String> {
        let mut current = self.prefs.lock().unwrap();
        let mut next = current.clone();
        change(&mut next);
        let path = self
            .path
            .lock()
            .unwrap()
            .clone()
            .ok_or("偏好目录尚未就绪")?;
        std::fs::create_dir_all(path.parent().ok_or("偏好目录无效")?).map_err(|e| e.to_string())?;
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, serde_json::to_vec(&next).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(temp, path).map_err(|e| e.to_string())?;
        *current = next.clone();
        Ok(next)
    }
}
pub fn sync_window(app: &tauri::AppHandle) -> Result<(), String> {
    let prefs = app.state::<PetState>().snapshot();
    let (width, height) = dimensions(prefs.scale);
    if !prefs.enabled {
        let _ = app.emit("desktop-pet:preferences", &prefs);
        if let Some(w) = app.get_webview_window("pet") {
            w.destroy().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if let Some(w) = app.get_webview_window("pet") {
        w.set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        pet_move(w.clone(), 0.0)?;
        w.show().map_err(|e| e.to_string())?;
    } else {
        let navigation_app = app.clone();
        let mut builder = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
            .title("Juejin Usage Pet")
            .theme(crate::desktop::native_theme(app))
            .inner_size(width, height)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .initialization_script(include_str!("diagnostics.js"))
            .on_page_load(crate::diagnostics::page_load)
            .on_navigation(move |url| crate::diagnostics::navigation(&navigation_app, "pet", url));
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            builder = builder.position(
                (area.position.x as f64 + area.size.width as f64) / scale - 185.0,
                (area.position.y as f64 + area.size.height as f64) / scale - 225.0,
            );
        }
        #[cfg(target_os = "macos")]
        let builder = builder.visible_on_all_workspaces(true);
        let window = builder.visible(false).build().map_err(|e| e.to_string())?;
        if let Some((x, y)) = prefs.position {
            if let Ok(monitors) = app.available_monitors() {
                if monitors.iter().any(|m| {
                    let p = m.position();
                    let s = m.size();
                    x >= p.x
                        && y >= p.y
                        && (x as i64) < p.x as i64 + s.width as i64
                        && (y as i64) < p.y as i64 + s.height as i64
                }) {
                    window
                        .set_position(tauri::PhysicalPosition::new(x, y))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            let pet_window = window.clone();
            app.run_on_main_thread(move || {
                if let Ok(raw) = pet_window.ns_window() {
                    // Tauri owns the live NSWindow. Access stays on AppKit's main thread.
                    let native = unsafe { &*(raw as *const objc2_app_kit::NSWindow) };
                    let flags = native.collectionBehavior()
                        | objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces
                        | objc2_app_kit::NSWindowCollectionBehavior::FullScreenAuxiliary;
                    native.setCollectionBehavior(flags);
                }
            })
            .map_err(|e| e.to_string())?;
        }
        window.show().map_err(|e| e.to_string())?;
    }
    let _ = app.emit("desktop-pet:preferences", prefs);
    Ok(())
}
pub fn set_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<PetState>();
    let previous = state.snapshot();
    state.update(|p| p.enabled = enabled)?;
    if let Err(error) = sync_window(app) {
        let _ = state.update(|p| p.enabled = previous.enabled);
        return Err(error);
    }
    Ok(())
}
pub fn select(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if !is_builtin(id) {
        return Err("未知内置桌宠".into());
    }
    app.state::<PetState>()
        .update(|p| p.selected_pet_id = id.into())?;
    sync_window(app)
}
pub fn set_notifications(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<PetState>()
        .update(|p| p.notifications_enabled = enabled)?;
    Ok(())
}
pub fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    if app
        .try_state::<PetState>()
        .is_some_and(|s| s.snapshot().notifications_enabled)
    {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}
#[tauri::command]
pub fn pet_get(state: State<'_, PetState>) -> Preferences {
    state.snapshot()
}
#[tauri::command]
pub fn pet_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("仅桌宠窗口可以拖动".into());
    }
    window.start_dragging().map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_default_off_and_round_trip() {
        let p = Preferences::default();
        assert!(!p.enabled);
        assert!(!p.notifications_enabled);
        assert!(is_builtin(&p.selected_pet_id));
        assert!(!is_builtin("../../other"));
        let raw = serde_json::to_vec(&p).unwrap();
        assert_eq!(
            serde_json::from_slice::<Preferences>(&raw)
                .unwrap()
                .selected_pet_id,
            "hawking"
        );
    }
    #[test]
    fn preferences_persist_without_touching_core_config() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let state = PetState::default();
        state.load(dir.join("desktop-ui.json"));
        state
            .update(|p| {
                p.show_tray_usage = true;
                p.tray_usage_mode = "cost".into();
                p.enabled = true;
                p.selected_pet_id = "click".into()
            })
            .unwrap();
        let restored = PetState::default();
        restored.load(dir.join("desktop-ui.json"));
        assert!(restored.snapshot().enabled);
        assert!(restored.snapshot().show_tray_usage);
        assert_eq!(restored.snapshot().tray_usage_mode, "cost");
        assert_eq!(restored.snapshot().selected_pet_id, "click");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn dimensions(scale: f64) -> (f64, f64) {
    (
        (192.0 * scale).round().max(160.0),
        (208.0 * scale).round() + 116.0,
    )
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PetChanges {
    enabled: Option<bool>,
    selected_pet_id: Option<String>,
    scale: Option<f64>,
    frame_interval_ms: Option<u64>,
    auto_move_enabled: Option<bool>,
    auto_move_interval_minutes: Option<u64>,
    sync_feedback_enabled: Option<bool>,
    sync_feedback_duration_sec: Option<u64>,
    show_tray_usage: Option<bool>,
    tray_usage_mode: Option<String>,
}
fn apply_changes(p: &mut Preferences, c: &PetChanges) -> Result<(), String> {
    if c.scale
        .is_some_and(|v| !v.is_finite() || !(0.35..=0.75).contains(&v))
        || c.frame_interval_ms
            .is_some_and(|v| !(120..=320).contains(&v))
        || c.auto_move_interval_minutes
            .is_some_and(|v| !(1..=120).contains(&v))
        || c.sync_feedback_duration_sec
            .is_some_and(|v| !(1..=10).contains(&v))
    {
        return Err("桌宠设置超出允许范围".into());
    }
    if let Some(v) = &c.tray_usage_mode {
        if !matches!(v.as_str(), "both" | "tokens" | "cost") {
            return Err("用量显示方式无效".into());
        }
        p.tray_usage_mode = v.clone();
    }
    if let Some(v) = c.show_tray_usage {
        p.show_tray_usage = v;
    }
    if let Some(v) = c.enabled {
        p.enabled = v;
    }
    if let Some(v) = &c.selected_pet_id {
        if !valid_id(v) {
            return Err("宠物 ID 无效".into());
        }
        p.selected_pet_id = v.clone();
    }
    if let Some(v) = c.scale {
        p.scale = v;
    }
    if let Some(v) = c.frame_interval_ms {
        p.frame_interval_ms = v;
    }
    if let Some(v) = c.auto_move_enabled {
        p.auto_move_enabled = v;
    }
    if let Some(v) = c.auto_move_interval_minutes {
        p.auto_move_interval_minutes = v;
    }
    if let Some(v) = c.sync_feedback_enabled {
        p.sync_feedback_enabled = v;
    }
    if let Some(v) = c.sync_feedback_duration_sec {
        p.sync_feedback_duration_sec = v;
    }
    Ok(())
}
#[tauri::command]
pub async fn pet_set(app: tauri::AppHandle, changes: PetChanges) -> Result<Preferences, String> {
    if let Some(id) = &changes.selected_pet_id {
        if !valid_id(id) {
            return Err("宠物 ID 无效".into());
        }
        if !is_builtin(id) {
            let sidecar = app.state::<crate::sidecar::Sidecar>();
            let port = sidecar.port().await?;
            let response = app
                .state::<reqwest::Client>()
                .get(format!(
                    "http://127.0.0.1:{port}/functions/tud-desktop-pets"
                ))
                .header("x-tud-host-key", &sidecar.host_key)
                .send()
                .await
                .map_err(|_| "读取宠物目录失败")?;
            let catalog: serde_json::Value = response.json().await.map_err(|_| "宠物目录无效")?;
            if !catalog["data"]["pets"]
                .as_array()
                .is_some_and(|pets| pets.iter().any(|pet| pet["id"].as_str() == Some(id)))
            {
                return Err("请先安装宠物".into());
            }
        }
    }
    let state = app.state::<PetState>();
    let previous = state.snapshot();
    let mut next = previous.clone();
    apply_changes(&mut next, &changes)?;
    state.update(|p| *p = next)?;
    if let Err(error) = sync_window(&app) {
        let _ = state.update(|p| *p = previous);
        return Err(error);
    }
    crate::desktop::refresh_usage(app.clone());
    Ok(state.snapshot())
}
#[tauri::command]
pub fn pet_move(window: tauri::WebviewWindow, dx: f64) -> Result<(), String> {
    if window.label() != "pet" || !dx.is_finite() || dx.abs() > 10.0 {
        return Err("无效漫游请求".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("显示器不可用")?;
    let area = monitor.work_area();
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let current = window.outer_position().map_err(|e| e.to_string())?;
    let x = (current.x as f64 + dx * scale).clamp(
        area.position.x as f64,
        (area.position.x as f64 + area.size.width as f64 - size.width as f64)
            .max(area.position.x as f64),
    );
    let y = (current.y as f64).clamp(
        area.position.y as f64,
        (area.position.y as f64 + area.size.height as f64 - size.height as f64)
            .max(area.position.y as f64),
    );
    window
        .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn pet_mouse_ignore(window: tauri::WebviewWindow, ignored: bool) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("仅限桌宠窗口".into());
    }
    window
        .set_ignore_cursor_events(ignored)
        .map_err(|e| e.to_string())
}
#[cfg(test)]
mod preference_tests {
    use super::*;
    #[test]
    fn validates_ranges_and_local_pet_identifiers() {
        let mut prefs = Preferences::default();
        assert!(apply_changes(
            &mut prefs,
            &PetChanges {
                scale: Some(0.1),
                ..Default::default()
            }
        )
        .is_err());
        assert!(apply_changes(
            &mut prefs,
            &PetChanges {
                sync_feedback_duration_sec: Some(11),
                ..Default::default()
            }
        )
        .is_err());
        assert!(apply_changes(
            &mut prefs,
            &PetChanges {
                selected_pet_id: Some("../pet".into()),
                ..Default::default()
            }
        )
        .is_err());
        apply_changes(
            &mut prefs,
            &PetChanges {
                scale: Some(0.75),
                selected_pet_id: Some("local-pet".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(dimensions(prefs.scale), (160.0, 272.0));
    }
}

#[tauri::command]
pub fn pet_cursor(window: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    if window.label() != "pet" {
        return Err("仅限桌宠窗口".into());
    }
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    Ok((
        (cursor.x - origin.x as f64) / scale,
        (cursor.y - origin.y as f64) / scale,
    ))
}
#[tauri::command]
pub fn pet_context(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::menu::{ContextMenu, Menu, MenuItem};
    if window.label() != "pet" {
        return Err("仅限桌宠窗口".into());
    }
    let show = MenuItem::with_id(&app, "pet-show-main", "显示主窗口", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(&app, "pet-open-settings", "桌宠设置", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sync = MenuItem::with_id(&app, "sync", "同步数据", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let hide = MenuItem::with_id(&app, "pet-hide", "退出宠物", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    Menu::with_items(&app, &[&show, &sync, &settings, &hide])
        .map_err(|e| e.to_string())?
        .popup(window.as_ref().window())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn pet_save_position(
    window: tauri::WebviewWindow,
    state: State<'_, PetState>,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("仅限桌宠窗口".into());
    }
    let p = window.outer_position().map_err(|e| e.to_string())?;
    state.update(|prefs| prefs.position = Some((p.x, p.y)))?;
    Ok(())
}

#[tauri::command]
pub fn pet_directory(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let directory = std::env::var_os("TUD_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(
            app.path()
                .home_dir()
                .map_err(|e| e.to_string())?
                .join(".ai-usage"),
        )
        .join("pets");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
