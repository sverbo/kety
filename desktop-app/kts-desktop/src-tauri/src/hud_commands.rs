//! HUD window positioning helpers, show/hide logic, and HUD-related commands.

use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager};

use crate::hud_display::{self, MonitorBox};
use crate::{HudPresenterState, ScreenRecordState};

#[cfg(target_os = "macos")]
use crate::macos_focus;
#[cfg(target_os = "macos")]
use crate::macos_hud_window;

// ── Placement units ───────────────────────────────────────────────────────────
//
// Every coordinate below — anchors, work areas, window rects, the final position — is in
// *placement units*: global logical points on macOS, physical pixels everywhere else.
//
// The macOS choice is not cosmetic. Tauri reports a monitor's position and work area as that
// monitor's logical rect multiplied by *its own* scale factor, while `set_position` turns a
// `PhysicalPosition` back into a frame by dividing by the *window's* scale factor. With two
// displays of different scales those are two different spaces, they overlap, and a position
// computed from one display lands on the other. Logical points are the one description everything
// agrees on: `CGDisplayBounds`, `kCGWindowBounds`, the pointer, and the `NSWindow` frame a
// `LogicalPosition` sets. See [`crate::hud_display`] for the full account.

/// Takes a logical-pixel measurement into placement units.
#[cfg(target_os = "macos")]
fn from_logical(value: f64, _scale: f64) -> f64 {
    value
}
#[cfg(not(target_os = "macos"))]
fn from_logical(value: f64, scale: f64) -> f64 {
    value * scale
}

/// Takes a measurement Tauri reports as "physical" into placement units, given the scale factor of
/// whatever it was reported for — the window for a window rect, the monitor for a monitor rect.
#[cfg(target_os = "macos")]
fn from_physical(value: f64, scale: f64) -> f64 {
    value / scale
}
#[cfg(not(target_os = "macos"))]
fn from_physical(value: f64, _scale: f64) -> f64 {
    value
}

/// A scale factor that can safely be divided by.
fn usable_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn window_scale<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> f64 {
    usable_scale(win.scale_factor().unwrap_or(1.0))
}

/// Moves the HUD so its top-left corner sits at `(x, y)` in placement units.
///
/// Logical on macOS on purpose: Tauri passes a `LogicalPosition` through untouched, so it means
/// the same place whichever display the window happens to be on at the time. A
/// `PhysicalPosition` would first be divided by the window's own scale factor.
#[cfg(target_os = "macos")]
fn set_hud_top_left<R: tauri::Runtime>(
    hud: &tauri::WebviewWindow<R>,
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    hud.set_position(tauri::LogicalPosition { x: x.round(), y: y.round() })
}
#[cfg(not(target_os = "macos"))]
fn set_hud_top_left<R: tauri::Runtime>(
    hud: &tauri::WebviewWindow<R>,
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    hud.set_position(tauri::PhysicalPosition { x: x.round() as i32, y: y.round() as i32 })
}

/// Short name for the units in a log line, so a pasted log says which space it is talking about.
#[cfg(target_os = "macos")]
const PLACEMENT_UNITS: &str = "pt";
#[cfg(not(target_os = "macos"))]
const PLACEMENT_UNITS: &str = "px";

// ── Anchored HUD geometry ─────────────────────────────────────────────────────

/// Space left between the HUD and whatever it is placed beside, in logical pixels.
const HUD_ANCHOR_GAP_PX: f64 = 6.0;

/// The usable part of a display — menu bar and Dock excluded — in placement units, top-left
/// origin. A display to the left of the main one has a negative `x`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Something on screen the HUD is placed beside: the text the user selected, or the pointer.
/// Placement units, top-left origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct AnchorRect {
    /// Middle of the anchor, horizontally. The HUD is centred on it.
    pub center_x: f64,
    /// Top edge of the anchor.
    pub top: f64,
    /// Height of the anchor. Zero for a point, such as the pointer.
    pub height: f64,
    /// Which side of the anchor to try first when both have room.
    pub prefer_below: bool,
}

impl AnchorRect {
    /// The text the user has selected. The HUD drops below it, the way a menu drops from what it
    /// belongs to, leaving the selection itself readable above.
    ///
    /// Nothing builds one of these today: anchoring to the selection meant asking the focused
    /// application for its bounds, and enough applications answer with an unusable rect that the
    /// HUD is anchored to the pointer instead. Kept, with its tests, because it is the placement
    /// we want the day those bounds can be trusted — the geometry is not the part that was wrong.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn selection(x: f64, top: f64, width: f64, height: f64) -> Self {
        Self { center_x: x + width / 2.0, top, height, prefer_below: true }
    }

    /// The mouse pointer. The HUD goes above it, so it does not appear under the hand that is
    /// still on the trackpad, and so the pointer stays free to click whatever is underneath.
    pub fn pointer(x: f64, y: f64) -> Self {
        Self { center_x: x, top: y, height: 0.0, prefer_below: false }
    }
}

/// Pulls a window fully inside `work`.
///
/// When the window is larger than the work area in one direction no position fits, and the
/// top-left edge wins: the user then sees the start of what the window holds rather than its end.
pub(crate) fn clamp_into_work_area(x: f64, y: f64, width: f64, height: f64, work: WorkArea) -> (i32, i32) {
    let cx = x.min(work.x + work.width - width).max(work.x);
    let cy = y.min(work.y + work.height - height).max(work.y);
    (cx.round() as i32, cy.round() as i32)
}

/// Top-left corner for a window of `width` × `height` placed beside `anchor` and kept on screen.
///
/// The preferred side wins whenever the window fits there. When it does not, the other side is
/// tried — a 480 px tall chat rarely fits under a line of text near the bottom of the screen even
/// though the 68 px bubble it grew from did. When neither side has room, the side with more of it
/// is used and the clamp keeps the window on the display.
pub(crate) fn anchored_top_left(
    anchor: AnchorRect,
    width: f64,
    height: f64,
    work: WorkArea,
    gap: f64,
) -> (i32, i32) {
    let below = anchor.top + anchor.height + gap;
    let above = anchor.top - height - gap;
    let room_below = work.y + work.height - below;
    let room_above = anchor.top - gap - work.y;

    let y = if anchor.prefer_below {
        if height <= room_below {
            below
        } else if height <= room_above {
            above
        } else if room_below >= room_above {
            below
        } else {
            above
        }
    } else if height <= room_above {
        above
    } else if height <= room_below {
        below
    } else if room_above >= room_below {
        above
    } else {
        below
    };

    clamp_into_work_area(anchor.center_x - width / 2.0, y, width, height, work)
}

// ── Resolving the display ─────────────────────────────────────────────────────

/// The display the HUD is going to, and enough of how it was chosen to explain it in a log line.
struct HudTarget {
    /// Usable area of the chosen monitor, in placement units.
    work: WorkArea,
    /// Index into `available_monitors()`.
    monitor_index: usize,
    monitor_name: String,
    /// The CoreGraphics display the anchor fell on, already formatted. `"none"` when there was no
    /// anchor, or when it fell outside every display.
    display: String,
    /// `exact` / `nearest` when a display was matched to a monitor, `contains` when the monitor
    /// list was searched directly, `current` when nothing resolved and the HUD stayed put.
    how: &'static str,
}

/// The displays as the platform describes them, in placement units.
///
/// Empty on platforms where the monitor list is the only description there is; the caller then
/// falls back to searching that list.
#[cfg(target_os = "macos")]
fn placement_displays() -> Vec<hud_display::DisplayBox> {
    crate::macos_displays::active_display_boxes()
}
#[cfg(not(target_os = "macos"))]
fn placement_displays() -> Vec<hud_display::DisplayBox> {
    Vec::new()
}

/// What a monitor rect Tauri reports must be divided by to reach placement units: that monitor's
/// scale factor on macOS, nothing anywhere else.
#[cfg(target_os = "macos")]
fn monitor_divisor(scale: f64) -> f64 {
    usable_scale(scale)
}
#[cfg(not(target_os = "macos"))]
fn monitor_divisor(_scale: f64) -> f64 {
    1.0
}

/// The monitors Tauri reports, reduced to placement units and keeping their list index.
fn monitor_boxes(monitors: &[tauri::Monitor]) -> Vec<MonitorBox> {
    monitors
        .iter()
        .enumerate()
        .map(|(index, m)| {
            MonitorBox::from_tauri(
                index,
                m.position().x as f64,
                m.position().y as f64,
                m.size().width as f64,
                m.size().height as f64,
                monitor_divisor(m.scale_factor()),
            )
        })
        .collect()
}

/// Indices into `available_monitors()`, left to right across the desktop.
///
/// Ordered by placement-unit `x` and not by `Monitor::position().x`: the latter is a logical
/// origin multiplied by that display's own scale factor, which can put two side-by-side displays
/// in the wrong order when their scales differ.
fn monitors_left_to_right(boxes: &[MonitorBox]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..boxes.len()).collect();
    order.sort_by(|a, b| boxes[*a].x.total_cmp(&boxes[*b].x));
    order
}

/// Where the same monitor sits in `monitors`, by the rect it occupies.
fn index_of_monitor(target: &tauri::Monitor, monitors: &[tauri::Monitor]) -> Option<usize> {
    monitors
        .iter()
        .position(|m| m.position() == target.position() && m.size() == target.size())
}

fn work_area_of(monitor: &tauri::Monitor) -> WorkArea {
    let d = monitor_divisor(monitor.scale_factor());
    let wa = monitor.work_area();
    WorkArea {
        x: wa.position.x as f64 / d,
        y: wa.position.y as f64 / d,
        width: wa.size.width as f64 / d,
        height: wa.size.height as f64 / d,
    }
}

/// The display `point` belongs to, resolved all the way to a work area.
///
/// The order of attempts, and why each one is there:
/// 1. the CoreGraphics display whose bounds contain the point, matched to its Tauri monitor —
///    the only step that is reliable across displays of different scale factors;
/// 2. the monitor whose own bounds contain the point, for platforms with no display list;
/// 3. the monitor the HUD is already on, then the primary one, then the first in the list.
///
/// It only gives up when there are no monitors at all.
fn hud_target_for_point<R: tauri::Runtime>(
    hud: &tauri::WebviewWindow<R>,
    point: Option<(f64, f64)>,
) -> Option<HudTarget> {
    let monitors = hud.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let boxes = monitor_boxes(&monitors);
    let displays = placement_displays();

    let mut chosen: Option<usize> = None;
    let mut how = "current";
    let mut display = String::from("none");

    if let Some((px, py)) = point {
        if let Some(d) = hud_display::display_containing(px, py, &displays) {
            display = format!(
                "#{}@({:.0},{:.0} {:.0}x{:.0})",
                d.id, d.x, d.y, d.width, d.height
            );
            if let Some(m) = hud_display::monitor_for_display(d, &boxes) {
                chosen = Some(m.index());
                how = m.label();
            }
        }
        if chosen.is_none() {
            if let Some(i) = hud_display::monitor_containing(px, py, &boxes) {
                chosen = Some(i);
                how = "contains";
            }
        }
    }

    let index = chosen
        .or_else(|| {
            hud.current_monitor()
                .ok()
                .flatten()
                .and_then(|m| index_of_monitor(&m, &monitors))
        })
        .or_else(|| {
            hud.primary_monitor()
                .ok()
                .flatten()
                .and_then(|m| index_of_monitor(&m, &monitors))
        })
        .unwrap_or(0);

    let monitor = monitors.get(index)?;
    Some(HudTarget {
        work: work_area_of(monitor),
        monitor_index: index,
        monitor_name: monitor.name().cloned().unwrap_or_else(|| "?".to_string()),
        display,
        how,
    })
}

/// The monitor a running screen recording has locked the HUD to, if one has.
///
/// The recording states must stay on the screen being recorded whatever the user is pointing at,
/// so this short-circuits the anchor entirely.
fn locked_recording_target<R: tauri::Runtime>(
    hud: &tauri::WebviewWindow<R>,
) -> Option<HudTarget> {
    let app = hud.app_handle();
    let sr = app.try_state::<ScreenRecordState>()?;
    if !sr.is_recording.load(Ordering::SeqCst) {
        return None;
    }
    let locked = sr.locked_screen_index.load(Ordering::SeqCst) as usize;
    let monitors = hud.available_monitors().ok()?;
    let boxes = monitor_boxes(&monitors);
    let index = *monitors_left_to_right(&boxes).get(locked)?;
    let monitor = monitors.get(index)?;
    Some(HudTarget {
        work: work_area_of(monitor),
        monitor_index: index,
        monitor_name: monitor.name().cloned().unwrap_or_else(|| "?".to_string()),
        display: format!("locked-screen-{locked}"),
        how: "recording-lock",
    })
}

/// One line saying what a placement decided, so a HUD that still lands wrong can be diagnosed from
/// a log the user pastes back instead of by another round of guessing.
///
/// Every field is on the same line and in the same order every time, because the way it will be
/// read is `grep '\[kts:hud\] place'` on a log somebody mailed in. Read left to right it is the
/// decision in order: what was being placed, the point it was placed against, the display that
/// point fell on, the monitor that display was matched to and how, that monitor's usable area, the
/// size of the window, and where it ended up. The first field that looks wrong is the step that
/// lied.
fn placement_log_line(
    kind: &str,
    anchor: Option<(f64, f64)>,
    target: &HudTarget,
    size: (f64, f64),
    pos: (f64, f64),
) -> String {
    let anchor = match anchor {
        Some((x, y)) => format!("({x:.0},{y:.0})"),
        None => "none".to_string(),
    };
    format!(
        "[kts:hud] place kind={kind} anchor={anchor} display={display} monitor={index}/{name:?} \
         match={how} work=({wx:.0},{wy:.0} {ww:.0}x{wh:.0}) hud={sw:.0}x{sh:.0} \
         pos=({px:.0},{py:.0}) units={units}",
        display = target.display,
        index = target.monitor_index,
        name = target.monitor_name,
        how = target.how,
        wx = target.work.x,
        wy = target.work.y,
        ww = target.work.width,
        wh = target.work.height,
        sw = size.0,
        sh = size.1,
        px = pos.0,
        py = pos.1,
        units = PLACEMENT_UNITS,
    )
}

fn log_placement(
    kind: &str,
    anchor: Option<(f64, f64)>,
    target: &HudTarget,
    size: (f64, f64),
    pos: (f64, f64),
) {
    eprintln!("{}", placement_log_line(kind, anchor, target, size, pos));
}

// ── HUD geometry helpers ──────────────────────────────────────────────────────

/// Gap kept between the HUD and the bottom of the work area, in logical pixels.
const HUD_BOTTOM_MARGIN_PX: f64 = 14.0;

/// Top-left corner for a window of `width` × `height` at the bottom centre of `work`.
///
/// A window taller than the work area is pinned to its top rather than pushed off it.
pub(crate) fn bottom_center_top_left(work: WorkArea, width: f64, height: f64) -> (f64, f64) {
    let x = work.x + (work.width - width).max(0.0) / 2.0;
    let y = (work.y + work.height - height - HUD_BOTTOM_MARGIN_PX).max(work.y);
    (x, y)
}

/// The HUD's outer size in placement units.
///
/// `logical_size` is what a caller handed to `set_size` moments earlier; it is passed because
/// `outer_size` may not reflect that yet, and placing a window against a stale height puts it in
/// the wrong place.
fn hud_size_for_placement<R: tauri::Runtime>(
    hud: &tauri::WebviewWindow<R>,
    logical_size: Option<(f64, f64)>,
) -> Option<(f64, f64)> {
    let scale = window_scale(hud);
    match logical_size {
        Some((w, h)) => Some((from_logical(w, scale), from_logical(h, scale))),
        None => {
            let s = hud.outer_size().ok()?;
            Some((
                from_physical(s.width as f64, scale),
                from_physical(s.height as f64, scale),
            ))
        }
    }
}

/// The point the HUD should be placed against when nothing more specific is known.
///
/// The centre of the frontmost window, which is the display the user is *working* on, falling back
/// to the pointer. Both are read in placement units.
fn hud_default_anchor_point<R: tauri::Runtime>(hud: &tauri::WebviewWindow<R>) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        let _ = hud;
        macos_focus::frontmost_key_window_center_point().or_else(pointer_point)
    }
    #[cfg(not(target_os = "macos"))]
    {
        hud.cursor_position().ok().map(|p| (p.x, p.y))
    }
}

/// The mouse pointer in placement units.
#[cfg(target_os = "macos")]
fn pointer_point() -> Option<(f64, f64)> {
    crate::macos_displays::cursor_point()
}

pub(crate) fn place_hud_bottom_center_active_display<R: tauri::Runtime>(
    hud: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    let (target, anchor) = match locked_recording_target(hud) {
        Some(t) => (t, None),
        None => {
            let anchor = hud_default_anchor_point(hud);
            match hud_target_for_point(hud, anchor) {
                Some(t) => (t, anchor),
                None => return hud.center(),
            }
        }
    };
    let Some((width, height)) = hud_size_for_placement(hud, None) else {
        return hud.center();
    };
    let (x, y) = bottom_center_top_left(target.work, width, height);
    log_placement("bottom-center", anchor, &target, (width, height), (x, y));
    set_hud_top_left(hud, x, y)
}

// ── Anchored HUD placement ────────────────────────────────────────────────────

/// Where the HUD should sit.
///
/// Every path that shows the HUD picks one of these, and the one it picks is what the deferred
/// re-placement in [`present_hud_window`] applies too — the HUD is never anchored to a selection
/// and then quietly dragged back to the bottom of the screen a frame later.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum HudPlacement {
    /// Bottom of the display the user is working on. Where the recording states belong: they last
    /// as long as the recording does and must stay out of the way.
    BottomCenter,
    /// Beside a known rect — the text a transform was run on.
    Anchored(AnchorRect),
    /// Beside the mouse pointer, read at the moment the HUD is shown.
    ///
    /// The pointer is where the user has just finished dragging out a selection, so this is as
    /// close to "beside the text" as anything that does not depend on the focused application
    /// answering for its own layout.
    Pointer,
    /// Wherever the window already is. Only moved if it would hang off the screen.
    Keep,
}

/// Places the HUD beside `anchor`.
///
/// `logical_size` is the size the window has just been given, in logical pixels. Callers pass it
/// because a `set_size` made moments earlier may not be reflected by `outer_size` yet, and
/// placing a window against a stale height puts it in the wrong place. `None` measures it.
pub(crate) fn place_hud_anchored<R: tauri::Runtime>(
    hud: &tauri::WebviewWindow<R>,
    anchor: AnchorRect,
    logical_size: Option<(f64, f64)>,
) -> Option<()> {
    let point = (anchor.center_x, anchor.top);
    let target = hud_target_for_point(hud, Some(point))?;
    let (width, height) = hud_size_for_placement(hud, logical_size)?;
    let gap = from_logical(HUD_ANCHOR_GAP_PX, window_scale(hud));
    let (x, y) = anchored_top_left(anchor, width, height, target.work, gap);
    let (x, y) = (x as f64, y as f64);
    log_placement("anchored", Some(point), &target, (width, height), (x, y));
    set_hud_top_left(hud, x, y).ok()
}

/// Pulls the HUD back inside the display it is on, without otherwise moving it.
///
/// The display is chosen from the window's own centre, so a HUD half off an edge is pulled into
/// the display it is mostly on rather than the one it is spilling onto.
pub(crate) fn clamp_hud_into_work_area<R: tauri::Runtime>(hud: &tauri::WebviewWindow<R>) -> Option<()> {
    let (wx, wy, width, height) = hud_outer_rect(hud)?;
    let center = (wx + width / 2.0, wy + height / 2.0);
    let target = hud_target_for_point(hud, Some(center))?;
    let (x, y) = clamp_into_work_area(wx, wy, width, height, target.work);
    let (x, y) = (x as f64, y as f64);
    if (x - wx).abs() > 0.5 || (y - wy).abs() > 0.5 {
        log_placement("clamp", Some(center), &target, (width, height), (x, y));
        set_hud_top_left(hud, x, y).ok()?;
    }
    Some(())
}

/// The HUD's current outer rect — position and size — in placement units.
fn hud_outer_rect<R: tauri::Runtime>(hud: &tauri::WebviewWindow<R>) -> Option<(f64, f64, f64, f64)> {
    let scale = window_scale(hud);
    let pos = hud.outer_position().ok()?;
    let size = hud.outer_size().ok()?;
    Some((
        from_physical(pos.x as f64, scale),
        from_physical(pos.y as f64, scale),
        from_physical(size.width as f64, scale),
        from_physical(size.height as f64, scale),
    ))
}

/// Turns [`HudPlacement::Pointer`] into the rect it means, once.
///
/// The pointer is read here and not again: the deferred re-placement runs 72 ms later, and a HUD
/// that followed the mouse over those 72 ms would appear to slide away from where it was put.
fn resolve_hud_placement<R: tauri::Runtime>(
    hud: &tauri::WebviewWindow<R>,
    placement: HudPlacement,
) -> HudPlacement {
    match placement {
        HudPlacement::Pointer => {
            #[cfg(target_os = "macos")]
            let cursor = {
                let _ = hud;
                pointer_point()
            };
            #[cfg(not(target_os = "macos"))]
            let cursor = hud.cursor_position().ok().map(|p| (p.x, p.y));

            match cursor {
                Some((x, y)) => HudPlacement::Anchored(AnchorRect::pointer(x, y)),
                None => HudPlacement::BottomCenter,
            }
        }
        other => other,
    }
}

/// Places the HUD and records what that means for everything else that moves it.
///
/// Returns the placement actually applied, with [`HudPlacement::Pointer`] resolved to the rect it
/// stood for, so a caller can apply exactly the same placement again later.
///
/// `logical_size` is forwarded to [`place_hud_anchored`]; see the note there.
pub(crate) fn apply_hud_placement<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    hud: &tauri::WebviewWindow<R>,
    placement: HudPlacement,
    logical_size: Option<(f64, f64)>,
) -> HudPlacement {
    let placement = resolve_hud_placement(hud, placement);
    match placement {
        HudPlacement::BottomCenter | HudPlacement::Pointer => {
            let _ = place_hud_bottom_center_active_display(hud);
        }
        HudPlacement::Anchored(anchor) => {
            if place_hud_anchored(hud, anchor, logical_size).is_none() {
                let _ = place_hud_bottom_center_active_display(hud);
            }
        }
        HudPlacement::Keep => {
            let _ = clamp_hud_into_work_area(hud);
        }
    }

    if let Some(presenter) = app.try_state::<HudPresenterState>() {
        let off_bottom = !matches!(placement, HudPlacement::BottomCenter | HudPlacement::Pointer);
        presenter.hud_off_bottom.store(off_bottom, Ordering::SeqCst);
        // A fresh placement is a fresh presentation: whatever the user did with the previous one
        // no longer applies. `Keep` is the exception — it means "leave it alone", which is exactly
        // what a HUD the user has moved needs.
        if !matches!(placement, HudPlacement::Keep) {
            presenter.hud_user_moved.store(false, Ordering::SeqCst);
        }
        if let HudPlacement::Anchored(anchor) = placement {
            if let Ok(mut slot) = presenter.hud_anchor.lock() {
                *slot = Some(anchor);
            }
        }
    }
    placement
}

/// The placement for the text a transform just produced.
///
/// It belongs beside the text it was made from. The selection itself is gone by then — the new
/// text has replaced it — so the anchor the action popup was placed against is reused: that is
/// where the user was reading a second ago, and where the popup they clicked still is.
pub(crate) fn transform_result_placement<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> HudPlacement {
    let Some(presenter) = app.try_state::<HudPresenterState>() else {
        return HudPlacement::Keep;
    };
    if presenter.hud_user_moved.load(Ordering::SeqCst) {
        return HudPlacement::Keep;
    }
    // Only when the HUD is actually sitting somewhere anchored. The stored anchor outlives the
    // presentation that set it, and reusing a stale one would drag a dictation result across to
    // wherever a text action was run half an hour ago.
    if !presenter.hud_off_bottom.load(Ordering::SeqCst) {
        return HudPlacement::BottomCenter;
    }
    presenter
        .hud_anchor
        .lock()
        .ok()
        .and_then(|a| *a)
        .map(HudPlacement::Anchored)
        .unwrap_or(HudPlacement::BottomCenter)
}

/// Whether `win` overlaps the usable area of any display, in placement units.
///
/// Both sides have to be in the same space for the answer to mean anything: the window rect comes
/// from the window's own scale factor, each work area from its monitor's.
pub(crate) fn hud_window_intersects_any_work_area<R: tauri::Runtime>(
    win: &tauri::WebviewWindow<R>,
) -> bool {
    let Some((wx, wy, width, height)) = hud_outer_rect(win) else {
        return false;
    };
    let Ok(monitors) = win.available_monitors() else {
        return false;
    };
    let w_right = wx + width;
    let w_bottom = wy + height;

    monitors.iter().any(|m| {
        let wa = work_area_of(m);
        wx < wa.x + wa.width && w_right > wa.x && wy < wa.y + wa.height && w_bottom > wa.y
    })
}

pub(crate) fn ensure_hud_on_visible_monitor<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(hud) = app.get_webview_window("dictation_hud") else { return };
    if hud_window_intersects_any_work_area(&hud) {
        return;
    }
    eprintln!("[kts:hud] position hors écran - repositionnement bas-centre");
    let _ = place_hud_bottom_center_active_display(&hud);
}

pub(crate) fn reposition_hud_bottom_center_active<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(hud) = app.get_webview_window("dictation_hud") else { return };

    if let Some(sr) = app.try_state::<ScreenRecordState>() {
        if sr.is_pending.load(Ordering::SeqCst) && !sr.is_recording.load(Ordering::SeqCst) {
            return;
        }
        if sr.is_recording.load(Ordering::SeqCst) {
            let _ = place_hud_bottom_center_active_display(&hud);
            return;
        }
    }

    // Fires on every `Moved` event, including the ones a deliberate placement produces and the
    // ones a drag produces. A HUD that has been put somewhere on purpose — beside a selection,
    // beside the pointer, or by the user's own hand — is left exactly there.
    if app
        .try_state::<HudPresenterState>()
        .map(|s| s.hud_off_bottom.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        return;
    }

    // Against the display the HUD is on, not the one the user is working on: this runs after a
    // move, and dragging the window onto another screen is a move. `place_hud_bottom_center_active_display`
    // would read the frontmost window again and pull it straight back.
    let Some((width, height)) = hud_size_for_placement(&hud, None) else { return };
    let Some(target) = hud_target_for_point(&hud, None) else {
        let _ = hud.center();
        return;
    };
    let (tx, ty) = bottom_center_top_left(target.work, width, height);
    let Some((wx, wy, _, _)) = hud_outer_rect(&hud) else { return };
    if (wx - tx).abs() > 1.0 || (wy - ty).abs() > 1.0 {
        log_placement("moved-bottom-center", None, &target, (width, height), (tx, ty));
        let _ = set_hud_top_left(&hud, tx, ty);
    }
}

/// Logical size of the HUD in `result` mode. Must stay in sync with `DictationHud.tsx`
/// (`HUD_RESULT_WIDTH` / `HUD_RESULT_HEIGHT`): the window is pre-sized here so that the
/// bottom-center placement below already uses the final dimensions.
pub(crate) const HUD_RESULT_WIDTH: f64 = 320.0;
pub(crate) const HUD_RESULT_HEIGHT: f64 = 68.0;

/// Affiche le HUD en bas-centre de l'écran actif. Émet `mode` après show().
pub(crate) fn show_hud(app: &tauri::AppHandle, mode: &str) {
    show_hud_at(app, mode, HudPlacement::BottomCenter);
}

/// Shows the HUD in `mode`, where `placement` says.
///
/// The bottom of the screen is right for a state that lasts as long as a recording does and has
/// to stay out of the way. It is wrong for one that is about a particular piece of text the user
/// is looking at — see [`crate::dictation_commands::dictation_hud_placement`], which is where that
/// distinction is made.
pub(crate) fn show_hud_at(app: &tauri::AppHandle, mode: &str, placement: HudPlacement) {
    let Some(hud) = present_hud_window(app, placement, None) else { return };
    let _ = hud.emit("kts:hud/mode", mode);
}

/// Shows the HUD again with the text a dictation or a text transform just produced, so the
/// user can read it and copy it whatever happened to the insertion. Blank text shows nothing.
///
/// `chat_prompt` is the request a model already answered to produce `text`. When it is present
/// the HUD offers to carry on the conversation; when it is `None` the text is simply shown.
///
/// `placement` decides where the text lands. It is the whole point of this path: an answer that
/// appears at the bottom of the screen while the user is looking at their selection is an answer
/// they have to go and find.
///
/// Callers must have finished with the previously focused application (paste attempt included)
/// before calling this: the HUD is only brought back once that work is done.
pub(crate) fn show_hud_result(
    app: &tauri::AppHandle,
    text: &str,
    source: &str,
    chat_prompt: Option<&str>,
    placement: HudPlacement,
) {
    if text.trim().is_empty() {
        return;
    }
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: HUD_RESULT_WIDTH,
            height: HUD_RESULT_HEIGHT,
        }));
    }
    let Some(hud) = present_hud_window(app, placement, Some((HUD_RESULT_WIDTH, HUD_RESULT_HEIGHT)))
    else {
        return;
    };
    let chat_prompt = chat_prompt.filter(|p| !p.trim().is_empty());
    let _ = hud.emit(
        "kts:hud/result",
        serde_json::json!({ "text": text, "source": source, "chatPrompt": chat_prompt }),
    );
}

/// Places the HUD where `placement` says and shows it, without focusing it.
/// Returns the window so the caller can emit whatever describes the state it is showing.
fn present_hud_window(
    app: &tauri::AppHandle,
    placement: HudPlacement,
    logical_size: Option<(f64, f64)>,
) -> Option<tauri::WebviewWindow> {
    let hud = app.get_webview_window("dictation_hud")?;

    if let Some(presenter) = app.try_state::<HudPresenterState>() {
        let main_visible = app.get_webview_window("main")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        presenter.main_was_visible.store(main_visible, Ordering::SeqCst);
        #[cfg(target_os = "macos")]
        presenter.frontmost_pid.store(macos_focus::frontmost_pid(), Ordering::SeqCst);
    }

    let placement = apply_hud_placement(app, &hud, placement, logical_size);
    ensure_hud_on_visible_monitor(app);

    let _ = hud.show();
    #[cfg(target_os = "macos")]
    {
        macos_hud_window::apply_hud_rounded_corners(&hud);
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(72));
            let Some(hud) = app2.get_webview_window("dictation_hud") else {
                return;
            };
            if !hud.is_visible().unwrap_or(false) {
                return;
            }
            if let Some(sr) = app2.try_state::<ScreenRecordState>() {
                if sr.is_pending.load(Ordering::SeqCst) && !sr.is_recording.load(Ordering::SeqCst) {
                    return;
                }
            }
            // Showing a window can land it on a different display than the one it was placed
            // against, so the placement is applied a second time once macOS has settled. The
            // *same* placement: this pass used to be unconditionally bottom-center, which pulled
            // an anchored HUD down to the bottom of the screen a moment after it appeared.
            if app2
                .try_state::<HudPresenterState>()
                .map(|s| s.hud_user_moved.load(Ordering::SeqCst))
                .unwrap_or(false)
            {
                return;
            }
            apply_hud_placement(&app2, &hud, placement, logical_size);
            ensure_hud_on_visible_monitor(&app2);
        });
    }
    Some(hud)
}

// ── Main window helpers ───────────────────────────────────────────────────────

pub(crate) fn restore_main_window_visibility(app: &tauri::AppHandle) {
    let was_visible = app
        .try_state::<HudPresenterState>()
        .map(|s| s.main_was_visible.load(Ordering::SeqCst))
        .unwrap_or(true);
    if !was_visible {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn reactivate_previous_frontmost(app: &tauri::AppHandle) {
    let pid = app
        .try_state::<HudPresenterState>()
        .map(|s| s.frontmost_pid.load(Ordering::SeqCst))
        .unwrap_or(0);
    if pid <= 0 { return; }
    let own_pid = std::process::id() as i32;
    if pid == own_pid { return; }
    macos_focus::reactivate_app_by_pid(pid);
}

pub(crate) fn activate_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn open_main_assistant_tab<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Err(e) = app.emit(crate::ASSISTANT_OPEN_EVENT, serde_json::Value::Null) {
        eprintln!("kts: emit `{}`: {e}", crate::ASSISTANT_OPEN_EVENT);
    }
}

pub(crate) fn open_main_settings_tab<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Err(e) = app.emit(crate::SETTINGS_OPEN_EVENT, serde_json::Value::Null) {
        eprintln!("kts: emit `{}`: {e}", crate::SETTINGS_OPEN_EVENT);
    }
}

pub(crate) fn open_main_sessions_tab<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Err(e) = app.emit(crate::SESSIONS_OPEN_EVENT, serde_json::Value::Null) {
        eprintln!("kts: emit `{}`: {e}", crate::SESSIONS_OPEN_EVENT);
    }
}

// ── Screen record HUD snap ────────────────────────────────────────────────────

/// Which screen the HUD is on, numbered left to right — the numbering the recorder locks on to.
pub(crate) fn detect_hud_screen_index(app: &tauri::AppHandle) -> u32 {
    (|| -> Option<u32> {
        let hud = app.get_webview_window("dictation_hud")?;
        let current = hud.current_monitor().ok()??;
        let monitors = hud.available_monitors().ok()?;
        let index = index_of_monitor(&current, &monitors)?;
        let order = monitors_left_to_right(&monitor_boxes(&monitors));
        let idx = order.iter().position(|i| *i == index)?;
        Some(idx as u32)
    })()
    .unwrap_or(0)
}

pub(crate) fn snap_hud_to_recording_screen(app: &tauri::AppHandle) {
    let sr = match app.try_state::<ScreenRecordState>() {
        Some(s) => s,
        None => return,
    };
    if !sr.is_recording.load(Ordering::SeqCst) { return; }
    let locked_idx = sr.locked_screen_index.load(Ordering::SeqCst) as usize;

    let hud = match app.get_webview_window("dictation_hud") { Some(w) => w, None => return };
    if detect_hud_screen_index(app) as usize == locked_idx {
        return;
    }
    let Some(target) = locked_recording_target(&hud) else { return };
    let (width, height) = hud_size_for_placement(&hud, None).unwrap_or((268.0, 44.0));
    let (x, y) = bottom_center_top_left(target.work, width, height);
    eprintln!(
        "[kts:screen-record] HUD hors moniteur d'enregistrement → snap bas-centre moniteur {locked_idx}"
    );
    log_placement("recording-snap", None, &target, (width, height), (x, y));
    let _ = set_hud_top_left(&hud, x, y);
}

// ── HUD commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn hide_hud_cmd(app: tauri::AppHandle, sr_state: tauri::State<ScreenRecordState>) {
    sr_state.is_pending.store(false, Ordering::SeqCst);
    crate::off_session_focus::clear_screen_record_pending(&app);
    if let Some(presenter) = app.try_state::<HudPresenterState>() {
        presenter.suppress_next_reopen.store(true, Ordering::SeqCst);
    }
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.hide();
    }
    #[cfg(target_os = "macos")]
    reactivate_previous_frontmost(&app);
    restore_main_window_visibility(&app);
}

/// Brings the HUD back to show `text` (the dictation transcript or a transform result) with a
/// short label saying where it came from. Called once the text has been handed to the focused app.
#[tauri::command]
pub fn show_hud_result_cmd(
    app: tauri::AppHandle,
    text: String,
    source: String,
    chat_prompt: Option<String>,
) {
    // The frontend re-applies whatever this echoes back, so a caller that has a chat prompt has
    // to send it through here — dropping it would clear the one the caller just set.
    let placement = transform_result_placement(&app);
    show_hud_result(&app, &text, &source, chat_prompt.as_deref(), placement);
}

/// Puts the HUD back where it belongs now that it has a new size.
///
/// The frontend calls this after every resize it makes. macOS resizes a window around its
/// bottom-left corner, so a window that grows — the follow-up chat is several times taller than
/// the bubble it opens from — grows upwards, and near the top of a display it grows straight off
/// the edge. Placement alone cannot cover this: the new size is only known once the resize has
/// landed, and it is the frontend that decides it.
///
/// A HUD anchored to something is anchored again against its new height, so a chat that no longer
/// fits under the selection it came from moves above it rather than spilling over an edge. A HUD
/// the user has dragged is left alone, and so is one in a state Rust already places itself; both
/// are only pulled back inside the display.
#[tauri::command]
pub fn place_hud_after_resize_cmd(app: tauri::AppHandle) {
    let Some(hud) = app.get_webview_window("dictation_hud") else { return };
    let anchor = app.try_state::<HudPresenterState>().and_then(|presenter| {
        if presenter.hud_user_moved.load(Ordering::SeqCst)
            || !presenter.hud_off_bottom.load(Ordering::SeqCst)
        {
            return None;
        }
        presenter.hud_anchor.lock().ok().and_then(|a| *a)
    });
    // `None` for the size: the window has just been resized and its own measurement is the only
    // one that knows by how much.
    let placed = anchor.and_then(|anchor| place_hud_anchored(&hud, anchor, None));
    if placed.is_none() {
        let _ = clamp_hud_into_work_area(&hud);
    }
}

/// Records that the user has moved the HUD themselves.
///
/// From then on nothing puts it back: not the bottom-center placement, not the anchoring a
/// transform result would otherwise do. A window that snaps home after being placed by hand is
/// worse than one that never moved. The next time the HUD is presented afresh this is cleared.
#[tauri::command]
pub fn mark_hud_moved_by_user_cmd(app: tauri::AppHandle) {
    let Some(presenter) = app.try_state::<HudPresenterState>() else { return };
    presenter.hud_user_moved.store(true, Ordering::SeqCst);
    presenter.hud_off_bottom.store(true, Ordering::SeqCst);
}

/// Gives the HUD the keyboard, so the user can type in it.
///
/// Every other HUD state is shown without focus on purpose — it floats over the app the user is
/// working in and must not interrupt it. The follow-up chat is the one state the user talks to,
/// and it needs the keystrokes. `hide_hud_cmd` hands the keyboard back to the application that
/// was in front when the HUD appeared, which is why the pid recorded at that moment is left
/// untouched here.
#[tauri::command]
pub fn focus_hud_cmd(app: tauri::AppHandle) {
    let Some(hud) = app.get_webview_window("dictation_hud") else { return };
    let _ = hud.set_focus();
}

#[tauri::command]
pub fn get_hud_state_cmd(
    sr_state: tauri::State<ScreenRecordState>,
    dict_state: tauri::State<crate::DictationActiveState>,
) -> &'static str {
    if dict_state.is_processing.load(Ordering::SeqCst) || sr_state.is_processing.load(Ordering::SeqCst) {
        "processing"
    } else if sr_state.is_paused.load(Ordering::SeqCst) {
        "screen-paused"
    } else if sr_state.is_recording.load(Ordering::SeqCst) {
        "screen"
    } else if sr_state.is_pending.load(Ordering::SeqCst) {
        "screen-ready"
    } else if dict_state.is_paused.load(Ordering::SeqCst) {
        "dictation-paused"
    } else if dict_state.is_recording.load(Ordering::SeqCst) {
        "dictation"
    } else {
        "idle"
    }
}

#[tauri::command]
pub fn discard_hud_cmd(
    app: tauri::AppHandle,
    dict_state: tauri::State<crate::DictationActiveState>,
    sr_state: tauri::State<ScreenRecordState>,
) -> Result<(), String> {
    if let Some(presenter) = app.try_state::<HudPresenterState>() {
        presenter.suppress_next_reopen.store(true, Ordering::SeqCst);
    }
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.hide();
    }
    if dict_state.is_recording.load(Ordering::SeqCst) || dict_state.is_paused.load(Ordering::SeqCst) {
        // Throwing the recording away releases the chat's claim on it too, so the microphone is
        // not left marked as taken by a conversation that is no longer on screen.
        dict_state.hud_chat_mic_mode.store(false, Ordering::SeqCst);
        crate::dictation::discard_dictation(&dict_state)?;
    }
    if sr_state.is_recording.load(Ordering::SeqCst) || sr_state.is_paused.load(Ordering::SeqCst) {
        crate::screen_record::discard_screen_record(&sr_state)?;
    }
    sr_state.is_pending.store(false, Ordering::SeqCst);
    crate::off_session_focus::clear_screen_record_pending(&app);
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.emit("kts:hud/mode", "idle");
    }
    #[cfg(target_os = "macos")]
    reactivate_previous_frontmost(&app);
    restore_main_window_visibility(&app);
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod placement_tests {
    use super::*;

    /// A 1× display, 1440 × 900, menu bar taken off the top.
    fn main_display() -> WorkArea {
        WorkArea { x: 0.0, y: 25.0, width: 1440.0, height: 875.0 }
    }

    /// A second display sitting to the left of the main one, so its coordinates are negative.
    fn left_display() -> WorkArea {
        WorkArea { x: -1920.0, y: -100.0, width: 1920.0, height: 1080.0 }
    }

    const GAP: f64 = 6.0;

    #[test]
    fn a_selection_mid_screen_puts_the_box_under_it() {
        let anchor = AnchorRect::selection(600.0, 400.0, 200.0, 20.0);
        let (x, y) = anchored_top_left(anchor, 320.0, 68.0, main_display(), GAP);
        assert_eq!(y, 426); // 400 + 20 + 6
        assert_eq!(x, 540); // centred on 700
    }

    #[test]
    fn a_selection_near_the_bottom_puts_the_box_above_it() {
        // 120 px of work area left below the selection: the 68 px bubble fits, the 480 px chat
        // does not and has to go above.
        let anchor = AnchorRect::selection(600.0, 760.0, 200.0, 20.0);
        let work = main_display();
        let (_, bubble_y) = anchored_top_left(anchor, 320.0, 68.0, work, GAP);
        assert_eq!(bubble_y, 786);
        let (_, chat_y) = anchored_top_left(anchor, 320.0, 480.0, work, GAP);
        assert_eq!(chat_y, 274); // 760 - 480 - 6
    }

    #[test]
    fn a_selection_at_the_very_top_puts_the_box_below_it() {
        let anchor = AnchorRect::selection(600.0, 25.0, 200.0, 18.0);
        let (_, y) = anchored_top_left(anchor, 320.0, 480.0, main_display(), GAP);
        assert_eq!(y, 49); // 25 + 18 + 6, nothing fits above
    }

    #[test]
    fn the_pointer_is_preferred_above_but_drops_below_when_there_is_no_room() {
        let work = main_display();
        let (_, above) = anchored_top_left(AnchorRect::pointer(700.0, 500.0), 320.0, 68.0, work, GAP);
        assert_eq!(above, 426); // 500 - 68 - 6

        let (_, below) = anchored_top_left(AnchorRect::pointer(700.0, 40.0), 320.0, 68.0, work, GAP);
        assert_eq!(below, 46); // 40 + 6, nothing fits above
    }

    #[test]
    fn a_box_taller_than_the_work_area_starts_at_its_top() {
        // Neither side has room and no position fits: the top edge wins, so the user reads the
        // beginning of what is in the box rather than its end.
        let anchor = AnchorRect::selection(600.0, 400.0, 20.0, 20.0);
        let work = main_display();
        let (_, y) = anchored_top_left(anchor, 320.0, 2000.0, work, GAP);
        assert_eq!(y, work.y as i32);
    }

    #[test]
    fn a_selection_at_the_left_edge_keeps_the_box_on_screen() {
        let anchor = AnchorRect::selection(0.0, 400.0, 10.0, 20.0);
        let (x, _) = anchored_top_left(anchor, 320.0, 68.0, main_display(), GAP);
        assert_eq!(x, 0);
    }

    #[test]
    fn a_selection_at_the_right_edge_keeps_the_box_on_screen() {
        let anchor = AnchorRect::selection(1430.0, 400.0, 10.0, 20.0);
        let work = main_display();
        let (x, _) = anchored_top_left(anchor, 320.0, 68.0, work, GAP);
        assert_eq!(x, (work.x + work.width - 320.0) as i32);
    }

    #[test]
    fn a_display_with_negative_coordinates_is_clamped_in_its_own_space() {
        let work = left_display();
        // Selection at the far bottom-left of the left-hand display.
        let anchor = AnchorRect::selection(-1915.0, 940.0, 40.0, 20.0);
        let (x, y) = anchored_top_left(anchor, 320.0, 480.0, work, GAP);
        assert_eq!(x, -1920); // clamped to that display's left edge, not to zero
        assert_eq!(y, 454); // above the selection: 940 - 480 - 6
        assert!(y as f64 >= work.y);
        assert!((y as f64) + 480.0 <= work.y + work.height);
    }

    #[test]
    fn clamping_leaves_a_window_that_already_fits_alone() {
        let work = main_display();
        assert_eq!(clamp_into_work_area(300.0, 300.0, 320.0, 68.0, work), (300, 300));
    }

    #[test]
    fn clamping_pulls_a_window_back_from_every_edge() {
        let work = main_display();
        assert_eq!(clamp_into_work_area(-50.0, -50.0, 320.0, 68.0, work), (0, 25));
        assert_eq!(clamp_into_work_area(5000.0, 5000.0, 320.0, 68.0, work), (1120, 832));
    }

    #[test]
    fn a_pointer_anchor_is_centred_on_the_pointer_and_a_selection_on_its_middle() {
        assert_eq!(AnchorRect::pointer(700.0, 500.0).center_x, 700.0);
        assert_eq!(AnchorRect::selection(600.0, 400.0, 200.0, 20.0).center_x, 700.0);
    }

    #[test]
    fn the_bottom_centre_of_a_work_area_sits_above_its_bottom_edge() {
        let work = main_display();
        let (x, y) = bottom_center_top_left(work, 320.0, 68.0);
        assert_eq!(x, (work.x + (work.width - 320.0) / 2.0));
        assert_eq!(y, work.y + work.height - 68.0 - HUD_BOTTOM_MARGIN_PX);
    }

    #[test]
    fn the_bottom_centre_of_a_display_with_a_negative_origin_stays_on_that_display() {
        // The whole point of the fix: nothing here may assume the desktop starts at zero.
        let work = left_display();
        let (x, y) = bottom_center_top_left(work, 320.0, 68.0);
        assert_eq!(x, -1120.0); // -1920 + (1920 - 320) / 2
        assert_eq!(y, 898.0); // -100 + 1080 - 68 - 14
        assert!(x >= work.x && x + 320.0 <= work.x + work.width);
        assert!(y >= work.y && y + 68.0 <= work.y + work.height);
    }

    #[test]
    fn a_window_taller_than_the_work_area_is_pinned_to_its_top() {
        let work = main_display();
        let (_, y) = bottom_center_top_left(work, 320.0, 5000.0);
        assert_eq!(y, work.y);
    }

    #[test]
    fn a_window_wider_than_the_work_area_starts_at_its_left_edge() {
        let work = left_display();
        let (x, _) = bottom_center_top_left(work, 5000.0, 68.0);
        assert_eq!(x, work.x);
    }

    /// Pins the diagnostic line, because its whole value is that somebody who has never read this
    /// file can be told what to look for and find it.
    #[test]
    fn the_placement_log_line_says_every_step_of_the_decision() {
        let target = HudTarget {
            work: WorkArea { x: 1512.0, y: -331.0, width: 2560.0, height: 1440.0 },
            monitor_index: 1,
            monitor_name: "Monitor #0".to_string(),
            display: "#4@(1512,-331 2560x1440)".to_string(),
            how: "exact",
        };
        let line = placement_log_line(
            "anchored",
            Some((2357.4, 416.2)),
            &target,
            (320.0, 68.0),
            (2197.0, 342.0),
        );
        assert_eq!(
            line,
            format!(
                "[kts:hud] place kind=anchored anchor=(2357,416) display=#4@(1512,-331 2560x1440) \
                 monitor=1/\"Monitor #0\" match=exact work=(1512,-331 2560x1440) hud=320x68 \
                 pos=(2197,342) units={PLACEMENT_UNITS}"
            )
        );
        assert!(!line.contains('\n'), "one placement is one line");
    }
}
