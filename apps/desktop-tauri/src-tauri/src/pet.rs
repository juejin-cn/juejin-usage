//! Opt-in builtin pet and notification preferences, separate from Core identity.
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub selected_pet_id: String,
    pub notifications_enabled: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: false,
            selected_pet_id: "hawking".into(),
            notifications_enabled: false,
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
                if !is_builtin(&prefs.selected_pet_id) {
                    prefs.selected_pet_id = "hawking".into();
                }
                *self.prefs.lock().unwrap() = prefs;
            }
        }
        *self.path.lock().unwrap() = Some(path);
    }
    pub fn snapshot(&self) -> Preferences {
        self.prefs.lock().unwrap().clone()
    }
    fn update(&self, change: impl FnOnce(&mut Preferences)) -> Result<Preferences, String> {
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
    if !prefs.enabled {
        let _ = app.emit("desktop-pet:preferences", &prefs);
        if let Some(w) = app.get_webview_window("pet") {
            w.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if let Some(w) = app.get_webview_window("pet") {
        w.show().map_err(|e| e.to_string())?;
    } else {
        let mut builder = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
            .title("Juejin Usage Pet")
            .inner_size(160.0, 200.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .on_navigation(|url| matches!(url.host_str(), Some("localhost" | "tauri.localhost")));
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            builder = builder.position(
                (area.position.x as f64 + area.size.width as f64) / scale - 185.0,
                (area.position.y as f64 + area.size.height as f64) / scale - 225.0,
            );
        }
        builder.build().map_err(|e| e.to_string())?;
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
                p.enabled = true;
                p.selected_pet_id = "click".into()
            })
            .unwrap();
        let restored = PetState::default();
        restored.load(dir.join("desktop-ui.json"));
        assert!(restored.snapshot().enabled);
        assert_eq!(restored.snapshot().selected_pet_id, "click");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
