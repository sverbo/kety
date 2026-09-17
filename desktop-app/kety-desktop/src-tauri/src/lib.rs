use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri_plugin_store::StoreExt;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, ShortcutState};

// ── Event name constants (pub so sub-modules can use them) ────────────────────

/// Fenêtre « note tray » : réinitialiser le champ texte.
pub(crate) const TRAY_NOTE_FOCUS_EVENT: &str = "kts:tray-note/focus";

/// Tray / fenêtre note → webview principale : Start, Pause, Resume, Stop.
pub(crate) const RECORDING_TRAY_EVENT: &str = "kts:recording/tray";

/// Rust → webview principale : afficher l'onglet Assistant et focus sur le chat.
pub(crate) const ASSISTANT_OPEN_EVENT: &str = "kts:assistant/open";

/// Rust → webview principale : ouvrir les settings.
pub(crate) const SETTINGS_OPEN_EVENT: &str = "kts:settings/open";
pub(crate) const SESSIONS_OPEN_EVENT: &str = "kts:sessions/open";

/// Rust → webview principale : ouvrir la modale de connexion (menu tray).
const TRAY_REQUEST_SIGN_IN_EVENT: &str = "kts:tray/request-sign-in";

/// Rust → webview principale : déconnexion (menu tray).
const TRAY_REQUEST_SIGN_OUT_EVENT: &str = "kts:tray/request-sign-out";

/// Rust → webview : copie des notes du segment ouvert (après chaque ajout + dans `focus-current`).
pub const SEGMENT_CONTEXT_PENDING_EVENT: &str = "kts:recording/segment-context-pending";

/// Rust → webview : note saisie alors qu'aucun enregistrement n'est actif.
pub const OFF_SESSION_NOTE_EVENT: &str = "kts:recording/off-session-note";

/// Rust → webview : capture plein écran hors session (chemin fichier local).
pub const OFF_SESSION_IMAGE_EVENT: &str = "kts:recording/off-session-image";

/// Rust → webview : résultat OCR d'une capture (chemin absolu + texte extrait).
pub const OCR_RESULT_EVENT: &str = "kts:ocr/result";

/// Rust → webview : vidéo d'enregistrement écran terminée (chemin fichier local).
pub const OFF_SESSION_VIDEO_EVENT: &str = "kts:recording/off-session-video";

/// Rust → webview : Meet transcript pushed with manual=true.
pub const GOOGLE_MEET_MANUAL_INGESTED_EVENT: &str = "kts:google-meet/manual-ingested";

/// Rust → webview : texte dicté injecté dans un champ de saisie.
pub(crate) const DICTATION_FIELD_INJECT_EVENT: &str = "kts:dictation/field-inject";

// ── Module declarations ───────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos_ax_selection;
#[cfg(target_os = "macos")]
mod macos_capture;
#[cfg(target_os = "macos")]
mod macos_focus;
#[cfg(target_os = "macos")]
mod shortcuts;
#[cfg(target_os = "macos")]
mod macos_fn_dictation;
#[cfg(target_os = "macos")]
mod macos_copy_history;
#[cfg(target_os = "macos")]
mod screen_capture_sck;
#[cfg(target_os = "macos")]
mod macos_hud_window;
#[cfg(target_os = "macos")]
mod macos_displays;
#[cfg(target_os = "macos")]
mod macos_tray_note_window;
mod off_session_focus;
mod focus_poll;
mod dictation;
mod kety_paths;
mod gcp_share;
mod gcp_share_commands;
mod screen_record;
mod transcript_clean;
mod cloud_transcribe;
mod whisper_setup;
mod qwen_setup;
mod embed_setup;
mod local_index;
mod auto_index;
mod index_export;
mod index_import;
mod local_llm;
mod meet_bridge;

// ── New sub-modules ───────────────────────────────────────────────────────────
mod capture_dispatch;
mod upload_commands;
mod document_commands;
mod tray_commands;
mod hud_display;
mod hud_commands;
mod dictation_commands;
mod screen_record_commands;
mod whisper_commands;
mod qwen_commands;
mod embed_commands;
mod local_index_commands;
mod ocr_queue;
mod hotkey_commands;
mod tray_note_commands;
mod http_auth;
mod mcp_api;
mod text_action_commands;

// Re-export state types needed by sub-modules
pub(crate) use dictation::DictationActiveState;
pub(crate) use screen_record::ScreenRecordState;

// Re-export for sub-modules
pub(crate) use tray_commands::{TrayAuthState, TrayRecordingHandles};
pub(crate) use whisper_commands::DownloadState;
pub(crate) use qwen_commands::QwenDownloadState;
pub(crate) use embed_commands::EmbedDownloadState;

// ── Shared state types ────────────────────────────────────────────────────────

/// Serializes all embedding operations.
pub struct EmbedLockState(pub tokio::sync::Mutex<()>);

/// Modèle Qwen sélectionné pour usage futur.
pub(crate) struct QwenLocalModelState(pub std::sync::Mutex<String>);

pub(crate) fn current_qwen_model(app: &tauri::AppHandle) -> String {
    app.try_state::<QwenLocalModelState>()
        .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

// Import dictation helpers used in lib.rs
use dictation_commands::{current_model, current_dictation_provider};
// Re-export for sub-modules
pub(crate) use dictation_commands::dictation_is_functional;
pub(crate) use tray_commands::refresh_dictation_state;

/// Horodatage (ms depuis UNIX epoch) du dernier appui sur le raccourci dictée.
#[cfg(target_os = "macos")]
static DICTATION_PRESS_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// État runtime : raccourci touche Fn / Globe.
#[cfg(target_os = "macos")]
pub(crate) struct FnDictationShortcutSetting {
    pub enabled: Arc<AtomicBool>,
}

/// Lettres ⌘⌥+X actuellement enregistrées.
#[cfg(target_os = "macos")]
pub(crate) struct HotkeyCodesState(pub std::sync::RwLock<shortcuts::HotkeyResolvedCodes>);

static CLIPBOARD_MONITOR_ENABLED: AtomicBool = AtomicBool::new(false);
static CLIPBOARD_MONITOR_LAST: std::sync::OnceLock<Mutex<String>> = std::sync::OnceLock::new();

#[inline]
pub(crate) fn clipboard_monitor_is_enabled() -> bool {
    CLIPBOARD_MONITOR_ENABLED.load(Ordering::Relaxed)
}

/// Ignore copy-history capture until this instant.
static CLIPBOARD_COPY_HISTORY_SUPPRESS_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn clipboard_copy_history_suppress_for_ms(ms: u64) {
    let end = now_epoch_ms().saturating_add(ms);
    let _ = CLIPBOARD_COPY_HISTORY_SUPPRESS_UNTIL_MS.fetch_max(end, Ordering::SeqCst);
}

pub(crate) fn clipboard_copy_history_is_suppressed() -> bool {
    now_epoch_ms() < CLIPBOARD_COPY_HISTORY_SUPPRESS_UNTIL_MS.load(Ordering::Relaxed)
}

pub(crate) fn capture_clipboard_for_user_copy_history(app: &tauri::AppHandle) {
    if clipboard_copy_history_is_suppressed() {
        return;
    }
    if !clipboard_monitor_is_enabled() {
        return;
    }
    let Ok(text) = read_clipboard_text_plain() else {
        return;
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    let last = CLIPBOARD_MONITOR_LAST.get_or_init(|| Mutex::new(String::new()));
    let changed = {
        let mut g = last.lock().unwrap();
        if *g == text {
            false
        } else {
            *g = text.clone();
            true
        }
    };
    if changed {
        capture_dispatch::emit_off_session_note(
            app,
            &text,
            None,
            ContextNoteSource::CopyHistory,
            None,
            None,
            None,
        );
    }
}

// ── HudPresenterState ─────────────────────────────────────────────────────────

pub(crate) struct HudPresenterState {
    pub main_was_visible: AtomicBool,
    pub suppress_next_reopen: AtomicBool,
    pub frontmost_pid: std::sync::atomic::AtomicI32,
    /// True while the HUD sits somewhere other than the bottom of the display: beside a
    /// selection, beside the pointer, or wherever the user dropped it. Everything that would
    /// otherwise pull it back to the bottom on a `Moved` event checks this first.
    pub hud_off_bottom: AtomicBool,
    /// True once the user has dragged the HUD. Nothing moves it after that until it is presented
    /// afresh — a window that snaps home the moment it is let go is worse than one that never
    /// moved at all.
    pub hud_user_moved: AtomicBool,
    /// What the HUD was last anchored to. The result of a transform is placed against it: by the
    /// time the text comes back the selection it was made from has been overwritten.
    pub hud_anchor: std::sync::Mutex<Option<hud_commands::AnchorRect>>,
}
impl HudPresenterState {
    fn new() -> Self {
        Self {
            main_was_visible: AtomicBool::new(false),
            suppress_next_reopen: AtomicBool::new(false),
            frontmost_pid: std::sync::atomic::AtomicI32::new(0),
            hud_off_bottom: AtomicBool::new(false),
            hud_user_moved: AtomicBool::new(false),
            hud_anchor: std::sync::Mutex::new(None),
        }
    }
}

// ── ContextNoteSource ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextNoteSource {
    Highlight,
    Clipboard,
    #[serde(rename = "copyHistory")]
    CopyHistory,
    Manual,
    Dictation,
    #[serde(rename = "screenRecording")]
    ScreenRecording,
    #[serde(rename = "googleMeet")]
    GoogleMeet,
    #[serde(rename = "textTransform")]
    TextTransform,
}

// ── ContextTimelineItem ───────────────────────────────────────────────────────

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContextTimelineItem {
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        explanation: Option<String>,
        source: ContextNoteSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Document {
        summary: String,
        #[serde(rename = "filePath", alias = "path")]
        file_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        explanation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_size: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        process_doc_index_doc: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    Screenshot {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        explanation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ocr: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ScreenRecording {
        path: String,
        transcription: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thumbnail_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        explanation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lang: Option<String>,
    },
}

// ── SegmentContextState ───────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct SegmentContextState {
    pub timeline: Arc<Mutex<Vec<ContextTimelineItem>>>,
    pub session_id: Arc<Mutex<Option<String>>>,
    pub focus_poll_active: Arc<AtomicBool>,
}

impl SegmentContextState {
    pub(crate) fn live_segment_capture(&self) -> bool {
        let has_open_session = self
            .session_id
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| !s.is_empty()))
            .unwrap_or(false);
        has_open_session && self.focus_poll_active.load(Ordering::SeqCst)
    }
}

// ── Utility helpers ───────────────────────────────────────────────────────────

pub(crate) fn emit_payload_to_main(
    app: &tauri::AppHandle,
    event: &str,
    payload: &impl serde::Serialize,
) {
    if let Some(main) = app.get_webview_window("main") {
        if let Err(e) = main.emit(event, payload) {
            eprintln!("kts: emit `{event}` → fenêtre main : {e} - repli global");
            if let Err(e2) = app.emit(event, payload) {
                eprintln!("kts: emit `{event}` global : {e2}");
            }
        }
    } else if let Err(e) = app.emit(event, payload) {
        eprintln!("kts: emit `{event}` : {e}");
    }
}

fn read_clipboard_text_plain() -> Result<String, String> {
    let mut clip = arboard::Clipboard::new().map_err(|e| format!("Presse-papiers : {e}"))?;
    clip.get_text()
        .map_err(|e| format!("Pas de texte dans le presse-papiers (ou format non pris en charge) : {e}"))
}

#[cfg(target_os = "macos")]
pub(crate) fn clipboard_plain_text_preview_source() -> Option<String> {
    let mut clip = arboard::Clipboard::new().ok()?;
    let t = clip.get_text().ok()?;
    let t = t.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn paste_to_context_tray_menu_update(
    clipboard_text: Option<&str>,
    shortcut_suffix: &str,
) -> (bool, String) {
    const BASE: &str = "Paste";
    let empty_label = format!("{BASE}{shortcut_suffix}");
    let Some(raw) = clipboard_text.map(str::trim) else {
        return (false, empty_label);
    };
    if raw.is_empty() {
        return (false, empty_label);
    }
    let flat: String = raw
        .chars()
        .map(|c| match c {
            '\n' | '\r' | '\t' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return (false, empty_label);
    }
    let head: String = flat.chars().take(5).collect();
    (true, format!("{BASE} - {head}…{shortcut_suffix}"))
}

// ── Sound helpers ─────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn afplay_system_sound_aiff(name: &str, volume: &str) {
    use std::process::{Command, Stdio};
    let path = format!("/System/Library/Sounds/{name}.aiff");
    let _ = Command::new("afplay")
        .args(["-v", volume, &path])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(target_os = "macos")]
pub(crate) fn play_context_success_sound() {
    afplay_system_sound_aiff("Pop", "0.35");
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn play_context_success_sound() {}

#[cfg(target_os = "macos")]
pub(crate) fn play_dictation_recording_started_sound() {
    afplay_system_sound_aiff("Glass", "0.28");
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn play_dictation_recording_started_sound() {}

#[cfg(target_os = "macos")]
pub(crate) fn play_context_fail_sound() {
    afplay_system_sound_aiff("Tink", "0.22");
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn play_context_fail_sound() {}

// ── Context helpers (clipboard / highlight) ───────────────────────────────────

#[cfg(target_os = "macos")]
fn apply_clipboard_as_context(app: &tauri::AppHandle) -> Result<(), String> {
    let text = read_clipboard_text_plain()?;
    capture_dispatch::dispatch_context_note(app, &text, None, ContextNoteSource::Clipboard, None)
}

#[cfg(target_os = "macos")]
fn apply_highlight_as_context(app: &tauri::AppHandle) -> Result<bool, String> {
    let target_pid = macos_focus::frontmost_pid();
    let sel = macos_ax_selection::selected_text_via_accessibility()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| macos_ax_selection::read_selection_via_copy(target_pid));
    match sel {
        Some(s) => {
            capture_dispatch::dispatch_context_note(app, &s, None, ContextNoteSource::Highlight, None)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn show_text_actions_hud(app: &tauri::AppHandle, selected_text: String) {
    use tauri::Emitter;
    let Some(hud) = app.get_webview_window("dictation_hud") else { return };

    if let Some(presenter) = app.try_state::<HudPresenterState>() {
        let main_visible = app.get_webview_window("main")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        presenter.main_was_visible.store(main_visible, std::sync::atomic::Ordering::SeqCst);
        presenter.frontmost_pid.store(macos_focus::frontmost_pid(), std::sync::atomic::Ordering::SeqCst);
    }

    let actions = text_action_commands::load_text_actions(app);
    let save_to_history = text_action_commands::load_save_to_history(app);

    // Pre-size before positioning so coordinates use the correct dimensions.
    // Mirrors DictationHud.tsx: h = 32 + (n+1)*30 + 12, clamped [60, 280] logical px.
    const HUD_W: f64 = 220.0;
    let hud_h: f64 = (32.0 + (actions.len() + 1) as f64 * 30.0 + 12.0).max(60.0).min(280.0);
    let _ = hud.set_size(tauri::Size::Logical(tauri::LogicalSize { width: HUD_W, height: hud_h }));

    // Beside the pointer, which is where the user has just finished dragging out the selection
    // this popup is about — so the actions appear next to the text rather than at the far edge of
    // the screen.
    //
    // The selection's own rect would be better still, but it comes from AXBoundsForRange and
    // enough applications answer with an unusable one that the popup used to land in the top-left
    // corner. The pointer needs nobody's cooperation. It was parked for a while because it put the
    // popup on the wrong display; that was the placement arithmetic working in a coordinate space
    // that could not describe two displays of different scale factors, not the anchor. Placement
    // is in logical points now, and the pointer is read in the same points.
    hud_commands::apply_hud_placement(
        app,
        &hud,
        hud_commands::HudPlacement::Pointer,
        Some((HUD_W, hud_h)),
    );
    hud_commands::ensure_hud_on_visible_monitor(app);

    let _ = hud.show();
    #[cfg(target_os = "macos")]
    macos_hud_window::apply_hud_rounded_corners(&hud);
    let payload = serde_json::json!({
        "selectedText": selected_text,
        "actions": actions,
        "saveToHistory": save_to_history,
    });
    let _ = hud.emit("kts:hud/text-actions", payload);
}

#[cfg(target_os = "macos")]
pub(crate) fn trigger_text_transform_hud(app: &tauri::AppHandle) {
    let target_pid = macos_focus::frontmost_pid();
    let sel = macos_ax_selection::selected_text_via_accessibility()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| macos_ax_selection::read_selection_via_copy(target_pid));
    match sel {
        Some(text) => show_text_actions_hud(app, text),
        None => {
            let hud_was_visible = app
                .get_webview_window("dictation_hud")
                .and_then(|h| h.is_visible().ok())
                .unwrap_or(false);
            if !hud_was_visible {
                hud_commands::show_hud(app, "idle");
            }
            let app2 = app.clone();
            std::thread::spawn(move || {
                if !hud_was_visible {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                if let Some(hud) = app2.get_webview_window("dictation_hud") {
                    use tauri::Emitter;
                    let _ = hud.emit("kts:hud/brief-warning", "No text selected");
                }
                if !hud_was_visible {
                    std::thread::sleep(std::time::Duration::from_millis(3000));
                    if let Some(hud) = app2.get_webview_window("dictation_hud") {
                        let _ = hud.hide();
                    }
                }
            });
        }
    }
}

// ── Misc simple commands ──────────────────────────────────────────────────────

#[tauri::command]
fn delete_capture_files(paths: Vec<String>) {
    for p in paths {
        if let Err(e) = std::fs::remove_file(&p) {
            eprintln!("kts: suppression capture {p}: {e}");
        }
    }
}

#[tauri::command]
fn sum_file_sizes_cmd(paths: Vec<String>) -> u64 {
    paths
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .sum()
}

#[tauri::command]
fn get_file_sizes_cmd(paths: Vec<String>) -> Vec<u64> {
    paths
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .collect()
}

#[tauri::command]
fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    clipboard_copy_history_suppress_for_ms(400);
    let mut clip = arboard::Clipboard::new().map_err(|e| format!("Presse-papiers : {e}"))?;
    clip.set_text(text)
        .map_err(|e| format!("Copie presse-papiers : {e}"))
}

#[tauri::command]
fn capture_app_screenshot_cmd(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos_capture::capture_as_base64_png(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Screenshot not supported on this platform".into())
    }
}

#[tauri::command]
fn get_rust_logs_cmd() -> String {
    String::new()
}

#[tauri::command]
fn set_clipboard_monitor_enabled_cmd(enabled: bool) {
    CLIPBOARD_MONITOR_ENABLED.store(enabled, Ordering::Relaxed);
    if !enabled {
        if let Some(last) = CLIPBOARD_MONITOR_LAST.get() {
            if let Ok(mut g) = last.lock() {
                g.clear();
            }
        }
    }
}

// ── Data migrations ───────────────────────────────────────────────────────────

fn run_data_migrations(app: &tauri::AppHandle) {
    let Ok(base) = app.path().app_local_data_dir() else { return };

    if let Some(parent) = base.parent() {
        let old_bundle = parent.join("com.kts.desktop");
        if old_bundle.exists() {
            if let Ok(entries) = std::fs::read_dir(&old_bundle) {
                for entry in entries.flatten() {
                    let src = entry.path();
                    let dst = base.join(entry.file_name());
                    if !dst.exists() {
                        let _ = std::fs::rename(&src, &dst);
                    }
                }
            }
            let _ = std::fs::remove_dir(&old_bundle);
        }
    }

    let old_kts = base.join("kts");
    let new_kety = base.join("kety");
    if old_kts.exists() && !new_kety.exists() {
        let _ = std::fs::rename(&old_kts, &new_kety);
    }

    if new_kety.exists() {
        for (old_name, new_name) in &[
            ("kts-session-store.json", "kety-session-store.json"),
            ("kts-settings.json",      "kety-settings.json"),
        ] {
            let old_f = new_kety.join(old_name);
            let new_f = new_kety.join(new_name);
            if old_f.exists() && !new_f.exists() {
                let _ = std::fs::rename(&old_f, &new_f);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn reset_tcc_if_version_changed(app: &tauri::AppHandle) {
    let Ok(kety_dir) = kety_paths::kety_dir(app) else { return };
    let _ = std::fs::create_dir_all(&kety_dir);
    let marker = kety_dir.join(".tcc_version");
    let current = app.package_info().version.to_string();

    let needs_reset = match std::fs::read_to_string(&marker) {
        Ok(stored) if stored.trim() == current => false,
        _ => true,
    };
    if !needs_reset { return; }

    let bundle_id = app.config().identifier.as_str();
    eprintln!("[kts] nouvelle version ({current}), réinitialisation TCC pour {bundle_id}");
    let _ = std::process::Command::new("tccutil")
        .args(["reset", "ScreenCapture", bundle_id])
        .status();
    let _ = std::process::Command::new("tccutil")
        .args(["reset", "Microphone", bundle_id])
        .status();
    let _ = std::fs::write(&marker, &current);
    eprintln!("[kts] TCC réinitialisé → les permissions seront redemandées à l'usage");
}

#[cfg(target_os = "macos")]
fn read_fn_dictation_shortcut_enabled(app: &tauri::AppHandle) -> bool {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return true;
    };
    store
        .get("fnDictationShortcutEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

// ── run() ─────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    let global_shortcut_plugin = GlobalShortcutBuilder::new()
        .with_handler(|app, shortcut, event| {
            let k = shortcut.key;
            let hk = app
                .try_state::<HotkeyCodesState>()
                .and_then(|s| s.0.read().ok().map(|g| *g))
                .unwrap_or_default();

            // ── Gestion du relâchement du raccourci dictée ────────────────────
            if (k == hk.dictation || k == hk.custom_dictation) && event.state == ShortcutState::Released {
                let dict_state = app.state::<DictationActiveState>();
                if dict_state.is_recording.load(Ordering::SeqCst) {
                    let press_ms = DICTATION_PRESS_MS.load(Ordering::SeqCst);
                    if press_ms > 0 {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let held_ms = now_ms.saturating_sub(press_ms);
                        eprintln!("[kts:dictation] relâchement raccourci, tenu={held_ms}ms");
                        if held_ms >= 2000 {
                            let app2 = app.clone();
                            std::thread::spawn(move || {
                                if let Err(e) = dictation_commands::stop_dictation_cmd(
                                    app2.clone(),
                                    app2.state::<DictationActiveState>(),
                                ) {
                                    eprintln!("[kts:dictation] stop via relâchement: {e}");
                                }
                            });
                        }
                    }
                }
                return;
            }

            if event.state == ShortcutState::Pressed {
                eprintln!("[kts:global-shortcut] Pressed → {:?}", shortcut);
            }
            if event.state != ShortcutState::Pressed {
                return;
            }
            if k == hk.note_window {
                tray_note_commands::show_tray_note_window(app);
            } else if k == hk.context_text {
                match apply_clipboard_as_context(app) {
                    Ok(()) => play_context_success_sound(),
                    Err(e) => {
                        play_context_fail_sound();
                        eprintln!("kts: ⌘⌥V → clipboard context: {e}");
                    }
                }
            } else if k == hk.text_transform {
                trigger_text_transform_hud(app);
            } else if k == hk.context_highlight {
                match apply_highlight_as_context(app) {
                    Ok(true) => play_context_success_sound(),
                    Ok(false) => {
                        play_context_fail_sound();
                        eprintln!("kts: ⌘⌥C → aucune sélection AX disponible");
                    }
                    Err(e) => {
                        play_context_fail_sound();
                        eprintln!("kts: ⌘⌥C → highlight context erreur: {e}");
                        let hud_was_visible = app
                            .get_webview_window("dictation_hud")
                            .and_then(|h| h.is_visible().ok())
                            .unwrap_or(false);
                        if !hud_was_visible {
                            hud_commands::show_hud(app, "idle");
                        }
                        let app2 = app.clone();
                        let e2 = e.clone();
                        std::thread::spawn(move || {
                            if !hud_was_visible {
                                std::thread::sleep(std::time::Duration::from_millis(150));
                            }
                            if let Some(hud) = app2.get_webview_window("dictation_hud") {
                                let _ = hud.emit("kts:hud/brief-warning", &e2);
                            }
                            if !hud_was_visible {
                                std::thread::sleep(std::time::Duration::from_millis(3500));
                                let dict = app2.state::<DictationActiveState>();
                                let sr   = app2.state::<ScreenRecordState>();
                                let busy = dict.is_recording.load(Ordering::SeqCst)
                                    || dict.is_processing.load(Ordering::SeqCst)
                                    || sr.is_recording.load(Ordering::SeqCst)
                                    || sr.is_processing.load(Ordering::SeqCst);
                                if !busy {
                                    if let Some(hud) = app2.get_webview_window("dictation_hud") {
                                        let _ = hud.hide();
                                    }
                                }
                            }
                        });
                    }
                }
            } else if k == hk.screenshot {
                eprintln!("[kts:⌃B] capture interactive");
                ocr_queue::spawn_interactive_capture(app);
            } else if shortcuts::REGISTER_RECORDING_TOGGLE_SHORTCUT && k == hk.recording_toggle {
                tray_note_commands::emit_recording_tray_action(app, "toggle_recording");
            } else if k == hk.dictation || k == hk.custom_dictation {
                let start_custom_dictation = k == hk.custom_dictation;
                if !dictation_is_functional(app) {
                    let provider = current_dictation_provider(app);
                    if provider == "openai:whisper-1" {
                        let _ = app.emit(dictation::EVT_ERROR, "Clé API OpenAI manquante pour la dictée cloud.");
                        return;
                    }
                    let _ = app.emit(whisper_setup::EVT_NOT_INSTALLED, ());
                    return;
                }
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                DICTATION_PRESS_MS.store(now_ms, Ordering::SeqCst);

                let dict_state = app.state::<DictationActiveState>();
                let sr_state = app.state::<ScreenRecordState>();
                if dict_state.is_recording.load(Ordering::SeqCst) {
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = dictation_commands::stop_dictation_cmd(app2.clone(), app2.state::<DictationActiveState>()) {
                            eprintln!("[kts:dictation] stop via raccourci: {e}");
                        }
                    });
                } else if dict_state.is_processing.load(Ordering::SeqCst) {
                    tray_commands::warn_hud_busy(app);
                } else if sr_state.is_recording.load(Ordering::SeqCst)
                    || sr_state.is_processing.load(Ordering::SeqCst)
                {
                    tray_commands::warn_hud_busy(app);
                } else {
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        let r = if start_custom_dictation {
                            dictation_commands::start_dictation_custom_cmd(
                                app2.clone(),
                                app2.state::<DictationActiveState>(),
                                app2.state::<ScreenRecordState>(),
                            )
                        } else {
                            dictation_commands::start_dictation_cmd(
                                app2.clone(),
                                app2.state::<DictationActiveState>(),
                                app2.state::<ScreenRecordState>(),
                            )
                        };
                        if let Err(e) = r {
                            eprintln!("[kts:dictation] start via raccourci: {e}");
                        }
                    });
                }
            } else if k == hk.screen_record {
                let sr_state = app.state::<ScreenRecordState>();
                let dict_state = app.state::<DictationActiveState>();
                if sr_state.is_recording.load(Ordering::SeqCst) {
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = screen_record_commands::stop_screen_record_cmd(
                            app2.clone(),
                            app2.state::<ScreenRecordState>(),
                            app2.state::<DictationActiveState>(),
                        ) {
                            eprintln!("[kts:screen-record] stop via shortcut: {e}");
                        }
                    });
                } else if sr_state.is_processing.load(Ordering::SeqCst) {
                    tray_commands::warn_hud_busy(app);
                } else if dict_state.is_recording.load(Ordering::SeqCst)
                    || dict_state.is_processing.load(Ordering::SeqCst)
                {
                    tray_commands::warn_hud_busy(app);
                } else if sr_state.is_pending.load(Ordering::SeqCst) {
                    sr_state.is_pending.store(false, Ordering::SeqCst);
                    off_session_focus::clear_screen_record_pending(app);
                    if let Some(hud) = app.get_webview_window("dictation_hud") {
                        let _ = hud.hide();
                    }
                } else {
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = screen_record_commands::prepare_screen_record_cmd(
                            app2.clone(),
                            app2.state::<ScreenRecordState>(),
                            app2.state::<DictationActiveState>(),
                        ) {
                            eprintln!("[kts:screen-record] prepare via shortcut: {e}");
                        }
                    });
                }
            } else if k == hk.assistant {
                hud_commands::open_main_assistant_tab(app);
            } else if k == hk.open_app {
                hud_commands::open_main_sessions_tab(app);
            } else {
                eprintln!("[kts:global-shortcut] touche non gérée: {:?}", k);
            }
        })
        .build();

    #[cfg(not(target_os = "macos"))]
    let global_shortcut_plugin = tauri_plugin_global_shortcut::Builder::new().build();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(global_shortcut_plugin)
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if window.label() == "tray_note" {
                        tray_note_commands::dismiss_tray_note_window(window.app_handle());
                    } else {
                        let _ = window.hide();
                    }
                }
                WindowEvent::Moved(_pos) if window.label() == "dictation_hud" => {
                    let app = window.app_handle();
                    if let Some(sr) = app.try_state::<ScreenRecordState>() {
                        if sr.is_recording.load(Ordering::SeqCst) {
                            hud_commands::snap_hud_to_recording_screen(&app);
                        }
                    }
                    hud_commands::reposition_hud_bottom_center_active(&app);
                }
                WindowEvent::Moved(pos) if window.label() == "tray_note" => {
                    if let Ok(store) = window.app_handle().store(kety_paths::SETTINGS_STORE_FILE) {
                        let scale = window.scale_factor().unwrap_or(1.0);
                        let lx = pos.x as f64 / scale;
                        let ly = pos.y as f64 / scale;
                        store.set(
                            "tray_note_position",
                            serde_json::json!({"x": lx, "y": ly}),
                        );
                        let _ = store.save();
                    }
                }
                WindowEvent::ScaleFactorChanged { .. } if window.label() == "dictation_hud" => {
                    if window.is_visible().unwrap_or(false) {
                        let app = window.app_handle();
                        hud_commands::reposition_hud_bottom_center_active(&app);
                        hud_commands::ensure_hud_on_visible_monitor(&app);
                    }
                }
                WindowEvent::ScaleFactorChanged { .. } if window.label() == "tray_note" => {
                    if window.is_visible().unwrap_or(false) {
                        let app = window.app_handle();
                        if let Some(tn) = app.get_webview_window("tray_note") {
                            tray_note_commands::ensure_tray_note_on_visible_monitor(&tn);
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            capture_app_screenshot_cmd,
            get_rust_logs_cmd,
            tray_commands::set_tray_signed_in_cmd,
            delete_capture_files,
            sum_file_sizes_cmd,
            get_file_sizes_cmd,
            copy_text_to_clipboard,
            dictation_commands::start_dictation_cmd,
            dictation_commands::start_dictation_custom_cmd,
            dictation_commands::sync_dictation_custom_settings_cmd,
            dictation_commands::get_dictation_custom_prompt_defaults_cmd,
            dictation_commands::start_tray_dictation_cmd,
            dictation_commands::stop_dictation_cmd,
            dictation_commands::hud_chat_mic_available_cmd,
            dictation_commands::start_hud_chat_mic_cmd,
            dictation_commands::stop_hud_chat_mic_cmd,
            dictation_commands::pause_dictation_cmd,
            dictation_commands::resume_dictation_cmd,
            dictation_commands::set_dictation_lang_cmd,
            hud_commands::hide_hud_cmd,
            hud_commands::get_hud_state_cmd,
            hud_commands::discard_hud_cmd,
            hud_commands::show_hud_result_cmd,
            hud_commands::place_hud_after_resize_cmd,
            hud_commands::mark_hud_moved_by_user_cmd,
            hud_commands::focus_hud_cmd,
            screen_record_commands::prepare_screen_record_cmd,
            screen_record_commands::start_screen_record_cmd,
            screen_record_commands::stop_screen_record_cmd,
            screen_record_commands::pause_screen_record_cmd,
            screen_record_commands::resume_screen_record_cmd,
            hotkey_commands::get_shortcuts_cmd,
            tray_note_commands::hide_tray_note_window_cmd,
            whisper_commands::check_whisper_cmd,
            whisper_commands::download_whisper_cmd,
            whisper_commands::cancel_whisper_download_cmd,
            whisper_commands::remove_whisper_cmd,
            whisper_commands::set_whisper_model_cmd,
            whisper_commands::set_dictation_provider_cmd,
            qwen_commands::check_qwen_models_cmd,
            qwen_commands::download_qwen_model_cmd,
            qwen_commands::cancel_qwen_download_cmd,
            qwen_commands::remove_qwen_model_cmd,
            qwen_commands::set_qwen_local_model_cmd,
            embed_commands::check_embed_models_cmd,
            embed_commands::download_embed_model_cmd,
            embed_commands::cancel_embed_download_cmd,
            embed_commands::remove_embed_model_cmd,
            embed_commands::set_active_embed_model_cmd,
            local_index_commands::local_index_capture_cmd,
            local_index_commands::local_hard_delete_capture_cmd,
            local_index_commands::local_index_stats_cmd,
            local_index_commands::local_index_pending_cmd,
            local_index_commands::local_unindex_captures_cmd,
            local_index_commands::local_reindex_captures_cmd,
            local_index_commands::local_index_state_counts_cmd,
            local_index_commands::local_save_capture_cmd,
            local_index_commands::local_list_captures_cmd,
            local_index_commands::local_save_tag_cmd,
            local_index_commands::local_list_tags_cmd,
            local_index_commands::local_delete_tag_cmd,
            local_index_commands::local_distinct_tag_ids_cmd,
            local_index_commands::local_distinct_tag_ids_for_model_cmd,
            local_index_commands::local_index_diag_cmd,
            local_index_commands::local_model_coverage_cmd,
            local_index_commands::local_coverage_by_model_cmd,
            local_index_commands::local_embed_missing_cmd,
            local_index_commands::local_clear_embed_errors_cmd,
            local_index_commands::local_search_cmd,
            local_index_commands::sqlite_list_tables_cmd,
            local_index_commands::sqlite_query_table_cmd,
            local_index_commands::sqlite_execute_cmd,
            local_index_commands::local_pack_context_cmd,
            index_export::build_index_export_cmd,
            index_import::import_shared_index_cmd,
            index_import::delete_assistant_cmd,
            index_import::list_orphan_assistants_cmd,
            document_commands::check_local_llm_cmd,
            document_commands::sensitive_preview_run_cmd,
            document_commands::run_prompt_cmd,
            document_commands::summarize_pdf_cmd,
            document_commands::meta_summarize_cmd,
            document_commands::ocr_pdf_page_cmd,
            document_commands::read_pdf_bytes_cmd,
            document_commands::extract_docx_pages_cmd,
            document_commands::persist_context_source_file_cmd,
            document_commands::get_sensitive_prompt_template_cmd,
            document_commands::set_sensitive_prompt_template_cmd,
            upload_commands::save_captures_zip_cmd,
            upload_commands::build_captures_zip_to_temp_cmd,
            upload_commands::delete_temp_file_cmd,
            upload_commands::download_url_to_downloads_cmd,
            upload_commands::copy_local_file_to_downloads_cmd,
            set_clipboard_monitor_enabled_cmd,
            upload_commands::export_chrome_extension_zip_cmd,
            mcp_api::get_mcp_server_path_cmd,
            mcp_api::mcp_api_info_cmd,
            mcp_api::regenerate_mcp_api_token_cmd,
            gcp_share_commands::gcp_share_set_config_cmd,
            gcp_share_commands::gcp_share_get_config_cmd,
            gcp_share_commands::gcp_share_remove_config_cmd,
            gcp_share_commands::gcp_share_test_connection_cmd,
            gcp_share_commands::gcp_share_create_link_cmd,
            gcp_share_commands::gcp_share_list_links_cmd,
            gcp_share_commands::gcp_share_revoke_link_cmd,
            capture_dispatch::set_google_meet_timeline_explanation_cmd,
            hotkey_commands::set_fn_dictation_shortcut_enabled_cmd,
            hotkey_commands::apply_macos_hotkey_key_letters_cmd,
            text_action_commands::get_text_actions_config_cmd,
            text_action_commands::save_text_actions_cmd,
            text_action_commands::run_text_action_cmd,
            text_action_commands::insert_text_result_cmd,
        ])
        .setup(|app| {
            // ── Data migrations ────────────────────────────────────────────────
            run_data_migrations(app.handle());

            #[cfg(target_os = "macos")]
            reset_tcc_if_version_changed(app.handle());

            #[cfg(target_os = "macos")]
            let hk_boot = hotkey_commands::load_hotkey_codes_from_store(app.handle());
            #[cfg(target_os = "macos")]
            app.manage(HotkeyCodesState(std::sync::RwLock::new(hk_boot)));

            let open_settings = MenuItem::with_id(app, "open_settings", "Settings", true, None::<&str>)?;
            #[cfg(target_os = "macos")]
            let show = MenuItem::with_id(
                app,
                "show",
                &format!(
                    "Open app{}",
                    shortcuts::menu_suffix_for_code(hk_boot.open_app)
                ),
                true,
                None::<&str>,
            )?;
            #[cfg(not(target_os = "macos"))]
            let show = MenuItem::with_id(app, "show", "Open app", true, None::<&str>)?;
            #[cfg(target_os = "macos")]
            let open_assistant = MenuItem::with_id(
                app,
                "open_assistant",
                &format!(
                    "Open assistant{}",
                    shortcuts::menu_suffix_for_code(hk_boot.assistant)
                ),
                true,
                None::<&str>,
            )?;
            #[cfg(not(target_os = "macos"))]
            let open_assistant = MenuItem::with_id(
                app,
                "open_assistant",
                "Open AI assistant (Ctrl+A)",
                true,
                None::<&str>,
            )?;
            let auth_action = MenuItem::with_id(app, "auth_action", "Sign in", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            #[cfg(target_os = "macos")]
            let tray_note = MenuItem::with_id(
                app,
                "tray_note",
                &format!(
                    "Capture note…{}",
                    shortcuts::menu_suffix_for_code(hk_boot.note_window)
                ),
                true,
                None::<&str>,
            )?;
            #[cfg(not(target_os = "macos"))]
            let tray_note = MenuItem::with_id(
                app,
                "tray_note",
                "Capture note…",
                true,
                None::<&str>,
            )?;

            #[cfg(target_os = "macos")]
            let paste_context = MenuItem::with_id(
                app,
                "paste_context",
                &format!(
                    "Paste {}",
                    shortcuts::menu_suffix_for_code(hk_boot.context_text)
                ),
                false,
                None::<&str>,
            )?;
            #[cfg(target_os = "macos")]
            let screenshot_context = MenuItem::with_id(
                app,
                "screenshot_context",
                &format!(
                    "Screenshot {}",
                    shortcuts::menu_suffix_for_code(hk_boot.screenshot)
                ),
                true,
                None::<&str>,
            )?;

            #[cfg(target_os = "macos")]
            let text_transform_item = MenuItem::with_id(
                app,
                "text_transform",
                &format!(
                    "Selection transform{}",
                    shortcuts::menu_suffix_for_code(hk_boot.text_transform)
                ),
                true,
                None::<&str>,
            )?;

            #[cfg(target_os = "macos")]
            let dictation_item = MenuItem::with_id(
                app,
                "dictation",
                &format!(
                    "Dictation{}",
                    shortcuts::menu_suffix_for_code(hk_boot.dictation)
                ),
                true,
                None::<&str>,
            )?;

            #[cfg(target_os = "macos")]
            let custom_dictation_item = MenuItem::with_id(
                app,
                "custom_dictation",
                &format!(
                    "Custom dictation{}",
                    shortcuts::menu_suffix_for_code(hk_boot.custom_dictation)
                ),
                true,
                None::<&str>,
            )?;

            #[cfg(target_os = "macos")]
            let screen_record_item = MenuItem::with_id(
                app,
                "screen_record",
                &format!(
                    "Record screen{}",
                    shortcuts::menu_suffix_for_code(hk_boot.screen_record)
                ),
                true,
                None::<&str>,
            )?;
            #[cfg(not(target_os = "macos"))]
            let screen_record_item = MenuItem::with_id(
                app,
                "screen_record",
                "Record screen  (⌃S)",
                true,
                None::<&str>,
            )?;

            let tray_sep_before_app = PredefinedMenuItem::separator(app)?;

            #[cfg(target_os = "macos")]
            let menu = Menu::with_items(
                app,
                &[
                    &tray_note,
                    &paste_context,
                    &screenshot_context,
                    &text_transform_item,
                    &dictation_item,
                    &custom_dictation_item,
                    &screen_record_item,
                    &tray_sep_before_app,
                    &show,
                    &open_assistant,
                    &open_settings,
                    &auth_action,
                    &quit,
                ],
            )?;
            #[cfg(not(target_os = "macos"))]
            let menu = Menu::with_items(
                app,
                &[
                    &tray_note,
                    &screen_record_item,
                    &tray_sep_before_app,
                    &show,
                    &open_assistant,
                    &open_settings,
                    &auth_action,
                    &quit,
                ],
            )?;

            let icon_idle = include_bytes!("../icons/tray-icon.png").to_vec();
            let icon = tauri::image::Image::from_bytes(&icon_idle)?;

            let tray = TrayIconBuilder::new()
                .icon(icon)
                .icon_as_template(false)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        hud_commands::open_main_sessions_tab(app);
                    }
                    "open_assistant" => {
                        hud_commands::open_main_assistant_tab(app);
                    }
                    "open_settings" => {
                        hud_commands::open_main_settings_tab(app);
                    }
                    "auth_action" => {
                        if tray_commands::tray_auth_signed_in(app) {
                            emit_payload_to_main(
                                app,
                                TRAY_REQUEST_SIGN_OUT_EVENT,
                                &serde_json::Value::Null,
                            );
                        } else {
                            hud_commands::activate_main_window(app);
                            emit_payload_to_main(
                                app,
                                TRAY_REQUEST_SIGN_IN_EVENT,
                                &serde_json::Value::Null,
                            );
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    "tray_note" => {
                        tray_note_commands::show_tray_note_window(app);
                    }
                    #[cfg(target_os = "macos")]
                    "paste_context" => match apply_clipboard_as_context(app) {
                        Ok(()) => play_context_success_sound(),
                        Err(e) => {
                            play_context_fail_sound();
                            eprintln!("kts: tray « Paste »: {e}");
                        }
                    },
                    #[cfg(target_os = "macos")]
                    "screenshot_context" => ocr_queue::spawn_interactive_capture(app),
                    #[cfg(target_os = "macos")]
                    "text_transform" => trigger_text_transform_hud(app),
                    "dictation" => {
                        if !kety_paths::whisper_is_functional(app, &current_model(app)) {
                            let _ = app.emit(whisper_setup::EVT_NOT_INSTALLED, ());
                            return;
                        }
                        let dict_state = app.state::<DictationActiveState>();
                        let sr_state = app.state::<ScreenRecordState>();
                        if dict_state.is_recording.load(Ordering::SeqCst)
                            || dict_state.is_processing.load(Ordering::SeqCst)
                        {
                            tray_commands::warn_hud_busy(app);
                            return;
                        }
                        if sr_state.is_recording.load(Ordering::SeqCst)
                            || sr_state.is_processing.load(Ordering::SeqCst)
                        {
                            tray_commands::warn_hud_busy(app);
                            return;
                        }
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            if let Err(e) = dictation_commands::start_dictation_cmd(
                                app2.clone(),
                                app2.state::<DictationActiveState>(),
                                app2.state::<ScreenRecordState>(),
                            ) {
                                eprintln!("[kts:dictation] start via menu tray: {e}");
                            }
                        });
                    }
                    // Same guards as "dictation" above: custom dictation records with the same
                    // microphone and the same Whisper model, and only differs once the transcript
                    // exists, when the user's model post-processes it.
                    "custom_dictation" => {
                        if !kety_paths::whisper_is_functional(app, &current_model(app)) {
                            let _ = app.emit(whisper_setup::EVT_NOT_INSTALLED, ());
                            return;
                        }
                        let dict_state = app.state::<DictationActiveState>();
                        let sr_state = app.state::<ScreenRecordState>();
                        if dict_state.is_recording.load(Ordering::SeqCst)
                            || dict_state.is_processing.load(Ordering::SeqCst)
                        {
                            tray_commands::warn_hud_busy(app);
                            return;
                        }
                        if sr_state.is_recording.load(Ordering::SeqCst)
                            || sr_state.is_processing.load(Ordering::SeqCst)
                        {
                            tray_commands::warn_hud_busy(app);
                            return;
                        }
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            if let Err(e) = dictation_commands::start_dictation_custom_cmd(
                                app2.clone(),
                                app2.state::<DictationActiveState>(),
                                app2.state::<ScreenRecordState>(),
                            ) {
                                eprintln!("[kts:dictation] start custom via menu tray: {e}");
                            }
                        });
                    }
                    "screen_record" => {
                        let dict_state = app.state::<DictationActiveState>();
                        let sr_state = app.state::<ScreenRecordState>();
                        if sr_state.is_recording.load(Ordering::SeqCst)
                            || sr_state.is_processing.load(Ordering::SeqCst)
                            || sr_state.is_pending.load(Ordering::SeqCst)
                        {
                            tray_commands::warn_hud_busy(app);
                            return;
                        }
                        if dict_state.is_recording.load(Ordering::SeqCst)
                            || dict_state.is_processing.load(Ordering::SeqCst)
                        {
                            tray_commands::warn_hud_busy(app);
                            return;
                        }
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            if let Err(e) = screen_record_commands::prepare_screen_record_cmd(
                                app2.clone(),
                                app2.state::<ScreenRecordState>(),
                                app2.state::<DictationActiveState>(),
                            ) {
                                eprintln!("[kts:screen-record] prepare via tray: {e}");
                            }
                        });
                    }
                    _ => {}
                })
                .build(app)?;

            tray_commands::tray_force_fullcolor(&tray);

            app.manage(TrayAuthState::new());

            app.manage(TrayRecordingHandles {
                tray,
                tray_note_item: tray_note.clone(),
                show_item: show.clone(),
                open_assistant_item: open_assistant.clone(),
                screen_record_item: screen_record_item.clone(),
                auth_action_item: auth_action.clone(),
                #[cfg(target_os = "macos")]
                paste_context_item: paste_context.clone(),
                #[cfg(target_os = "macos")]
                screenshot_context_item: screenshot_context.clone(),
                #[cfg(target_os = "macos")]
                dictation_item: dictation_item.clone(),
                icon_idle,
            });

            app.manage(DictationActiveState::new());
            app.manage(HudPresenterState::new());
            app.manage(DownloadState(std::sync::Mutex::new(None)));
            app.manage(QwenDownloadState(std::sync::Mutex::new(None)));
            app.manage(QwenLocalModelState(std::sync::Mutex::new(String::new())));
            app.manage(EmbedDownloadState(std::sync::Mutex::new(None)));

            app.manage(local_index::LocalIndexState(std::sync::Mutex::new(local_index::LocalIndexConn::new())));
            app.manage(EmbedLockState(tokio::sync::Mutex::new(())));
            refresh_dictation_state(app.handle());
            app.manage(ScreenRecordState::new());
            app.manage(ocr_queue::start_ocr_worker());

            #[cfg(target_os = "macos")]
            tray_commands::spawn_paste_tray_menu_poller(app.handle().clone());

            #[cfg(target_os = "macos")]
            {
                let enabled = Arc::new(AtomicBool::new(read_fn_dictation_shortcut_enabled(
                    app.handle(),
                )));
                app.manage(FnDictationShortcutSetting {
                    enabled: Arc::clone(&enabled),
                });
                macos_fn_dictation::spawn_fn_dictation_listener(app.handle().clone(), enabled);
            }

            #[cfg(target_os = "macos")]
            {
                if let Err(e) = hotkey_commands::register_macos_global_hotkeys(app.handle()) {
                    eprintln!("[kts:hotkeys] enregistrement initial: {e}");
                }
            }

            let focus_poll_active = Arc::new(AtomicBool::new(false));
            let focus_session_id = Arc::new(Mutex::new(None::<String>));

            let context_timeline = Arc::new(Mutex::new(Vec::<ContextTimelineItem>::new()));
            let recording_identity = focus_poll::RecordingSelfIdentity {
                own_pid: std::process::id() as i32,
                self_bundle_id: {
                    #[cfg(target_os = "macos")]
                    {
                        macos_focus::self_bundle_identifier()
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        None::<String>
                    }
                },
                config_identifier: app.config().identifier.clone(),
            };

            app.manage(SegmentContextState {
                timeline: Arc::clone(&context_timeline),
                session_id: Arc::clone(&focus_session_id),
                focus_poll_active: Arc::clone(&focus_poll_active),
            });

            app.manage(off_session_focus::PendingOffSessionFocus::default());

            focus_poll::spawn_focus_poll_thread(
                app.handle().clone(),
                Arc::clone(&focus_poll_active),
                focus_session_id,
                context_timeline,
                recording_identity,
            );

            mcp_api::start_mcp_api_server(app.handle().clone());
            auto_index::start_auto_index_loop(app.handle().clone());
            meet_bridge::maybe_spawn_meet_bridge(app.handle().clone());

            tray_commands::refresh_tray_menu_full(app.handle())?;

            #[cfg(target_os = "macos")]
            eprintln!(
                "[kts:startup] Raccourcis globaux macOS : ⌃V (sélection ou presse-papiers), ⌃X, ⌃B, ⌃N - src-tauri/src/shortcuts.rs - logs : [kts:global-shortcut], [kts:ctrl-b]."
            );

            #[cfg(target_os = "macos")]
            macos_copy_history::spawn_cmd_c_copy_history_listener(app.handle().clone());

            #[cfg(not(target_os = "macos"))]
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let last = CLIPBOARD_MONITOR_LAST.get_or_init(|| Mutex::new(String::new()));
                    loop {
                        std::thread::sleep(Duration::from_millis(600));
                        if !clipboard_monitor_is_enabled() {
                            continue;
                        }
                        let Ok(text) = read_clipboard_text_plain() else { continue };
                        let text = text.trim().to_string();
                        if text.is_empty() {
                            continue;
                        }
                        let changed = {
                            let mut g = last.lock().unwrap();
                            if *g == text {
                                false
                            } else {
                                *g = text.clone();
                                true
                            }
                        };
                        if changed {
                            capture_dispatch::emit_off_session_note(
                                &app_handle,
                                &text,
                                None,
                                ContextNoteSource::CopyHistory,
                                None,
                                None,
                                None,
                            );
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                let suppressed = app
                    .try_state::<HudPresenterState>()
                    .map(|s| s.suppress_next_reopen.swap(false, Ordering::SeqCst))
                    .unwrap_or(false);
                if !suppressed {
                    hud_commands::activate_main_window(app);
                }
            }
        });
}
