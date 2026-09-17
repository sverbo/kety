//! FFI vers `vendor-src/kts_screen_capture.swift` (Screen Capture Kit + AVAssetWriter).
//! Préflight TCC : `CGRequestScreenCaptureAccess` affiche la boîte système si besoin (souvent sur le thread principal).

use std::ffi::CString;
use std::os::raw::{c_char, c_int};

use tauri::AppHandle;
use tauri::Runtime;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Vérifie que l’app a la permission « Enregistrement de l’écran ».
/// Si elle n’est pas encore accordée, déclenche la boîte système et retourne une erreur
/// demandant de redémarrer l’application - car macOS ne propage la permission au processus
/// en cours qu’au prochain démarrage (CGRequestScreenCaptureAccess retourne toujours false
/// même si l’utilisateur vient d’activer le toggle dans Réglages Système).
pub fn ensure_screen_capture_access<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<bool>(1);
    app.run_on_main_thread(move || {
        let already_granted = unsafe { CGPreflightScreenCaptureAccess() };
        eprintln!("[kts:screen-record] CGPreflightScreenCaptureAccess → {already_granted}");
        if !already_granted {
            // Ouvre la boîte système (ou Réglages Système sur macOS 13+).
            // La valeur de retour est toujours false dans macOS moderne - on l’ignore.
            unsafe { CGRequestScreenCaptureAccess() };
            eprintln!("[kts:screen-record] CGRequestScreenCaptureAccess → dialogue affiché (redémarrage requis)");
        }
        let _ = tx.send(already_granted);
    })
    .map_err(|e| format!("Impossible d’exécuter la demande d’accès écran sur le thread principal : {e}"))?;

    let already_granted = rx
        .recv()
        .map_err(|_| "Réponse accès écran introuvable.".to_string())?;
    if !already_granted {
        return Err(
            "Enregistrement de l’écran : autorisation requise.\n\
Active **kts-desktop** dans Réglages système → Confidentialité et sécurité → \
Enregistrement de l’écran, puis **redémarre l’application** pour que la permission prenne effet."
                .to_string(),
        );
    }
    Ok(())
}

/// Vérifie (et demande si nécessaire) l'accès au microphone via AVFoundation / TCC.
/// Bloquant : attend la réponse de l'utilisateur si le statut est notDetermined.
/// Contrairement à l'enregistrement d'écran, la permission micro prend effet immédiatement
/// dans la session en cours - pas besoin de redémarrer l'application.
pub fn ensure_microphone_access() -> Result<(), String> {
    let mut err = vec![0u8; 512];
    let r = unsafe { kts_ensure_microphone_access(err.as_mut_ptr() as *mut c_char, err.len()) };
    if r != 0 {
        return Err(err_buf_to_string(&err));
    }
    Ok(())
}

#[link(name = "kts_screen_capture", kind = "dylib")]
unsafe extern "C" {
    fn kts_sck_start(
        path: *const c_char,
        display_index: u32,
        quality: u32,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn kts_sck_stop(err: *mut c_char, err_len: usize) -> c_int;
    fn kts_sck_pause(err: *mut c_char, err_len: usize) -> c_int;
    fn kts_sck_resume(err: *mut c_char, err_len: usize) -> c_int;
    fn kts_sck_embed_audio(
        video_path: *const c_char,
        wav_path: *const c_char,
        output_path: *const c_char,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn kts_ensure_microphone_access(err: *mut c_char, err_len: usize) -> c_int;
}

fn err_buf_to_string(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

pub fn sck_start(path: &str, display_index: u32, quality: u32) -> Result<(), String> {
    eprintln!(
        "[kts:screen-record] FFI kts_sck_start → path={path} display_index={display_index} quality={quality}"
    );
    let c = CString::new(path).map_err(|e| e.to_string())?;
    let mut err = vec![0u8; 768];
    let r = unsafe {
        kts_sck_start(
            c.as_ptr(),
            display_index,
            quality,
            err.as_mut_ptr() as *mut c_char,
            err.len(),
        )
    };
    if r != 0 {
        let msg = err_buf_to_string(&err);
        eprintln!("[kts:screen-record] kts_sck_start ERREUR code={r} : {msg}");
        return Err(msg);
    }
    eprintln!("[kts:screen-record] kts_sck_start OK");
    Ok(())
}

pub fn sck_stop() -> Result<(), String> {
    eprintln!("[kts:screen-record] FFI kts_sck_stop…");
    let mut err = vec![0u8; 768];
    let r = unsafe { kts_sck_stop(err.as_mut_ptr() as *mut c_char, err.len()) };
    if r != 0 {
        let msg = err_buf_to_string(&err);
        eprintln!("[kts:screen-record] kts_sck_stop ERREUR code={r} : {msg}");
        return Err(msg);
    }
    eprintln!("[kts:screen-record] kts_sck_stop OK");
    Ok(())
}

pub fn sck_pause() -> Result<(), String> {
    let mut err = vec![0u8; 768];
    let r = unsafe { kts_sck_pause(err.as_mut_ptr() as *mut c_char, err.len()) };
    if r != 0 {
        return Err(err_buf_to_string(&err));
    }
    Ok(())
}

pub fn sck_resume() -> Result<(), String> {
    let mut err = vec![0u8; 768];
    let r = unsafe { kts_sck_resume(err.as_mut_ptr() as *mut c_char, err.len()) };
    if r != 0 {
        return Err(err_buf_to_string(&err));
    }
    Ok(())
}

pub fn sck_embed_audio(video_path: &str, wav_path: &str, output_path: &str) -> Result<(), String> {
    let cv = CString::new(video_path).map_err(|e| e.to_string())?;
    let cw = CString::new(wav_path).map_err(|e| e.to_string())?;
    let co = CString::new(output_path).map_err(|e| e.to_string())?;
    let mut err = vec![0u8; 768];
    let r = unsafe {
        kts_sck_embed_audio(cv.as_ptr(), cw.as_ptr(), co.as_ptr(),
                            err.as_mut_ptr() as *mut c_char, err.len())
    };
    if r != 0 {
        return Err(err_buf_to_string(&err));
    }
    Ok(())
}

