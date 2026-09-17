//! Phase A: bundled `llama-cli` + Phase B preview (single GGUF completion).
//!
//! Build the binary with `bash scripts/setup-llama-cli.sh` (macOS). Bundled like `whisper-cli`
//! via `tauri.conf.json` → `resources`.

use tauri::Manager;

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmStatus {
    pub cli_present: bool,
    pub selected_model_filename: String,
    pub model_file_present: bool,
    /// `llama-cli` + non-empty GGUF selection + model file on disk.
    pub ready: bool,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SensitivePreviewRequest {
    pub text: String,
    pub display_app: String,
    pub window_title: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SensitivePreviewResponse {
    pub raw_output: String,
    /// `-1` sensitive, `0` uncertain, `1` not sensitive, `None` if parse failed.
    pub parsed: Option<i8>,
    pub label: String,
}

const OPENAI_MODEL_PREFIX: &str = "openai:";
const OPENAI_CHAT_COMPLETIONS_URL: &str = "https://api.openai.com/v1/chat/completions";

// ── Prompts whose answer is pasted, not read ──────────────────────────────────

/// The one rule every prompt gets when its answer goes straight into the field the user was
/// typing in: custom dictation, the selection transform, and the HUD follow-up chat. There, a
/// "Sure, here is the translation:" opener is not noise, it is wrong text in the document.
///
/// A macro, not just a constant, so the default templates in `dictation.rs` can embed the very
/// same words at compile time and there is exactly one place where the wording lives.
macro_rules! output_only_rule {
    () => {
        "Reply with the resulting text only. No introduction, no explanation, no comment, no quotation marks around it, and no markdown code fences."
    };
}
pub(crate) use output_only_rule;

pub const OUTPUT_ONLY_RULE: &str = output_only_rule!();

/// Adds [`OUTPUT_ONLY_RULE`] to a prompt that has already been assembled — placeholders filled
/// in, text substituted. Applying it here rather than inside the templates is what makes it
/// reach the templates users have already saved, which no change to a default string could.
///
/// The rule goes last, after a blank line: these prompts are run as a raw completion by
/// `llama-cli` (no chat template), so the final line is the one immediately before the model
/// starts writing. A prompt that already carries the rule — every default template does — is
/// returned unchanged rather than told twice.
pub fn with_output_only_rule(prompt: &str) -> String {
    let body = prompt.trim_end();
    if body.contains(OUTPUT_ONLY_RULE) {
        return body.to_string();
    }
    if body.is_empty() {
        return OUTPUT_ONLY_RULE.to_string();
    }
    format!("{body}\n\n{OUTPUT_ONLY_RULE}")
}

/// Same resolution order as `whisper_bin_path`.
pub fn llama_cli_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("vendor").join("llama-cli");
        if p.exists() {
            return p;
        }
    }
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/vendor/llama-cli"))
}

pub fn llama_embedding_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("vendor").join("llama-embedding");
        if p.exists() {
            return p;
        }
    }
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/vendor/llama-embedding"))
}

pub fn check_status(app: &tauri::AppHandle, selected_gguf_filename: &str) -> LocalLlmStatus {
    let cli = llama_cli_path(app);
    let cli_present = cli.is_file();
    let model_file_present = if selected_gguf_filename.is_empty() {
        false
    } else {
        crate::kety_paths::qwen_model_for(app, selected_gguf_filename).is_file()
    };
    let ready = cli_present && model_file_present;
    LocalLlmStatus {
        cli_present,
        selected_model_filename: selected_gguf_filename.to_string(),
        model_file_present,
        ready,
    }
}

fn parse_sensitivity_token(stdout: &str) -> Option<i8> {
    for w in stdout.split_whitespace().rev() {
        let w = w.trim_matches(|c| ".,;:!?)]}>'\"".contains(c));
        match w {
            "-1" => return Some(-1),
            "0" => return Some(0),
            "1" => return Some(1),
            _ => {}
        }
    }
    None
}

fn label_for_parsed(p: Option<i8>) -> String {
    match p {
        Some(-1) => "sensitive".to_string(),
        Some(0) => "uncertain".to_string(),
        Some(1) => "not sensitive".to_string(),
        Some(_) => "parse_error".to_string(),
        None => "parse_error".to_string(),
    }
}

fn openai_model_from_selection(selection: &str) -> Option<&str> {
    selection
        .strip_prefix(OPENAI_MODEL_PREFIX)
        .map(str::trim)
        .filter(|m| !m.is_empty())
}

fn openai_api_key_or_err(openai_api_key: Option<&str>) -> Result<&str, String> {
    let key = openai_api_key
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            "OpenAI API key is missing. Set it in Settings → Local LM.".to_string()
        })?;
    Ok(key)
}

/// Call the chat completions API with an arbitrary message list.
pub fn run_openai_chat_completion_messages(
    api_key: &str,
    model: &str,
    messages: &[serde_json::Value],
    max_completion_tokens: usize,
    temperature: f32,
) -> Result<String, String> {
    let payload = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_completion_tokens": max_completion_tokens,
    });
    let response = ureq::post(OPENAI_CHAT_COMPLETIONS_URL)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let body = resp.into_string().unwrap_or_default();
                if body.trim().is_empty() { format!("OpenAI API error ({code}).") }
                else { format!("OpenAI API error ({code}): {body}") }
            }
            ureq::Error::Transport(t) => format!("OpenAI request failed: {t}"),
        })?;
    let parsed: serde_json::Value = response.into_json()
        .map_err(|e| format!("OpenAI response parse error: {e}"))?;
    parsed.get("choices").and_then(|v| v.as_array()).and_then(|a| a.first())
        .and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "OpenAI response missing choices[0].message.content.".to_string())
}

pub fn run_openai_chat_completion(
    api_key: &str,
    model: &str,
    prompt: &str,
    max_completion_tokens: usize,
    temperature: f32,
) -> Result<String, String> {
    let payload = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": temperature,
        "max_completion_tokens": max_completion_tokens,
    });

    let response = ureq::post(OPENAI_CHAT_COMPLETIONS_URL)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let body = resp.into_string().unwrap_or_default();
                if body.trim().is_empty() {
                    format!("OpenAI API error ({code}).")
                } else {
                    format!("OpenAI API error ({code}): {body}")
                }
            }
            ureq::Error::Transport(t) => format!("OpenAI request failed: {t}"),
        })?;

    let parsed: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("OpenAI response parse error: {e}"))?;

    let content = parsed
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|msg| msg.get("content"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .ok_or_else(|| "OpenAI response missing choices[0].message.content.".to_string())?;

    Ok(content.to_string())
}

/// Stored under `kts/llm_sensitive_prompt_template.txt`. Placeholders: `{{APP}}`, `{{WINDOW}}`, `{{TEXT}}`.
pub const SENSITIVE_PROMPT_TEMPLATE_FILE: &str = "llm_sensitive_prompt_template.txt";

pub const DEFAULT_SENSITIVE_PROMPT_TEMPLATE: &str = r#"You classify text for sensitive data before cloud upload. Personal data are allowed unless they are sensitive (address, passwords, api keys, ...). Reply with ONLY one token: -1 if the text contains sensitive data, 0 if unsure, 1 if it does not.

App: {{APP}}
Window: {{WINDOW}}

Text:
{{TEXT}}

Reply with only -1, 0, or 1:"#;

fn substitute_template(template: &str, req: &SensitivePreviewRequest) -> String {
    template
        .replace("{{APP}}", &req.display_app.replace('\n', " "))
        .replace("{{WINDOW}}", &req.window_title.replace('\n', " "))
        .replace("{{TEXT}}", &req.text)
}

/// Returns the current template file contents, or the built-in default if missing / empty.
pub fn get_prompt_template(app: &tauri::AppHandle) -> Result<String, String> {
    let path = crate::kety_paths::kety_dir(app)?.join(SENSITIVE_PROMPT_TEMPLATE_FILE);
    if path.is_file() {
        let s = std::fs::read_to_string(&path).map_err(|e| format!("read template: {e}"))?;
        if !s.trim().is_empty() {
            return Ok(s);
        }
    }
    Ok(DEFAULT_SENSITIVE_PROMPT_TEMPLATE.to_string())
}

/// Builds the prompt sent to llama-cli (template file or default).
fn build_preview_prompt(app: &tauri::AppHandle, req: &SensitivePreviewRequest) -> String {
    let template = get_prompt_template(app).unwrap_or_else(|_| DEFAULT_SENSITIVE_PROMPT_TEMPLATE.to_string());
    substitute_template(&template, req)
}

/// Writes the template file (creates `kts/` if needed). Empty string resets to default on next read.
pub fn set_prompt_template(app: &tauri::AppHandle, body: &str) -> Result<(), String> {
    let dir = crate::kety_paths::kety_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("kts dir: {e}"))?;
    let path = dir.join(SENSITIVE_PROMPT_TEMPLATE_FILE);
    let trimmed = body.trim();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    std::fs::write(&path, body.as_bytes()).map_err(|e| format!("write template: {e}"))
}

/// Returns a language instruction sentence to append to any LLM prompt.
/// `lang` uses the same codes as the Dictation setting: "fr", "en", "es", …
/// "document" (or empty) means "match the input language, fallback to English".
fn lang_instruction(lang: &str) -> &'static str {
    match lang {
        "document" | "" =>
            "Respond in the same language as the input text. If the language cannot be determined, use English.",
        "fr" => "Respond in French (Français).",
        "en" => "Respond in English.",
        "es" => "Respond in Spanish (Español).",
        "de" => "Respond in German (Deutsch).",
        "it" => "Respond in Italian (Italiano).",
        "pt" => "Respond in Portuguese (Português).",
        "nl" => "Respond in Dutch (Nederlands).",
        "ja" => "Respond in Japanese (日本語).",
        "zh" => "Respond in Chinese (中文).",
        "ar" => "Respond in Arabic (العربية).",
        _ => "Respond in English.",
    }
}

/// Strips common llama-cli end-of-generation artifacts (e.g. "> EOF by user") from output.
fn strip_llm_artifacts(s: &str) -> String {
    const MARKERS: &[&str] = &[
        "> EOF by user",
        "EOF by user",
        "[end of text]",
        "[EOT]",
        "<|im_end|>",
    ];
    let mut result = s.trim();
    loop {
        let mut found = false;
        for &m in MARKERS {
            if let Some(pos) = result.rfind(m) {
                if result[pos + m.len()..].trim().is_empty() {
                    result = result[..pos].trim_end();
                    found = true;
                    break;
                }
            }
        }
        if !found {
            break;
        }
    }
    result.to_string()
}

/// Runs llama-cli to produce a one-paragraph summary of `text` from document `doc_name`.
/// `lang`: language code ("en", "fr", …) or "document" to match the input language.
pub fn run_pdf_summary(
    app: &tauri::AppHandle,
    selected_gguf_filename: &str,
    text: &str,
    doc_name: &str,
    lang: &str,
    openai_api_key: Option<&str>,
) -> Result<String, String> {
    if let Some(openai_model) = openai_model_from_selection(selected_gguf_filename) {
        let api_key = openai_api_key_or_err(openai_api_key)?;
        let safe_name = doc_name.replace('\n', " ");
        let lang_inst = lang_instruction(lang);
        let prompt = format!(
            "Summarize the following text from the document \"{}\" in one concise paragraph. Capture the key information and main ideas. {}\nOutput only the summary paragraph, nothing else.\n\nText:\n{}\n\nSummary:",
            safe_name,
            lang_inst,
            text
        );
        let out = run_openai_chat_completion(api_key, openai_model, &prompt, 512, 0.3)?;
        return Ok(strip_llm_artifacts(&out));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, selected_gguf_filename, text, doc_name);
        return Err("Local LM is only supported on macOS in v1.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        if selected_gguf_filename.is_empty() {
            return Err(
                "No local model selected. Choose one in Settings → Process (Local Qwen).".to_string(),
            );
        }
        let cli = llama_cli_path(app);
        if !cli.is_file() {
            return Err(format!(
                "llama-cli not found at {}. Run: bash scripts/setup-llama-cli.sh",
                cli.display()
            ));
        }
        let model_path = crate::kety_paths::qwen_model_for(app, selected_gguf_filename);
        if !model_path.is_file() {
            return Err(format!(
                "Model file missing: {}. Download it in Settings.",
                model_path.display()
            ));
        }

        let safe_name = doc_name.replace('\n', " ");
        let lang_inst = lang_instruction(lang);
        let prompt = format!(
            "Summarize the following text from the document \"{}\" in one concise paragraph. Capture the key information and main ideas. {}\nOutput only the summary paragraph, nothing else.\n\nText:\n{}\n\nSummary:",
            safe_name,
            lang_inst,
            text
        );

        let prompt_path = crate::kety_paths::kety_dir(app)
            .map_err(|e| e.to_string())?
            .join("llm_pdf_summary_prompt.txt");
        std::fs::write(&prompt_path, prompt.as_bytes())
            .map_err(|e| format!("prompt file: {e}"))?;

        let model_s = model_path.to_str().ok_or("model path utf-8")?;
        let prompt_s = prompt_path.to_str().ok_or("prompt path utf-8")?;
        let cli_s = cli.to_str().ok_or("llama-cli path utf-8")?;

        let output = std::process::Command::new(cli_s)
            .args([
                "-m", model_s,
                "-f", prompt_s,
                "-n", "256",
                "--temp", "0.3",
                "-t", "4",
                "--no-display-prompt",
            ])
            .output()
            .map_err(|e| format!("llama-cli: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(format!(
                "llama-cli exited with {}. stderr: {}",
                output.status,
                if stderr.is_empty() { &stdout } else { &stderr }
            ));
        }

        let raw = String::from_utf8_lossy(&output.stdout).to_string();
        // Strip prompt echo: llama-cli may echo the prompt back even with --no-display-prompt
        // on some builds. The prompt always ends with "Summary:", so we take what follows.
        let result = raw
            .rfind("Summary:")
            .map(|idx| raw[idx + "Summary:".len()..].trim().to_string())
            .unwrap_or_else(|| raw.trim().to_string());
        Ok(strip_llm_artifacts(&result))
    }
}

/// Combines up to 10 per-page (or lower-level) summaries into a structured overview.
/// Never feed more than 10 items at once; the caller is responsible for batching.
/// `lang`: language code or "document" (match input language, fallback English).
pub fn run_meta_summary(
    app: &tauri::AppHandle,
    selected_gguf_filename: &str,
    summaries: &[String],
    lang: &str,
    openai_api_key: Option<&str>,
) -> Result<String, String> {
    if let Some(openai_model) = openai_model_from_selection(selected_gguf_filename) {
        let api_key = openai_api_key_or_err(openai_api_key)?;
        let numbered = summaries
            .iter()
            .enumerate()
            .map(|(i, s)| format!("[Section {}]\n{}", i + 1, s.trim()))
            .collect::<Vec<_>>()
            .join("\n\n");
        let lang_inst = lang_instruction(lang);
        let prompt = format!(
            "You are given {n} section summaries from the same document. Write a comprehensive, structured overview of the entire document. Your overview must:\n- Open with a short introduction (1-2 sentences) describing what the document is about.\n- Cover the main topics and themes found across all sections.\n- Highlight key points, findings, or arguments.\n- Be proportional to the scope: write multiple paragraphs if needed - do not compress everything into one short paragraph.\n- Preserve important details from all sections rather than discarding them.\n{lang}\nOutput only the overview, with no preamble.\n\nSection summaries:\n{sums}\n\nDocument overview:",
            n = summaries.len(),
            lang = lang_inst,
            sums = numbered
        );
        let out = run_openai_chat_completion(api_key, openai_model, &prompt, 1400, 0.3)?;
        return Ok(strip_llm_artifacts(&out));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, selected_gguf_filename, summaries);
        return Err("Local LM is only supported on macOS in v1.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        if selected_gguf_filename.is_empty() {
            return Err("No local model selected. Choose one in Settings → File processing.".to_string());
        }
        let cli = llama_cli_path(app);
        if !cli.is_file() {
            return Err(format!(
                "llama-cli not found at {}. Run: bash scripts/setup-llama-cli.sh",
                cli.display()
            ));
        }
        let model_path = crate::kety_paths::qwen_model_for(app, selected_gguf_filename);
        if !model_path.is_file() {
            return Err(format!("Model file missing: {}.", model_path.display()));
        }

        let numbered = summaries
            .iter()
            .enumerate()
            .map(|(i, s)| format!("[Section {}]\n{}", i + 1, s.trim()))
            .collect::<Vec<_>>()
            .join("\n\n");

        let lang_inst = lang_instruction(lang);
        let prompt = format!(
            "You are given {n} section summaries from the same document. Write a comprehensive, structured overview of the entire document. Your overview must:\n- Open with a short introduction (1-2 sentences) describing what the document is about.\n- Cover the main topics and themes found across all sections.\n- Highlight key points, findings, or arguments.\n- Be proportional to the scope: write multiple paragraphs if needed - do not compress everything into one short paragraph.\n- Preserve important details from all sections rather than discarding them.\n{lang}\nOutput only the overview, with no preamble.\n\nSection summaries:\n{sums}\n\nDocument overview:",
            n = summaries.len(),
            lang = lang_inst,
            sums = numbered
        );

        let prompt_path = crate::kety_paths::kety_dir(app)
            .map_err(|e| e.to_string())?
            .join("llm_meta_summary_prompt.txt");
        std::fs::write(&prompt_path, prompt.as_bytes())
            .map_err(|e| format!("prompt file: {e}"))?;

        let model_s = model_path.to_str().ok_or("model path utf-8")?;
        let prompt_s = prompt_path.to_str().ok_or("prompt path utf-8")?;
        let cli_s = cli.to_str().ok_or("llama-cli path utf-8")?;

        let output = std::process::Command::new(cli_s)
            .args([
                "-m", model_s,
                "-f", prompt_s,
                "-n", "1024",   // allow multi-paragraph overview
                "--temp", "0.3",
                "-t", "4",
                "--no-display-prompt",
            ])
            .output()
            .map_err(|e| format!("llama-cli: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(format!(
                "llama-cli exited with {}. stderr: {}",
                output.status,
                if stderr.is_empty() { &stdout } else { &stderr }
            ));
        }

        let raw = String::from_utf8_lossy(&output.stdout).to_string();
        let result = raw
            .rfind("Document overview:")
            .map(|idx| raw[idx + "Document overview:".len()..].trim().to_string())
            .unwrap_or_else(|| raw.trim().to_string());
        Ok(strip_llm_artifacts(&result))
    }
}

/// Single-shot chat for auto-tag and similar (`model_selection` = `openai:…` or `local:<gguf>`).
pub fn run_raw_prompt(
    app: &tauri::AppHandle,
    state_gguf_filename: &str,
    model_selection: Option<&str>,
    prompt: &str,
    max_tokens: usize,
    openai_api_key: Option<&str>,
) -> Result<String, String> {
    let msel = model_selection.unwrap_or("").trim();
    if let Some(openai_model) = openai_model_from_selection(msel) {
        let api_key = openai_api_key_or_err(openai_api_key)?;
        let out = run_openai_chat_completion(api_key, openai_model, prompt, max_tokens, 0.1)?;
        return Ok(strip_llm_artifacts(&out));
    }

    let gguf = if let Some(rest) = msel.strip_prefix("local:") {
        rest.trim()
    } else {
        state_gguf_filename.trim()
    };

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, gguf, prompt, max_tokens);
        return Err("Local LM prompt is only supported on macOS in v1.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        if gguf.is_empty() {
            return Err("No local model selected. Choose one in Settings → Tags.".to_string());
        }
        let cli = llama_cli_path(app);
        if !cli.is_file() {
            return Err(format!(
                "llama-cli not found at {}. Run: bash scripts/setup-llama-cli.sh",
                cli.display()
            ));
        }
        let model_path = crate::kety_paths::qwen_model_for(app, gguf);
        if !model_path.is_file() {
            return Err(format!(
                "Model file missing: {}. Download it in Settings.",
                model_path.display()
            ));
        }

        let prompt_path = crate::kety_paths::kety_dir(app)
            .map_err(|e| e.to_string())?
            .join("llm_raw_prompt.txt");
        std::fs::write(&prompt_path, prompt.as_bytes()).map_err(|e| format!("prompt file: {e}"))?;

        let model_s = model_path.to_str().ok_or("model path utf-8")?;
        let prompt_s = prompt_path.to_str().ok_or("prompt path utf-8")?;
        let cli_s = cli.to_str().ok_or("llama-cli path utf-8")?;
        let max_n = max_tokens.clamp(16, 4096).to_string();

        let output = std::process::Command::new(cli_s)
            .args([
                "-m", model_s,
                "-f", prompt_s,
                "-n", &max_n,
                "--temp", "0.1",
                "-t", "4",
                "--no-display-prompt",
            ])
            .output()
            .map_err(|e| format!("llama-cli: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(format!(
                "llama-cli exited with {}. stderr: {}",
                output.status,
                if stderr.is_empty() { &stdout } else { &stderr }
            ));
        }

        let raw = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(strip_llm_artifacts(&raw.trim().to_string()))
    }
}

pub fn run_sensitive_preview(
    app: &tauri::AppHandle,
    selected_gguf_filename: &str,
    sensitive_scan_model: Option<&str>,
    req: SensitivePreviewRequest,
    openai_api_key: Option<&str>,
) -> Result<SensitivePreviewResponse, String> {
    let openai_selection = sensitive_scan_model.and_then(openai_model_from_selection);

    if let Some(openai_model) = openai_selection {
        let api_key = openai_api_key_or_err(openai_api_key)?;
        let prompt = build_preview_prompt(app, &req);
        let raw = run_openai_chat_completion(api_key, openai_model, &prompt, 64, 0.0)?;
        let parsed = parse_sensitivity_token(&raw);
        let label = label_for_parsed(parsed);
        return Ok(SensitivePreviewResponse {
            raw_output: raw,
            parsed,
            label,
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, selected_gguf_filename, sensitive_scan_model, req);
        return Err("Local LM preview is only supported on macOS in v1.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        if selected_gguf_filename.is_empty() {
            return Err("No GGUF model selected. Choose one in Settings → Process (Local Qwen).".to_string());
        }
        let cli = llama_cli_path(app);
        if !cli.is_file() {
            return Err(format!(
                "llama-cli not found at {}. Run: bash scripts/setup-llama-cli.sh",
                cli.display()
            ));
        }
        let model_path = crate::kety_paths::qwen_model_for(app, selected_gguf_filename);
        if !model_path.is_file() {
            return Err(format!(
                "Model file missing: {}. Download it in Settings.",
                model_path.display()
            ));
        }

        let prompt = build_preview_prompt(app, &req);
        let prompt_path = crate::kety_paths::kety_dir(app)
            .map_err(|e| e.to_string())?
            .join("llm_sensitive_preview_prompt.txt");
        std::fs::write(&prompt_path, prompt.as_bytes()).map_err(|e| format!("prompt file: {e}"))?;

        let model_s = model_path.to_str().ok_or("model path utf-8")?;
        let prompt_s = prompt_path.to_str().ok_or("prompt path utf-8")?;
        let cli_s = cli.to_str().ok_or("llama-cli path utf-8")?;

        let output = std::process::Command::new(cli_s)
            .args([
                "-m",
                model_s,
                "-f",
                prompt_s,
                "-n",
                "48",
                "--temp",
                "0",
                "-t",
                "4",
            ])
            .output()
            .map_err(|e| format!("llama-cli: {e}"))?;

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = format!("{stdout}\n{stderr}");

        if !output.status.success() {
            return Err(format!(
                "llama-cli exited with {}. stderr: {}",
                output.status,
                if stderr.is_empty() { &stdout } else { &stderr }
            ));
        }

        let parsed = parse_sensitivity_token(&stdout).or_else(|| parse_sensitivity_token(&combined));
        let label = label_for_parsed(parsed);
        Ok(SensitivePreviewResponse {
            raw_output: if stdout.is_empty() {
                combined.trim().to_string()
            } else {
                stdout
            },
            parsed,
            label,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_only_rule_is_appended_after_a_blank_line() {
        let out = with_output_only_rule("Translate to English:\n\nBonjour");
        assert_eq!(
            out,
            format!("Translate to English:\n\nBonjour\n\n{OUTPUT_ONLY_RULE}")
        );
    }

    #[test]
    fn trailing_whitespace_does_not_push_the_rule_away() {
        let out = with_output_only_rule("Translate to English:\n\nBonjour\n\n   \n");
        assert_eq!(
            out,
            format!("Translate to English:\n\nBonjour\n\n{OUTPUT_ONLY_RULE}")
        );
    }

    #[test]
    fn a_prompt_that_already_carries_the_rule_is_left_alone() {
        let once = with_output_only_rule("Rewrite this:\n\nhello");
        let twice = with_output_only_rule(&once);
        assert_eq!(once, twice);
        assert_eq!(twice.matches(OUTPUT_ONLY_RULE).count(), 1);
    }

    #[test]
    fn an_empty_prompt_becomes_the_rule_alone() {
        assert_eq!(with_output_only_rule("   \n"), OUTPUT_ONLY_RULE);
    }

    #[test]
    fn default_dictation_templates_carry_the_rule_and_never_double_it() {
        for tmpl in [
            crate::dictation::DEFAULT_DICTATION_CUSTOM_PROMPT_HIGHLIGHT,
            crate::dictation::DEFAULT_DICTATION_CUSTOM_PROMPT_NO_HIGHLIGHT,
        ] {
            assert!(tmpl.ends_with(OUTPUT_ONLY_RULE), "template misses the rule: {tmpl}");
            assert_eq!(with_output_only_rule(tmpl), tmpl);
        }
    }

    #[test]
    fn the_rule_says_what_it_needs_to_say() {
        // The wording is what actually keeps preambles out of the user's document, so it is
        // pinned here: a well-meaning rewrite that drops one of these should fail loudly.
        for needle in [
            "text only",
            "No introduction",
            "no explanation",
            "no quotation marks",
            "no markdown code fences",
        ] {
            assert!(OUTPUT_ONLY_RULE.contains(needle), "rule misses {needle:?}");
        }
    }
}
