//! Qwen3-Embedding GGUF model download helpers (local embedding for RAG).
//!
//! Uses the same HF mirror mechanism as qwen_setup.rs.
//! Set `QWEN_MODEL_BASE_URL` to point at a mirror (shared with Qwen instruct models).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::Emitter;

pub const EVT_DOWNLOAD_PROGRESS: &str = "kts:embed/download-progress";
pub const EVT_DOWNLOAD_DONE: &str = "kts:embed/download-done";
pub const EVT_DOWNLOAD_ERROR: &str = "kts:embed/download-error";
pub const EVT_DOWNLOAD_CANCELLED: &str = "kts:embed/download-cancelled";

const MODEL_ROOT: &str = match option_env!("QWEN_MODEL_BASE_URL") {
    Some(u) => u,
    None => "https://huggingface.co",
};

pub struct EmbedModelInfo {
    pub id: &'static str,
    pub hf_repo: &'static str,
    pub filename: &'static str,
    pub label: &'static str,
    pub size_label: &'static str,
    pub approx_bytes: u64,
    /// Output embedding dimension (determines which vec_N table to use).
    pub dim: u32,
}

pub const MODELS: &[EmbedModelInfo] = &[
    EmbedModelInfo {
        id: "qwen3-embed-0.6b-q8",
        hf_repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
        filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
        label: "Qwen3-Embedding 0.6B (Q8)",
        size_label: "~660 MB",
        approx_bytes: 691_000_000,
        dim: 1024,
    },
    EmbedModelInfo {
        id: "qwen3-embed-4b-q4km",
        hf_repo: "Qwen/Qwen3-Embedding-4B-GGUF",
        filename: "Qwen3-Embedding-4B-Q4_K_M.gguf",
        label: "Qwen3-Embedding 4B (Q4_K_M)",
        size_label: "~2.5 GB",
        approx_bytes: 2_680_000_000,
        dim: 2560,
    },
];

/// Sentinel for the OpenAI embedding option — not a local GGUF, never downloaded.
pub const OPENAI_EMBED_MODEL_ID: &str = "openai:text-embedding-3-small";
pub const OPENAI_EMBED_DIM: u32 = 1536;

pub fn model_url(repo: &str, filename: &str) -> String {
    format!("{MODEL_ROOT}/{repo}/resolve/main/{filename}")
}

pub fn model_by_id(id: &str) -> Option<&'static EmbedModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn dim_for_model_id(id: &str) -> Option<u32> {
    if id == OPENAI_EMBED_MODEL_ID {
        return Some(OPENAI_EMBED_DIM);
    }
    model_by_id(id).map(|m| m.dim)
}

pub fn download_model<F: FnOnce(u32, std::path::PathBuf)>(
    app: &tauri::AppHandle,
    model_id: &str,
    on_spawned: F,
) -> Result<(), String> {
    let info = model_by_id(model_id).ok_or_else(|| format!("Unknown embed model: {model_id}"))?;

    let dest = crate::kety_paths::embed_model_dest(app, info.filename)?;
    let tmp = dest.with_extension("gguf.part");

    let _ = app.emit(
        EVT_DOWNLOAD_PROGRESS,
        serde_json::json!({ "modelId": model_id, "phase": "starting" }),
    );

    let url = model_url(info.hf_repo, info.filename);

    let mut child = std::process::Command::new("curl")
        .args(["-L", "-f", "-o", tmp.to_str().ok_or("invalid path")?, &url])
        .spawn()
        .map_err(|e| format!("curl: {e}"))?;

    on_spawned(child.id(), tmp.clone());

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = Arc::clone(&stop);
    let app2 = app.clone();
    let tmp2 = tmp.clone();
    let id = model_id.to_string();
    let url2 = url.clone();
    let approx_bytes = info.approx_bytes;

    std::thread::spawn(move || {
        let total: u64 = std::process::Command::new("curl")
            .args(["-sL", "--head", "--max-time", "15", "-D", "/dev/null", "-w", "%{content_length}", &url2])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(approx_bytes);

        while !stop2.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if stop2.load(Ordering::SeqCst) { break; }
            let downloaded = tmp2.metadata().map(|m| m.len()).unwrap_or(0);
            let percent = if total > 0 { (downloaded * 100 / total) as u8 } else { 0 };
            let _ = app2.emit(
                EVT_DOWNLOAD_PROGRESS,
                serde_json::json!({
                    "modelId": id,
                    "phase": "downloading",
                    "downloaded": downloaded,
                    "total": total,
                    "percent": percent,
                }),
            );
        }
    });

    let status = child.wait().map_err(|e| e.to_string())?;
    stop.store(true, Ordering::SeqCst);

    if !status.success() {
        std::fs::remove_file(&tmp).ok();
        return Err(format!("Download failed for embed model '{model_id}'."));
    }

    std::fs::rename(&tmp, &dest).map_err(|e| format!("rename .part → .gguf: {e}"))?;
    Ok(())
}

pub fn remove_model(app: &tauri::AppHandle, filename: &str) -> Result<(), String> {
    if let Ok(p) = crate::kety_paths::embed_model_dest(app, filename) {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("remove {filename}: {e}"))?;
        }
    }
    Ok(())
}
