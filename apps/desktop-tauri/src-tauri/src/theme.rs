//! Theme state + helpers. P0 keeps the mode in-memory (default `system`).
//! P2 moves it to `desktop-prefs.json`.

use serde::Serialize;
use std::sync::Mutex;

/// Accepted theme modes — mirrors `shared/theme.ts` (`isThemeMode`).
pub fn is_theme_mode(mode: &str) -> bool {
    matches!(mode, "system" | "light" | "dark")
}

/// Snapshot emitted as the `theme:changed` payload and returned by `theme_get`.
#[derive(Serialize, Clone)]
pub struct ThemeSnapshot {
    pub mode: String,
    pub resolved: String,
}

pub struct ThemeState(Mutex<ThemeSnapshot>);

impl Default for ThemeState {
    fn default() -> Self {
        Self(Mutex::new(ThemeSnapshot {
            mode: "system".to_string(),
            // In `system` mode the real OS appearance is unknown at P0; default
            // to light. P2/P3 resolve against the OS appearance.
            resolved: "light".to_string(),
        }))
    }
}

impl ThemeState {
    pub fn snapshot(&self) -> ThemeSnapshot {
        self.0.lock().unwrap().clone()
    }

    /// Update the stored mode. `resolved` equals `mode` unless `mode` is
    /// `system`, in which case it stays at the last-resolved value until the
    /// OS-appearance follow (P2) recomputes it.
    pub fn set_mode(&self, mode: &str) -> ThemeSnapshot {
        let mut state = self.0.lock().unwrap();
        state.mode = mode.to_string();
        if mode != "system" {
            state.resolved = mode.to_string();
        }
        state.clone()
    }
}
