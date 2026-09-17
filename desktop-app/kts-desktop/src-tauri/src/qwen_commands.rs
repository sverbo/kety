//! Qwen local model management commands (check, download, cancel, remove, set).

use tauri::Manager;

use crate::{kety_paths, qwen_setup, QwenLocalModelState};

// ── State ─────────────────────────────────────────────────────────────────────

pub(crate) struct QwenActiveDownload {
    pub pid: u32,
    pub tmp_path: std::path::PathBuf,
    pub model_id: String,
}
pub(crate) struct QwenDownloadState(pub std::sync::Mutex<Option<QwenActiveDownload>>);

// ── Response types ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QwenModelStatus {
    id: &'static str,
    filename: &'static str,
    label: &'static str,
    size_label: &'static str,
    installed: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenModelsStatus {
    selected_model: String,
    models: Vec<QwenModelStatus>,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_qwen_models_cmd(app: tauri::AppHandle) -> QwenModelsStatus {
    let selected = crate::current_qwen_model(&app);
    let installed = kety_paths::list_installed_qwen_models(&app);
    let installed_set: std::collections::HashSet<&str> =
        installed.iter().map(|s| s.as_str()).collect();

    let models = qwen_setup::MODELS
        .iter()
        .map(|m| QwenModelStatus {
            id: m.id,
            filename: m.filename,
            label: m.label,
            size_label: m.size_label,
            installed: installed_set.contains(m.filename),
        })
        .collect();

    QwenModelsStatus { selected_model: selected, models }
}

#[tauri::command]
pub fn download_qwen_model_cmd(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let model_id2 = model_id.clone();
        let app2 = app.clone();
        let result = qwen_setup::download_model(&app, &model_id, move |pid, tmp| {
            if let Some(state) = app2.try_state::<QwenDownloadState>() {
                if let Ok(mut g) = state.0.lock() {
                    *g = Some(QwenActiveDownload { pid, tmp_path: tmp, model_id: model_id2 });
                }
            }
        });

        match result {
            Ok(()) => {
                if let Some(state) = app.try_state::<QwenDownloadState>() {
                    let _ = state.0.lock().map(|mut g| g.take());
                }
                if crate::current_qwen_model(&app).is_empty() {
                    if let Some(info) = qwen_setup::model_by_id(&model_id) {
                        if let Some(st) = app.try_state::<QwenLocalModelState>() {
                            if let Ok(mut g) = st.0.lock() {
                                *g = info.filename.to_string();
                            }
                        }
                    }
                }
                let _ = tauri::Emitter::emit(&app, qwen_setup::EVT_DOWNLOAD_DONE, &model_id);
            }
            Err(e) => {
                let was_cancelled = app
                    .try_state::<QwenDownloadState>()
                    .and_then(|s| s.0.lock().ok().map(|mut g| g.take().is_none()))
                    .unwrap_or(false);
                if !was_cancelled {
                    let _ = tauri::Emitter::emit(
                        &app,
                        qwen_setup::EVT_DOWNLOAD_ERROR,
                        serde_json::json!({"modelId": model_id, "error": e}),
                    );
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_qwen_download_cmd(app: tauri::AppHandle) -> Result<(), String> {
    let active = app
        .try_state::<QwenDownloadState>()
        .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take()));

    if let Some(active) = active {
        let _ = std::process::Command::new("kill")
            .args(["-15", &active.pid.to_string()])
            .status();
        let _ = std::fs::remove_file(&active.tmp_path);
        let _ = tauri::Emitter::emit(
            &app,
            qwen_setup::EVT_DOWNLOAD_CANCELLED,
            serde_json::json!({"modelId": active.model_id}),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn remove_qwen_model_cmd(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    qwen_setup::remove_model(&app, &filename)?;
    Ok(())
}

#[tauri::command]
pub fn set_qwen_local_model_cmd(
    filename: String,
    state: tauri::State<QwenLocalModelState>,
) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = filename;
    Ok(())
}
