//! The displays and the pointer as CoreGraphics reports them: global logical points, top-left
//! origin.
//!
//! This is the space `kCGWindowBounds` is already read in, so an anchor taken from the frontmost
//! window and a display taken from here are directly comparable. See [`crate::hud_display`] for
//! why nothing else about the HUD's placement may be taken on trust.

use core_graphics::display::CGDisplay;
use core_graphics::event::CGEvent;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

use crate::hud_display::DisplayBox;

/// Every active display, in global logical points.
///
/// `CGDisplayBounds` gives the rect, top-left origin, tiled without overlap — the arrangement the
/// user dragged into place in System Settings. Note that `CGDisplayPixelsWide/High` report *points*
/// and not backing pixels despite their names (1512 × 982 on a 3024 × 1964 Retina panel), so the
/// bounds are the only size worth reading here.
///
/// An empty vector means CoreGraphics would not answer; the caller falls back to the monitor list.
pub fn active_display_boxes() -> Vec<DisplayBox> {
    let Ok(ids) = CGDisplay::active_displays() else {
        return Vec::new();
    };
    ids.into_iter()
        .map(|id| {
            let b = CGDisplay::new(id).bounds();
            DisplayBox {
                id,
                x: b.origin.x,
                y: b.origin.y,
                width: b.size.width,
                height: b.size.height,
            }
        })
        .filter(|d| d.width > 0.0 && d.height > 0.0)
        .collect()
}

/// The mouse pointer, in global logical points.
///
/// Read from a null CoreGraphics event, which reports the location in exactly the space
/// [`active_display_boxes`] describes. Tauri's `cursor_position()` is the same reading multiplied
/// by the *primary* display's scale factor, which puts a pointer on a secondary display at
/// coordinates no display's bounds contain — that is the one to stay away from.
pub fn cursor_point() -> Option<(f64, f64)> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let p = event.location();
    Some((p.x, p.y))
}
