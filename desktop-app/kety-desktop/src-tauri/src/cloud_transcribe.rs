//! Transcription via OpenAI `/v1/audio/transcriptions` (modèle `whisper-1`).
//!
//! Fournit deux modes :
//! - `transcribe_dictation` : `response_format=json`, retourne le texte brut nettoyé
//!   (équivalent de la dictée locale `whisper-cli -nt`).
//! - `transcribe_timestamped` : `response_format=verbose_json` + `timestamp_granularities[]=segment`,
//!   retourne `[MM:SS] phrase` ligne par ligne (équivalent du screen-record local).
//!
//! Seul `whisper-1` est exposé côté UI car c'est le seul modèle OpenAI qui
//! retourne des timestamps côté serveur (nécessaire pour la vidéo).

use std::path::Path;
use std::time::Duration;

const OPENAI_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODEL: &str = "whisper-1";

/// Langue passée à OpenAI. `auto` côté KTS → on omet le champ (auto-detect).
fn openai_language(lang: &str) -> Option<String> {
    let l = lang.trim().to_lowercase();
    if l.is_empty() || l == "auto" {
        None
    } else {
        Some(l)
    }
}

fn read_wav_bytes(wav_path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(wav_path).map_err(|e| format!("Lecture WAV : {e}"))
}

fn wav_file_name(wav_path: &Path) -> String {
    wav_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.wav")
        .to_string()
}

fn build_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        // Whisper cloud peut être long sur des sessions de plusieurs minutes.
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Client HTTP : {e}"))
}

fn base_form(
    wav_path: &Path,
    lang: &str,
    response_format: &str,
) -> Result<reqwest::blocking::multipart::Form, String> {
    let bytes = read_wav_bytes(wav_path)?;
    let name = wav_file_name(wav_path);
    let file_part = reqwest::blocking::multipart::Part::bytes(bytes)
        .file_name(name)
        .mime_str("audio/wav")
        .map_err(|e| format!("MIME audio/wav : {e}"))?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .text("model", OPENAI_MODEL.to_string())
        .text("response_format", response_format.to_string())
        .part("file", file_part);
    if let Some(l) = openai_language(lang) {
        form = form.text("language", l);
    }
    Ok(form)
}

fn check_api_key(api_key: &str) -> Result<(), String> {
    if api_key.trim().is_empty() {
        Err(
            "Clé API OpenAI manquante. Configurez-la dans Settings → LLM API Key pour utiliser le provider Cloud."
                .into(),
        )
    } else {
        Ok(())
    }
}

/// Dictée sans timestamps - équivalent `whisper-cli -nt`.
pub fn transcribe_dictation(
    api_key: &str,
    wav_path: &Path,
    lang: &str,
) -> Result<String, String> {
    check_api_key(api_key)?;
    let client = build_client()?;
    let form = base_form(wav_path, lang, "json")?;

    let resp = client
        .post(OPENAI_TRANSCRIPTIONS_URL)
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .map_err(|e| format!("OpenAI transcriptions : {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .map_err(|e| format!("Lecture réponse OpenAI : {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "OpenAI transcriptions a échoué ({status}) : {}",
            body.trim()
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse JSON OpenAI : {e} - body={body}"))?;
    let text = parsed
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Réponse OpenAI sans champ 'text' : {body}"))?
        .trim()
        .to_string();
    Ok(crate::transcript_clean::clean_plain_transcript(&text, lang))
}

/// Transcription horodatée - segments `[MM:SS] phrase`.
pub fn transcribe_timestamped(
    api_key: &str,
    wav_path: &Path,
    lang: &str,
) -> Result<String, String> {
    check_api_key(api_key)?;
    let client = build_client()?;
    let form = base_form(wav_path, lang, "verbose_json")?
        .text("timestamp_granularities[]", "segment");

    let resp = client
        .post(OPENAI_TRANSCRIPTIONS_URL)
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .map_err(|e| format!("OpenAI transcriptions : {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .map_err(|e| format!("Lecture réponse OpenAI : {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "OpenAI transcriptions a échoué ({status}) : {}",
            body.trim()
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Parse JSON OpenAI : {e} - body={body}"))?;
    let segments = parsed
        .get("segments")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("Réponse OpenAI sans champ 'segments' : {body}"))?;

    let pairs: Vec<(String, String)> = segments
        .iter()
        .filter_map(|seg| {
            let start = seg.get("start").and_then(|v| v.as_f64())?;
            let text = seg.get("text").and_then(|v| v.as_str())?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some((format_mmss(start), text))
        })
        .collect();

    Ok(crate::transcript_clean::build_timestamped_transcript(&pairs, lang))
}

/// `start` (secondes) → `[MM:SS]` cumulatif (minutes qui dépassent 59 → 60, 61…).
fn format_mmss(start_secs: f64) -> String {
    let total = start_secs.max(0.0).floor() as u64;
    let mm = total / 60;
    let ss = total % 60;
    format!("[{mm:02}:{ss:02}]")
}
