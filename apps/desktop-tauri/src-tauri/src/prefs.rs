//! On-disk UI preferences (`desktop-prefs.json`), P2.
//!
//! Mirrors the Electron `autostart.ts` store: a single JSON file under the app
//! config dir holding the launch/tray prefs plus the persisted theme mode and
//! dashboard range. Every read-modify-write is serialized behind a `Mutex`
//! (the Rust analogue of Electron's `withPrefsLock`), so consecutive writes
//! cannot clobber each other.
//!
//! The file lives in `BaseDirectory::AppConfig` — the Tauri equivalent of
//! Electron's `userData` directory.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// camelCase on disk to match the Electron `desktop-prefs.json` shape.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    /// 开机自启。缺省开启。
    #[serde(default = "default_true")]
    pub open_at_login: bool,
    /// 自启时是否静默（仅托盘）。缺省开启。
    #[serde(default = "default_true")]
    pub launch_hidden: bool,
    /// 主题模式（system / light / dark）；缺省跟随系统。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme_mode: Option<String>,
    /// 最近一次仪表盘时间范围；缺省 7 天。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_range: Option<String>,
    /// 桌面宠物偏好；未启用/未配置时缺省（`None` 不落盘）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_pet: Option<DesktopPetPref>,
}

fn default_true() -> bool {
    true
}

/// Desktop-pet position, camelCase `{x, y}` to match Electron's
/// `DesktopPetPosition`. Persisted so a re-enabled pet returns to where it
/// was last dragged / auto-moved.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct PetPosition {
    pub x: f64,
    pub y: f64,
}

/// Desktop-pet preference, camelCase to match Electron's `DesktopPetPref`
/// (the `desktopPet` field of `desktop-prefs.json`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetPref {
    /// 是否启用桌面宠物。
    pub enabled: bool,
    /// 选中的宠物 IP（hawking / yoyo / click）。
    pub selected_pet_id: String,
    /// 最近一次位置（逻辑像素）；缺省时新开窗口落在右下角。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<PetPosition>,
    /// 精灵缩放，夹在 0.35–0.75。缺省 0.5。
    pub scale: f64,
    /// 精灵帧间隔 ms，夹在 120–320。缺省 180。
    pub frame_interval_ms: u32,
    /// 是否自动移动。缺省开启。
    pub auto_move_enabled: bool,
    /// 自动移动间隔（分钟），夹在 1–120。缺省 2。
    pub auto_move_interval_minutes: u32,
}

impl Default for DesktopPetPref {
    // Mirrors `loadDesktopPetPref`'s fallback in the Electron `autostart.ts`.
    fn default() -> Self {
        Self {
            enabled: false,
            selected_pet_id: "hawking".to_string(),
            position: None,
            scale: 0.5,
            frame_interval_ms: 180,
            auto_move_enabled: true,
            auto_move_interval_minutes: 2,
        }
    }
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            open_at_login: true,
            launch_hidden: true,
            theme_mode: None,
            dashboard_range: None,
            desktop_pet: None,
        }
    }
}

/// Shared across the whole Tauri process. The path is resolved in `setup`
/// (it depends on the `AppHandle`'s config dir) and the cache is hydrated from
/// disk on first load.
pub struct PrefsState {
    path: Mutex<Option<PathBuf>>,
    cache: Mutex<Prefs>,
}

impl Default for PrefsState {
    fn default() -> Self {
        Self {
            path: Mutex::new(None),
            cache: Mutex::new(Prefs::default()),
        }
    }
}

impl PrefsState {
    /// Point the store at `desktop-prefs.json` under `dir` and load any
    /// existing contents into the in-memory cache. Call once in `setup`.
    pub fn load_from(&self, dir: PathBuf) {
        let path = dir.join("desktop-prefs.json");
        let read = match fs::read(&path) {
            Ok(raw) => serde_json::from_slice::<Prefs>(&raw).unwrap_or_default(),
            Err(_) => Prefs::default(),
        };
        *self.path.lock().unwrap() = Some(path);
        *self.cache.lock().unwrap() = read;
    }

    /// Current in-memory snapshot.
    pub fn get(&self) -> Prefs {
        self.cache.lock().unwrap().clone()
    }

    /// Read-modify-write under the lock. Returns the next full state.
    pub fn patch(&self, patch: impl FnOnce(&mut Prefs)) -> Prefs {
        let mut cache = self.cache.lock().unwrap();
        patch(&mut cache);
        let next = cache.clone();
        if let Some(path) = self.path.lock().unwrap().clone() {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            // Best-effort persist; a write failure must not break the in-memory
            // switch (same contract as Electron's `saveThemeMode` `.catch`).
            let mut text = serde_json::to_string_pretty(&next).unwrap_or_default();
            text.push('\n');
            let _ = fs::write(&path, text);
        }
        next
    }
}
