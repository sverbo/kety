//! Context dispatch helpers: emit_off_session_*, dispatch_context_note, Google Meet upsert.
//!
//! These functions route user-generated content (text notes, screenshots, videos, Meet captions)
//! to either the live recording segment timeline or the off-session event stream.

use tauri::Manager;

use crate::{
    ContextNoteSource, ContextTimelineItem, SegmentContextState,
    OFF_SESSION_IMAGE_EVENT, OFF_SESSION_NOTE_EVENT, OFF_SESSION_VIDEO_EVENT,
    GOOGLE_MEET_MANUAL_INGESTED_EVENT, SEGMENT_CONTEXT_PENDING_EVENT,
    emit_payload_to_main,
};

// ── Off-session emit helpers ──────────────────────────────────────────────────

pub(crate) fn emit_off_session_image(
    app: &tauri::AppHandle,
    path: &str,
    context_focus: Option<serde_json::Value>,
) {
    let created_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut map = serde_json::Map::new();
    map.insert(
        "path".into(),
        serde_json::Value::String(path.to_string()),
    );
    map.insert(
        "createdAt".into(),
        serde_json::Value::String(created_at),
    );
    map.insert(
        "mediaKind".into(),
        serde_json::Value::String("image".to_string()),
    );
    if let Some(v) = context_focus {
        map.insert("contextFocus".into(), v);
    }
    if let Ok(meta) = std::fs::metadata(path) {
        let fs = meta.len();
        if fs > 0 {
            map.insert("fileSize".into(), serde_json::Value::Number(fs.into()));
        }
    }
    emit_payload_to_main(
        app,
        OFF_SESSION_IMAGE_EVENT,
        &serde_json::Value::Object(map),
    );
}

pub(crate) fn emit_off_session_video(
    app: &tauri::AppHandle,
    path: &str,
    transcription: &str,
    context_focus: Option<serde_json::Value>,
    thumbnail_path: Option<String>,
) {
    let created_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut map = serde_json::Map::new();
    map.insert(
        "path".into(),
        serde_json::Value::String(path.to_string()),
    );
    map.insert(
        "createdAt".into(),
        serde_json::Value::String(created_at),
    );
    if !transcription.is_empty() {
        map.insert("transcription".into(), serde_json::Value::String(transcription.to_string()));
    }
    if let Some(v) = context_focus {
        map.insert("contextFocus".into(), v);
    }
    if let Some(t) = thumbnail_path {
        map.insert("thumbnailPath".into(), serde_json::Value::String(t));
    }
    map.insert(
        "mediaKind".into(),
        serde_json::Value::String("video".to_string()),
    );
    if let Ok(meta) = std::fs::metadata(path) {
        let fs = meta.len();
        if fs > 0 {
            map.insert("fileSize".into(), serde_json::Value::Number(fs.into()));
        }
    }
    emit_payload_to_main(
        app,
        OFF_SESSION_VIDEO_EVENT,
        &serde_json::Value::Object(map),
    );
}

pub(crate) fn emit_off_session_note(
    app: &tauri::AppHandle,
    text: &str,
    explanation: Option<String>,
    source: ContextNoteSource,
    context_focus: Option<serde_json::Value>,
    lang: Option<String>,
    client_id: Option<String>,
) {
    let created_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut map = serde_json::Map::new();
    map.insert(
        "text".into(),
        serde_json::Value::String(text.to_string()),
    );
    if let Some(exp) = explanation {
        if !exp.trim().is_empty() {
            map.insert("explanation".into(), serde_json::Value::String(exp));
        }
    }
    map.insert(
        "createdAt".into(),
        serde_json::Value::String(created_at),
    );
    match serde_json::to_value(source) {
        Ok(v) => {
            map.insert("source".into(), v);
        }
        Err(e) => {
            eprintln!("[kts] emit off-session note: source JSON {e}");
            map.insert("source".into(), serde_json::Value::Null);
        }
    }
    if let Some(v) = context_focus {
        map.insert("contextFocus".into(), v);
    }
    if let Some(l) = lang {
        if !l.trim().is_empty() {
            map.insert("lang".into(), serde_json::Value::String(l));
        }
    }
    if let Some(cid) = client_id {
        let t = cid.trim();
        if !t.is_empty() {
            map.insert("id".into(), serde_json::Value::String(t.to_string()));
            map.insert(
                "meetingCaptionsUpsert".into(),
                serde_json::Value::Bool(true),
            );
        }
    }
    emit_payload_to_main(
        app,
        OFF_SESSION_NOTE_EVENT,
        &serde_json::Value::Object(map),
    );
}

// ── Segment context pending ───────────────────────────────────────────────────

pub(crate) fn emit_segment_context_pending(app: &tauri::AppHandle, state: &SegmentContextState) {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        session_id: Option<String>,
        context_timeline: Vec<ContextTimelineItem>,
    }
    let session_id = state.session_id.lock().ok().and_then(|g| g.clone());
    let context_timeline = state
        .timeline
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();
    let payload = Payload {
        session_id,
        context_timeline,
    };
    emit_payload_to_main(app, SEGMENT_CONTEXT_PENDING_EVENT, &payload);
}

// ── Context dispatch ──────────────────────────────────────────────────────────

/// Texte utilisateur → segment en cours (session non en pause), note hors session, ou erreur.
pub(crate) fn dispatch_context_note(
    app: &tauri::AppHandle,
    text: &str,
    explanation: Option<String>,
    source: ContextNoteSource,
    lang: Option<String>,
) -> Result<(), String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("Le texte ne peut pas être vide.".into());
    }
    let explanation_clean = explanation
        .and_then(|e| { let s = e.trim().to_string(); if s.is_empty() { None } else { Some(s) } });
    let lang_clean = lang.filter(|s| !s.trim().is_empty());
    let state = app.state::<SegmentContextState>();
    if !state.live_segment_capture() {
        #[cfg(target_os = "macos")]
        let fj = crate::off_session_focus::resolve_focus_for_off_session_note(app, source)
            .and_then(|f| serde_json::to_value(f).ok());
        #[cfg(not(target_os = "macos"))]
        let fj = None;
        emit_off_session_note(
            app,
            t,
            explanation_clean,
            source,
            fj,
            lang_clean.clone(),
            None,
        );
        return Ok(());
    }
    state
        .timeline
        .lock()
        .map_err(|e| e.to_string())?
        .push(ContextTimelineItem::Text {
            text: t.to_string(),
            explanation: explanation_clean,
            source,
            lang: lang_clean,
            client_id: None,
        });
    emit_segment_context_pending(app, &state);
    Ok(())
}

pub(crate) fn dispatch_context_image_path(
    app: &tauri::AppHandle,
    path: std::path::PathBuf,
    context_focus: Option<serde_json::Value>,
) -> Result<(), String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| "Chemin capture invalide (non UTF-8).".to_string())?
        .to_string();
    let state = app.state::<SegmentContextState>();
    if !state.live_segment_capture() {
        eprintln!(
            "[kts:ctrl-b] dispatch → hors session (arrêt ou pause), path={path_str}"
        );
        emit_off_session_image(app, &path_str, context_focus);
        return Ok(());
    }
    eprintln!(
        "[kts:ctrl-b] dispatch → segment (enregistrement actif), path={path_str}"
    );
    state
        .timeline
        .lock()
        .map_err(|e| e.to_string())?
        .push(ContextTimelineItem::Screenshot {
            path: path_str,
            explanation: None,
            ocr: None,
            lang: None,
        });
    emit_segment_context_pending(app, &state);
    Ok(())
}

// ── Google Meet caption ───────────────────────────────────────────────────────

const MEET_CONTINUATION_DIVIDER_MARKER: &str = "────────────────────────────────────────";

#[derive(Clone, Debug)]
struct MeetCaptionLine {
    speaker: String,
    text: String,
}

fn parse_meet_caption_speaker_lines(s: &str) -> Vec<MeetCaptionLine> {
    let mut lines = Vec::new();
    for part in s.split("\n\n") {
        let block = part.trim();
        if block.is_empty() || block.starts_with("────") {
            continue;
        }
        for line in block.split('\n') {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            if let Some((speaker, text)) = t.split_once(':') {
                let text = text.trim();
                if !text.is_empty() {
                    lines.push(MeetCaptionLine {
                        speaker: speaker.trim().to_string(),
                        text: text.to_string(),
                    });
                }
            }
        }
    }
    lines
}

fn format_meet_caption_speaker_lines(lines: &[MeetCaptionLine]) -> String {
    lines
        .iter()
        .map(|l| format!("{}: {}", l.speaker, l.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The active Meet caption speaker is mutable until another speaker appears.
fn try_speaker_state_meet_caption_merge(prev: &str, inc: &str) -> Option<String> {
    let prev_lines = parse_meet_caption_speaker_lines(prev);
    let inc_lines = parse_meet_caption_speaker_lines(inc);
    if inc_lines.is_empty() {
        return Some(prev.to_string());
    }
    if prev_lines.is_empty() {
        return Some(inc.to_string());
    }

    if prev_lines.last()?.speaker == inc_lines.first()?.speaker {
        let mut merged = prev_lines[..prev_lines.len() - 1].to_vec();
        merged.extend(inc_lines.iter().cloned());
        return Some(format_meet_caption_speaker_lines(&merged));
    }

    None
}

fn split_meet_transcript_for_line_merge(s: &str) -> (String, String) {
    let marker_at = s.rfind(MEET_CONTINUATION_DIVIDER_MARKER);
    let Some(marker_at) = marker_at else {
        return (String::new(), s.trim().to_string());
    };
    let block_start = s[..marker_at].rfind("\n\n");
    let (cut, skip) = match block_start {
        Some(bs) => (bs, 2),
        None => (marker_at, 0),
    };
    (
        s[..cut].trim_end().to_string(),
        s[cut + skip..].trim().to_string(),
    )
}

fn join_meet_transcript_after_line_merge(head: &str, merged_tail: &str) -> String {
    let tail = merged_tail.trim();
    if head.is_empty() {
        return tail.to_string();
    }
    if tail.is_empty() {
        return head.to_string();
    }
    format!("{head}\n\n{tail}")
}

fn merge_google_meet_caption_transcript(existing: &str, incoming: &str) -> String {
    let prev = existing.trim_end();
    let inc = incoming.trim();
    if inc.is_empty() {
        return existing.to_string();
    }
    if prev.is_empty() {
        return inc.to_string();
    }
    let (prev_head, prev_tail) = split_meet_transcript_for_line_merge(prev);
    if let Some(line_merged_tail) = try_speaker_state_meet_caption_merge(&prev_tail, inc) {
        return join_meet_transcript_after_line_merge(&prev_head, &line_merged_tail);
    }
    if let Some(line_merged_full) = try_speaker_state_meet_caption_merge(prev, inc) {
        return line_merged_full;
    }

    format!("{prev}\n\n{inc}")
}

fn emit_google_meet_manual_ingested(
    app: &tauri::AppHandle,
    client_id: &str,
    text: &str,
    session_id: Option<String>,
    used_live_segment: bool,
    skip_auto_summary: bool,
) {
    let payload = serde_json::json!({
        "clientId": client_id,
        "text": text,
        "sessionId": session_id,
        "usedLiveSegment": used_live_segment,
        "skipAutoSummary": skip_auto_summary,
    });
    emit_payload_to_main(app, GOOGLE_MEET_MANUAL_INGESTED_EVENT, &payload);
}

/// Même `segmentId` (extension Chrome) → une seule entrée texte mise à jour.
pub(crate) fn upsert_google_meet_caption(
    app: &tauri::AppHandle,
    client_id: &str,
    text: &str,
    manual: bool,
) -> Result<(), String> {
    let cid = client_id.trim();
    if cid.is_empty() {
        return Err("segmentId ne peut pas être vide.".into());
    }
    let t = text.trim();
    if t.is_empty() {
        return Err("text ne peut pas être vide.".into());
    }
    let source = ContextNoteSource::GoogleMeet;
    let state = app.state::<SegmentContextState>();
    let session_snapshot = state.session_id.lock().ok().and_then(|g| g.clone());
    let used_live = state.live_segment_capture();
    if !used_live {
        #[cfg(target_os = "macos")]
        let fj = crate::off_session_focus::resolve_focus_for_off_session_note(app, source)
            .and_then(|f| serde_json::to_value(f).ok());
        #[cfg(not(target_os = "macos"))]
        let fj = None;
        emit_off_session_note(
            app,
            t,
            None,
            source,
            fj,
            None,
            Some(cid.to_string()),
        );
        if manual {
            emit_google_meet_manual_ingested(app, cid, t, session_snapshot, false, false);
        }
        return Ok(());
    }
    let mut timeline = state.timeline.lock().map_err(|e| e.to_string())?;
    let idx_opt = timeline.iter().position(|it| match it {
        ContextTimelineItem::Text {
            client_id: Some(id),
            source: s,
            ..
        } => *s == ContextNoteSource::GoogleMeet && id == cid,
        _ => false,
    });
    let preserved_explanation: Option<String> = idx_opt.and_then(|idx| match &timeline[idx] {
        ContextTimelineItem::Text { explanation, .. } => explanation
            .as_ref()
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty()),
        _ => None,
    });
    let skip_auto_summary = manual && preserved_explanation.is_some();
    let merged_text = idx_opt
        .and_then(|idx| match &timeline[idx] {
            ContextTimelineItem::Text { text, .. } => Some(merge_google_meet_caption_transcript(
                text.as_str(),
                t,
            )),
            _ => None,
        })
        .unwrap_or_else(|| t.to_string());
    let new_item = ContextTimelineItem::Text {
        text: merged_text,
        explanation: preserved_explanation,
        source,
        lang: None,
        client_id: Some(cid.to_string()),
    };
    if let Some(idx) = idx_opt {
        timeline[idx] = new_item;
    } else {
        timeline.push(new_item);
    }
    drop(timeline);
    emit_segment_context_pending(app, &state);
    if manual {
        emit_google_meet_manual_ingested(
            app,
            cid,
            t,
            session_snapshot,
            true,
            skip_auto_summary,
        );
    }
    Ok(())
}

#[tauri::command]
pub fn set_google_meet_timeline_explanation_cmd(
    app: tauri::AppHandle,
    client_id: String,
    explanation: String,
) -> Result<(), String> {
    let cid = client_id.trim().to_string();
    let exp = explanation.trim().to_string();
    if cid.is_empty() || exp.is_empty() {
        return Err("client_id and explanation must be non-empty.".into());
    }
    let state = app.state::<SegmentContextState>();
    if !state.live_segment_capture() {
        return Err("Not capturing to a live segment.".into());
    }
    let mut timeline = state.timeline.lock().map_err(|e| e.to_string())?;
    let mut found = false;
    for it in timeline.iter_mut() {
        if let ContextTimelineItem::Text {
            client_id: Some(id),
            explanation: ref mut ex,
            source,
            ..
        } = it
        {
            if *source == ContextNoteSource::GoogleMeet && id == &cid {
                *ex = Some(exp.clone());
                found = true;
                break;
            }
        }
    }
    if !found {
        return Err("No Google Meet caption item with this id in the current segment.".into());
    }
    drop(timeline);
    emit_segment_context_pending(&app, &state);
    Ok(())
}
