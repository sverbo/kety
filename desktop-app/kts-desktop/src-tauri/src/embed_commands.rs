//! Embed model management commands (check, download, cancel, remove, set active).

use tauri::Manager;

use crate::{embed_setup, kety_paths, local_index};

// ── State ─────────────────────────────────────────────────────────────────────

pub(crate) struct EmbedActiveDownload {
    pub pid: u32,
    pub tmp_path: std::path::PathBuf,
    pub model_id: String,
}
pub(crate) struct EmbedDownloadState(pub std::sync::Mutex<Option<EmbedActiveDownload>>);

// ── Response types ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmbedModelStatusOut {
    id: &'static str,
    filename: &'static str,
    label: &'static str,
    size_label: &'static str,
    dim: u32,
    installed: bool,
    is_open_ai: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedModelsStatusOut {
    active_model: String,
    active_dim: u32,
    models: Vec<EmbedModelStatusOut>,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_embed_models_cmd(
    app: tauri::AppHandle,
    user_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> EmbedModelsStatusOut {
    let installed = kety_paths::list_installed_embed_models(&app);
    let installed_set: std::collections::HashSet<&str> = installed.iter().map(|s| s.as_str()).collect();

    let mut models: Vec<EmbedModelStatusOut> = embed_setup::MODELS
        .iter()
        .map(|m| EmbedModelStatusOut {
            id: m.id,
            filename: m.filename,
            label: m.label,
            size_label: m.size_label,
            dim: m.dim,
            installed: installed_set.contains(m.filename),
            is_open_ai: false,
        })
        .collect();

    models.push(EmbedModelStatusOut {
        id: embed_setup::OPENAI_EMBED_MODEL_ID,
        filename: "",
        label: "OpenAI text-embedding-3-small",
        size_label: "API",
        dim: embed_setup::OPENAI_EMBED_DIM,
        installed: true,
        is_open_ai: true,
    });

    let (active_model, active_dim) = user_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|uid| {
            index.0.lock().ok().and_then(|mut guard| {
                let c = guard.get_for(&app, uid, None).ok()?;
                let model: String = c.query_row("SELECT value FROM meta WHERE key='active_embed_model'", [], |r| r.get(0)).ok()?;
                let dim: u32 = c.query_row("SELECT value FROM meta WHERE key='active_embed_dim'", [], |r| {
                    r.get::<_, String>(0).map(|s| s.parse::<u32>().unwrap_or(0))
                }).ok()?;
                Some((model, dim))
            })
        })
        .unwrap_or_default();

    EmbedModelsStatusOut { active_model, active_dim, models }
}

#[tauri::command]
pub fn download_embed_model_cmd(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let model_id2 = model_id.clone();
        let app2 = app.clone();
        let result = embed_setup::download_model(&app, &model_id, move |pid, tmp| {
            if let Some(state) = app2.try_state::<EmbedDownloadState>() {
                if let Ok(mut g) = state.0.lock() {
                    *g = Some(EmbedActiveDownload { pid, tmp_path: tmp, model_id: model_id2 });
                }
            }
        });
        match result {
            Ok(()) => {
                if let Some(state) = app.try_state::<EmbedDownloadState>() {
                    let _ = state.0.lock().map(|mut g| g.take());
                }
                let _ = tauri::Emitter::emit(&app, embed_setup::EVT_DOWNLOAD_DONE, &model_id);
            }
            Err(e) => {
                let was_cancelled = app
                    .try_state::<EmbedDownloadState>()
                    .and_then(|s| s.0.lock().ok().map(|mut g| g.take().is_none()))
                    .unwrap_or(false);
                if !was_cancelled {
                    let _ = tauri::Emitter::emit(&app, embed_setup::EVT_DOWNLOAD_ERROR,
                        serde_json::json!({"modelId": model_id, "error": e}));
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_embed_download_cmd(app: tauri::AppHandle) -> Result<(), String> {
    let active = app
        .try_state::<EmbedDownloadState>()
        .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take()));
    if let Some(active) = active {
        let _ = std::process::Command::new("kill").args(["-15", &active.pid.to_string()]).status();
        let _ = std::fs::remove_file(&active.tmp_path);
        let _ = tauri::Emitter::emit(&app, embed_setup::EVT_DOWNLOAD_CANCELLED, serde_json::json!({"modelId": active.model_id}));
    }
    Ok(())
}

#[tauri::command]
pub fn remove_embed_model_cmd(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    embed_setup::remove_model(&app, &filename)
}

#[tauri::command]
pub fn set_active_embed_model_cmd(
    app: tauri::AppHandle,
    model_id: String,
    user_id: String,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<(), String> {
    let dim = embed_setup::dim_for_model_id(&model_id)
        .ok_or_else(|| format!("Unknown embed model: {model_id}"))?;
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    local_index::set_active_embed_model(conn, &model_id, dim)
}
