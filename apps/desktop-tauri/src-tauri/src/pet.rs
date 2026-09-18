//! Desktop pet window (P3) — transparent, always-on-top, cursor-ignorable.
//!
//! Port of the Electron `DesktopPet.ts`. The renderer (`pet.html`) was copied
//! verbatim and reads `window.tud` for pet commands/events; this module owns
//! the native window and the behaviors the preload used to drive:
//!
//!   - a borderless transparent `WebviewWindow` (`pet.html`) that stays
//!     always-on-top and is invisible to the taskbar
//!   - **cursor follow**: on drag-begin the renderer hands the whole drag to
//!     main, which polls the OS cursor (~8ms) and re-positions its own window,
//!     so the sprite never lags behind IPC. Mirrors `tickDrag`.
//!   - **auto-move**: a Bézier wander between random work-area points, exactly
//!     the `createAutoMoveSegments`/`cubicPoint` math from Electron.
//!   - **animation** direction events (`idle` / `running-left` /
//!     `running-right`) emitted as `desktop-pet:animation`.
//!   - **prefs** persist to `desktop-prefs.json` (`desktop_pet`), broadcast as
//!     `desktop-pet:preferences` so the pet window re-scales live.
//!
//! State lives in a Tauri-managed `PetState`; the cursor-follow and auto-move
//! loops run on short-lived std threads coordinated by atomics (Rust's
//! analogue of Electron's `setInterval`/`setTimeout` bookkeeping).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    Emitter, LogicalPosition, LogicalSize, Manager, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::prefs::{DesktopPetPref, PetPosition, PrefsState};

pub const PET_LABEL: &str = "desktop-pet";

// ---- layout (mirrors shared/desktop-pet-layout.ts) -------------------------

const DESKTOP_PET_SOURCE_WIDTH: f64 = 192.0;
const DESKTOP_PET_SOURCE_HEIGHT: f64 = 208.0;
const DESKTOP_PET_POPOVER_WIDTH: f64 = 136.0;
const DESKTOP_PET_POPOVER_TOP_SPACE: f64 = 116.0;
const DESKTOP_PET_HORIZONTAL_GUTTER: f64 = 12.0;

/// Layout values the native host needs: the transparent window's size, and the
/// sprite's placement inside it. Matches `getDesktopPetLayout`.
fn pet_layout(scale: f64) -> (f64, f64, f64, f64, f64) {
    let sprite_w = (DESKTOP_PET_SOURCE_WIDTH * scale).round();
    let sprite_h = (DESKTOP_PET_SOURCE_HEIGHT * scale).round();
    let host_w = sprite_w.max(DESKTOP_PET_POPOVER_WIDTH + DESKTOP_PET_HORIZONTAL_GUTTER * 2.0);
    let host_h = sprite_h + DESKTOP_PET_POPOVER_TOP_SPACE;
    let sprite_left = ((host_w - sprite_w) / 2.0).round();
    (host_w, host_h, sprite_w, sprite_h, sprite_left)
}

// ---- timing / movement constants (from DesktopPet.ts) ----------------------

const DRAG_TICK_MS: u64 = 8;
const DRAG_DIRECTION_THRESHOLD: f64 = 1.5;
const AUTO_MOVE_TICK_MS: u64 = 16;
const AUTO_MOVE_EDGE_MARGIN: f64 = 24.0;
const AUTO_MOVE_MIN_DURATION_MS: u64 = 1600;
const AUTO_MOVE_MAX_DURATION_MS: u64 = 5200;
const PET_MARGIN: f64 = 24.0;

type PetAnimation = &'static str;
const ANIM_IDLE: PetAnimation = "idle";
const ANIM_LEFT: PetAnimation = "running-left";
const ANIM_RIGHT: PetAnimation = "running-right";

/// Tauri-managed control state. Atomics gate the background loops; the
/// generation counter cancels a running follow/auto-move when a new one starts.
pub struct PetState {
    /// A drag is in flight (main is following the cursor).
    pub dragging: AtomicBool,
    /// Bumped to retire any in-flight follow / auto-move thread.
    pub gen: AtomicU64,
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            dragging: AtomicBool::new(false),
            gen: AtomicU64::new(0),
        }
    }
}

// ---- geometry helpers -------------------------------------------------------

/// Global cursor in logical points. On macOS this uses the Quartz combined
/// session-state source (already a Tauri transitive dep, zero extra download);
/// elsewhere the pet still works, it just cannot auto-follow the cursor.
fn global_cursor() -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
        let src = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
        let ev = CGEvent::new(src).ok()?;
        let p = ev.location();
        Some((p.x, p.y))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Logical work-area of the monitor the pet window currently sits on.
fn monitor_work_area(w: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let monitor = w.current_monitor().ok()??;
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    Some((
        wa.position.x as f64 / scale,
        wa.position.y as f64 / scale,
        wa.size.width as f64 / scale,
        wa.size.height as f64 / scale,
    ))
}

/// Logical work-area of the primary monitor (used to place a freshly-created
/// pet or to clamp a position when no live window is at hand).
fn primary_work_area(app: &tauri::AppHandle) -> Option<(f64, f64, f64, f64)> {
    let monitor = app.primary_monitor().ok()??;
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    Some((
        wa.position.x as f64 / scale,
        wa.position.y as f64 / scale,
        wa.size.width as f64 / scale,
        wa.size.height as f64 / scale,
    ))
}

/// Best available work-area bounds: the window's own monitor if it has one,
/// otherwise the primary monitor's.
fn work_area_for(app: &tauri::AppHandle, win: Option<&WebviewWindow>) -> Option<(f64, f64, f64, f64)> {
    if let Some(w) = win {
        if let Some(bounds) = monitor_work_area(w) {
            return Some(bounds);
        }
    }
    primary_work_area(app)
}

/// The window's outer (frame) position in logical points.
fn window_logical_pos(w: &WebviewWindow) -> Option<(f64, f64)> {
    let p = w.outer_position().ok()?;
    let scale = w.scale_factor().ok()?;
    Some((p.x as f64 / scale, p.y as f64 / scale))
}

/// Clamp a logical position to the given work-area bounds.
fn clamp_position(x: f64, y: f64, scale: f64, bounds: (f64, f64, f64, f64)) -> (f64, f64) {
    let (wa_x, wa_y, wa_w, wa_h) = bounds;
    let (_, host_h, sprite_w, _, _) = pet_layout(scale);
    let cx = x.min(wa_x + wa_w - sprite_w.max(1.0)).max(wa_x);
    let cy = y.min(wa_y + wa_h - host_h.max(1.0)).max(wa_y);
    (cx.round(), cy.round())
}

/// Where a freshly-created pet starts: bottom-right of the primary work area.
fn default_position(app: &tauri::AppHandle, scale: f64) -> (f64, f64) {
    let Some((wa_x, wa_y, wa_w, wa_h)) = primary_work_area(app) else {
        return (0.0, 0.0);
    };
    let (_, host_h, sprite_w, _, sprite_left) = pet_layout(scale);
    let x = wa_x + wa_w - sprite_w - sprite_left - PET_MARGIN;
    let y = wa_y + wa_h - host_h - PET_MARGIN;
    (x.round(), y.round())
}

// ---- small dependency-free RNG (offline: no `rand` crate) ------------------

static RNG: AtomicU64 = AtomicU64::new(0x9e3779b97f4a7c15);

fn rand_between(min: f64, max: f64) -> f64 {
    // xorshift64 — plenty of quality for a wander target, zero dependencies.
    let mut x = RNG.fetch_add(0x2545f4914f6cdd1d, Ordering::Relaxed);
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    let unit = (x & 0xffff_ffff) as f64 / 4_294_967_296.0;
    min + unit * (max - min)
}

// ---- Bézier auto-move (ported from createAutoMoveSegments / cubicPoint) ----

#[derive(Clone, Copy)]
struct Pt {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy)]
struct Seg {
    from: Pt,
    c1: Pt,
    c2: Pt,
    to: Pt,
}

fn cubic_point(s: &Seg, t: f64) -> Pt {
    let i = 1.0 - t;
    Pt {
        x: i * i * i * s.from.x
            + 3.0 * i * i * t * s.c1.x
            + 3.0 * i * t * t * s.c2.x
            + t * t * t * s.to.x,
        y: i * i * i * s.from.y
            + 3.0 * i * i * t * s.c1.y
            + 3.0 * i * t * t * s.c2.y
            + t * t * t * s.to.y,
    }
}

fn make_segments(from: Pt, to: Pt) -> [Seg; 2] {
    let mid = Pt {
        x: (from.x + to.x) / 2.0,
        y: (from.y + to.y) / 2.0,
    };
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let dist = (dx * dx + dy * dy).sqrt().max(1.0);
    let perp = Pt {
        x: -dy / dist,
        y: dx / dist,
    };
    let bend_max = f64::min(180.0, dist * 0.35);
    let bend = rand_between(-bend_max, bend_max);
    let bent_mid = Pt {
        x: mid.x + perp.x * bend,
        y: mid.y + perp.y * bend,
    };
    let c1 = Pt {
        x: from.x + dx * 0.22 + perp.x * bend * 0.35,
        y: from.y + dy * 0.22 + perp.y * bend * 0.35,
    };
    let c2 = Pt {
        x: bent_mid.x - dx * 0.16 + perp.x * bend * 0.12,
        y: bent_mid.y - dy * 0.16 + perp.y * bend * 0.12,
    };
    let c3 = Pt {
        x: bent_mid.x + dx * 0.16 + perp.x * bend * 0.12,
        y: bent_mid.y + dy * 0.16 + perp.y * bend * 0.12,
    };
    let c4 = Pt {
        x: to.x - dx * 0.22 + perp.x * bend * 0.35,
        y: to.y - dy * 0.22 + perp.y * bend * 0.35,
    };
    [
        Seg { from, c1, c2, to: bent_mid },
        Seg {
            from: bent_mid,
            c1: c3,
            c2: c4,
            to,
        },
    ]
}

fn random_target(scale: f64, current: Pt, bounds: (f64, f64, f64, f64)) -> Option<Pt> {
    let (wa_x, wa_y, wa_w, wa_h) = bounds;
    let (_, _, sprite_w, host_h, _) = pet_layout(scale);
    let min_x = wa_x + AUTO_MOVE_EDGE_MARGIN;
    let min_y = wa_y + AUTO_MOVE_EDGE_MARGIN;
    let max_x = wa_x + wa_w - sprite_w - AUTO_MOVE_EDGE_MARGIN;
    let max_y = wa_y + wa_h - host_h - AUTO_MOVE_EDGE_MARGIN;
    if max_x <= min_x || max_y <= min_y {
        return None;
    }
    for _ in 0..8 {
        let t = Pt {
            x: rand_between(min_x, max_x).round(),
            y: rand_between(min_y, max_y).round(),
        };
        let d = ((t.x - current.x).powi(2) + (t.y - current.y).powi(2)).sqrt();
        let min_dist = 180.0_f64.min(sprite_w.max(80.0).max(sprite_w * 0.8));
        if d >= min_dist {
            return Some(t);
        }
    }
    Some(Pt {
        x: rand_between(min_x, max_x).round(),
        y: rand_between(min_y, max_y).round(),
    })
}

// ---- background loops -------------------------------------------------------

/// One auto-move "wander" pass: wait the configured interval, then run a Bézier
/// move to a random work-area point. Runs until the generation is bumped.
fn spawn_auto_move(app: tauri::AppHandle, state: &Arc<PetState>, gen: u64) {
    let state = state.clone();
    thread::spawn(move || {
        let interval = prefs_of(&app).auto_move_interval_minutes.max(1) as u64 * 60;
        loop {
            if state.gen.load(Ordering::SeqCst) != gen {
                return;
            }
            // Interruptible sleep for the interval; a drag aborts the wait early.
            let deadline = Instant::now() + Duration::from_secs(interval);
            while Instant::now() < deadline {
                if state.gen.load(Ordering::SeqCst) != gen || state.dragging.load(Ordering::SeqCst) {
                    return;
                }
                thread::sleep(Duration::from_millis(200));
            }
            if state.gen.load(Ordering::SeqCst) != gen {
                return;
            }
            run_auto_move_once(&app, &state, gen);
        }
    });
}

fn run_auto_move_once(app: &tauri::AppHandle, state: &Arc<PetState>, gen: u64) {
    let Some(win) = app.get_webview_window(PET_LABEL) else {
        return;
    };
    let scale = pref_scale(app);
    let Some((x, y)) = window_logical_pos(&win) else {
        return;
    };
    let Some(bounds) = monitor_work_area(&win) else {
        return;
    };
    let from = Pt { x, y };
    let Some(target) = random_target(scale, from, bounds) else {
        return;
    };
    let distance = ((target.x - x).powi(2) + (target.y - y).powi(2)).sqrt();
    let duration_ms = (AUTO_MOVE_MIN_DURATION_MS.max(
        (distance / 0.12).round() as u64,
    ))
    .min(AUTO_MOVE_MAX_DURATION_MS);

    let segments = make_segments(from, target);
    let started = Instant::now();
    let mut prev_x = x;
    let dir = if target.x < x { ANIM_LEFT } else { ANIM_RIGHT };
    app.emit("desktop-pet:animation", dir).ok();

    loop {
        if state.gen.load(Ordering::SeqCst) != gen || state.dragging.load(Ordering::SeqCst) {
            return;
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let overall = (elapsed_ms as f64 / duration_ms as f64).min(1.0);
        // easeInOutCubic (mirrors tickAutoMove)
        let eased = if overall < 0.5 {
            4.0 * overall * overall * overall
        } else {
            1.0 - ((-2.0 * overall + 2.0).powi(3)) / 2.0
        };
        let seg_idx = if eased < 0.5 { 0 } else { 1 };
        let seg_p = if eased < 0.5 { eased * 2.0 } else { (eased - 0.5) * 2.0 };
        let pt = cubic_point(&segments[seg_idx], seg_p);
        let (cx, cy) = clamp_position(pt.x, pt.y, scale, bounds);
        let _ = win.set_position(LogicalPosition::new(cx, cy));
        if cx < prev_x {
            app.emit("desktop-pet:animation", ANIM_LEFT).ok();
        } else if cx > prev_x {
            app.emit("desktop-pet:animation", ANIM_RIGHT).ok();
        }
        prev_x = cx;
        if overall >= 1.0 {
            save_latest_position(app, cx, cy);
            app.emit("desktop-pet:animation", ANIM_IDLE).ok();
            // Re-schedule (re-wait the interval) for the next wander.
            continue;
        }
        thread::sleep(Duration::from_millis(AUTO_MOVE_TICK_MS));
    }
}

/// Spawn the cursor-follow loop for a drag. Captures the cursor→window offset;
/// retires when `dragging` is cleared or the generation is bumped.
fn spawn_drag_follow(app: tauri::AppHandle, state: &Arc<PetState>, gen: u64, off_x: f64, off_y: f64) {
    let state = state.clone();
    thread::spawn(move || {
        let mut last_x: Option<f64> = None;
        let mut anim: PetAnimation = ANIM_IDLE;
        loop {
            if !state.dragging.load(Ordering::SeqCst) || state.gen.load(Ordering::SeqCst) != gen {
                break;
            }
            let Some(cursor) = global_cursor() else {
                thread::sleep(Duration::from_millis(DRAG_TICK_MS));
                continue;
            };
            let tx = (cursor.0 - off_x).round();
            let ty = (cursor.1 - off_y).round();
            if let Some(win) = app.get_webview_window(PET_LABEL) {
                let _ = win.set_position(LogicalPosition::new(tx, ty));
                if let Some(lx) = last_x {
                    let delta = cursor.0 - lx;
                    if delta.abs() >= DRAG_DIRECTION_THRESHOLD {
                        last_x = Some(cursor.0);
                        let next = if delta < 0.0 { ANIM_LEFT } else { ANIM_RIGHT };
                        if anim != next {
                            anim = next;
                            app.emit("desktop-pet:animation", anim).ok();
                        }
                    }
                } else {
                    last_x = Some(cursor.0);
                }
            }
            thread::sleep(Duration::from_millis(DRAG_TICK_MS));
        }
    });
}

// ---- helpers over Tauri state ----------------------------------------------

fn prefs_of(app: &tauri::AppHandle) -> DesktopPetPref {
    let p = app.state::<PrefsState>().get();
    p.desktop_pet.clone().unwrap_or_default()
}

fn pref_scale(app: &tauri::AppHandle) -> f64 {
    prefs_of(app).scale
}

/// Persist the last position into the pref (best-effort, mirrors
/// `schedulePositionSave`).
fn save_latest_position(app: &tauri::AppHandle, x: f64, y: f64) {
    let state = app.state::<PrefsState>();
    state.patch(|p| {
        let mut pref = p.desktop_pet.clone().unwrap_or_default();
        pref.position = Some(PetPosition { x, y });
        pref.enabled = true;
        p.desktop_pet = Some(pref);
    });
}

// ---- window lifecycle -------------------------------------------------------

/// Create the pet webview if absent (lazy, like the tray popover).
fn ensure_pet_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(PET_LABEL) {
        return Some(w);
    }
    let pref = prefs_of(app);
    let bounds = work_area_for(app, None);
    let pos = match (pref.position, bounds) {
        (Some(p), Some(b)) => clamp_position(p.x, p.y, pref.scale, b),
        _ => default_position(app, pref.scale),
    };
    let (w, h, _, _, _) = pet_layout(pref.scale);
    let win = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("pet.html".into()))
        .title("\u{200B}")
        .inner_size(w, h)
        .position(pos.0, pos.1)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .transparent(true)
        .focused(false)
        .build()
        .ok()?;
    let _ = win.set_ignore_cursor_events(false);
    let _ = win.show();
    Some(win)
}

/// Reconcile the pet window with the current pref (enable/size/show/destroy).
/// Mirrors Electron's `syncDesktopPet`.
fn sync_pet(app: &tauri::AppHandle, state: &Arc<PetState>) {
    let pref = prefs_of(app);

    // Broadcast the (possibly new) pref so the pet renderer re-scales live.
    app.emit("desktop-pet:preferences", &pref).ok();

    if !pref.enabled {
        // Releasing the renderer entirely, not just hiding it.
        state.gen.fetch_add(1, Ordering::SeqCst);
        state.dragging.store(false, Ordering::SeqCst);
        if let Some(w) = app.get_webview_window(PET_LABEL) {
            let _ = w.destroy();
        }
        return;
    }

    let win = match ensure_pet_window(app) {
        Some(w) => w,
        None => return,
    };
    // Re-apply bounds for the current scale (a scale change resizes the host).
    let (w, h, _, _, _) = pet_layout(pref.scale);
    let _ = win.set_size(Size::Logical(LogicalSize::new(w, h)));
    if let Some(pos) = pref.position {
        let (cx, cy) = match work_area_for(app, Some(&win)) {
            Some(b) => clamp_position(pos.x, pos.y, pref.scale, b),
            None => (pos.x.round(), pos.y.round()),
        };
        let _ = win.set_position(LogicalPosition::new(cx, cy));
    }
    let _ = win.set_ignore_cursor_events(false);
    let _ = win.show();

    // (Re)schedule the wander if auto-move is on.
    if pref.auto_move_enabled {
        let gen = state.gen.fetch_add(1, Ordering::SeqCst) + 1;
        spawn_auto_move(app.clone(), state, gen);
    }
}

// ---- context menu (right-click on the pet) ---------------------------------

/// Build + pop the pet's context menu at a screen position. Dispatching is
/// wired in `lib.rs` via `on_menu_event` on the matching item ids.
fn show_pet_menu(app: &tauri::AppHandle, x: f64, y: f64) {
    let item_show =
        match MenuItem::with_id(app, "pet-show-main", "显示主窗口", true, None::<&str>) {
            Ok(i) => i,
            Err(_) => return,
        };
    let item_sync =
        match MenuItem::with_id(app, "pet-sync", "同步数据", true, None::<&str>) {
            Ok(i) => i,
            Err(_) => return,
        };
    let item_settings =
        match MenuItem::with_id(app, "pet-settings", "设置", true, None::<&str>) {
            Ok(i) => i,
            Err(_) => return,
        };
    let item_quit =
        match MenuItem::with_id(app, "pet-quit", "退出宠物", true, None::<&str>) {
            Ok(i) => i,
            Err(_) => return,
        };
    let separator = match PredefinedMenuItem::separator(app) {
        Ok(i) => i,
        Err(_) => return,
    };
    let menu = match Menu::with_items(
        app,
        &[
            &item_show,
            &item_sync,
            &item_settings,
            &separator,
            &item_quit,
        ],
    ) {
        Ok(m) => m,
        Err(_) => return,
    };
    // `popup_menu_at` wants a physical Position; convert logical→physical.
    if let Some(win) = app.get_webview_window(PET_LABEL) {
        let scale = win.scale_factor().unwrap_or(1.0);
        let pos = tauri::PhysicalPosition::new((x * scale) as i32, (y * scale) as i32);
        let _ = win.popup_menu_at(&menu, pos);
    }
}

// ---- Tauri commands (the `window.tud` surface) -----------------------------

#[tauri::command]
pub fn desktop_pet_get(state: tauri::State<'_, PrefsState>) -> DesktopPetPref {
    state.get().desktop_pet.clone().unwrap_or_default()
}

/// The engine is created in `lib.rs` and re-shared here via the app state.
fn engine(app: &tauri::AppHandle) -> Option<Arc<PetState>> {
    let st: tauri::State<'_, Arc<PetState>> = app.state();
    Some(Arc::clone(&*st))
}

#[tauri::command]
pub fn desktop_pet_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, PrefsState>,
    enabled: bool,
) -> bool {
    state.patch(|p| {
        let mut pref = p.desktop_pet.clone().unwrap_or_default();
        pref.enabled = enabled;
        p.desktop_pet = Some(pref);
    });
    if let Some(engine) = engine(&app) {
        sync_pet(&app, &engine);
    }
    enabled
}

#[tauri::command]
pub fn desktop_pet_set_selected(
    app: tauri::AppHandle,
    state: tauri::State<'_, PrefsState>,
    selected_pet_id: String,
) -> Result<DesktopPetPref, String> {
    if !matches!(selected_pet_id.as_str(), "hawking" | "yoyo" | "click") {
        return Err("unknown desktop pet".to_string());
    }
    let next = state.patch(|p| {
        let mut pref = p.desktop_pet.clone().unwrap_or_default();
        pref.selected_pet_id = selected_pet_id.clone();
        p.desktop_pet = Some(pref);
    });
    let pref = next.desktop_pet.clone().unwrap_or_default();
    if let Some(engine) = engine(&app) {
        // A sprite swap restarts the wander; re-emit so the renderer loads
        // the new atlas.
        app.emit("desktop-pet:preferences", &pref).ok();
        let _ = engine;
    }
    Ok(pref)
}

#[tauri::command]
pub fn desktop_pet_set_preferences(
    app: tauri::AppHandle,
    state: tauri::State<'_, PrefsState>,
    changes: serde_json::Value,
) -> Result<DesktopPetPref, String> {
    let cur = state.get().desktop_pet.clone().unwrap_or_default();
    let num = |k: &str| changes.get(k).and_then(|v| v.as_f64());
    let scale = match num("scale") {
        Some(s) if s >= 0.35 && s <= 0.75 => s,
        _ => cur.scale,
    };
    let frame_interval_ms = match num("frameIntervalMs") {
        Some(f) if (120.0..=320.0).contains(&f) => f.round() as u32,
        _ => cur.frame_interval_ms,
    };
    let auto_move_enabled = changes
        .get("autoMoveEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(cur.auto_move_enabled);
    let auto_move_interval_minutes = match changes.get("autoMoveIntervalMinutes").and_then(|v| v.as_u64())
    {
        Some(m) if (1..=120).contains(&m) => m as u32,
        _ => cur.auto_move_interval_minutes,
    };

    let next = state.patch(|p| {
        let mut pref = p.desktop_pet.clone().unwrap_or_default();
        pref.scale = scale;
        pref.frame_interval_ms = frame_interval_ms;
        pref.auto_move_enabled = auto_move_enabled;
        pref.auto_move_interval_minutes = auto_move_interval_minutes;
        p.desktop_pet = Some(pref);
    });
    let pref = next.desktop_pet.clone().unwrap_or_default();
    if let Some(engine) = engine(&app) {
        sync_pet(&app, &engine);
    }
    Ok(pref)
}

#[tauri::command]
pub fn desktop_pet_set_mouse_ignored(app: tauri::AppHandle, ignored: bool) {
    if let Some(win) = app.get_webview_window(PET_LABEL) {
        let _ = win.set_ignore_cursor_events(ignored);
    }
}

#[tauri::command]
pub fn desktop_pet_begin_drag(app: tauri::AppHandle) {
    let Some(engine) = engine(&app) else {
        return;
    };
    let Some(win) = app.get_webview_window(PET_LABEL) else {
        return;
    };
    // Cancel any auto-move so the user's drag wins.
    let gen = engine.gen.fetch_add(1, Ordering::SeqCst) + 1;
    engine.dragging.store(true, Ordering::SeqCst);
    let (off_x, off_y) = match (window_logical_pos(&win), global_cursor()) {
        (Some((wx, wy)), Some((cx, cy))) => (cx - wx, cy - wy),
        _ => {
            engine.dragging.store(false, Ordering::SeqCst);
            return;
        }
    };
    spawn_drag_follow(app.clone(), &engine, gen, off_x, off_y);
}

#[tauri::command]
pub fn desktop_pet_end_drag(app: tauri::AppHandle) {
    let Some(engine) = engine(&app) else {
        return;
    };
    engine.dragging.store(false, Ordering::SeqCst);
    app.emit("desktop-pet:animation", ANIM_IDLE).ok();
    // Persist where it settled, then resume the wander.
    if let Some(win) = app.get_webview_window(PET_LABEL) {
        if let Some((x, y)) = window_logical_pos(&win) {
            save_latest_position(&app, x, y);
        }
    }
    let pref = prefs_of(&app);
    if pref.auto_move_enabled {
        let gen = engine.gen.fetch_add(1, Ordering::SeqCst) + 1;
        spawn_auto_move(app.clone(), &engine, gen);
    }
}

#[tauri::command]
pub fn pet_show_context_menu(app: tauri::AppHandle, x: f64, y: f64) {
    show_pet_menu(&app, x, y);
}

/// Register the pet menu dispatch on the app. Called once from `run()`.
pub fn on_pet_menu_event(app: &tauri::AppHandle, event: &MenuEvent) {
    match event.id().as_ref() {
        "pet-show-main" => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }
        "pet-sync" => {
            let state = app.state::<crate::sidecar::SidecarState>();
            crate::sidecar::trigger_sync(&state);
        }
        "pet-settings" => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
            let _ = app.emit("app:open-settings", serde_json::json!({ "tab": "pet" }));
        }
        "pet-quit" => {
            let state = app.state::<PrefsState>();
            state.patch(|p| {
                let mut pref = p.desktop_pet.clone().unwrap_or_default();
                pref.enabled = false;
                p.desktop_pet = Some(pref);
            });
            if let Some(engine) = engine(app) {
                sync_pet(app, &engine);
            }
        }
        _ => {}
    }
}

/// Reconcile the pet window to the persisted pref and (re)start the wander.
/// Called from `setup` (after the app is ready) and after any pref change.
pub fn create(app: &tauri::AppHandle) {
    let engine: tauri::State<'_, Arc<PetState>> = app.state();
    sync_pet(app, &*engine);
}
