//! Tray note window show/hide helpers and commands.

use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

use crate::{
    hud_commands::hud_window_intersects_any_work_area,
    off_session_focus, kety_paths,
    TRAY_NOTE_FOCUS_EVENT,
};

#[cfg(target_os = "macos")]
use crate::{macos_ax_selection, macos_tray_note_window};

// ── Tray note window positioning ──────────────────────────────────────────────

fn place_tray_note_top_center_under_cursor<R: tauri::Runtime>(
    w: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    let cursor = w.cursor_position()?;
    let mon = w
        .monitor_from_point(cursor.x, cursor.y)?
        .or(w.primary_monitor()?);
    let Some(mon) = mon else {
        return w.center();
    };

    let wa = mon.work_area();
    let outer = w.outer_size()?;
    let pw = outer.width as i32;
    let ph = outer.height as i32;
    let wx = wa.position.x;
    let wy = wa.position.y;
    let ww = wa.size.width as i32;
    let wh = wa.size.height as i32;

    const TOP_MARGIN: i32 = 10;
    let x = wx + (ww - pw).max(0) / 2;
    let mut y = wy + TOP_MARGIN;
    if y + ph > wy + wh {
        y = wy + (wh - ph).max(0);
    }
    if y < wy {
        y = wy;
    }

    w.set_position(tauri::PhysicalPosition { x, y })
}

pub(crate) fn ensure_tray_note_on_visible_monitor<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) {
    if hud_window_intersects_any_work_area(w) {
        return;
    }
    eprintln!("[kts:tray-note] position hors écran - repositionnement");
    if place_tray_note_top_center_under_cursor(w).is_err() {
        let _ = w.center();
    }
}

pub(crate) fn show_tray_note_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let selection = {
        let sel = macos_ax_selection::selected_text_via_accessibility()
            .filter(|s| !s.trim().is_empty());
        eprintln!("[kts:tray-note] sélection AX : {:?}", sel.as_deref().map(|s| if s.len() > 80 { &s[..80] } else { s }));
        sel
    };
    #[cfg(not(target_os = "macos"))]
    let selection: Option<String> = None;

    off_session_focus::capture_note_window_target(app);
    let Some(w) = app.get_webview_window("tray_note") else {
        eprintln!("kts: fenêtre `tray_note` introuvable (tauri.conf)");
        return;
    };

    let restored = (|| -> Option<()> {
        let store = app.store(kety_paths::SETTINGS_STORE_FILE).ok()?;
        let pos = store.get("tray_note_position")?;
        let x = pos.get("x")?.as_f64()?;
        let y = pos.get("y")?.as_f64()?;
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
        Some(())
    })();

    if restored.is_none() {
        if let Err(e) = place_tray_note_top_center_under_cursor(&w) {
            eprintln!("kts: position fenêtre note (écran curseur): {e}");
            let _ = w.center();
        }
    }

    ensure_tray_note_on_visible_monitor(&w);

    let final_logical = if let (Ok(p), Ok(scale)) = (w.outer_position(), w.scale_factor()) {
        Some((p.x as f64 / scale, p.y as f64 / scale))
    } else {
        None
    };

    if let Some((lx, ly)) = final_logical {
        let _ = w.set_position(tauri::LogicalPosition::new(lx, ly));
    }

    let _ = w.unminimize();
    let _ = w.show();

    if let Some((lx, ly)) = final_logical {
        let _ = w.set_position(tauri::LogicalPosition::new(lx, ly));
    }

    #[cfg(target_os = "macos")]
    {
        let app_handle = app.clone();
        let tray_note_clone = w.clone();
        if let Err(e) = app_handle.run_on_main_thread(move || {
            macos_tray_note_window::activate_and_focus(&tray_note_clone);
        }) {
            eprintln!("kts: tray-note activate_and_focus: {e}");
            let _ = w.set_focus();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = w.set_focus();

    let payload = serde_json::json!({ "selection": selection });
    if let Err(e) = w.emit(TRAY_NOTE_FOCUS_EVENT, payload) {
        eprintln!("kts: emit `{TRAY_NOTE_FOCUS_EVENT}`: {e}");
    }
}

pub(crate) fn dismiss_tray_note_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use std::sync::atomic::Ordering;
    #[cfg(target_os = "macos")]
    if let Some(state) = app.try_state::<crate::HudPresenterState>() {
        state.suppress_next_reopen.store(true, Ordering::SeqCst);
    }

    let Some(w) = app.get_webview_window("tray_note") else {
        return;
    };
    let _ = w.hide();
}

#[tauri::command]
pub fn hide_tray_note_window_cmd(app: tauri::AppHandle) -> Result<(), String> {
    dismiss_tray_note_window(&app);
    Ok(())
}

pub(crate) fn emit_recording_tray_action(app: &tauri::AppHandle, action: &'static str) {
    use tauri::Emitter;
    let payload = serde_json::json!({ "action": action });
    if let Err(e) = app.emit(crate::RECORDING_TRAY_EVENT, payload) {
        eprintln!(
            "kts: impossible d'émettre `{}` (action={action}): {e}",
            crate::RECORDING_TRAY_EVENT
        );
    }
}
