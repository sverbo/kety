//! Serial OCR worker queue — one process at a time, tasks enqueue in order.

use tauri::Manager;

use crate::document_commands::{emit_ocr_result, run_ocr};

pub(crate) struct OcrQueueState {
    pub tx: std::sync::mpsc::Sender<(std::path::PathBuf, tauri::AppHandle)>,
}

pub(crate) fn start_ocr_worker() -> OcrQueueState {
    let (tx, rx) =
        std::sync::mpsc::channel::<(std::path::PathBuf, tauri::AppHandle)>();
    std::thread::spawn(move || {
        for (path, app) in rx {
            if let Some(text) = run_ocr(&path, &app) {
                if let Some(s) = path.to_str() {
                    emit_ocr_result(&app, s, &text);
                }
            }
        }
    });
    OcrQueueState { tx }
}

pub(crate) fn enqueue_ocr(app: &tauri::AppHandle, path: std::path::PathBuf) {
    let state = app.state::<OcrQueueState>();
    if let Err(e) = state.tx.send((path, app.clone())) {
        eprintln!("[kts:ocr] Impossible d'envoyer dans la queue OCR : {e}");
    } else {
        eprintln!("[kts:ocr] Tâche ajoutée à la queue.");
    }
}

/// Lance la capture interactive (sélection région) dans un thread dédié, puis dispatche le résultat.
#[cfg(target_os = "macos")]
pub(crate) fn spawn_interactive_capture(app: &tauri::AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        let fj = crate::off_session_focus::sample_for_off_session_image(&app2)
            .and_then(|f| serde_json::to_value(f).ok());
        match crate::macos_capture::capture_interactive_png(&app2) {
            Ok(Some(path)) => {
                let path_for_ocr = path.clone();
                match crate::capture_dispatch::dispatch_context_image_path(&app2, path, fj) {
                    Ok(()) => {
                        crate::play_context_success_sound();
                        enqueue_ocr(&app2, path_for_ocr);
                    }
                    Err(e) => eprintln!("[kts:ctrl-b] dispatch ERREUR: {e}"),
                }
            }
            Ok(None) => eprintln!("[kts:ctrl-b] capture annulée par l'utilisateur"),
            Err(e) => eprintln!("[kts:ctrl-b] capture ERREUR: {e}"),
        }
    });
}
