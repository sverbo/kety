//! Dictation Tauri commands and dictation flow helpers.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

use crate::{
    dictation, kety_paths, local_llm, off_session_focus,
    whisper_setup, ContextNoteSource, DictationActiveState, ScreenRecordState,
};
use crate::capture_dispatch::dispatch_context_note;
use crate::hud_commands::{restore_main_window_visibility, show_hud_at, HudPlacement};
use crate::tray_commands::warn_hud_busy;

#[cfg(target_os = "macos")]
use crate::screen_capture_sck;
#[cfg(target_os = "macos")]
use crate::hud_commands::reactivate_previous_frontmost;
#[cfg(target_os = "macos")]
use crate::{macos_ax_selection, macos_focus};

// ── Dictation mode ────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
pub(crate) enum DictationStartMode {
    ContextCapture,
    FnField,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

pub(crate) fn current_model(app: &tauri::AppHandle) -> String {
    app.try_state::<DictationActiveState>()
        .and_then(|s| s.model.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

pub(crate) fn current_dictation_provider(app: &tauri::AppHandle) -> String {
    app.try_state::<DictationActiveState>()
        .and_then(|s| s.provider.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "local".to_string())
}

pub(crate) fn current_openai_api_key(app: &tauri::AppHandle) -> String {
    app.try_state::<DictationActiveState>()
        .and_then(|s| s.openai_api_key.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

pub(crate) fn dictation_is_functional(app: &tauri::AppHandle) -> bool {
    match current_dictation_provider(app).as_str() {
        "openai:whisper-1" => !current_openai_api_key(app).trim().is_empty(),
        _ => kety_paths::whisper_is_functional(app, &current_model(app)),
    }
}

fn read_dictation_auto_stop_minutes(app: &tauri::AppHandle) -> u32 {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return 60;
    };
    match store.get("dictationAutoStopMinutes").and_then(|v| v.as_u64()) {
        Some(v) => (v as u32).min(24 * 60),
        None => 60,
    }
}

pub(crate) fn schedule_dictation_auto_stop(app: &tauri::AppHandle) {
    let mins = read_dictation_auto_stop_minutes(app);
    if mins == 0 {
        return;
    }
    let epoch = app
        .state::<DictationActiveState>()
        .record_epoch
        .load(Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(u64::from(mins) * 60));
        let d = app2.state::<DictationActiveState>();
        if !d.is_recording.load(Ordering::SeqCst) {
            return;
        }
        if d.record_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        eprintln!("[kts:dictation] auto-stop safety: {mins} min elapsed");
        let _ = stop_dictation_cmd(app2.clone(), app2.state());
    });
}

/// Returns the rewritten transcript and, when a model was actually asked for it, the prompt it
/// was given. That prompt is what a follow-up conversation in the HUD starts from; it is `None`
/// when no model ran and the transcript came back untouched.
fn apply_dictation_custom_llm(
    app: &tauri::AppHandle,
    dict_state: &DictationActiveState,
    transcript: &str,
    highlights: &str,
    use_highlight_prompt: bool,
) -> Result<(String, Option<String>), String> {
    let model = dict_state
        .dictation_custom_model
        .lock()
        .map_err(|e| e.to_string())?;
    let m = model.trim();
    if m.is_empty() || m == "disabled" {
        return Ok((transcript.to_string(), None));
    }
    let tmpl = if use_highlight_prompt {
        dict_state
            .dictation_custom_prompt_highlight
            .lock()
            .map_err(|e| e.to_string())?
    } else {
        dict_state
            .dictation_custom_prompt_no_highlight
            .lock()
            .map_err(|e| e.to_string())?
    };
    let request = fill_dictation_custom_template(&tmpl, transcript, highlights);
    // The rewritten text is pasted into whatever field had focus, so the model must answer with
    // it and nothing else. The rule is added here, to the assembled prompt, rather than to the
    // default template: that is the only place that also covers the templates users have saved.
    let prompt = local_llm::with_output_only_rule(&request);
    eprintln!(
        "[kts:dictation] custom LLM full user prompt (model={m}, chars={}, highlight_template={}):\n{}",
        prompt.len(),
        use_highlight_prompt,
        prompt
    );
    let api_key = dict_state
        .openai_api_key
        .lock()
        .map_err(|e| e.to_string())?;
    let api = api_key.trim();

    const OPENAI_PREFIX: &str = "openai:";
    let rewritten = if m.starts_with(OPENAI_PREFIX) {
        let openai_model = m.strip_prefix(OPENAI_PREFIX).unwrap_or(m).trim();
        if openai_model.is_empty() {
            return Err("Invalid custom dictation model.".into());
        }
        if api.is_empty() {
            return Err(
                "OpenAI API key is missing. Add it in Settings to use an OpenAI model for custom dictation."
                    .into(),
            );
        }
        local_llm::run_openai_chat_completion(api, openai_model, &prompt, 8192, 0.25)
    } else if m.starts_with("local:") {
        let sel = crate::current_qwen_model(app);
        let openai_opt = if api.is_empty() { None } else { Some(api) };
        local_llm::run_raw_prompt(app, &sel, Some(m), &prompt, 8192, openai_opt)
    } else {
        Err(format!(
            "Custom dictation model not supported: {m}. Choose Disabled, openai:…, or local:<gguf>."
        ))
    }?;

    // The conversation starts from the request as the user wrote it, without the output-only
    // rule: every follow-up is sent through `run_text_action_cmd`, which adds the rule again.
    Ok((rewritten, Some(request)))
}

/// Fills a custom-dictation template. Separate from the model call so it can be tested.
fn fill_dictation_custom_template(tmpl: &str, transcript: &str, highlights: &str) -> String {
    tmpl.replace("{{DICTATION_TEXT}}", transcript)
        .replace("{{HIGHLIGHTS}}", highlights)
}

/// What the optional custom post-processing step produced: the text to carry on with, and — when
/// a model actually rewrote the transcript — the prompt it answered, so the user can reopen that
/// exchange as a conversation.
pub(crate) struct DictationCustomPost {
    pub text: String,
    pub chat_prompt: Option<String>,
}

pub(crate) fn apply_dictation_custom_post_if_needed(
    app: &tauri::AppHandle,
    dict_state: &DictationActiveState,
    raw_transcript: String,
) -> DictationCustomPost {
    if !dict_state
        .custom_dictation_postprocess
        .swap(false, Ordering::SeqCst)
    {
        return DictationCustomPost { text: raw_transcript, chat_prompt: None };
    }
    let highlights = dict_state
        .initial_selection
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.clone()))
        .unwrap_or_default();
    let use_h = !highlights.trim().is_empty();
    match apply_dictation_custom_llm(app, dict_state, &raw_transcript, &highlights, use_h) {
        Ok((text, chat_prompt)) => DictationCustomPost { text, chat_prompt },
        Err(e) => {
            eprintln!("[kts:dictation] custom LLM: {e}");
            let _ = app.emit(dictation::EVT_ERROR, format!("Custom dictation: {e}"));
            // The transcript comes through untouched: there is no model answer to carry on from.
            DictationCustomPost { text: raw_transcript, chat_prompt: None }
        }
    }
}

/// Where the HUD belongs for a dictation that is about to start.
///
/// Custom dictation has two shapes, and one thing already known by the time the HUD is placed
/// tells them apart: whether the user had text selected when they triggered it.
///
/// - **With a selection** it is a transform that happens to be spoken. The answer will be about
///   *that* text, the user is looking at it, and the HUD belongs beside it.
/// - **With nothing selected** it is ordinary dictation. Ordinary dictation lasts as long as the
///   user keeps talking and has nothing to be beside, so it stays at the bottom of the screen,
///   out of the way — which is also where every non-custom dictation stays, selection or not.
///
/// Beside the *pointer* rather than beside the selection's own rectangle: that rectangle comes
/// from `AXBoundsForRange`, which enough applications answer badly that the HUD used to land in a
/// corner of the screen. The pointer is a few pixels from the text at the moment the shortcut is
/// pressed and needs no cooperation from the application the text is in.
pub(crate) fn dictation_hud_placement(is_custom: bool, has_selection: bool) -> HudPlacement {
    if is_custom && has_selection {
        HudPlacement::Pointer
    } else {
        HudPlacement::BottomCenter
    }
}

/// Whether the dictation about to start has text to work on.
///
/// Blank counts as nothing: a selection of spaces is not something a model can be asked about, and
/// `apply_dictation_custom_post_if_needed` already treats it as no selection when it chooses
/// between the two prompt templates. The placement has to agree with that, or a HUD would arrive
/// beside text that the prompt never mentions.
fn dictation_has_selection(state: &DictationActiveState) -> bool {
    state
        .initial_selection
        .lock()
        .ok()
        .map(|g| g.as_deref().is_some_and(|s| !s.trim().is_empty()))
        .unwrap_or(false)
}

fn describe_dictation_note_dispatch_target(app: &tauri::AppHandle, source: ContextNoteSource) -> String {
    let live = app
        .try_state::<crate::SegmentContextState>()
        .map(|s| s.live_segment_capture())
        .unwrap_or(false);
    if live {
        return "live recording segment timeline (in-app)".to_string();
    }
    match source {
        ContextNoteSource::CopyHistory => {
            "Copy History (desktop app, not the Captures grid)".to_string()
        }
        ContextNoteSource::Dictation => {
            "Captures off-session note (dictation source)".to_string()
        }
        other => format!("off-session note (source={other:?})"),
    }
}

pub(crate) fn start_dictation_inner(
    app: &tauri::AppHandle,
    state: &DictationActiveState,
    sr_state: &ScreenRecordState,
    #[cfg(target_os = "macos")] mode: DictationStartMode,
) -> Result<(), String> {
    eprintln!("[kts:dictation] start_dictation_inner");
    if !dictation_is_functional(app) {
        let provider = current_dictation_provider(app);
        if provider == "openai:whisper-1" {
            return Err(
                "Clé API OpenAI manquante. Configurez-la dans Settings → LLM API Key pour utiliser le provider Cloud."
                    .into(),
            );
        }
        let _ = app.emit(whisper_setup::EVT_NOT_INSTALLED, ());
        return Err("Whisper non installé. Installez-le depuis Settings → Voice dictation.".into());
    }
    if state.is_processing.load(Ordering::SeqCst) || sr_state.is_processing.load(Ordering::SeqCst) {
        warn_hud_busy(app);
        return Err("En traitement.".into());
    }
    if state.is_recording.load(Ordering::SeqCst) {
        warn_hud_busy(app);
        return Err("Dictée déjà en cours.".into());
    }
    if sr_state.is_recording.load(Ordering::SeqCst) {
        warn_hud_busy(app);
        return Err("Enregistrement écran en cours.".into());
    }
    if sr_state.is_pending.load(Ordering::SeqCst) {
        sr_state.is_pending.store(false, Ordering::SeqCst);
        if let Some(hud) = app.get_webview_window("dictation_hud") {
            let _ = hud.hide();
        }
    }
    state.tray_note_mode.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        match mode {
            DictationStartMode::ContextCapture => {
                state.fn_field_dictation.store(false, Ordering::SeqCst);
                state.inject_into_field.store(false, Ordering::SeqCst);
                let target_pid = macos_focus::frontmost_pid();
                let sel = macos_ax_selection::selected_text_via_accessibility()
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| macos_ax_selection::read_selection_via_copy(target_pid));
                if let Ok(mut guard) = state.initial_selection.lock() {
                    *guard = sel;
                }
            }
            DictationStartMode::FnField => {
                state.fn_field_dictation.store(true, Ordering::SeqCst);
                state.inject_into_field.store(true, Ordering::SeqCst);
                if let Ok(mut guard) = state.initial_selection.lock() {
                    *guard = None;
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(mut guard) = state.initial_selection.lock() {
            *guard = None;
        }
    }
    off_session_focus::capture_dictation_target(app);
    // Read after the selection has been stored above, and after the caller has said whether this
    // is a custom dictation — both are settled by now, and the HUD has not been placed yet.
    let placement = dictation_hud_placement(
        state.custom_dictation_postprocess.load(Ordering::SeqCst),
        dictation_has_selection(state),
    );
    show_hud_at(app, "dictation", placement);
    #[cfg(target_os = "macos")]
    if let Err(e) = screen_capture_sck::ensure_microphone_access() {
        let _ = app.emit(dictation::EVT_ERROR, &e);
        return Err(e);
    }
    dictation::start_dictation(app, state)?;
    schedule_dictation_auto_stop(app);
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn start_dictation_fn_hotkey(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DictationActiveState>();
    let sr_state = app.state::<ScreenRecordState>();
    start_dictation_inner(app, &state, &sr_state, DictationStartMode::FnField)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn start_dictation_cmd(
    app: tauri::AppHandle,
    state: tauri::State<DictationActiveState>,
    sr_state: tauri::State<ScreenRecordState>,
) -> Result<(), String> {
    eprintln!("[kts:dictation] start_dictation_cmd");
    state
        .custom_dictation_postprocess
        .store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        start_dictation_inner(&app, &state, &sr_state, DictationStartMode::ContextCapture)
    }
    #[cfg(not(target_os = "macos"))]
    {
        start_dictation_inner(&app, &state, &sr_state)
    }
}

#[tauri::command]
pub fn start_dictation_custom_cmd(
    app: tauri::AppHandle,
    state: tauri::State<DictationActiveState>,
    sr_state: tauri::State<ScreenRecordState>,
) -> Result<(), String> {
    eprintln!("[kts:dictation] start_dictation_custom_cmd");
    state
        .custom_dictation_postprocess
        .store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        start_dictation_inner(&app, &state, &sr_state, DictationStartMode::ContextCapture)
    }
    #[cfg(not(target_os = "macos"))]
    {
        start_dictation_inner(&app, &state, &sr_state)
    }
}

#[tauri::command]
pub fn sync_dictation_custom_settings_cmd(
    state: tauri::State<DictationActiveState>,
    model: String,
    prompt_highlight: String,
    prompt_no_highlight: String,
) -> Result<(), String> {
    *state.dictation_custom_model.lock().map_err(|e| e.to_string())? = model;
    *state
        .dictation_custom_prompt_highlight
        .lock()
        .map_err(|e| e.to_string())? = prompt_highlight;
    *state
        .dictation_custom_prompt_no_highlight
        .lock()
        .map_err(|e| e.to_string())? = prompt_no_highlight;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationCustomPromptDefaults {
    prompt_highlight: String,
    prompt_no_highlight: String,
}

#[tauri::command]
pub fn get_dictation_custom_prompt_defaults_cmd() -> DictationCustomPromptDefaults {
    DictationCustomPromptDefaults {
        prompt_highlight: dictation::DEFAULT_DICTATION_CUSTOM_PROMPT_HIGHLIGHT.to_string(),
        prompt_no_highlight: dictation::DEFAULT_DICTATION_CUSTOM_PROMPT_NO_HIGHLIGHT.to_string(),
    }
}

#[tauri::command]
pub fn start_tray_dictation_cmd(
    app: tauri::AppHandle,
    state: tauri::State<DictationActiveState>,
    sr_state: tauri::State<ScreenRecordState>,
) -> Result<(), String> {
    if !dictation_is_functional(&app) {
        let provider = current_dictation_provider(&app);
        if provider == "openai:whisper-1" {
            return Err(
                "Clé API OpenAI manquante. Configurez-la dans Settings → LLM API Key pour utiliser le provider Cloud."
                    .into(),
            );
        }
        let _ = app.emit(whisper_setup::EVT_NOT_INSTALLED, ());
        return Err("Whisper non installé.".into());
    }
    if state.is_processing.load(Ordering::SeqCst) || sr_state.is_processing.load(Ordering::SeqCst) {
        return Err("En traitement.".into());
    }
    if state.is_recording.load(Ordering::SeqCst) {
        return Err("Dictée déjà en cours.".into());
    }
    if sr_state.is_recording.load(Ordering::SeqCst) {
        return Err("Enregistrement écran en cours.".into());
    }
    if sr_state.is_pending.load(Ordering::SeqCst) {
        sr_state.is_pending.store(false, Ordering::SeqCst);
        off_session_focus::clear_screen_record_pending(&app);
        if let Some(hud) = app.get_webview_window("dictation_hud") {
            let _ = hud.hide();
        }
    }
    state.tray_note_mode.store(true, Ordering::SeqCst);
    state
        .custom_dictation_postprocess
        .store(false, Ordering::SeqCst);
    if let Ok(mut guard) = state.initial_selection.lock() {
        *guard = None;
    }
    #[cfg(target_os = "macos")]
    screen_capture_sck::ensure_microphone_access()
        .map_err(|e| {
            let _ = app.emit(dictation::EVT_ERROR, &e);
            e
        })?;
    dictation::start_dictation(&app, &state)?;
    schedule_dictation_auto_stop(&app);
    Ok(())
}

// ── The microphone in the HUD's follow-up chat ────────────────────────────────
//
// Recording and transcription, and none of what dictation usually drags along with them: nothing
// is pasted into the focused application, nothing reaches Copy History or the captures, and no
// model rewrites the words afterwards. The transcript is handed straight back to the window that
// asked for it, which drops it into the box the user is typing in; sending it is still their
// keystroke.
//
// That is why these go to `dictation::start_dictation` and `dictation::stop_and_transcribe`
// directly rather than through `start_dictation_cmd` / `stop_dictation_cmd`: every side effect
// listed above lives in those commands, not in the recording underneath them.

/// Whether the chat can offer a microphone at all — a button that could only fail is not offered.
#[tauri::command]
pub fn hud_chat_mic_available_cmd(app: tauri::AppHandle) -> bool {
    dictation_is_functional(&app)
}

/// Starts recording for the HUD chat's microphone.
///
/// The busy checks are the ones every other entry point makes, against the same shared flags: one
/// microphone, one recording at a time. `warn_hud_busy` is deliberately not called here — the
/// caller *is* the HUD, and it shows the message this returns, so raising a second banner over the
/// same window would say it twice.
#[tauri::command]
pub fn start_hud_chat_mic_cmd(
    app: tauri::AppHandle,
    state: tauri::State<DictationActiveState>,
    sr_state: tauri::State<ScreenRecordState>,
) -> Result<(), String> {
    eprintln!("[kts:dictation] start_hud_chat_mic_cmd");
    if !dictation_is_functional(&app) {
        return Err("Voice input is not set up yet. Add it in Settings → Voice dictation.".into());
    }
    if state.is_processing.load(Ordering::SeqCst) || sr_state.is_processing.load(Ordering::SeqCst) {
        return Err("Still finishing the last recording. Try again in a moment.".into());
    }
    if state.is_recording.load(Ordering::SeqCst) {
        return Err("A dictation is already running.".into());
    }
    if sr_state.is_recording.load(Ordering::SeqCst) {
        return Err("A screen recording is running.".into());
    }
    #[cfg(target_os = "macos")]
    if let Err(e) = screen_capture_sck::ensure_microphone_access() {
        eprintln!("[kts:dictation] hud chat mic: microphone access refused: {e}");
        return Err("Kety cannot reach the microphone. Allow it in System Settings → Privacy & Security → Microphone.".into());
    }
    // Claimed before the recording starts, so there is no instant in which a recording is running
    // that nothing owns and the dictation shortcut could stop on the user's behalf.
    state.hud_chat_mic_mode.store(true, Ordering::SeqCst);
    if let Err(e) = dictation::start_dictation(&app, &state) {
        state.hud_chat_mic_mode.store(false, Ordering::SeqCst);
        eprintln!("[kts:dictation] hud chat mic: start failed: {e}");
        return Err("The recording would not start. Try again.".into());
    }
    Ok(())
}

/// Stops the HUD chat's microphone and returns what was said.
///
/// Async because transcription takes seconds and a blocking command would freeze every window.
/// Whatever happens — a transcription that fails, a recording with no sound in it — the shared
/// flags are left exactly as they were found, so the next dictation is not refused by a state this
/// one forgot to release.
#[tauri::command]
pub async fn stop_hud_chat_mic_cmd(app: tauri::AppHandle) -> Result<String, String> {
    eprintln!("[kts:dictation] stop_hud_chat_mic_cmd");
    let app2 = app.clone();
    let transcribed = tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<DictationActiveState>();
        if !state.hud_chat_mic_mode.load(Ordering::SeqCst) {
            return Err("Nothing is being recorded.".to_string());
        }
        // Held for the whole transcription, not just the recording: whisper runs for seconds
        // afterwards, and a dictation started in that window would fight this one for the model.
        state.is_processing.store(true, Ordering::SeqCst);
        let result = dictation::stop_and_transcribe(&app2, &state);
        state.is_processing.store(false, Ordering::SeqCst);
        state.hud_chat_mic_mode.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| {
        eprintln!("[kts:dictation] hud chat mic: join failed: {e}");
        "That did not come through. Try again.".to_string()
    })?;

    match transcribed {
        Ok(text) => Ok(text.trim().to_string()),
        Err(e) => {
            // The transcription errors are written for the log, not for a text box in a small
            // floating window; the user is told what to do instead of what went wrong.
            eprintln!("[kts:dictation] hud chat mic: {e}");
            Err("That did not come through. Try again.".to_string())
        }
    }
}

#[tauri::command]
pub fn stop_dictation_cmd(
    app: tauri::AppHandle,
    state: tauri::State<DictationActiveState>,
) -> Result<(), String> {
    eprintln!("[kts:dictation] stop_dictation_cmd");
    if state.hud_chat_mic_mode.load(Ordering::SeqCst) {
        // The chat is holding the microphone and expects its own transcript back. Finishing the
        // recording here would send those words to the focused field or to the captures instead.
        return Err("The chat box is recording. Stop it there first.".into());
    }
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("Aucune dictée en cours.".into());
    }
    if !state
        .stop_inflight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        if !state.tray_note_mode.load(Ordering::SeqCst) {
            warn_hud_busy(&app);
        }
        return Ok(());
    }
    let is_tray = state.tray_note_mode.load(Ordering::SeqCst);
    state.is_processing.store(true, Ordering::SeqCst);
    if is_tray {
        if let Some(tn) = app.get_webview_window("tray_note") {
            let _ = tn.emit("kts:tray-note/mic-mode", "processing");
        }
    } else if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.emit("kts:hud/mode", "processing");
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        let dict_state = app2.state::<DictationActiveState>();
        let is_tray = dict_state.tray_note_mode.load(Ordering::SeqCst);
        let is_fn_field = dict_state.fn_field_dictation.load(Ordering::SeqCst);
        let mut inject_candidate: Option<String> = None;
        #[cfg(target_os = "macos")]
        let mut inject_copy_history_fallback = false;
        #[cfg(target_os = "macos")]
        let mut inject_highlights_note: Option<String> = None;
        // The request the custom model answered, when one ran — what a follow-up chat resumes.
        #[cfg(target_os = "macos")]
        let mut dictation_chat_prompt: Option<String> = None;
        let mut play_dictation_saved_sound = false;

        let result = match dictation::stop_and_transcribe(&app2, &*dict_state) {
            Ok(raw_text) => {
                let custom_on = dict_state
                    .custom_dictation_postprocess
                    .load(Ordering::SeqCst);
                let saved_highlights = dict_state
                    .initial_selection
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(|s| s.clone()))
                    .unwrap_or_default();

                let post = apply_dictation_custom_post_if_needed(&app2, &*dict_state, raw_text);
                #[cfg(target_os = "macos")]
                {
                    dictation_chat_prompt = post.chat_prompt;
                }
                let text = post.text;
                if is_tray {
                    if let Some(tn) = app2.get_webview_window("tray_note") {
                        let _ = tn.emit("kts:tray-note/dictation-result", &text);
                    }
                    if !text.trim().is_empty() {
                        play_dictation_saved_sound = true;
                    }
                    Ok(())
                } else {
                    #[cfg(target_os = "macos")]
                    let inject_mode = dict_state.inject_into_field.load(Ordering::SeqCst);
                    #[cfg(not(target_os = "macos"))]
                    let inject_mode = false;

                    if inject_mode && !text.trim().is_empty() {
                        inject_candidate = Some(text);
                        Ok(())
                    } else if custom_on && !text.trim().is_empty() {
                        #[cfg(target_os = "macos")]
                        {
                            inject_copy_history_fallback = true;
                            inject_highlights_note = if saved_highlights.trim().is_empty() {
                                None
                            } else {
                                Some(saved_highlights)
                            };
                            inject_candidate = Some(text);
                            let _ = dict_state
                                .initial_selection
                                .lock()
                                .ok()
                                .and_then(|mut g| g.take());
                            Ok(())
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            let hl = dict_state
                                .initial_selection
                                .lock()
                                .ok()
                                .and_then(|mut g| g.take())
                                .unwrap_or_default();
                            let expl = {
                                let t = hl.trim();
                                (!t.is_empty()).then(|| t.to_string())
                            };
                            let dict_lang = dict_state
                                .lang
                                .lock()
                                .ok()
                                .map(|g| g.clone())
                                .filter(|s| !s.trim().is_empty());
                            let dispatch_r = dispatch_context_note(
                                &app2,
                                &text,
                                expl,
                                ContextNoteSource::CopyHistory,
                                dict_lang,
                            );
                            if dispatch_r.is_ok() {
                                play_dictation_saved_sound = true;
                                let _ = app2.emit(crate::DICTATION_FIELD_INJECT_EVENT, text.as_str());
                            }
                            dispatch_r
                        }
                    } else {
                        let sel = dict_state
                            .initial_selection
                            .lock()
                            .ok()
                            .and_then(|mut g| g.take());
                        let (final_text, explanation) = match sel {
                            Some(s) if !s.trim().is_empty() && !text.is_empty() => {
                                (s, Some(text))
                            }
                            _ => (text, None),
                        };
                        if final_text.trim().is_empty() {
                            eprintln!("[kts:dictation] transcription vide - rien dispatché");
                            Ok(())
                        } else {
                            eprintln!("[kts:dictation] dispatch contexte : {final_text:?}");
                            let dict_lang = dict_state
                                .lang
                                .lock()
                                .ok()
                                .map(|g| g.clone())
                                .filter(|s| !s.trim().is_empty());
                            let dispatch_r = dispatch_context_note(
                                &app2,
                                &final_text,
                                explanation,
                                ContextNoteSource::Dictation,
                                dict_lang,
                            );
                            if dispatch_r.is_ok() {
                                play_dictation_saved_sound = true;
                            }
                            dispatch_r
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("[kts:dictation] stop_and_transcribe ERREUR: {e}");
                let _ = app2.emit(dictation::EVT_ERROR, &e);
                Err(e)
            }
        };
        dict_state.is_processing.store(false, Ordering::SeqCst);
        dict_state.stop_inflight.store(false, Ordering::SeqCst);
        dict_state.tray_note_mode.store(false, Ordering::SeqCst);
        dict_state.inject_into_field.store(false, Ordering::SeqCst);
        dict_state.fn_field_dictation.store(false, Ordering::SeqCst);
        if is_tray {
            if let Some(tn) = app2.get_webview_window("tray_note") {
                let _ = tn.emit("kts:tray-note/mic-mode", "idle");
            }
        } else {
            if let Some(presenter) = app2.try_state::<crate::HudPresenterState>() {
                presenter.suppress_next_reopen.store(true, Ordering::SeqCst);
            }
            if let Some(hud) = app2.get_webview_window("dictation_hud") {
                let _ = hud.hide();
            }
            #[cfg(target_os = "macos")]
            reactivate_previous_frontmost(&app2);
            restore_main_window_visibility(&app2);

            #[cfg(target_os = "macos")]
            if let Some(ref txt) = inject_candidate {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let fail_expl = if inject_copy_history_fallback {
                    inject_highlights_note.as_ref().and_then(|h| {
                        let t = h.trim();
                        (!t.is_empty()).then(|| t.to_string())
                    })
                } else {
                    None
                };
                let fail_src = if inject_copy_history_fallback {
                    ContextNoteSource::CopyHistory
                } else {
                    ContextNoteSource::Dictation
                };
                let ax_role = crate::macos_ax_selection::focused_ui_ax_role()
                    .unwrap_or_else(|| "(unknown)".to_string());
                eprintln!(
                    "[kts:dictation] field inject: attempting clipboard + ⌘V (focused AX role: {ax_role})"
                );
                if crate::macos_ax_selection::insert_text_via_paste(txt) {
                    let _ = app2.emit(crate::DICTATION_FIELD_INJECT_EVENT, txt.as_str());
                    play_dictation_saved_sound = true;
                } else {
                    let dest = describe_dictation_note_dispatch_target(&app2, fail_src);
                    eprintln!(
                        "[kts:dictation] field inject: clipboard/⌘V path failed; fallback → {dest}"
                    );
                    if dispatch_context_note(&app2, txt, fail_expl.clone(), fail_src, None).is_ok() {
                        play_dictation_saved_sound = true;
                    }
                    if is_fn_field && !txt.trim().is_empty() {
                        let _ = app2.emit(crate::DICTATION_FIELD_INJECT_EVENT, txt.as_str());
                    }
                    if inject_copy_history_fallback && !txt.trim().is_empty() {
                        let _ = app2.emit(crate::DICTATION_FIELD_INJECT_EVENT, txt.as_str());
                    }
                }

                // Whatever happened above - pasted into the focused field, or saved as a note
                // because no field would take it - the text is also shown in the HUD so the
                // user can read it and copy it. Comes last on purpose: the hide, the
                // reactivation and the paste must be over before the HUD comes back.
                // When a custom model wrote this text, its prompt travels with it so the user
                // can reopen the exchange and ask for something better.
                //
                // Wherever the recording HUD was: `transform_result_placement` reads back the
                // placement that was actually applied when the dictation started. A custom
                // dictation on a selection was anchored beside the text, and its answer belongs
                // in the same place — an answer that appears at the far edge of the screen is one
                // the user has to go and find. Everything else was at the bottom of the screen and
                // stays there. Deriving it rather than deciding it again is what keeps the result
                // from jumping across the display when it arrives.
                crate::hud_commands::show_hud_result(
                    &app2,
                    txt,
                    "Dictation",
                    dictation_chat_prompt.as_deref(),
                    crate::hud_commands::transform_result_placement(&app2),
                );
            }
        }
        if play_dictation_saved_sound {
            crate::play_context_success_sound();
        }
        if let Err(e) = result {
            eprintln!("[kts:dictation] (arrière-plan) {e}");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn pause_dictation_cmd(
    app: tauri::AppHandle,
    state: tauri::State<DictationActiveState>,
) -> Result<(), String> {
    dictation::pause_dictation(&state)?;
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.emit("kts:hud/mode", "dictation-paused");
    }
    Ok(())
}

#[tauri::command]
pub fn resume_dictation_cmd(
    app: tauri::AppHandle,
    state: tauri::State<DictationActiveState>,
) -> Result<(), String> {
    dictation::resume_dictation(&state)?;
    if let Some(hud) = app.get_webview_window("dictation_hud") {
        let _ = hud.emit("kts:hud/mode", "dictation");
    }
    Ok(())
}

#[tauri::command]
pub fn set_dictation_lang_cmd(
    lang: String,
    state: tauri::State<DictationActiveState>,
) -> Result<(), String> {
    eprintln!("[kts:dictation] langue → {lang}");
    *state.lang.lock().map_err(|e| e.to_string())? = lang;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_llm::{with_output_only_rule, OUTPUT_ONLY_RULE};

    #[test]
    fn template_placeholders_are_filled() {
        let out = fill_dictation_custom_template(
            dictation::DEFAULT_DICTATION_CUSTOM_PROMPT_HIGHLIGHT,
            "translate this",
            "the reader is French",
        );
        assert!(out.contains("translate this"));
        assert!(out.contains("the reader is French"));
        assert!(!out.contains("{{DICTATION_TEXT}}"));
        assert!(!out.contains("{{HIGHLIGHTS}}"));
    }

    #[test]
    fn a_saved_template_without_the_rule_still_gets_it() {
        // The case that matters: someone edited their template long before the rule existed.
        let saved = "Turn this into a polite email:\n\n{{DICTATION_TEXT}}";
        let prompt = with_output_only_rule(&fill_dictation_custom_template(saved, "call me back", ""));
        assert!(prompt.starts_with("Turn this into a polite email:\n\ncall me back"));
        assert!(prompt.ends_with(OUTPUT_ONLY_RULE));
        assert_eq!(prompt.matches(OUTPUT_ONLY_RULE).count(), 1);
    }

    #[test]
    fn custom_dictation_on_a_selection_is_placed_beside_the_text() {
        // The shape the user described as "a bit like a custom transform": the HUD has somewhere
        // to be, and it is next to what they highlighted.
        assert_eq!(dictation_hud_placement(true, true), HudPlacement::Pointer);
    }

    #[test]
    fn custom_dictation_without_a_selection_is_ordinary_dictation() {
        assert_eq!(
            dictation_hud_placement(true, false),
            HudPlacement::BottomCenter
        );
    }

    #[test]
    fn plain_dictation_stays_at_the_bottom_whatever_was_selected() {
        // A selection during a plain dictation is not a thing the transcript is *about* — it is
        // prepended to it as context. Nothing to be beside.
        assert_eq!(
            dictation_hud_placement(false, true),
            HudPlacement::BottomCenter
        );
        assert_eq!(
            dictation_hud_placement(false, false),
            HudPlacement::BottomCenter
        );
    }

    #[test]
    fn a_selection_of_blanks_does_not_count_as_a_selection() {
        // The same rule `apply_dictation_custom_post_if_needed` uses to choose a prompt template:
        // the placement and the prompt must agree on whether there is a selection at all.
        let state = DictationActiveState::new();
        assert!(!dictation_has_selection(&state));

        *state.initial_selection.lock().unwrap() = Some("   \n\t ".to_string());
        assert!(!dictation_has_selection(&state));

        *state.initial_selection.lock().unwrap() = Some("the paragraph".to_string());
        assert!(dictation_has_selection(&state));
    }

    #[test]
    fn the_default_template_is_not_told_the_rule_twice() {
        let prompt = with_output_only_rule(&fill_dictation_custom_template(
            dictation::DEFAULT_DICTATION_CUSTOM_PROMPT_NO_HIGHLIGHT,
            "call me back",
            "",
        ));
        assert_eq!(prompt.matches(OUTPUT_ONLY_RULE).count(), 1);
        assert!(prompt.ends_with(OUTPUT_ONLY_RULE));
    }
}
