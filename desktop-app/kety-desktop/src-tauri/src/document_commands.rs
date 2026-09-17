//! Document processing commands: PDF OCR, DOCX extraction, sensitive scan, summarization,
//! file persistence, and related helpers.

use std::io::Write as _;

use crate::{kety_paths, local_llm};

// ── OCR ───────────────────────────────────────────────────────────────────────

pub(crate) fn run_ocr(image_path: &std::path::Path, app: &tauri::AppHandle) -> Option<String> {
    let bin = kety_paths::ocr_bin_path(app);
    if !bin.exists() {
        return None;
    }
    eprintln!("[kts:ocr] Lancement ocr-tool sur {}", image_path.display());
    let output = std::process::Command::new(&bin)
        .arg(image_path)
        .output()
        .map_err(|e| eprintln!("[kts:ocr] Erreur lancement : {e}"))
        .ok()?;
    if !output.status.success() {
        eprintln!(
            "[kts:ocr] ocr-tool a échoué : {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        eprintln!("[kts:ocr] Aucun texte extrait.");
        None
    } else {
        eprintln!("[kts:ocr] Texte extrait ({} chars).", text.len());
        Some(text)
    }
}

pub(crate) fn emit_ocr_result(app: &tauri::AppHandle, path: &str, text: &str) {
    use tauri::Emitter;
    #[derive(Clone, serde::Serialize)]
    struct Payload {
        path: String,
        text: String,
    }
    if let Err(e) = app.emit(
        crate::OCR_RESULT_EVENT,
        Payload {
            path: path.to_string(),
            text: text.to_string(),
        },
    ) {
        eprintln!("kts: impossible d'émettre `{}`: {e}", crate::OCR_RESULT_EVENT);
    }
}

/// OCR a single PDF page image rendered on the frontend.
#[tauri::command]
pub fn ocr_pdf_page_cmd(app: tauri::AppHandle, image_base64: String) -> Result<String, String> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_base64)
        .map_err(|e| format!("base64 decode: {e}"))?;

    let dir = kety_paths::kety_dir(&app).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("kety dir: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = dir.join(format!("pdf_ocr_page_{ts}.png"));

    let mut f = std::fs::File::create(&tmp_path).map_err(|e| format!("tmp file: {e}"))?;
    f.write_all(&bytes).map_err(|e| format!("write tmp: {e}"))?;
    drop(f);

    let result = run_ocr(&tmp_path, &app)
        .ok_or_else(|| "OCR found no text - the page may be blank or the image failed to render.".to_string());
    let _ = std::fs::remove_file(&tmp_path);
    result
}

/// Reads arbitrary file bytes for the PDF drop zone.
#[tauri::command]
pub fn read_pdf_bytes_cmd(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Cannot read file: {e}"))
}

// ── DOCX extraction ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub(crate) struct DocxResult {
    pub pages: Vec<String>,
    pub file_size: u64,
}

/// Extracts text pages from a DOCX file.
#[tauri::command]
pub fn extract_docx_pages_cmd(path: String) -> Result<DocxResult, String> {
    use std::io::Read;

    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    let file = std::fs::File::open(&path)
        .map_err(|e| format!("Cannot open file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Not a valid DOCX (ZIP error): {e}"))?;

    let mut xml = String::new();
    {
        let mut entry = archive
            .by_name("word/document.xml")
            .map_err(|_| "Missing word/document.xml - not a valid DOCX file.".to_string())?;
        entry.read_to_string(&mut xml)
            .map_err(|e| format!("Cannot read document.xml: {e}"))?;
    }

    let pages = parse_docx_pages(&xml);
    Ok(DocxResult { pages, file_size })
}

fn parse_docx_pages(xml: &str) -> Vec<String> {
    let mut pages: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut chars = xml.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '<' {
            let mut tag = String::new();
            for c in chars.by_ref() {
                if c == '>' { break; }
                tag.push(c);
            }
            let t = tag.trim();

            if t.starts_with("w:t") {
                let rest = &t[3..];
                if rest.is_empty() || rest.starts_with(' ') {
                    in_text = true;
                    continue;
                }
            }
            if t == "/w:t" {
                in_text = false;
                continue;
            }
            if t.starts_with("/w:p") {
                if !current.is_empty() && !current.ends_with('\n') {
                    current.push('\n');
                }
                in_text = false;
                continue;
            }
            if t.contains("w:type=\"page\"") || t.starts_with("w:lastRenderedPageBreak") {
                let page = current.trim().to_string();
                if !page.is_empty() {
                    pages.push(page);
                }
                current.clear();
                in_text = false;
            }
        } else if in_text {
            if ch == '&' {
                let mut entity = String::from('&');
                for c in chars.by_ref() {
                    entity.push(c);
                    if c == ';' { break; }
                }
                match entity.as_str() {
                    "&amp;"  => current.push('&'),
                    "&lt;"   => current.push('<'),
                    "&gt;"   => current.push('>'),
                    "&quot;" => current.push('"'),
                    "&apos;" => current.push('\''),
                    _ => {}
                }
            } else {
                current.push(ch);
            }
        }
    }

    let last = current.trim().to_string();
    if !last.is_empty() {
        pages.push(last);
    }

    pages
}

// ── Sensitive scan / summarize commands ──────────────────────────────────────

#[tauri::command]
pub fn get_sensitive_prompt_template_cmd(app: tauri::AppHandle) -> Result<String, String> {
    local_llm::get_prompt_template(&app)
}

#[tauri::command]
pub fn set_sensitive_prompt_template_cmd(app: tauri::AppHandle, body: String) -> Result<(), String> {
    local_llm::set_prompt_template(&app, &body)
}

#[tauri::command]
pub async fn sensitive_preview_run_cmd(
    app: tauri::AppHandle,
    req: local_llm::SensitivePreviewRequest,
    sensitive_scan_model: Option<String>,
    openai_api_key: Option<String>,
    state: tauri::State<'_, crate::QwenLocalModelState>,
) -> Result<local_llm::SensitivePreviewResponse, String> {
    let sel = state.0.lock().map_err(|e| e.to_string())?.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        local_llm::run_sensitive_preview(
            &app,
            &sel,
            sensitive_scan_model.as_deref(),
            req,
            openai_api_key.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking panic: {e}"))?;

    // The automatic scan runs per capture in the background and its caller only has a
    // console it cannot show anyone, so a failure here used to leave no trace at all:
    // the feature looked idle rather than broken. Say it where the app's log can be read.
    if let Err(ref e) = out {
        eprintln!("[kts:sensitive] scan failed: {e}");
    }
    out
}

#[tauri::command]
pub async fn run_prompt_cmd(
    app: tauri::AppHandle,
    model_selection: String,
    prompt: String,
    max_tokens: usize,
    openai_api_key: Option<String>,
    state: tauri::State<'_, crate::QwenLocalModelState>,
) -> Result<String, String> {
    let sel = state.0.lock().map_err(|e| e.to_string())?.clone();
    let model_sel: Option<String> = if model_selection.is_empty() || model_selection == "disabled" {
        None
    } else {
        Some(model_selection)
    };
    tauri::async_runtime::spawn_blocking(move || {
        local_llm::run_raw_prompt(
            &app,
            &sel,
            model_sel.as_deref(),
            &prompt,
            max_tokens,
            openai_api_key.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking panic: {e}"))?
}

#[tauri::command]
pub async fn summarize_pdf_cmd(
    app: tauri::AppHandle,
    text: String,
    doc_name: String,
    model_filename: String,
    lang: String,
    openai_api_key: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        local_llm::run_pdf_summary(
            &app,
            &model_filename,
            &text,
            &doc_name,
            &lang,
            openai_api_key.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking panic: {e}"))?
}

#[tauri::command]
pub async fn meta_summarize_cmd(
    app: tauri::AppHandle,
    summaries: Vec<String>,
    model_filename: String,
    lang: String,
    openai_api_key: Option<String>,
) -> Result<String, String> {
    if summaries.is_empty() {
        return Err("No summaries provided.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        local_llm::run_meta_summary(
            &app,
            &model_filename,
            &summaries,
            &lang,
            openai_api_key.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking panic: {e}"))?
}

// ── File persistence ──────────────────────────────────────────────────────────

fn sanitize_file_name_component(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_was_sep = false;
    for ch in raw.chars() {
        let keep = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
        if keep {
            out.push(ch);
            last_was_sep = false;
        } else if !last_was_sep {
            out.push('_');
            last_was_sep = true;
        }
    }
    let cleaned = out.trim_matches('_').to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// Copies a user-selected source document into app-local KTS storage.
#[tauri::command]
pub fn persist_context_source_file_cmd(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let source_raw = path.trim();
    if source_raw.is_empty() {
        return Err("Source path is empty.".to_string());
    }
    let source = std::path::PathBuf::from(source_raw);
    if !source.exists() {
        return Err("Source file does not exist.".to_string());
    }
    if !source.is_file() {
        return Err("Source path is not a file.".to_string());
    }

    let docs_dir = kety_paths::kety_documents_dir(&app)?;
    let stem_raw = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let ext_raw = source.extension().and_then(|s| s.to_str()).unwrap_or("");
    let stem = sanitize_file_name_component(stem_raw, "document");
    let ext = sanitize_file_name_component(ext_raw, "");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let suffix = format!("{ts}_{}", std::process::id());
    let dest_name = if ext.is_empty() {
        format!("{stem}_{suffix}")
    } else {
        format!("{stem}_{suffix}.{ext}")
    };
    let dest = docs_dir.join(dest_name);
    std::fs::copy(&source, &dest).map_err(|e| format!("Cannot copy source file: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

// ── Check local LLM ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_local_llm_cmd(
    app: tauri::AppHandle,
    state: tauri::State<crate::QwenLocalModelState>,
) -> local_llm::LocalLlmStatus {
    let sel = state
        .0
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    local_llm::check_status(&app, &sel)
}
