//! Tray menu management: auth state, recording UI, tray icon helpers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{image::Image, menu::MenuItem, tray::TrayIcon, Emitter, Manager, Wry};

#[cfg(target_os = "macos")]
use crate::{shortcuts, HotkeyCodesState};

// ── Auth state ────────────────────────────────────────────────────────────────

pub(crate) struct TrayAuthState {
    pub signed_in: AtomicBool,
}

impl TrayAuthState {
    pub fn new() -> Self {
        Self {
            signed_in: AtomicBool::new(false),
        }
    }
}

pub(crate) fn tray_auth_signed_in(app: &tauri::AppHandle) -> bool {
    app.try_state::<TrayAuthState>()
        .map(|s| s.signed_in.load(Ordering::SeqCst))
        .unwrap_or(false)
}

// ── TrayRecordingHandles ──────────────────────────────────────────────────────

pub(crate) struct TrayRecordingHandles {
    pub tray: TrayIcon<Wry>,
    pub tray_note_item: MenuItem<Wry>,
    pub show_item: MenuItem<Wry>,
    pub open_assistant_item: MenuItem<Wry>,
    pub screen_record_item: MenuItem<Wry>,
    pub auth_action_item: MenuItem<Wry>,
    #[cfg(target_os = "macos")]
    pub paste_context_item: MenuItem<Wry>,
    #[cfg(target_os = "macos")]
    pub screenshot_context_item: MenuItem<Wry>,
    #[cfg(target_os = "macos")]
    pub dictation_item: MenuItem<Wry>,
    pub icon_idle: Vec<u8>,
}

// ── Tray icon helpers ─────────────────────────────────────────────────────────

pub(crate) fn tray_force_fullcolor(tray: &TrayIcon<Wry>) {
    let _ = tray.set_icon_as_template(false);
}

pub(crate) fn apply_tray_recording_ui(handles: &TrayRecordingHandles) -> Result<(), String> {
    handles
        .tray
        .set_icon(None)
        .map_err(|e| format!("kts: tray set_icon (clear): {e}"))?;
    let icon = Image::from_bytes(handles.icon_idle.as_slice())
        .map_err(|e| format!("kts: Image::from_bytes (tray idle): {e}"))?;
    handles
        .tray
        .set_icon(Some(icon))
        .map_err(|e| format!("kts: tray set_icon: {e}"))?;
    tray_force_fullcolor(&handles.tray);
    handles
        .tray
        .set_tooltip(Some("Kety"))
        .map_err(|e| format!("kts: tray set_tooltip: {e}"))?;
    Ok(())
}

/// Indication courte sous l'icône tray : une autre action est déjà en cours.
pub(crate) fn flash_tray_busy<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(handles) = app.try_state::<TrayRecordingHandles>() else {
        return;
    };
    let _ = handles.tray.set_tooltip(Some("Kety - Working…"));
    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        if let Some(h) = app_handle.try_state::<TrayRecordingHandles>() {
            let _ = h.tray.set_tooltip(Some("Kety"));
        }
    });
}

/// HUD visible : bandeau « En traitement » + tooltip tray.
pub(crate) fn warn_hud_busy<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        if hud.is_visible().unwrap_or(false) {
            let _ = hud.emit("kts:hud/brief-warning", "En traitement");
        }
    }
    flash_tray_busy(app);
}

// ── Refresh helpers ───────────────────────────────────────────────────────────

/// Enables/disables the dictation tray item based on functional state.
pub(crate) fn refresh_dictation_state(app: &tauri::AppHandle) {
    let functional = crate::dictation_is_functional(app);
    #[cfg(target_os = "macos")]
    if let Some(handles) = app.try_state::<TrayRecordingHandles>() {
        let signed_in = tray_auth_signed_in(app);
        let _ = handles
            .dictation_item
            .set_enabled(signed_in && functional);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = functional;
}

/// Met à jour les libellés « … (⌘⌥X) » du menu tray après changement de lettres.
#[cfg(target_os = "macos")]
pub(crate) fn refresh_tray_menu_hotkey_suffixes(app: &tauri::AppHandle) -> Result<(), String> {
    let handles = app.state::<TrayRecordingHandles>();
    let hk = app
        .try_state::<HotkeyCodesState>()
        .and_then(|s| s.0.read().ok().map(|g| *g))
        .unwrap_or_default();
    handles
        .tray_note_item
        .set_text(&format!(
            "Capture note…{}",
            shortcuts::menu_suffix_for_code(hk.note_window)
        ))
        .map_err(|e| format!("tray Capture note set_text: {e}"))?;
    handles
        .open_assistant_item
        .set_text(&format!(
            "Open assistant{}",
            shortcuts::menu_suffix_for_code(hk.assistant)
        ))
        .map_err(|e| format!("tray Open assistant set_text: {e}"))?;
    handles
        .paste_context_item
        .set_text(&format!(
            "Paste {}",
            shortcuts::menu_suffix_for_code(hk.context_text)
        ))
        .map_err(|e| format!("tray Paste set_text: {e}"))?;
    handles
        .screenshot_context_item
        .set_text(&format!(
            "Screenshot {}",
            shortcuts::menu_suffix_for_code(hk.screenshot)
        ))
        .map_err(|e| format!("tray Screenshot set_text: {e}"))?;
    handles
        .dictation_item
        .set_text(&format!(
            "Dictation {}",
            shortcuts::menu_suffix_for_code(hk.dictation)
        ))
        .map_err(|e| format!("tray Dictation set_text: {e}"))?;
    handles
        .screen_record_item
        .set_text(&format!(
            "Record screen {}",
            shortcuts::menu_suffix_for_code(hk.screen_record)
        ))
        .map_err(|e| format!("tray Screen record set_text: {e}"))?;
    handles
        .show_item
        .set_text(&format!(
            "Open app{}",
            shortcuts::menu_suffix_for_code(hk.open_app)
        ))
        .map_err(|e| format!("tray Open app set_text: {e}"))?;
    Ok(())
}

/// Sync menu tray avec l'état auth.
pub(crate) fn refresh_tray_menu_full(app: &tauri::AppHandle) -> Result<(), String> {
    let handles = app.state::<TrayRecordingHandles>();
    let signed_in = tray_auth_signed_in(app);

    let auth_label = if signed_in { "Sign out" } else { "Sign in" };
    handles
        .auth_action_item
        .set_text(auth_label)
        .map_err(|e| format!("tray Sign in / Sign out - set_text: {e}"))?;
    handles
        .auth_action_item
        .set_enabled(true)
        .map_err(|e| format!("tray Sign in / Sign out - set_enabled: {e}"))?;

    let enabled = signed_in;
    handles
        .tray_note_item
        .set_enabled(enabled)
        .map_err(|e| format!("tray Capture note - set_enabled: {e}"))?;
    handles
        .open_assistant_item
        .set_enabled(enabled)
        .map_err(|e| format!("tray Open assistant - set_enabled: {e}"))?;
    handles
        .screen_record_item
        .set_enabled(enabled)
        .map_err(|e| format!("tray Screen record - set_enabled: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        handles
            .paste_context_item
            .set_enabled(enabled)
            .map_err(|e| format!("tray Paste  - set_enabled: {e}"))?;
        handles
            .screenshot_context_item
            .set_enabled(enabled)
            .map_err(|e| format!("tray Screenshot - set_enabled: {e}"))?;
        handles
            .dictation_item
            .set_enabled(false)
            .map_err(|e| format!("tray Dictation - set_enabled: {e}"))?;
    }

    apply_tray_recording_ui(&handles)?;
    #[cfg(target_os = "macos")]
    if signed_in {
        refresh_dictation_state(app);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = refresh_tray_menu_hotkey_suffixes(app);
    }
    Ok(())
}

// ── Paste menu poller ─────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub(crate) fn spawn_paste_tray_menu_poller(app: tauri::AppHandle<Wry>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(450));
        let opt = crate::clipboard_plain_text_preview_source();
        let sfx = app
            .try_state::<HotkeyCodesState>()
            .and_then(|s| s.0.read().ok().map(|g| shortcuts::menu_suffix_for_code(g.context_text)))
            .unwrap_or_else(|| shortcuts::menu_suffix_for_code(shortcuts::KEY_CONTEXT_TEXT));
        let (enabled, label) = crate::paste_to_context_tray_menu_update(opt.as_deref(), &sfx);
        let label_owned = label;
        let app_main = app.clone();
        let app_state = app.clone();
        if app_main
            .run_on_main_thread(move || {
                let Some(st) = app_state.try_state::<TrayRecordingHandles>() else {
                    return;
                };
                let h = st.inner();
                let signed_in = tray_auth_signed_in(&app_state);
                let paste_on = signed_in && enabled;
                let _ = h.paste_context_item.set_enabled(paste_on);
                let _ = h.paste_context_item.set_text(&label_owned);
            })
            .is_err()
        {
            break;
        }
    });
}

// ── Command ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn set_tray_signed_in_cmd(app: tauri::AppHandle, signed_in: bool) -> Result<(), String> {
    if let Some(st) = app.try_state::<TrayAuthState>() {
        st.signed_in.store(signed_in, Ordering::SeqCst);
    }
    refresh_tray_menu_full(&app)
}
