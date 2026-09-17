//! macOS global hotkey management and shortcut info commands.

use std::sync::atomic::Ordering;

use tauri::Manager;

use crate::kety_paths;
#[cfg(target_os = "macos")]
use crate::{shortcuts, HotkeyCodesState};
#[cfg(target_os = "macos")]
use tauri_plugin_store::StoreExt;
#[cfg(target_os = "macos")]
use tauri_plugin_global_shortcut::GlobalShortcutExt;

// ── Response type ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutsInfo {
    context_text: String,
    context_highlight: String,
    note_window: String,
    screenshot: String,
    recording_toggle: String,
    dictation: String,
    custom_dictation: String,
    screen_record: String,
    assistant: String,
    open_app: String,
    text_transform: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub(crate) fn load_hotkey_codes_from_store(app: &tauri::AppHandle) -> shortcuts::HotkeyResolvedCodes {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return shortcuts::HotkeyResolvedCodes::default();
    };
    let Some(raw) = store.get("hotkeyKeyLetters") else {
        return shortcuts::HotkeyResolvedCodes::default();
    };
    match shortcuts::HotkeyResolvedCodes::from_json_partial(&raw) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[kts:hotkeys] config invalide, défauts : {e}");
            shortcuts::HotkeyResolvedCodes::default()
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn register_macos_global_hotkeys(app: &tauri::AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs
        .unregister_all()
        .map_err(|e| format!("unregister_all hotkeys: {e}"))?;
    let codes = app
        .try_state::<HotkeyCodesState>()
        .and_then(|s| s.0.read().ok().map(|g| *g))
        .unwrap_or_default();
    let vec = codes.to_shortcuts_vec();
    gs.register_multiple(vec)
        .map_err(|e| format!("register_multiple hotkeys: {e}"))?;
    Ok(())
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn apply_macos_hotkey_key_letters_cmd(
    app: tauri::AppHandle,
    letters: serde_json::Value,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let resolved = shortcuts::HotkeyResolvedCodes::from_json_full(&letters)?;
        let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
            return Err("Store indisponible.".into());
        };
        store.set("hotkeyKeyLetters", letters);
        store
            .save()
            .map_err(|e| format!("store save hotkeyKeyLetters: {e}"))?;
        if let Some(st) = app.try_state::<HotkeyCodesState>() {
            *st.0.write().map_err(|e| format!("hotkey lock: {e}"))? = resolved;
        }
        register_macos_global_hotkeys(&app)?;
        crate::tray_commands::refresh_tray_menu_hotkey_suffixes(&app)?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, letters);
        Ok(())
    }
}

#[tauri::command]
pub fn get_shortcuts_cmd(app: tauri::AppHandle) -> ShortcutsInfo {
    #[cfg(target_os = "macos")]
    {
        let hk = app
            .try_state::<HotkeyCodesState>()
            .and_then(|s| s.0.read().ok().map(|g| *g))
            .unwrap_or_default();
        ShortcutsInfo {
            context_text: shortcuts::shortcut_key(hk.context_text),
            context_highlight: shortcuts::shortcut_key(hk.context_highlight),
            note_window: shortcuts::shortcut_key(hk.note_window),
            screenshot: shortcuts::shortcut_key(hk.screenshot),
            recording_toggle: shortcuts::shortcut_key(hk.recording_toggle),
            dictation: shortcuts::shortcut_key(hk.dictation),
            custom_dictation: shortcuts::shortcut_key(hk.custom_dictation),
            screen_record: shortcuts::shortcut_key(hk.screen_record),
            assistant: shortcuts::shortcut_key(hk.assistant),
            open_app: shortcuts::shortcut_key(hk.open_app),
            text_transform: shortcuts::shortcut_key(hk.text_transform),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        ShortcutsInfo {
            context_text: "?".into(),
            context_highlight: "?".into(),
            note_window: "?".into(),
            screenshot: "?".into(),
            recording_toggle: "?".into(),
            dictation: "?".into(),
            custom_dictation: "?".into(),
            screen_record: "?".into(),
            assistant: "?".into(),
            open_app: "?".into(),
            text_transform: "?".into(),
        }
    }
}

#[tauri::command]
pub fn set_fn_dictation_shortcut_enabled_cmd(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
            return Err("Store indisponible.".into());
        };
        store.set("fnDictationShortcutEnabled", enabled);
        store.save().map_err(|e| format!("store save: {e}"))?;
        if let Some(st) = app.try_state::<crate::FnDictationShortcutSetting>() {
            st.enabled.store(enabled, Ordering::SeqCst);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}
