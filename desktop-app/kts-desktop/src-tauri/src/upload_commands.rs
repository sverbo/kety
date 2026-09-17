//! ZIP build and local export commands (local export ZIP, captures export).

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use tauri::Manager;

// ── ZIP helpers ───────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingsZipMediaEntry {
    pub disk_path: String,
    pub zip_path: String,
}

pub(crate) fn validate_zip_entry_path(zip_path: &str) -> Result<(), String> {
    if zip_path.is_empty() {
        return Err("Empty zip_path in media entry".to_string());
    }
    if zip_path.contains("..") {
        return Err(format!("Invalid zip_path (..): {zip_path}"));
    }
    if zip_path.starts_with('/') || zip_path.starts_with('\\') {
        return Err(format!("Invalid zip_path (absolute): {zip_path}"));
    }
    if !zip_path.starts_with("artefacts/") {
        return Err(format!(
            "zip_path must start with artefacts/: {zip_path}"
        ));
    }
    Ok(())
}

pub(crate) fn reveal_exported_file_in_system_ui(path: &Path) {
    #[cfg(target_os = "macos")]
    if let Some(s) = path.to_str() {
        let _ = std::process::Command::new("open").args(["-R", s]).status();
    }
    #[cfg(target_os = "windows")]
    if let Some(s) = path.to_str() {
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{s}"))
            .status();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(parent) = path.parent().and_then(|p| p.to_str()) {
        let _ = std::process::Command::new("xdg-open").arg(parent).status();
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Télécharge une ressource HTTP(S) vers le dossier Téléchargements.
#[tauri::command]
pub fn download_url_to_downloads_cmd(app: tauri::AppHandle, url: String, filename: String) -> Result<String, String> {
    use std::io::Read;
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Downloads folder unavailable: {e}"))?;
    let safe: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base_name = if safe.is_empty() || safe == "." || safe == ".." {
        "download.bin".to_string()
    } else {
        safe
    };
    let mut path: PathBuf = dir.join(&base_name);
    if path.exists() {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("download");
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        let ext_part = if ext.is_empty() {
            String::new()
        } else {
            format!(".{ext}")
        };
        for i in 1..10_000 {
            let candidate = dir.join(format!("{stem}-{i}{ext_part}"));
            if !candidate.exists() {
                path = candidate;
                break;
            }
        }
    }

    let resp = ureq::get(url.trim())
        .call()
        .map_err(|e| format!("Download GET failed: {e}"))?;
    let status = resp.status();
    if !(200..300).contains(&status) {
        return Err(format!("Download failed: HTTP {status}"));
    }
    let mut body = Vec::new();
    resp.into_reader()
        .read_to_end(&mut body)
        .map_err(|e| format!("Download read body: {e}"))?;

    std::fs::write(&path, &body).map_err(|e| format!("Write download: {e}"))?;
    let path_str = path
        .to_str()
        .ok_or_else(|| "Download path is not valid UTF-8".to_string())?
        .to_string();
    reveal_exported_file_in_system_ui(Path::new(&path_str));
    Ok(path_str)
}

/// Save a captures export ZIP to the Downloads folder.
#[tauri::command]
pub fn save_captures_zip_cmd(
    app: tauri::AppHandle,
    json_content: String,
    media_files: Vec<RecordingsZipMediaEntry>,
) -> Result<String, String> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Downloads folder unavailable: {e}"))?;
    let filename = "kety-captures.zip";
    let mut path: PathBuf = dir.join(filename);
    if path.exists() {
        for i in 1..10_000u32 {
            let candidate = dir.join(format!("kety-captures-{i}.zip"));
            if !candidate.exists() {
                path = candidate;
                break;
            }
        }
    }

    let w = std::io::Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(w);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("captures.json", opts)
        .map_err(|e| format!("ZIP captures.json: {e}"))?;
    zip.write_all(json_content.as_bytes())
        .map_err(|e| format!("ZIP write JSON: {e}"))?;

    for entry in &media_files {
        validate_zip_entry_path(&entry.zip_path)?;
        let src = Path::new(&entry.disk_path);
        if !src.is_file() {
            continue;
        }
        zip.start_file(&entry.zip_path, opts)
            .map_err(|e| format!("ZIP {}: {e}", entry.zip_path))?;
        let mut r = std::fs::File::open(src)
            .map_err(|e| format!("Open {}: {e}", entry.disk_path))?;
        std::io::copy(&mut r, &mut zip)
            .map_err(|e| format!("Copy into ZIP ({}): {e}", entry.zip_path))?;
    }

    let w = zip.finish().map_err(|e| format!("ZIP finalize: {e}"))?;
    let bytes = w.into_inner();
    std::fs::write(&path, &bytes).map_err(|e| format!("Write ZIP: {e}"))?;

    let path_str = path
        .to_str()
        .ok_or_else(|| "ZIP path is not valid UTF-8".to_string())?
        .to_string();
    reveal_exported_file_in_system_ui(Path::new(&path_str));
    Ok(path_str)
}

/// Build a captures export ZIP to a temp file (not Downloads) — used to stage a file for
/// upload in the GCP share flow. Returns the temp file path.
#[tauri::command]
pub fn build_captures_zip_to_temp_cmd(
    json_content: String,
    media_files: Vec<RecordingsZipMediaEntry>,
) -> Result<String, String> {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("kts-share-{}.zip", uuid::Uuid::new_v4()));

    let w = std::io::Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(w);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("captures.json", opts)
        .map_err(|e| format!("ZIP captures.json: {e}"))?;
    zip.write_all(json_content.as_bytes())
        .map_err(|e| format!("ZIP write JSON: {e}"))?;

    for entry in &media_files {
        validate_zip_entry_path(&entry.zip_path)?;
        let src = Path::new(&entry.disk_path);
        if !src.is_file() {
            continue;
        }
        zip.start_file(&entry.zip_path, opts)
            .map_err(|e| format!("ZIP {}: {e}", entry.zip_path))?;
        let mut r = std::fs::File::open(src)
            .map_err(|e| format!("Open {}: {e}", entry.disk_path))?;
        std::io::copy(&mut r, &mut zip)
            .map_err(|e| format!("Copy into ZIP ({}): {e}", entry.zip_path))?;
    }

    let w = zip.finish().map_err(|e| format!("ZIP finalize: {e}"))?;
    let bytes = w.into_inner();
    std::fs::write(&path, &bytes).map_err(|e| format!("Write ZIP: {e}"))?;

    path.to_str()
        .ok_or_else(|| "ZIP path is not valid UTF-8".to_string())
        .map(|s| s.to_string())
}

/// Delete a file the frontend no longer needs (e.g. the temp ZIP staged for the GCP share
/// flow). "Already gone" counts as success — the goal is just "make sure it's gone".
#[tauri::command]
pub fn delete_temp_file_cmd(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Delete temp file: {e}")),
    }
}

#[tauri::command]
pub fn export_chrome_extension_zip_cmd(
    app: tauri::AppHandle,
) -> Result<crate::meet_bridge::ChromeExtensionExportResult, String> {
    crate::meet_bridge::export_chrome_extension_zip(&app)
}

/// Copy a local file to the Downloads folder and reveal it in the system file browser.
#[tauri::command]
pub fn copy_local_file_to_downloads_cmd(app: tauri::AppHandle, src_path: String) -> Result<String, String> {
    let src = Path::new(&src_path);
    let filename = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Downloads folder unavailable: {e}"))?;
    let mut dest: PathBuf = dir.join(&filename);
    if dest.exists() {
        let stem = dest.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = dest.extension().and_then(|s| s.to_str()).unwrap_or("");
        let ext_part = if ext.is_empty() { String::new() } else { format!(".{ext}") };
        for i in 1..10_000u32 {
            let candidate = dir.join(format!("{stem}-{i}{ext_part}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }
    std::fs::copy(src, &dest).map_err(|e| format!("Copy to Downloads failed: {e}"))?;
    let dest_str = dest.to_str().ok_or_else(|| "Invalid path".to_string())?.to_string();
    reveal_exported_file_in_system_ui(Path::new(&dest_str));
    Ok(dest_str)
}
