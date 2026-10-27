//! Dedicated tray surface. Never load the full application shell in this window.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct PopoverState {
    hidden_at: Mutex<Option<Instant>>,
    anchor: Mutex<Option<tauri::Rect>>,
}

pub fn hide(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("tray-popover") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            *app.state::<PopoverState>().hidden_at.lock().unwrap() = Some(Instant::now());
        }
    }
}

pub fn create(app: &tauri::AppHandle) -> tauri::Result<()> {
    let external_app = app.clone();
    let navigation_app = app.clone();
    WebviewWindowBuilder::new(
        app,
        "tray-popover",
        WebviewUrl::App("index.html?view=tray-popover".into()),
    )
    .title("用量概览")
    .inner_size(430.0, 650.0)
    .decorations(false)
    // The web surface supplies the rounded outline. Keep the
    // native shadow, as in Electron, without an opaque rectangular backing.
    .transparent(true)
    .shadow(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .focused(false)
    .initialization_script(include_str!("bridge.js"))
    .initialization_script(include_str!("diagnostics.js"))
    .on_page_load(crate::diagnostics::page_load)
    .on_new_window(move |url, _| {
        crate::desktop::handle_new_window(external_app.clone(), url);
        tauri::webview::NewWindowResponse::Deny
    })
    .on_navigation(move |url| crate::diagnostics::navigation(&navigation_app, "tray-popover", url))
    .build()?;
    Ok(())
}

// Coordinates below are physical pixels, including negative monitor origins.
fn place(
    anchor: (f64, f64, f64, f64),
    area: (f64, f64, f64, f64),
    width: f64,
    height: f64,
    gap: f64,
) -> (f64, f64) {
    let (ax, ay, aw, ah) = anchor;
    let (x, y, w, h) = area;
    let left = (ax + aw / 2.0 - width / 2.0).clamp(x, (x + w - width).max(x));
    let below = ay + ah + gap;
    let top = if below + height <= y + h {
        below
    } else {
        ay - height - gap
    };
    (left, top.clamp(y, (y + h - height).max(y)))
}

// Menu-bar rectangles can straddle a monitor edge. Choose the nearest
// monitor instead of refusing to show the popover when strict containment fails.
fn distance_to_area(point: (f64, f64), area: (f64, f64, f64, f64)) -> f64 {
    let (x, y, width, height) = area;
    let dx = point.0 - point.0.clamp(x, x + width);
    let dy = point.1 - point.1.clamp(y, y + height);
    dx * dx + dy * dy
}

fn position(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("tray-popover")
        .ok_or("托盘窗口不存在")?;
    // Keep the click's rect for subsequent renderer-driven resizes too.
    let rect = (*app.state::<PopoverState>().anchor.lock().unwrap()).ok_or("托盘位置不可用")?;
    // A tray Rect may contain logical or physical coordinates; convert both
    // using the monitor containing the click / tray icon, rather than primary.
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .min_by(|a, b| {
            let distance = |m: &tauri::Monitor| {
                let p = rect.position.to_physical::<f64>(m.scale_factor());
                let size = rect.size.to_physical::<f64>(m.scale_factor());
                let origin = m.position();
                let extent = m.size();
                distance_to_area(
                    (p.x + size.width / 2.0, p.y + size.height / 2.0),
                    (
                        origin.x as f64,
                        origin.y as f64,
                        extent.width as f64,
                        extent.height as f64,
                    ),
                )
            };
            distance(a).total_cmp(&distance(b))
        })
        .ok_or("托盘显示器不可用")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let anchor = rect.position.to_physical::<f64>(scale);
    let icon = rect.size.to_physical::<f64>(scale);
    let height = (window.inner_size().map_err(|e| e.to_string())?.height as f64)
        .min(area.size.height as f64);
    window
        .set_size(tauri::PhysicalSize::new(
            (430.0 * scale).min(area.size.width as f64) as u32,
            height as u32,
        ))
        .map_err(|e| e.to_string())?;
    let (x, y) = place(
        (anchor.x, anchor.y, icon.width, icon.height),
        (
            area.position.x as f64,
            area.position.y as f64,
            area.size.width as f64,
            area.size.height as f64,
        ),
        (430.0 * scale).min(area.size.width as f64),
        height,
        6.0 * scale,
    );
    window
        .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
        .map_err(|e| e.to_string())
}

pub fn toggle(app: &tauri::AppHandle, rect: tauri::Rect) -> Result<(), String> {
    *app.state::<PopoverState>().anchor.lock().unwrap() = Some(rect);
    let window = app
        .get_webview_window("tray-popover")
        .ok_or("托盘窗口不存在")?;
    if window.is_visible().map_err(|e| e.to_string())? {
        hide(app);
        return Ok(());
    }
    // macOS can report blur before delivering the click on the status item.
    if app
        .state::<PopoverState>()
        .hidden_at
        .lock()
        .unwrap()
        .is_some_and(|t| t.elapsed() < Duration::from_millis(200))
    {
        return Ok(());
    }
    position(app)?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    let _ = app.emit_to("tray-popover", "app:popover-shown", ());
    Ok(())
}

#[tauri::command]
pub fn tray_resize(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    height: f64,
) -> Result<(), String> {
    if window.label() != "tray-popover" || !height.is_finite() {
        return Err("无效托盘窗口尺寸请求".into());
    }
    window
        .set_size(tauri::LogicalSize::new(430.0, height.clamp(200.0, 700.0)))
        .map_err(|e| e.to_string())?;
    // The hidden renderer measures itself at startup, before any tray click.
    // Save that size without requiring an anchor until the first open.
    if app.state::<PopoverState>().anchor.lock().unwrap().is_some() {
        position(&app)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{distance_to_area, place};

    #[test]
    fn menu_bar_outside_monitor_bounds_still_selects_nearest_display() {
        let left = (-1920.0, 0.0, 1920.0, 1080.0);
        let right = (0.0, 0.0, 2880.0, 1800.0);
        assert_eq!(distance_to_area((-100.0, -1.0), left), 1.0);
        assert!(distance_to_area((-100.0, -1.0), left) < distance_to_area((-100.0, -1.0), right));
        assert_eq!(distance_to_area((2880.0, 0.0), right), 0.0);
        assert_eq!(distance_to_area((100.0, 20.0), right), 0.0);
    }
    #[test]
    fn clamps_to_negative_origin_scaled_monitor_and_flips_at_bottom() {
        assert_eq!(
            place(
                (-10.0, 0.0, 20.0, 24.0),
                (-1920.0, 24.0, 1920.0, 1056.0),
                430.0,
                700.0,
                6.0
            ),
            (-430.0, 30.0)
        );
        assert_eq!(
            place(
                (1900.0, 1056.0, 20.0, 24.0),
                (0.0, 0.0, 1920.0, 1080.0),
                430.0,
                700.0,
                6.0
            ),
            (1490.0, 350.0)
        );
        assert_eq!(
            place(
                (200.0, 0.0, 40.0, 48.0),
                (0.0, 48.0, 2880.0, 1752.0),
                860.0,
                1400.0,
                12.0
            ),
            (0.0, 60.0)
        );
    }
}
