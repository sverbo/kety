//! Screen recording Tauri commands.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

use crate::{
    dictation_commands::{current_model, current_dictation_provider, current_openai_api_key},
    hud_commands::{detect_hud_screen_index, show_hud},
    off_session_focus,
    screen_record,
    capture_dispatch::emit_off_session_video,
    tray_commands::warn_hud_busy,
    kety_paths, DictationActiveState, ScreenRecordState,
};

#[cfg(target_os = "macos")]
use crate::macos_capture;
#[cfg(target_os = "macos")]
use crate::macos_focus;

// ── Auto-stop ─────────────────────────────────────────────────────────────────

fn read_screen_record_auto_stop_minutes(app: &tauri::AppHandle) -> u32 {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return 120;
    };
    match store.get("screenRecordAutoStopMinutes").and_then(|v| v.as_u64()) {
        Some(v) => (v as u32).min(24 * 60),
        None => 120,
    }
}

pub(crate) fn schedule_screen_record_auto_stop(app: &tauri::AppHandle) {
    let mins = read_screen_record_auto_stop_minutes(app);
    if mins == 0 {
        return;
    }
    let epoch = app
        .state::<ScreenRecordState>()
        .record_epoch
        .load(Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(u64::from(mins) * 60));
        let sr = app2.state::<ScreenRecordState>();
        if !sr.is_recording.load(Ordering::SeqCst) {
            return;
        }
        if sr.record_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        eprintln!("[kts:screen-record] auto-stop safety: {mins} min elapsed");
        let dict_state = app2.state::<DictationActiveState>();
        let _ = stop_screen_record_cmd(app2.clone(), sr, dict_state);
    });
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn pause_screen_record_cmd(
    app: tauri::AppHandle,
    state: tauri::State<ScreenRecordState>,
) -> Result<(), String> {
    screen_record::pause_screen_record(&state)?;
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.emit("kts:hud/mode", "screen-paused");
    }
    Ok(())
}

#[tauri::command]
pub fn resume_screen_record_cmd(
    app: tauri::AppHandle,
    state: tauri::State<ScreenRecordState>,
) -> Result<(), String> {
    screen_record::resume_screen_record(&state)?;
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.emit("kts:hud/mode", "screen");
    }
    Ok(())
}

/// Shows HUD in "screen-ready" mode without starting the recording.
#[tauri::command]
pub fn prepare_screen_record_cmd(
    app: tauri::AppHandle,
    state: tauri::State<ScreenRecordState>,
    dict_state: tauri::State<DictationActiveState>,
) -> Result<(), String> {
    if dict_state.is_recording.load(Ordering::SeqCst) || dict_state.is_processing.load(Ordering::SeqCst) {
        warn_hud_busy(&app);
        return Err("Processing in progress.".into());
    }
    if state.is_recording.load(Ordering::SeqCst) || state.is_processing.load(Ordering::SeqCst) {
        warn_hud_busy(&app);
        return Err("Processing in progress.".into());
    }
    if state.is_pending.load(Ordering::SeqCst) {
        show_hud(&app, "screen-ready");
        return Ok(());
    }
    eprintln!("[kts:screen-record] prepare — showing HUD immediately");
    off_session_focus::capture_screen_record_target(&app);
    #[cfg(target_os = "macos")]
    if let Some(sample) = macos_focus::sample_frontmost_focus() {
        if let Ok(mut g) = state.start_app_name.lock() { *g = sample.app_name; }
        if let Ok(mut g) = state.start_bundle_id.lock() { *g = sample.bundle_id; }
    }
    state.is_pending.store(true, Ordering::SeqCst);
    show_hud(&app, "preparing");

    let app2 = app.clone();
    std::thread::spawn(move || {
        let sr = app2.state::<ScreenRecordState>();
        #[cfg(target_os = "macos")]
        if let Ok(p) = macos_capture::capture_fullscreen_png(&app2) {
            if let Ok(mut g) = sr.thumbnail_path.lock() { *g = Some(p); }
        }
        if let Some(hud) = app2.get_webview_window("dictation_hud") {
            let _ = hud.emit("kts:hud/mode", "screen-ready");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn start_screen_record_cmd(
    app: tauri::AppHandle,
    state: tauri::State<ScreenRecordState>,
    dict_state: tauri::State<DictationActiveState>,
) -> Result<(), String> {
    eprintln!("[kts:screen-record] start_screen_record_cmd");
    if dict_state.is_processing.load(Ordering::SeqCst) || state.is_processing.load(Ordering::SeqCst) {
        warn_hud_busy(&app);
        return Err("Processing in progress.".into());
    }
    state.is_pending.store(false, Ordering::SeqCst);
    let screen_index = detect_hud_screen_index(&app);
    eprintln!("[kts:screen-record] selected screen index: {screen_index}");
    match screen_record::start_screen_record(&app, &state, screen_index) {
        Ok(()) => {
            schedule_screen_record_auto_stop(&app);
            if let Some(hud) = app.get_webview_window("dictation_hud") {
                let _ = hud.emit("kts:hud/mode", "screen");
            }
            Ok(())
        }
        Err(e) => {
            eprintln!("[kts:screen-record] start error: {e}");
            crate::play_context_fail_sound();
            state.is_pending.store(true, Ordering::SeqCst);
            if let Some(hud) = app.get_webview_window("dictation_hud") {
                let _ = hud.emit("kts:hud/mode", "screen-ready");
                let _ = hud.emit(screen_record::EVT_ERROR, &e);
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub fn stop_screen_record_cmd(
    app: tauri::AppHandle,
    state: tauri::State<ScreenRecordState>,
    dict_state: tauri::State<DictationActiveState>,
) -> Result<(), String> {
    eprintln!("[kts:screen-record] stop_screen_record_cmd");
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("No screen recording in progress.".into());
    }
    if !state
        .stop_inflight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        warn_hud_busy(&app);
        return Ok(());
    }
    state.is_processing.store(true, Ordering::SeqCst);
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.emit("kts:hud/mode", "processing");
    }
    let lang = dict_state.lang.lock().map(|g| g.clone()).unwrap_or_else(|_| "fr".to_string());
    let whisper_model = current_model(&app);
    let provider = current_dictation_provider(&app);
    let api_key = current_openai_api_key(&app);
    let thumbnail_path = state.thumbnail_path.lock().ok()
        .and_then(|mut g| g.take())
        .and_then(|p| p.to_str().map(|s| s.to_string()));

    let app2 = app.clone();
    std::thread::spawn(move || {
        let sr_state = app2.state::<ScreenRecordState>();
        #[cfg(target_os = "macos")]
        let focus_json = off_session_focus::take_screen_record_sample(&app2)
            .and_then(|f| serde_json::to_value(f).ok());
        #[cfg(not(target_os = "macos"))]
        let focus_json: Option<serde_json::Value> = None;

        let result = match screen_record::stop_and_process(
            &app2, &*sr_state, &lang, &whisper_model, &provider, &api_key,
        ) {
            Ok((text, video_path)) => {
                eprintln!("[kts:screen-record] done: {:?}", text);
                if let Some(path_str) = video_path.to_str() {
                    emit_off_session_video(&app2, path_str, &text, focus_json, thumbnail_path);
                }
                crate::play_context_success_sound();
                Ok(())
            }
            Err(e) => {
                eprintln!("[kts:screen-record] stop_and_process error: {e}");
                crate::play_context_fail_sound();
                let _ = app2.emit(screen_record::EVT_ERROR, &e);
                Err(e)
            }
        };
        sr_state.is_processing.store(false, Ordering::SeqCst);
        sr_state.stop_inflight.store(false, Ordering::SeqCst);
        if let Some(hud) = app2.get_webview_window("dictation_hud") {
            let _ = hud.hide();
        }
        if let Err(e) = result {
            eprintln!("[kts:screen-record] background error: {e}");
        }
    });
    Ok(())
}
