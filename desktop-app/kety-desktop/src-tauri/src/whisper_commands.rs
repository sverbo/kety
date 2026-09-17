//! Whisper model management Tauri commands (check, download, cancel, remove, set, provider).

use tauri::Manager;

use crate::{
    dictation_commands::current_model,
    tray_commands::refresh_dictation_state,
    kety_paths, whisper_setup, DictationActiveState,
};

// ── State types ───────────────────────────────────────────────────────────────

pub(crate) struct ActiveDownload {
    pub pid: u32,
    pub tmp_path: std::path::PathBuf,
    pub model_id: String,
}
pub(crate) struct DownloadState(pub std::sync::Mutex<Option<ActiveDownload>>);

// ── Response types ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WhisperModelStatus {
    id: &'static str,
    filename: &'static str,
    label: &'static str,
    size_label: &'static str,
    installed: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperStatus {
    cli: bool,
    selected_model: String,
    models: Vec<WhisperModelStatus>,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_whisper_cmd(app: tauri::AppHandle) -> WhisperStatus {
    let cli = kety_paths::whisper_bin_path(&app).exists();
    let selected = current_model(&app);
    let installed = kety_paths::list_installed_models(&app);
    let installed_set: std::collections::HashSet<&str> =
        installed.iter().map(|s| s.as_str()).collect();

    let models = whisper_setup::MODELS
        .iter()
        .map(|m| WhisperModelStatus {
            id: m.id,
            filename: m.filename,
            label: m.label,
            size_label: m.size_label,
            installed: installed_set.contains(m.filename),
        })
        .collect();

    WhisperStatus { cli, selected_model: selected, models }
}

#[tauri::command]
pub fn download_whisper_cmd(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let model_id2 = model_id.clone();
        let app2 = app.clone();
        let result = whisper_setup::download_model(&app, &model_id, move |pid, tmp| {
            if let Some(state) = app2.try_state::<DownloadState>() {
                if let Ok(mut g) = state.0.lock() {
                    *g = Some(ActiveDownload { pid, tmp_path: tmp, model_id: model_id2 });
                }
            }
        });

        match result {
            Ok(()) => {
                if let Some(state) = app.try_state::<DownloadState>() {
                    let _ = state.0.lock().map(|mut g| g.take());
                }
                if current_model(&app).is_empty() {
                    if let Some(info) = whisper_setup::model_by_id(&model_id) {
                        if let Some(state) = app.try_state::<DictationActiveState>() {
                            if let Ok(mut g) = state.model.lock() {
                                *g = info.filename.to_string();
                            }
                        }
                    }
                }
                refresh_dictation_state(&app);
                let _ = tauri::Emitter::emit(&app, whisper_setup::EVT_DOWNLOAD_DONE, &model_id);
            }
            Err(e) => {
                let was_cancelled = app.try_state::<DownloadState>()
                    .and_then(|s| s.0.lock().ok().map(|mut g| g.take().is_none()))
                    .unwrap_or(false);
                if !was_cancelled {
                    let _ = tauri::Emitter::emit(
                        &app,
                        whisper_setup::EVT_DOWNLOAD_ERROR,
                        serde_json::json!({"modelId": model_id, "error": e}),
                    );
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_whisper_download_cmd(app: tauri::AppHandle) -> Result<(), String> {
    let active = app.try_state::<DownloadState>()
        .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take()));

    if let Some(active) = active {
        let _ = std::process::Command::new("kill")
            .args(["-15", &active.pid.to_string()])
            .status();
        let _ = std::fs::remove_file(&active.tmp_path);
        let _ = tauri::Emitter::emit(
            &app,
            whisper_setup::EVT_DOWNLOAD_CANCELLED,
            serde_json::json!({"modelId": active.model_id}),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn remove_whisper_cmd(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    whisper_setup::remove_model(&app, &filename)?;
    refresh_dictation_state(&app);
    Ok(())
}

#[tauri::command]
pub fn set_whisper_model_cmd(
    app: tauri::AppHandle,
    filename: String,
    state: tauri::State<DictationActiveState>,
) -> Result<(), String> {
    *state.model.lock().map_err(|e| e.to_string())? = filename;
    refresh_dictation_state(&app);
    Ok(())
}

#[tauri::command]
pub fn set_dictation_provider_cmd(
    app: tauri::AppHandle,
    state: tauri::State<DictationActiveState>,
    provider: String,
    openai_api_key: Option<String>,
) -> Result<(), String> {
    let provider = provider.trim().to_string();
    if provider != "local" && provider != "openai:whisper-1" {
        return Err(format!("Provider de dictée inconnu : {provider}"));
    }
    *state.provider.lock().map_err(|e| e.to_string())? = provider;
    *state.openai_api_key.lock().map_err(|e| e.to_string())? =
        openai_api_key.unwrap_or_default();
    refresh_dictation_state(&app);
    Ok(())
}
