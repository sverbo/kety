//! Parsing sortie `whisper-cli` + suppression des phrases « crédit sous-titres » (Amara, etc.) par langue.
//! Chaque entrée est retirée partout où elle apparaît dans le texte (sous-chaîne, casse ignorée) ;
//! si la transcription entière n’est que l’une de ces phrases → « - ».

/// Phrases à retirer ou à remplacer par « - » si la transcription n’est que ça (dictée / écran).
const BOILERPLATE_FR: &[&str] = &[
    "[Sous-titres par la communauté d'Amara.org]",
    "[Sous-titres réalisés par la communauté d'Amara.org]",
    "[Sous-titres par Amara.org]",
    "Sous-titres par la communauté d'Amara.org",
    "Sous-titres réalisés par la communauté d'Amara.org",
    "[Sous-titres communautaires Amara.org]",
    "Merci d'avoir regardé cette vidéo !",
    "Merci d'avoir regardé cette vidéo!",
    "[Bruit de clavier]",
    "[Propos inaudibles]",
    "*Bruit de la voiture qui s'éteint*",
    "[silence]"
];

const BOILERPLATE_EN: &[&str] = &[
    "[Subtitles by the Amara.org community]",
    "Subtitles by the Amara.org community",
    "[Subtitles by Amara.org]",
    "Subtitles by Amara.org",
    "[Captions by the Amara.org community]",
];

fn boilerplate_for_lang(lang: &str) -> Vec<&'static str> {
    let lang = lang.trim().to_lowercase();
    match lang.as_str() {
        "fr" | "fra" | "french" => BOILERPLATE_FR.to_vec(),
        "en" | "eng" | "english" => BOILERPLATE_EN.to_vec(),
        "auto" => BOILERPLATE_FR
            .iter()
            .chain(BOILERPLATE_EN.iter())
            .copied()
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_hhmmss_to_mmss(raw: &str) -> Option<String> {
    let t = raw.trim().replace(',', ".");
    let parts: Vec<&str> = t.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let hh = parts[0].parse::<u32>().ok()?;
    let mm = parts[1].parse::<u32>().ok()?;
    let sec_part = parts[2];
    let ss = sec_part.split('.').next()?.parse::<u32>().ok()?;
    let total_min = hh.saturating_mul(60).saturating_add(mm);
    Some(format!("[{:02}:{:02}]", total_min, ss))
}

fn parse_timestamp_header(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if !trimmed.starts_with('[') {
        return None;
    }
    let close_idx = trimmed.find(']')?;
    let inside = &trimmed[1..close_idx];
    if !inside.contains("-->") {
        return None;
    }
    let mut parts = inside.split("-->");
    let start_raw = parts.next()?.trim();
    let _end_raw = parts.next()?.trim();
    let ts = parse_hhmmss_to_mmss(start_raw)?;
    let after = trimmed[(close_idx + 1)..].trim().to_string();
    Some((ts, after))
}

/// Parse Whisper stdout into lines formatted as `(timestamp, phrase)`.
fn parse_whisper_output_timed(raw: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut pending_ts: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some((ts, after)) = parse_timestamp_header(trimmed) {
            if after.is_empty() {
                pending_ts = Some(ts);
            } else {
                out.push((ts, after));
                pending_ts = None;
            }
            continue;
        }
        if let Some(ts) = pending_ts.take() {
            out.push((ts, trimmed.to_string()));
        } else {
            // Fallback for non-timestamped whisper lines.
            out.push(("[00:00]".to_string(), trimmed.to_string()));
        }
    }
    out
}

fn replace_all_ci(haystack: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return haystack.to_string();
    }
    let from_lower: Vec<char> = from.to_lowercase().chars().collect();
    let hay: Vec<char> = haystack.chars().collect();
    let n = from_lower.len();
    if n == 0 {
        return haystack.to_string();
    }
    let mut out = String::with_capacity(haystack.len());
    let mut i = 0usize;
    while i < hay.len() {
        if i + n <= hay.len() {
            let slice_lower: String = hay[i..i + n].iter().collect::<String>().to_lowercase();
            let fl: String = from_lower.iter().collect();
            if slice_lower == fl {
                out.push_str(to);
                i += n;
                continue;
            }
        }
        out.push(hay[i]);
        i += 1;
    }
    out
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Si le texte entier correspond (sans tenir compte de la casse) à une entrée de la liste → « - ».
fn replace_whole_text_if_boilerplate(text: &str, phrases: &[&str]) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let tl = trimmed.to_lowercase();
    for p in phrases {
        if tl == p.to_lowercase() {
            return Some("-".to_string());
        }
    }
    None
}

fn strip_boilerplate_phrases(mut text: String, lang: &str) -> String {
    let phrases = boilerplate_for_lang(lang);
    if phrases.is_empty() || text.trim().is_empty() {
        return text;
    }
    if let Some(replaced) = replace_whole_text_if_boilerplate(&text, &phrases) {
        return replaced;
    }
    // Retirer chaque phrase partout où elle apparaît (casse ignorée), les plus longues d’abord.
    let mut sorted: Vec<&str> = phrases.iter().copied().collect();
    sorted.sort_by_key(|p| std::cmp::Reverse(p.len()));
    for p in sorted {
        text = replace_all_ci(&text, p, "");
    }
    let text = normalize_ws(&text);
    if text.is_empty() {
        return "-".to_string();
    }
    text
}

/// Whisper stdout -> plain transcript (no timestamp lines), boilerplate filtered.
fn parse_whisper_output_plain(raw: &str) -> String {
    raw.lines()
        .filter(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return false;
            }
            parse_timestamp_header(trimmed).is_none()
        })
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Sortie brute stdout de `whisper-cli` → texte dictée/texte plat (sans timestamps).
pub fn whisper_stdout_to_transcript(raw_stdout: &str, lang: &str) -> String {
    let parsed = parse_whisper_output_plain(raw_stdout);
    strip_boilerplate_phrases(parsed, lang)
}

/// Sortie brute stdout de `whisper-cli` → texte horodaté (`[MM:SS] phrase`).
pub fn whisper_stdout_to_timestamped_transcript(raw_stdout: &str, lang: &str) -> String {
    let parsed = parse_whisper_output_timed(raw_stdout);
    build_timestamped_transcript(&parsed, lang)
}

/// Texte plat (déjà extrait) → nettoyage boilerplate (Amara, merci d'avoir regardé, etc.).
/// Utilisé par le provider cloud (OpenAI retourne directement `text`, pas de stdout).
pub fn clean_plain_transcript(text: &str, lang: &str) -> String {
    strip_boilerplate_phrases(text.to_string(), lang)
}

/// `(ts, phrase)` → `[MM:SS] phrase\n…` avec nettoyage boilerplate par segment.
/// Partagé entre la sortie `whisper-cli` horodatée et les segments verbose_json d'OpenAI.
pub fn build_timestamped_transcript(pairs: &[(String, String)], lang: &str) -> String {
    if pairs.is_empty() {
        return "-".to_string();
    }
    let mut lines: Vec<String> = Vec::new();
    for (ts, phrase) in pairs {
        let cleaned = strip_boilerplate_phrases(phrase.clone(), lang);
        let final_text = cleaned.trim();
        if final_text.is_empty() || final_text == "-" {
            continue;
        }
        lines.push(format!("{ts} {final_text}"));
    }
    if lines.is_empty() {
        "-".to_string()
    } else {
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amara_fr_becomes_dash() {
        let raw = "[Sous-titres par la communauté d'Amara.org]";
        let t = whisper_stdout_to_transcript(raw, "fr");
        assert_eq!(t, "-");
    }

    #[test]
    fn amara_mixed_line() {
        let raw = "Bonjour [Sous-titres par la communauté d'Amara.org] fin";
        let t = whisper_stdout_to_transcript(raw, "fr");
        assert_eq!(t, "Bonjour fin");
    }

    #[test]
    fn boilerplate_embedded_case_insensitive() {
        let raw = "début SOUS-TITRES PAR LA COMMUNAUTÉ D'AMARA.ORG fin";
        let t = whisper_stdout_to_transcript(raw, "fr");
        assert_eq!(t, "début fin");
    }

    #[test]
    fn merci_video_outro_fr() {
        let raw = "Merci d'avoir regardé cette vidéo !";
        let t = whisper_stdout_to_transcript(raw, "fr");
        assert_eq!(t, "-");
    }
}
