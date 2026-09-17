//! Which display the HUD belongs on, decided in one coordinate space.
//!
//! macOS hands the same screen out in three different systems of units, and the HUD has landed on
//! the wrong display three times because placement mixed them.
//!
//! - **Global logical points, top-left origin.** What `CGDisplayBounds` describes, what
//!   `kCGWindowBounds` reports, what `CGEventGetLocation` returns, and what an `NSWindow` frame is
//!   expressed in. Displays tile this space without overlapping: it is the arrangement the user
//!   sees in System Settings.
//! - **Tauri "physical pixels" for a monitor.** `Monitor::position()` and `Monitor::work_area()`
//!   are that monitor's logical rect multiplied by *its own* scale factor. With displays of
//!   different scale factors the results no longer tile: a 2× internal display 1512 pt wide at
//!   logical x 0 occupies 0…3024, while a 1× external display at logical x 1512 occupies
//!   1512…4072. They overlap by 1512 units that mean two different places.
//! - **Tauri "physical pixels" for a window.** `set_position(PhysicalPosition)` divides by the
//!   *window's* scale factor before setting the frame. A position computed from a 1× monitor and
//!   applied to a window sitting on a 2× display is halved, which is how a HUD aimed at the
//!   external display ends up in the middle of the internal one.
//!
//! So everything here works in global logical points, and only the last step — handing the result
//! to Tauri as a `LogicalPosition` — leaves it. The two functions that decide the display,
//! [`display_containing`] and [`monitor_for_display`], are pure so they can be tested against
//! arrangements nobody here has the hardware to reproduce.

/// A display as CoreGraphics describes it: global logical points, top-left origin.
///
/// A display placed to the left of the main one has a negative `x`; one placed higher, a negative
/// `y`. These are the numbers an anchor read from a window or from the pointer is comparable with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DisplayBox {
    /// `CGDirectDisplayID`. Carried only so a log line can name the display it chose.
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl DisplayBox {
    /// Half-open on the far edges, so a point on the seam between two displays belongs to exactly
    /// one of them — the one it is the left or top edge of.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }

    fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// One of the monitors Tauri reports, brought back into global logical points.
///
/// `index` is the position in the `available_monitors()` list it was built from, which is how the
/// caller gets back to the `Monitor` itself — that is where the work area lives.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct MonitorBox {
    pub index: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl MonitorBox {
    /// Builds one from what `Monitor::position()`, `Monitor::size()` and `Monitor::scale_factor()`
    /// report.
    ///
    /// Tauri produces those two rects by multiplying the display's logical rect by its scale
    /// factor, so dividing by the same factor recovers the logical rect exactly, up to the integer
    /// rounding that happened on the way. That is the whole conversion: no guessing, and nothing
    /// that depends on which display anything else happens to be on.
    pub fn from_tauri(index: usize, px: f64, py: f64, width: f64, height: f64, scale: f64) -> Self {
        let scale = if scale > 0.0 { scale } else { 1.0 };
        Self {
            index,
            x: px / scale,
            y: py / scale,
            width: width / scale,
            height: height / scale,
        }
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }

    fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// How far two descriptions of the same display may differ and still be taken for it, in points.
///
/// Both sides come from `CGDisplayBounds`; the only thing between them is Tauri rounding a
/// multiplied rect to whole pixels. A point of slack covers that and nothing else.
const MATCH_TOLERANCE_PT: f64 = 1.5;

/// The outcome of looking for the Tauri monitor that stands for a CoreGraphics display.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum MonitorMatch {
    /// The monitor's logical bounds are the display's, to within [`MATCH_TOLERANCE_PT`].
    Exact(usize),
    /// Nothing lined up, so the monitor whose centre is closest was taken. Still the right screen
    /// whenever the mismatch is a rounding or a work-area quirk rather than a different display.
    Nearest(usize),
}

impl MonitorMatch {
    pub fn index(self) -> usize {
        match self {
            MonitorMatch::Exact(i) | MonitorMatch::Nearest(i) => i,
        }
    }

    /// One word for the log line.
    pub fn label(self) -> &'static str {
        match self {
            MonitorMatch::Exact(_) => "exact",
            MonitorMatch::Nearest(_) => "nearest",
        }
    }
}

/// The display a point in global logical points falls on.
///
/// `None` when it falls on none of them — which happens for real: a window can be dragged so its
/// centre sits in the gap between two displays of different heights, and a stale anchor can name a
/// display that has since been unplugged. The caller must have somewhere to go in that case.
pub(crate) fn display_containing(x: f64, y: f64, displays: &[DisplayBox]) -> Option<DisplayBox> {
    displays.iter().copied().find(|d| d.contains(x, y))
}

/// The monitor a point in global logical points falls on.
///
/// Used when no CoreGraphics description of the displays is available — on platforms other than
/// macOS, where the monitor list is the only description there is.
pub(crate) fn monitor_containing(x: f64, y: f64, monitors: &[MonitorBox]) -> Option<usize> {
    monitors.iter().find(|m| m.contains(x, y)).map(|m| m.index)
}

/// The Tauri monitor that stands for `display`.
///
/// **The rule:** the two describe the same screen when their logical bounds agree — same origin,
/// same size, to within [`MATCH_TOLERANCE_PT`]. Both are derived from `CGDisplayBounds`, so on a
/// healthy system this is an equality and not a heuristic; the tolerance only absorbs Tauri's
/// rounding. Origin is what carries the weight: two identical displays side by side have the same
/// size and are told apart by where they start.
///
/// **When it fails:** the monitor whose centre is nearest the display's centre is returned as
/// [`MonitorMatch::Nearest`], because a list that is merely imprecise still names the right screen.
/// Only an empty list gives `None`, and the caller then falls back to the monitor the HUD is
/// already on — never to nothing.
pub(crate) fn monitor_for_display(
    display: DisplayBox,
    monitors: &[MonitorBox],
) -> Option<MonitorMatch> {
    let matches = |m: &MonitorBox| {
        (m.x - display.x).abs() <= MATCH_TOLERANCE_PT
            && (m.y - display.y).abs() <= MATCH_TOLERANCE_PT
            && (m.width - display.width).abs() <= MATCH_TOLERANCE_PT
            && (m.height - display.height).abs() <= MATCH_TOLERANCE_PT
    };
    if let Some(m) = monitors.iter().find(|m| matches(m)) {
        return Some(MonitorMatch::Exact(m.index));
    }
    let (dcx, dcy) = display.center();
    monitors
        .iter()
        .min_by(|a, b| {
            let d = |m: &MonitorBox| {
                let (cx, cy) = m.center();
                (cx - dcx).powi(2) + (cy - dcy).powi(2)
            };
            d(a).total_cmp(&d(b))
        })
        .map(|m| MonitorMatch::Nearest(m.index))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// The arrangement this bug was reported on: a 2× internal display, and a 1× external one to
    /// its right whose top edge sits above the internal display's.
    fn internal() -> DisplayBox {
        DisplayBox { id: 1, x: 0.0, y: 0.0, width: 1512.0, height: 982.0 }
    }
    fn external_right() -> DisplayBox {
        DisplayBox { id: 4, x: 1512.0, y: -331.0, width: 2560.0, height: 1440.0 }
    }
    /// The same external display moved to the other side, so its origin is negative.
    fn external_left() -> DisplayBox {
        DisplayBox { id: 4, x: -2560.0, y: -331.0, width: 2560.0, height: 1440.0 }
    }

    /// What Tauri reports for a display: its logical rect multiplied by its own scale factor, then
    /// rounded to whole pixels. Building the test monitors this way rather than by hand means the
    /// tests exercise the same conversion the production code inverts.
    fn tauri_monitor(index: usize, d: DisplayBox, scale: f64) -> MonitorBox {
        MonitorBox::from_tauri(
            index,
            (d.x * scale).round(),
            (d.y * scale).round(),
            (d.width * scale).round(),
            (d.height * scale).round(),
            scale,
        )
    }

    #[test]
    fn a_point_on_the_display_to_the_right_picks_that_display() {
        let displays = [internal(), external_right()];
        let d = display_containing(2500.0, 400.0, &displays).unwrap();
        assert_eq!(d.id, 4);
    }

    #[test]
    fn a_point_on_the_display_to_the_left_picks_that_display() {
        // Negative origin: the arithmetic must not assume displays start at zero.
        let displays = [internal(), external_left()];
        let d = display_containing(-800.0, 300.0, &displays).unwrap();
        assert_eq!(d.id, 4);
        // And a point on the main display still resolves to it, from the same list.
        assert_eq!(display_containing(700.0, 400.0, &displays).unwrap().id, 1);
    }

    #[test]
    fn a_point_above_the_main_display_belongs_to_the_taller_neighbour() {
        // y = -200 is off the top of the internal display but well inside the external one.
        let displays = [internal(), external_right()];
        assert_eq!(display_containing(2000.0, -200.0, &displays).unwrap().id, 4);
        assert!(display_containing(700.0, -200.0, &displays).is_none());
    }

    #[test]
    fn the_seam_between_two_displays_belongs_to_exactly_one_of_them() {
        let displays = [internal(), external_right()];
        assert_eq!(display_containing(1511.9, 400.0, &displays).unwrap().id, 1);
        assert_eq!(display_containing(1512.0, 400.0, &displays).unwrap().id, 4);
    }

    #[test]
    fn a_point_inside_no_display_matches_nothing() {
        let displays = [internal(), external_right()];
        assert!(display_containing(5000.0, 5000.0, &displays).is_none());
        assert!(display_containing(-10.0, 400.0, &displays).is_none());
    }

    #[test]
    fn displays_with_different_scale_factors_still_match_their_monitors() {
        let displays = [internal(), external_right()];
        let monitors = [
            tauri_monitor(0, internal(), 2.0),
            tauri_monitor(1, external_right(), 1.0),
        ];
        assert_eq!(
            monitor_for_display(internal(), &monitors),
            Some(MonitorMatch::Exact(0))
        );
        assert_eq!(
            monitor_for_display(external_right(), &monitors),
            Some(MonitorMatch::Exact(1))
        );
        // And the whole path: a point on the external display reaches the external monitor.
        let d = display_containing(2500.0, 400.0, &displays).unwrap();
        assert_eq!(monitor_for_display(d, &monitors).unwrap().index(), 1);
    }

    #[test]
    fn a_point_on_the_right_display_is_not_swallowed_by_the_left_ones_pixel_range() {
        // The regression this module exists for. In Tauri's per-monitor "physical" units the 2×
        // internal display spans 0…3024 and the 1× external one spans 1512…4072: a point at 2500
        // falls inside both, and the internal one is found first. In logical points there is no
        // overlap and the external display wins.
        let monitors = [
            tauri_monitor(0, internal(), 2.0),
            tauri_monitor(1, external_right(), 1.0),
        ];
        let internal_physical_right = 1512.0 * 2.0;
        assert!(2500.0 < internal_physical_right, "the overlap this test is about must exist");

        let d = display_containing(2500.0, 400.0, &[internal(), external_right()]).unwrap();
        assert_eq!(monitor_for_display(d, &monitors).unwrap(), MonitorMatch::Exact(1));
    }

    #[test]
    fn two_identical_displays_are_told_apart_by_where_they_start() {
        let left = DisplayBox { id: 7, x: -1920.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let right = DisplayBox { id: 8, x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let monitors = [tauri_monitor(0, left, 1.0), tauri_monitor(1, right, 1.0)];
        assert_eq!(monitor_for_display(left, &monitors), Some(MonitorMatch::Exact(0)));
        assert_eq!(monitor_for_display(right, &monitors), Some(MonitorMatch::Exact(1)));
    }

    #[test]
    fn a_monitor_list_that_does_not_line_up_falls_back_to_the_nearest() {
        // Bounds nobody can match exactly — shifted well past the tolerance.
        let monitors = [
            MonitorBox { index: 0, x: 0.0, y: 0.0, width: 1512.0, height: 982.0 },
            MonitorBox { index: 1, x: 1600.0, y: -300.0, width: 2400.0, height: 1400.0 },
        ];
        let m = monitor_for_display(external_right(), &monitors).unwrap();
        assert_eq!(m, MonitorMatch::Nearest(1));
        assert_eq!(m.label(), "nearest");
    }

    #[test]
    fn an_empty_monitor_list_matches_nothing() {
        assert!(monitor_for_display(external_right(), &[]).is_none());
    }

    #[test]
    fn rounding_a_scaled_rect_stays_inside_the_tolerance() {
        // A scale factor that does not divide cleanly is the case the tolerance is for.
        let odd = DisplayBox { id: 9, x: 1512.0, y: -331.0, width: 1707.0, height: 960.0 };
        let monitors = [tauri_monitor(0, odd, 1.5)];
        assert_eq!(monitor_for_display(odd, &monitors), Some(MonitorMatch::Exact(0)));
    }

    #[test]
    fn a_monitor_list_is_searched_by_containment_when_there_are_no_displays() {
        let monitors = [
            tauri_monitor(0, internal(), 1.0),
            tauri_monitor(1, external_right(), 1.0),
        ];
        assert_eq!(monitor_containing(2500.0, 400.0, &monitors), Some(1));
        assert_eq!(monitor_containing(700.0, 400.0, &monitors), Some(0));
        assert_eq!(monitor_containing(9000.0, 400.0, &monitors), None);
    }

    #[test]
    fn a_zero_scale_factor_is_treated_as_one_rather_than_dividing_by_zero() {
        let m = MonitorBox::from_tauri(0, 100.0, 200.0, 300.0, 400.0, 0.0);
        assert_eq!(m, MonitorBox { index: 0, x: 100.0, y: 200.0, width: 300.0, height: 400.0 });
    }
}
