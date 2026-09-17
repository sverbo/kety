//! Boucle d’échantillonnage (500 ms) : segments de focus tant que `focus_poll_active` est vrai.
//! Cette app (KTS) est traitée comme inexistante : pas de segment dédié, on prolonge l’app d’avant.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

use crate::ContextTimelineItem;

pub const FOCUS_SEGMENT_EVENT: &str = "kts:recording/focus-segment";

/// Segment ouvert en cours (mise à jour ~500 ms). `live: false` = rien d’ouvert.
pub const FOCUS_CURRENT_SEGMENT_EVENT: &str = "kts:recording/focus-current";

/// Intervalle fixe entre deux lectures du focus (indépendant du seuil d’affichage UI).
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Identifiants du processus KTS (thread de poll + garde-fous à l’émission).
#[derive(Clone)]
pub struct RecordingSelfIdentity {
    pub own_pid: i32,
    pub self_bundle_id: Option<String>,
    /// `identifier` du `tauri.conf` (souvent = CFBundleIdentifier en prod).
    pub config_identifier: String,
}

#[cfg(target_os = "macos")]
fn is_self_app(sample: &crate::macos_focus::FocusSample, id: &RecordingSelfIdentity) -> bool {
    if sample.process_id == id.own_pid {
        return true;
    }
    let Some(b) = sample.bundle_id.as_deref() else {
        return false;
    };
    if b.is_empty() {
        return false;
    }
    if let Some(sb) = id.self_bundle_id.as_deref() {
        if !sb.is_empty() && b.eq_ignore_ascii_case(sb) {
            return true;
        }
    }
    if !id.config_identifier.is_empty() && b.eq_ignore_ascii_case(&id.config_identifier) {
        return true;
    }
    false
}

#[cfg(target_os = "macos")]
struct OpenSegment {
    started_at: String,
    fingerprint: String,
    sample: crate::macos_focus::FocusSample,
}

#[cfg(target_os = "macos")]
fn emit_segment(
    app: &AppHandle,
    session_id: Option<String>,
    started_at: &str,
    ended_at: &str,
    sample: &crate::macos_focus::FocusSample,
    context_timeline: &Arc<Mutex<Vec<ContextTimelineItem>>>,
    identity: &RecordingSelfIdentity,
) {
    if is_self_app(sample, identity) {
        eprintln!("kts: émission ignorée - échantillon « self » (ne devrait pas arriver)");
        return;
    }

    let timeline: Vec<ContextTimelineItem> = match context_timeline.lock() {
        Ok(mut g) => std::mem::take(&mut *g),
        Err(e) => std::mem::take(&mut *e.into_inner()),
    };

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        started_at: &'a str,
        ended_at: &'a str,
        source: &'static str,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        context_timeline: Vec<ContextTimelineItem>,
        #[serde(flatten)]
        sample: &'a crate::macos_focus::FocusSample,
    }
    let payload = Payload {
        session_id,
        started_at,
        ended_at,
        source: "macos",
        context_timeline: timeline,
        sample,
    };
    crate::emit_payload_to_main(app, FOCUS_SEGMENT_EVENT, &payload);
}

#[cfg(target_os = "macos")]
fn emit_focus_current_live(
    app: &AppHandle,
    session_id: Option<String>,
    started_at: &str,
    sample: &crate::macos_focus::FocusSample,
    context_timeline: &Arc<Mutex<Vec<ContextTimelineItem>>>,
) {
    let timeline_vec = context_timeline
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        session_id: Option<String>,
        live: bool,
        started_at: &'a str,
        source: &'static str,
        context_timeline: Vec<ContextTimelineItem>,
        #[serde(flatten)]
        sample: &'a crate::macos_focus::FocusSample,
    }
    let payload = Payload {
        session_id,
        live: true,
        started_at,
        source: "macos",
        context_timeline: timeline_vec,
        sample,
    };
    crate::emit_payload_to_main(app, FOCUS_CURRENT_SEGMENT_EVENT, &payload);
}

#[cfg(target_os = "macos")]
fn emit_focus_current_clear(app: &AppHandle, session_id: Option<String>) {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        session_id: Option<String>,
        live: bool,
    }
    let payload = Payload {
        session_id,
        live: false,
    };
    crate::emit_payload_to_main(app, FOCUS_CURRENT_SEGMENT_EVENT, &payload);
}

#[cfg(target_os = "macos")]
pub fn spawn_focus_poll_thread(
    app: AppHandle,
    focus_poll_active: Arc<AtomicBool>,
    session_id: Arc<Mutex<Option<String>>>,
    context_timeline: Arc<Mutex<Vec<ContextTimelineItem>>>,
    identity: RecordingSelfIdentity,
) {
    std::thread::spawn(move || {
        let mut was_recording = false;
        let mut open: Option<OpenSegment> = None;

        loop {
            let rec = focus_poll_active.load(Ordering::SeqCst);

            if !rec {
                let sid_idle = session_id.lock().ok().and_then(|g| g.clone());
                emit_focus_current_clear(&app, sid_idle);
                if was_recording {
                    if let Some(seg) = open.take() {
                        let ended =
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        let sid = session_id.lock().ok().and_then(|g| g.clone());
                        emit_segment(
                            &app,
                            sid,
                            &seg.started_at,
                            &ended,
                            &seg.sample,
                            &context_timeline,
                            &identity,
                        );
                    } else if let Ok(mut g) = context_timeline.lock() {
                        g.clear();
                    }
                    was_recording = false;
                }
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }

            was_recording = true;
            std::thread::sleep(POLL_INTERVAL);

            let Some(sample) = crate::macos_focus::sample_frontmost_focus() else {
                let sid = session_id.lock().ok().and_then(|g| g.clone());
                if let Some(ref cur) = open {
                    emit_focus_current_live(
                        &app,
                        sid,
                        &cur.started_at,
                        &cur.sample,
                        &context_timeline,
                    );
                } else {
                    emit_focus_current_clear(&app, sid);
                }
                continue;
            };

            if is_self_app(&sample, &identity) {
                let sid = session_id.lock().ok().and_then(|g| g.clone());
                if let Some(ref cur) = open {
                    emit_focus_current_live(
                        &app,
                        sid,
                        &cur.started_at,
                        &cur.sample,
                        &context_timeline,
                    );
                } else {
                    emit_focus_current_clear(&app, sid);
                }
                continue;
            }

            let fp = crate::macos_focus::fingerprint(&sample);
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let sid = session_id.lock().ok().and_then(|g| g.clone());

            match &mut open {
                None => {
                    open = Some(OpenSegment {
                        started_at: now,
                        fingerprint: fp,
                        sample,
                    });
                }
                Some(cur) if cur.fingerprint != fp => {
                    emit_segment(
                        &app,
                        sid.clone(),
                        &cur.started_at,
                        &now,
                        &cur.sample,
                        &context_timeline,
                        &identity,
                    );
                    open = Some(OpenSegment {
                        started_at: now,
                        fingerprint: fp,
                        sample,
                    });
                }
                Some(cur) => {
                    cur.sample = sample;
                }
            }

            if let Some(ref cur) = open {
                emit_focus_current_live(
                    &app,
                    sid,
                    &cur.started_at,
                    &cur.sample,
                    &context_timeline,
                );
            } else {
                emit_focus_current_clear(&app, sid);
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn spawn_focus_poll_thread(
    _app: AppHandle,
    focus_poll_active: Arc<AtomicBool>,
    _session_id: Arc<Mutex<Option<String>>>,
    _context_timeline: Arc<Mutex<Vec<ContextTimelineItem>>>,
    _identity: RecordingSelfIdentity,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let _rec = focus_poll_active.load(Ordering::SeqCst);
    });
}
