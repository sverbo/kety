//! Whisper model download helpers and model catalog.
//! whisper-cli is bundled in the .app and does not need to be downloaded.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::Emitter;

// ── Events emitted to the frontend ───────────────────────────────────────────

pub const EVT_DOWNLOAD_PROGRESS: &str = "kts:whisper/download-progress";
pub const EVT_DOWNLOAD_DONE: &str = "kts:whisper/download-done";
pub const EVT_DOWNLOAD_ERROR: &str = "kts:whisper/download-error";
pub const EVT_DOWNLOAD_CANCELLED: &str = "kts:whisper/download-cancelled";
/// Emitted when the user tries to start dictation but no model is installed.
pub const EVT_NOT_INSTALLED: &str = "kts:whisper/not-installed";

// ── Model catalog ─────────────────────────────────────────────────────────────

/// Base URL for model downloads.
/// Set `WHISPER_MODEL_BASE_URL` at build time to point to your own bucket:
///   WHISPER_MODEL_BASE_URL=https://storage.googleapis.com/your-bucket/whisper-models cargo tauri build
/// Falls back to the official HuggingFace mirror if not set.
const MODEL_BASE_URL: &str = match option_env!("WHISPER_MODEL_BASE_URL") {
    Some(u) => u,
    None => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main",
};

pub struct ModelInfo {
    /// Short identifier used in commands (e.g. "medium").
    pub id: &'static str,
    /// Filename on disk and in the CDN bucket (e.g. "ggml-medium.bin").
    pub filename: &'static str,
    /// Human-readable label shown in the UI.
    pub label: &'static str,
    /// Approximate size shown in the UI.
    pub size_label: &'static str,
    /// Approximate file size in bytes - used as progress fallback when the server
    /// does not return a Content-Length header (e.g. chunked transfer encoding).
    pub approx_bytes: u64,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo { id: "tiny",     filename: "ggml-tiny.bin",     label: "Tiny",     size_label: "~75 MB",   approx_bytes:    75_000_000 },
    ModelInfo { id: "base",     filename: "ggml-base.bin",     label: "Base",     size_label: "~142 MB",  approx_bytes:   142_000_000 },
    ModelInfo { id: "small",    filename: "ggml-small.bin",    label: "Small",    size_label: "~244 MB",  approx_bytes:   244_000_000 },
    ModelInfo { id: "medium",   filename: "ggml-medium.bin",   label: "Medium",   size_label: "~1.5 GB",  approx_bytes: 1_500_000_000 },
    ModelInfo { id: "large-v3", filename: "ggml-large-v3.bin", label: "Large v3", size_label: "~3.1 GB",  approx_bytes: 3_100_000_000 },
];

/// Constructs the download URL for a model (base URL + "/" + filename).
pub fn model_url(filename: &str) -> String {
    format!("{MODEL_BASE_URL}/{filename}")
}

pub fn model_by_id(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

// ── Download ──────────────────────────────────────────────────────────────────

/// Downloads a model by its catalog ID into app-local-data/whisper/models/.
/// Emits progress events every 2 s. Runs synchronously - call from a background thread.
///
/// `on_spawned(pid, tmp_path)` is called immediately after curl is spawned (before wait),
/// allowing the caller to store the PID for cancellation.
pub fn download_model<F: FnOnce(u32, std::path::PathBuf)>(
    app: &tauri::AppHandle,
    model_id: &str,
    on_spawned: F,
) -> Result<(), String> {
    let info = model_by_id(model_id)
        .ok_or_else(|| format!("Modèle inconnu : {model_id}"))?;

    let dest = crate::kety_paths::whisper_model_dest(app, info.filename)?;
    let tmp = dest.with_extension("bin.part");

    let _ = app.emit(
        EVT_DOWNLOAD_PROGRESS,
        serde_json::json!({
            "modelId": model_id,
            "phase": "starting",
        }),
    );

    let url = model_url(info.filename);

    // Spawn curl as a child so we can monitor progress concurrently.
    let mut child = std::process::Command::new("curl")
        .args(["-L", "-f", "-o", tmp.to_str().ok_or("invalid path")?, &url])
        .spawn()
        .map_err(|e| format!("curl: {e}"))?;

    // Notify caller of the PID before blocking on wait().
    on_spawned(child.id(), tmp.clone());

    // Background thread: poll file size and emit progress events.
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = Arc::clone(&stop);
    let app2 = app.clone();
    let tmp2 = tmp.clone();
    let id = model_id.to_string();

    let url2 = url.clone();
    std::thread::spawn(move || {
        // HEAD request to get content-length.
        // -D /dev/null sends response headers to /dev/null (not stdout),
        // so stdout contains only the %{content_length} value.
        // Falls back to the catalog's approx_bytes when the server uses chunked encoding
        // (content_length == -1, which fails to parse as u64).
        let total: u64 = std::process::Command::new("curl")
            .args(["-sL", "--head", "--max-time", "15", "-D", "/dev/null", "-w", "%{content_length}", &url2])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(info.approx_bytes);

        while !stop2.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if stop2.load(Ordering::SeqCst) {
                break;
            }
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
        return Err(format!("Téléchargement du modèle '{model_id}' échoué."));
    }

    std::fs::rename(&tmp, &dest).map_err(|e| format!("rename .part → .bin: {e}"))?;
    Ok(())
}

// ── Remove ────────────────────────────────────────────────────────────────────

/// Removes a model by filename from app-local-data.
pub fn remove_model(app: &tauri::AppHandle, filename: &str) -> Result<(), String> {
    if let Ok(p) = crate::kety_paths::whisper_model_dest(app, filename) {
        if p.exists() {
            std::fs::remove_file(&p)
                .map_err(|e| format!("remove {filename}: {e}"))?;
        }
    }
    Ok(())
}
