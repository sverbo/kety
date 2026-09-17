//! Métadonnées fenêtre / app pour le contexte **hors session** (optionnel, lu depuis le store).

#[cfg(target_os = "macos")]
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_store::StoreExt;

use crate::kety_paths;
use crate::ContextNoteSource;
use crate::SegmentContextState;

#[cfg(target_os = "macos")]
use crate::macos_focus;

/// Échantillons à réutiliser quand le focus au moment de l’émission ne reflète plus l’app cible
/// (fenêtre note KTS, fin de dictée, fin d’enregistrement écran).
#[cfg(target_os = "macos")]
#[derive(Default)]
pub struct PendingOffSessionFocus {
    pub note_window: Mutex<Option<macos_focus::FocusSample>>,
    pub dictation: Mutex<Option<macos_focus::FocusSample>>,
    pub screen_record: Mutex<Option<macos_focus::FocusSample>>,
}

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct PendingOffSessionFocus;

/// Vrai seulement quand le focus est échantillonné pour les segments (pas en pause, pas arrêté).
pub fn recording_session_active<R: Runtime>(app: &AppHandle<R>) -> bool {
    let ctx = app.state::<SegmentContextState>();
    ctx.live_segment_capture()
}

pub fn read_attach_off_session_focus<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return false;
    };
    store
        .get("attachOffSessionFocus")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// À appeler **avant** d’afficher la fenêtre note (raccourci ou menu tray).
#[cfg(target_os = "macos")]
pub fn capture_note_window_target<R: Runtime>(app: &AppHandle<R>) {
    if !read_attach_off_session_focus(app) || recording_session_active(app) {
        return;
    }
    if let Some(s) = macos_focus::sample_frontmost_focus() {
        if let Some(st) = app.try_state::<PendingOffSessionFocus>() {
            if let Ok(mut g) = st.note_window.lock() {
                *g = Some(s);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn capture_note_window_target<R: Runtime>(_app: &AppHandle<R>) {}

#[cfg(target_os = "macos")]
pub fn take_note_window_sample<R: Runtime>(app: &AppHandle<R>) -> Option<macos_focus::FocusSample> {
    let st = app.try_state::<PendingOffSessionFocus>()?;
    st.note_window.lock().ok().and_then(|mut g| g.take())
}

#[cfg(not(target_os = "macos"))]
pub fn capture_dictation_target<R: Runtime>(_app: &AppHandle<R>) {}

#[cfg(target_os = "macos")]
pub fn capture_dictation_target<R: Runtime>(app: &AppHandle<R>) {
    if !read_attach_off_session_focus(app) || recording_session_active(app) {
        return;
    }
    if let Some(s) = macos_focus::sample_frontmost_focus() {
        if let Some(st) = app.try_state::<PendingOffSessionFocus>() {
            if let Ok(mut g) = st.dictation.lock() {
                *g = Some(s);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn take_dictation_sample<R: Runtime>(app: &AppHandle<R>) -> Option<macos_focus::FocusSample> {
    let st = app.try_state::<PendingOffSessionFocus>()?;
    st.dictation.lock().ok().and_then(|mut g| g.take())
}

#[cfg(not(target_os = "macos"))]
pub fn capture_screen_record_target<R: Runtime>(_app: &AppHandle<R>) {}

#[cfg(target_os = "macos")]
pub fn capture_screen_record_target<R: Runtime>(app: &AppHandle<R>) {
    if !read_attach_off_session_focus(app) || recording_session_active(app) {
        return;
    }
    if let Some(s) = macos_focus::sample_frontmost_focus() {
        if let Some(st) = app.try_state::<PendingOffSessionFocus>() {
            if let Ok(mut g) = st.screen_record.lock() {
                *g = Some(s);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn take_screen_record_sample<R: Runtime>(app: &AppHandle<R>) -> Option<macos_focus::FocusSample> {
    let st = app.try_state::<PendingOffSessionFocus>()?;
    st.screen_record.lock().ok().and_then(|mut g| g.take())
}

#[cfg(not(target_os = "macos"))]
pub fn clear_screen_record_pending<R: Runtime>(_app: &AppHandle<R>) {}

#[cfg(target_os = "macos")]
pub fn clear_screen_record_pending<R: Runtime>(app: &AppHandle<R>) {
    if let Some(st) = app.try_state::<PendingOffSessionFocus>() {
        if let Ok(mut g) = st.screen_record.lock() {
            g.take();
        }
    }
}

/// Presse-papiers / sélection : échantillon au moment du raccourci.
#[cfg(target_os = "macos")]
pub fn sample_for_immediate_off_session<R: Runtime>(app: &AppHandle<R>) -> Option<macos_focus::FocusSample> {
    if !read_attach_off_session_focus(app) || recording_session_active(app) {
        return None;
    }
    macos_focus::sample_frontmost_focus()
}

/// Capture plein écran : thread dédié, **avant** l’UI interactive.
#[cfg(target_os = "macos")]
pub fn sample_for_off_session_image<R: Runtime>(app: &AppHandle<R>) -> Option<macos_focus::FocusSample> {
    if !read_attach_off_session_focus(app) || recording_session_active(app) {
        return None;
    }
    macos_focus::sample_frontmost_focus()
}

#[cfg(target_os = "macos")]
pub fn resolve_focus_for_off_session_note<R: Runtime>(
    app: &AppHandle<R>,
    source: ContextNoteSource,
) -> Option<macos_focus::FocusSample> {
    if source == ContextNoteSource::GoogleMeet {
        return Some(macos_focus::google_meet_bridge_focus_sample());
    }
    if !read_attach_off_session_focus(app) {
        return None;
    }
    match source {
        ContextNoteSource::Manual => take_note_window_sample(app),
        ContextNoteSource::Dictation => take_dictation_sample(app),
        ContextNoteSource::Clipboard
        | ContextNoteSource::CopyHistory
        | ContextNoteSource::Highlight
        | ContextNoteSource::TextTransform => {
            sample_for_immediate_off_session(app)
        }
        ContextNoteSource::ScreenRecording => take_screen_record_sample(app),
        ContextNoteSource::GoogleMeet => unreachable!("handled above"),
    }
}
