//! Enregistrement écran : **macOS** - Screen Capture Kit (SCK) pour la vidéo +
//! capture micro via cpal pour la transcription audio (même flux que la dictée).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Emitter;
use tauri_plugin_store::StoreExt;

use crate::kety_paths::{kety_audio_dir, kety_captures_dir};

#[cfg(target_os = "macos")]
use crate::screen_capture_sck;

// ── Événements ───────────────────────────────────────────────────────────────

pub const EVT_STARTED: &str = "kts:screenrecord/started";
pub const EVT_STOPPED: &str = "kts:screenrecord/stopped";
pub const EVT_ERROR: &str = "kts:screenrecord/error";

// ── État partagé ─────────────────────────────────────────────────────────────

pub struct ScreenRecordState {
    pub is_recording: Arc<AtomicBool>,
    pub is_paused: Arc<AtomicBool>,
    pub is_pending: Arc<AtomicBool>,
    pub is_processing: Arc<AtomicBool>,
    pub stop_inflight: Arc<AtomicBool>,
    /// Index du moniteur en cours d'enregistrement (trié par x puis y).
    /// Valide uniquement quand is_recording == true.
    pub locked_screen_index: Arc<AtomicU32>,
    /// Incrémenté à chaque démarrage d’enregistrement écran (auto-stop multi-sessions).
    pub record_epoch: Arc<AtomicU64>,

    start_time: Mutex<Option<std::time::Instant>>,
    output_path: Mutex<Option<PathBuf>>,

    // ── Capture micro (cpal, même mécanisme que dictation.rs) ──────────────
    mic_stop_tx: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
    mic_samples: Mutex<Option<Arc<Mutex<Vec<i16>>>>>,
    /// Fréquence d'échantillonnage native détectée par le thread cpal.
    mic_sample_rate: Arc<Mutex<u32>>,

    /// Nom de l'app frontmost au moment du prepare (avant affichage HUD).
    pub start_app_name: Mutex<Option<String>>,
    /// Bundle ID frontmost au moment du prepare.
    pub start_bundle_id: Mutex<Option<String>>,
    /// Titre de fenêtre frontmost au moment du prepare (avant affichage HUD).
    pub start_window_name: Mutex<Option<String>>,
    /// Chemin du screenshot de démarrage (miniature vidéo, pris avant affichage HUD).
    pub thumbnail_path: Mutex<Option<PathBuf>>,
}

impl ScreenRecordState {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            is_pending: Arc::new(AtomicBool::new(false)),
            is_processing: Arc::new(AtomicBool::new(false)),
            stop_inflight: Arc::new(AtomicBool::new(false)),
            locked_screen_index: Arc::new(AtomicU32::new(0)),
            record_epoch: Arc::new(AtomicU64::new(0)),
            start_time: Mutex::new(None),
            output_path: Mutex::new(None),
            mic_stop_tx: Mutex::new(None),
            mic_samples: Mutex::new(None),
            mic_sample_rate: Arc::new(Mutex::new(16_000)),
            start_app_name: Mutex::new(None),
            start_bundle_id: Mutex::new(None),
            start_window_name: Mutex::new(None),
            thumbnail_path: Mutex::new(None),
        }
    }
}

unsafe impl Send for ScreenRecordState {}
unsafe impl Sync for ScreenRecordState {}

// ── Capture micro ─────────────────────────────────────────────────────────────

/// Démarre la capture micro en arrière-plan (non bloquant, échec non fatal).
fn start_mic_capture(state: &ScreenRecordState) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
    let shared_samples: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
    let shared_samples_thread = Arc::clone(&shared_samples);
    let sample_rate_arc = Arc::clone(&state.mic_sample_rate);
    let is_paused = Arc::clone(&state.is_paused);

    if let Ok(mut g) = state.mic_stop_tx.lock() { *g = Some(tx); }
    if let Ok(mut g) = state.mic_samples.lock() { *g = Some(shared_samples); }

    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                eprintln!("[kts:screen-record] mic: aucun périphérique d'entrée");
                return;
            }
        };
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[kts:screen-record] mic: config audio : {e}");
                return;
            }
        };
        let sr = config.sample_rate().0;
        let channels = config.channels() as usize;
        eprintln!("[kts:screen-record] mic: démarré ({sr} Hz, {channels} ch)");
        if let Ok(mut g) = sample_rate_arc.lock() { *g = sr; }

        use cpal::SampleFormat;
        let samples_cb = Arc::clone(&shared_samples_thread);
        let stream_config: cpal::StreamConfig = config.clone().into();

        fn err_fn(e: cpal::StreamError) {
            eprintln!("[kts:screen-record] mic erreur: {e}");
        }

        let stream = match config.sample_format() {
            SampleFormat::I16 => {
                let sp = Arc::clone(&samples_cb); let ip = Arc::clone(&is_paused);
                device.build_input_stream(&stream_config, move |data: &[i16], _| {
                    if ip.load(Ordering::Relaxed) { return; }
                    let mono = stereo_to_mono_i16(data, channels);
                    if let Ok(mut g) = sp.lock() { g.extend_from_slice(&mono); }
                }, err_fn, None)
            }
            SampleFormat::F32 => {
                let sp = Arc::clone(&samples_cb); let ip = Arc::clone(&is_paused);
                device.build_input_stream(&stream_config, move |data: &[f32], _| {
                    if ip.load(Ordering::Relaxed) { return; }
                    let mono: Vec<i16> = stereo_to_mono_f32(data, channels)
                        .iter().map(|&s| f32_to_i16(s)).collect();
                    if let Ok(mut g) = sp.lock() { g.extend_from_slice(&mono); }
                }, err_fn, None)
            }
            SampleFormat::U16 => {
                let sp = Arc::clone(&samples_cb); let ip = Arc::clone(&is_paused);
                device.build_input_stream(&stream_config, move |data: &[u16], _| {
                    if ip.load(Ordering::Relaxed) { return; }
                    let mono: Vec<i16> = stereo_to_mono_u16(data, channels)
                        .iter().map(|&s| u16_to_i16(s)).collect();
                    if let Ok(mut g) = sp.lock() { g.extend_from_slice(&mono); }
                }, err_fn, None)
            }
            fmt => {
                eprintln!("[kts:screen-record] mic: format non pris en charge : {fmt:?}");
                return;
            }
        };

        let stream = match stream {
            Ok(s) => s,
            Err(e) => { eprintln!("[kts:screen-record] mic build_stream : {e}"); return; }
        };
        if let Err(e) = stream.play() {
            eprintln!("[kts:screen-record] mic stream.play() : {e}"); return;
        }

        let _ = rx.recv(); // Bloque jusqu'au signal stop ou discard.
        drop(stream);
        eprintln!("[kts:screen-record] mic: arrêté");
    });
}

/// Arrête la capture micro et retourne (samples, sample_rate). Retourne None si pas de capture.
fn stop_mic_capture(state: &ScreenRecordState) -> Option<(Vec<i16>, u32)> {
    // Envoie stop
    if let Ok(mut g) = state.mic_stop_tx.lock() {
        if let Some(tx) = g.take() { let _ = tx.send(()); }
    }
    std::thread::sleep(Duration::from_millis(200));

    let samples = {
        let arc = state.mic_samples.lock().ok()?.take()?;
        let s = arc.lock().ok()?.clone();
        s
    };
    let sr = state.mic_sample_rate.lock().map(|g| *g).unwrap_or(16_000);
    eprintln!("[kts:screen-record] mic: {} échantillons (sr={sr})", samples.len());
    Some((samples, sr))
}

/// Arrête et jette les échantillons micro sans transcription.
fn discard_mic_capture(state: &ScreenRecordState) {
    if let Ok(mut g) = state.mic_stop_tx.lock() {
        if let Some(tx) = g.take() { let _ = tx.send(()); }
    }
    if let Ok(mut g) = state.mic_samples.lock() { *g = None; }
}

// ── Démarrage ────────────────────────────────────────────────────────────────

/// Lit la qualité d'enregistrement depuis le store (0=low, 1=medium, 2=high). Défaut : 1.
fn read_screen_record_quality(app: &tauri::AppHandle) -> u32 {
    let Ok(store) = app.store(crate::kety_paths::SESSION_STORE_FILE) else {
        return 1;
    };
    store
        .get("screenRecordQuality")
        .and_then(|v| v.as_u64())
        .map(|v| (v as u32).min(2))
        .unwrap_or(1)
}

/// `screen_index` : même convention que `detect_hud_screen_index` (moniteurs triés par x puis y).
pub fn start_screen_record(
    app: &tauri::AppHandle,
    state: &ScreenRecordState,
    screen_index: u32,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, screen_index);
        return Err("Screen recording: macOS only.".into());
    }

    #[cfg(target_os = "macos")]
    {
        if state.is_recording.load(Ordering::SeqCst) {
            return Err("Screen recording already in progress.".into());
        }

        let captures_dir = kety_captures_dir(app)?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let output_path = captures_dir.join(format!("{ts}.mp4"));
        let path_str = output_path.to_str().ok_or("MP4 path not UTF-8")?;

        eprintln!(
            "[kts:screen-record] démarrage SCK → {} (moniteur index {})",
            output_path.display(),
            screen_index
        );

        screen_capture_sck::ensure_screen_capture_access(app)?;
        let quality = read_screen_record_quality(app);
        eprintln!("[kts:screen-record] qualité enregistrement: {quality} (0=low 1=medium 2=high)");
        screen_capture_sck::sck_start(path_str, screen_index, quality)?;

        *state.start_time.lock().map_err(|e| e.to_string())? = Some(std::time::Instant::now());
        *state.output_path.lock().map_err(|e| e.to_string())? = Some(output_path);
        state.locked_screen_index.store(screen_index, Ordering::SeqCst);
        state.record_epoch.fetch_add(1, Ordering::SeqCst);
        state.is_recording.store(true, Ordering::SeqCst);

        // Capture micro en parallèle pour la transcription (non fatal si indisponible).
        start_mic_capture(state);

        let _ = app.emit(EVT_STARTED, serde_json::Value::Null);
        eprintln!("[kts:screen-record] capture démarrée (SCK + mic)");
        Ok(())
    }
}

// ── Arrêt + traitement ────────────────────────────────────────────────────────

/// Arrête la capture vidéo + micro, transcrit selon le provider configuré.
/// - `provider` = `"local"` → whisper-cli avec `whisper_model` (vide ou non installé = pas de transcription).
/// - `provider` = `"openai:whisper-1"` → OpenAI `/v1/audio/transcriptions` + timestamps segment.
pub fn stop_and_process(
    app: &tauri::AppHandle,
    state: &ScreenRecordState,
    lang: &str,
    whisper_model: &str,
    provider: &str,
    openai_api_key: &str,
) -> Result<(String, PathBuf), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, lang, whisper_model, provider, openai_api_key);
        return Err("Screen recording: macOS only.".into());
    }

    #[cfg(target_os = "macos")]
    {
        if !state.is_recording.load(Ordering::SeqCst) {
            return Err("No screen recording in progress.".into());
        }

        let elapsed_secs = {
            let guard = state.start_time.lock().map_err(|e| e.to_string())?;
            guard.as_ref().map(|t| t.elapsed().as_secs()).unwrap_or(0)
        };
        *state.start_time.lock().map_err(|e| e.to_string())? = None;

        // Arrêter le micro EN PREMIER pour ne pas perdre les dernières millisecondes.
        let mic_result = stop_mic_capture(state);

        eprintln!("[kts:screen-record] arrêt SCK…");
        screen_capture_sck::sck_stop()?;

        state.is_recording.store(false, Ordering::SeqCst);
        let _ = app.emit(EVT_STOPPED, serde_json::Value::Null);

        let video_path = {
            let mut guard = state.output_path.lock().map_err(|e| e.to_string())?;
            guard.take().ok_or("Video path not found.")?
        };

        for _ in 0..80 {
            if video_path.exists() { break; }
            std::thread::sleep(Duration::from_millis(50));
        }

        if !video_path.exists() {
            return Err(format!(
                "Video file was not created ({}). \
Check Screen Recording permission for this binary in System Settings → Privacy & Security.",
                video_path.display()
            ));
        }

        eprintln!("[kts:screen-record] vidéo → {} ({elapsed_secs}s)", video_path.display());

        let duration_str = format_duration(elapsed_secs);

        // Écrire le WAV micro et l'intégrer dans la vidéo (non fatal).
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        // Write mic WAV — used for transcription and mic-audio embed.
        let wav_path_opt: Option<PathBuf> = if let Some((samples, sample_rate)) = &mic_result {
            if !samples.is_empty() {
                let wav_path = kety_audio_dir(app)?.join(format!("kts-screenrecord-{ts}.wav"));
                eprintln!("[kts:screen-record] écriture WAV micro → {}", wav_path.display());
                match write_wav(wav_path.to_str().unwrap_or(""), samples, *sample_rate) {
                    Ok(()) => Some(wav_path),
                    Err(e) => {
                        eprintln!("[kts:screen-record] WAV write échec: {e}");
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // Embed mic audio into video in a background thread while transcription runs in parallel.
        // Uses AVAssetReader/Writer with video stream copy (no re-encode) + mic WAV → AAC only.
        let embed_handle: Option<std::thread::JoinHandle<()>> =
            wav_path_opt.as_ref().map(|wav_path| {
                let wav_bg = wav_path.clone();
                let vid_bg = video_path.clone();
                let stem = vid_bg.file_stem()
                    .and_then(|s| s.to_str()).unwrap_or("rec").to_string();
                let combined = vid_bg.with_file_name(format!("{stem}_combined.mp4"));
                std::thread::spawn(move || {
                    match screen_capture_sck::sck_embed_audio(
                        vid_bg.to_str().unwrap_or(""),
                        wav_bg.to_str().unwrap_or(""),
                        combined.to_str().unwrap_or(""),
                    ) {
                        Ok(()) => {
                            if let Err(e) = std::fs::rename(&combined, &vid_bg) {
                                eprintln!("[kts:screen-record] rename combined échec: {e}");
                                let _ = std::fs::remove_file(&combined);
                            } else {
                                eprintln!("[kts:screen-record] mic audio intégré dans la vidéo");
                            }
                        }
                        Err(e) => {
                            eprintln!("[kts:screen-record] embed audio échec (non fatal): {e}");
                            let _ = std::fs::remove_file(&combined);
                        }
                    }
                })
            });

        // Transcription selon provider.
        let transcript = if provider == "openai:whisper-1" {
            if let Some(wav_path) = &wav_path_opt {
                eprintln!("[kts:screen-record] provider=cloud (openai whisper-1), langue={lang}…");
                match crate::cloud_transcribe::transcribe_timestamped(openai_api_key, wav_path, lang) {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("[kts:screen-record] OpenAI transcription a échoué : {e}");
                        String::new()
                    }
                }
            } else {
                eprintln!("[kts:screen-record] aucun échantillon micro → pas de transcription");
                String::new()
            }
        } else if crate::kety_paths::whisper_is_functional(app, whisper_model) {
            if let Some(wav_path) = &wav_path_opt {
                let wav_str = wav_path.to_str().unwrap_or("").to_string();
                let whisper_bin = crate::kety_paths::whisper_bin_path(app);
                let whisper_model_path = crate::kety_paths::whisper_model_for(app, whisper_model);
                eprintln!("[kts:screen-record] lancement whisper-cli (langue={lang})…");
                match std::process::Command::new(&whisper_bin)
                    .args(["-m", whisper_model_path.to_str().unwrap_or(""), "-f", &wav_str,
                           "--print-progress", "0", "-l", lang])
                    .output()
                {
                    Ok(o) if o.status.success() => {
                        let stdout = String::from_utf8_lossy(&o.stdout);
                        eprintln!("[kts:screen-record] whisper stdout ({} car.)", stdout.len());
                        crate::transcript_clean::whisper_stdout_to_timestamped_transcript(&stdout, lang)
                    }
                    Ok(o) => {
                        eprintln!("[kts:screen-record] whisper-cli a échoué : {}", String::from_utf8_lossy(&o.stderr));
                        String::new()
                    }
                    Err(e) => {
                        eprintln!("[kts:screen-record] impossible de lancer whisper-cli : {e}");
                        String::new()
                    }
                }
            } else {
                eprintln!("[kts:screen-record] aucun échantillon micro → pas de transcription");
                String::new()
            }
        } else {
            eprintln!("[kts:screen-record] whisper non configuré → pas de transcription");
            String::new()
        };

        // Wait for embed to finish, then delete the WAV.
        if let Some(handle) = embed_handle {
            let _ = handle.join();
        }
        if let Some(ref wav_path) = wav_path_opt {
            let _ = std::fs::remove_file(wav_path);
        }

        eprintln!("[kts:screen-record] transcription : {transcript:?}");

        let text = if transcript.trim().is_empty() {
            format!("[Screen recording - {duration_str}]")
        } else {
            format!("[Screen recording - {duration_str}] {}", transcript.trim())
        };

        Ok((text, video_path))
    }
}

// ── Pause / Resume ────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub fn pause_screen_record(state: &ScreenRecordState) -> Result<(), String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("No screen recording in progress.".into());
    }
    screen_capture_sck::sck_pause()?;
    // is_paused = true → le callback cpal ignore les échantillons micro.
    state.is_paused.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn resume_screen_record(state: &ScreenRecordState) -> Result<(), String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("No screen recording in progress.".into());
    }
    screen_capture_sck::sck_resume()?;
    state.is_paused.store(false, Ordering::SeqCst);
    Ok(())
}

// ── Discard ───────────────────────────────────────────────────────────────────

/// Arrête la capture et supprime le fichier vidéo sans traitement.
pub fn discard_screen_record(state: &ScreenRecordState) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    { let _ = state; return Ok(()); }

    #[cfg(target_os = "macos")]
    {
        if !state.is_recording.load(Ordering::SeqCst) {
            return Ok(());
        }
        state.is_paused.store(false, Ordering::SeqCst);
        discard_mic_capture(state);
        let _ = screen_capture_sck::sck_stop();
        state.is_recording.store(false, Ordering::SeqCst);
        state.stop_inflight.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = state.output_path.lock() {
            if let Some(path) = guard.take() {
                let _ = std::fs::remove_file(&path);
            }
        }
        // Nettoyer la miniature et le nom d'app si abandon.
        if let Ok(mut g) = state.thumbnail_path.lock() {
            if let Some(p) = g.take() { let _ = std::fs::remove_file(&p); }
        }
        if let Ok(mut g) = state.start_app_name.lock() { g.take(); }
        if let Ok(mut g) = state.start_bundle_id.lock() { g.take(); }
        if let Ok(mut g) = state.start_window_name.lock() { g.take(); }
        Ok(())
    }
}

// ── Helpers audio ─────────────────────────────────────────────────────────────

#[inline] fn f32_to_i16(s: f32) -> i16 { (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16 }
#[inline] fn u16_to_i16(s: u16) -> i16 { (s as i32 - 32768) as i16 }

fn stereo_to_mono_i16(data: &[i16], ch: usize) -> Vec<i16> {
    if ch <= 1 { return data.to_vec(); }
    data.chunks(ch).map(|c| { let s: i32 = c.iter().map(|&x| x as i32).sum(); (s / ch as i32) as i16 }).collect()
}
fn stereo_to_mono_f32(data: &[f32], ch: usize) -> Vec<f32> {
    if ch <= 1 { return data.to_vec(); }
    data.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect()
}
fn stereo_to_mono_u16(data: &[u16], ch: usize) -> Vec<u16> {
    if ch <= 1 { return data.to_vec(); }
    data.chunks(ch).map(|c| { let s: u32 = c.iter().map(|&x| x as u32).sum(); (s / ch as u32) as u16 }).collect()
}

fn write_wav(path: &str, samples: &[i16], sample_rate: u32) -> Result<(), String> {
    use hound::{WavSpec, WavWriter};
    let spec = WavSpec { channels: 1, sample_rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = WavWriter::create(path, spec).map_err(|e| format!("WAV create: {e}"))?;
    for &s in samples { w.write_sample(s).map_err(|e| format!("WAV write: {e}"))?; }
    w.finalize().map_err(|e| format!("WAV finalize: {e}"))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn format_duration(secs: u64) -> String {
    let m = secs / 60;
    let s = secs % 60;
    format!("{m}:{s:02}")
}
