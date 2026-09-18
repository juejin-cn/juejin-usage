//! Dashboard range state. P0 keeps it in-memory; P2 persists to
//! `desktop-prefs.json`. Valid values mirror `shared/dashboard-range.ts`.

use std::sync::Mutex;

pub const DEFAULT_RANGE: &str = "last-7-days";

fn is_range(range: &str) -> bool {
    matches!(
        range,
        "today" | "last-7-days" | "last-30-days" | "last-90-days"
    )
}

pub struct DashboardRangeState(Mutex<String>);

impl Default for DashboardRangeState {
    fn default() -> Self {
        Self(Mutex::new(DEFAULT_RANGE.to_string()))
    }
}

impl DashboardRangeState {
    pub fn current(&self) -> String {
        self.0.lock().unwrap().clone()
    }

    /// Set the range, ignoring invalid values. Returns the value now stored.
    pub fn set(&self, range: &str) -> String {
        if is_range(range) {
            *self.0.lock().unwrap() = range.to_string();
        }
        self.current()
    }
}
