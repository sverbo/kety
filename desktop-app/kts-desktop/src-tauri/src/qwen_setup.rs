//! Qwen2.5 GGUF model download helpers (Local LM weights for future on-device use).
//!
//! Default source: official `Qwen/*-Instruct-GGUF` repos on Hugging Face (`…/resolve/main/…`).
//! Set `QWEN_MODEL_BASE_URL` at build time to point at a mirror that keeps the same path layout:
//!   `{QWEN_MODEL_BASE_URL}/{repo}/resolve/main/{filename}`
//! Example mirror root: `https://huggingface.co` or `https://your-cdn.example.com/hf-mirror`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::Emitter;

pub const EVT_DOWNLOAD_PROGRESS: &str = "kts:qwen/download-progress";
pub const EVT_DOWNLOAD_DONE: &str = "kts:qwen/download-done";
pub const EVT_DOWNLOAD_ERROR: &str = "kts:qwen/download-error";
pub const EVT_DOWNLOAD_CANCELLED: &str = "kts:qwen/download-cancelled";

/// Hugging Face origin (or CDN root) without trailing slash.
const MODEL_ROOT: &str = match option_env!("QWEN_MODEL_BASE_URL") {
    Some(u) => u,
    None => "https://huggingface.co",
};

pub struct ModelInfo {
    pub id: &'static str,
    /// Repo path segment (org/name), e.g. `Qwen/Qwen2.5-0.5B-Instruct-GGUF`.
    pub hf_repo: &'static str,
    pub filename: &'static str,
    pub label: &'static str,
    pub size_label: &'static str,
    pub approx_bytes: u64,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "qwen25-0.5b-q4km",
        hf_repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
        label: "Qwen2.5 0.5B (Q4_K_M)",
        size_label: "~470 MB",
        approx_bytes: 491_400_032,
    },
    ModelInfo {
        id: "qwen25-1.5b-q4km",
        hf_repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        label: "Qwen2.5 1.5B (Q4_K_M)",
        size_label: "~1.0 GB",
        approx_bytes: 1_117_320_736,
    },
    ModelInfo {
        id: "qwen25-3b-q6k",
        hf_repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
        filename: "qwen2.5-3b-instruct-q6_k.gguf",
        label: "Qwen2.5 3B (Q6_K)",
        size_label: "~2.6 GB",
        approx_bytes: 2_793_410_976,
    },
];

pub fn model_url(repo: &str, filename: &str) -> String {
    format!("{MODEL_ROOT}/{repo}/resolve/main/{filename}")
}

pub fn model_by_id(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

/// Downloads a catalog model into `app-local-data/kts/qwen/models/`.
pub fn download_model<F: FnOnce(u32, std::path::PathBuf)>(
    app: &tauri::AppHandle,
    model_id: &str,
    on_spawned: F,
) -> Result<(), String> {
    let info = model_by_id(model_id).ok_or_else(|| format!("Unknown Qwen model: {model_id}"))?;

    let dest = crate::kety_paths::qwen_model_dest(app, info.filename)?;
    let tmp = dest.with_extension("gguf.part");

    let _ = app.emit(
        EVT_DOWNLOAD_PROGRESS,
        serde_json::json!({
            "modelId": model_id,
            "phase": "starting",
        }),
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
            if stop2.load(Ordering::SeqCst) {
                break;
            }
            let downloaded = tmp2.metadata().map(|m| m.len()).unwrap_or(0);
            let percent = if total > 0 {
                (downloaded * 100 / total) as u8
            } else {
                0
            };
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
        return Err(format!("Download failed for model '{model_id}'."));
    }

    std::fs::rename(&tmp, &dest).map_err(|e| format!("rename .part → .gguf: {e}"))?;
    Ok(())
}

pub fn remove_model(app: &tauri::AppHandle, filename: &str) -> Result<(), String> {
    if let Ok(p) = crate::kety_paths::qwen_model_dest(app, filename) {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("remove {filename}: {e}"))?;
        }
    }
    Ok(())
}
