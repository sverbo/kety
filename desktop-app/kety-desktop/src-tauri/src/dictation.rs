//! Dictée vocale : enregistrement micro → WAV → whisper-cli → texte de contexte.
//!
//! Utilisation :
//! ```
//! start_dictation(&app, &state)?;   // démarre en arrière-plan
//! let text = stop_and_transcribe(&app, &state)?;  // arrête + transcrit
//! ```

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::kety_paths::kety_audio_dir;
use crate::local_llm::output_only_rule;

// Paths are resolved at runtime via kety_paths (app-local-data first, vendor fallback in dev).

// ── Événements ───────────────────────────────────────────────────────────────

pub const EVT_STARTED: &str = "kts:dictation/started";
pub const EVT_STOPPED: &str = "kts:dictation/stopped";
pub const EVT_ERROR: &str = "kts:dictation/error";

/// Source unique des prompts par défaut (post-traitement dictée custom ⌘⌥+lettre). Le client lit via `get_dictation_custom_prompt_defaults_cmd`.
///
/// The output-only rule is written into the defaults so that a user who resets their template,
/// or reads it in Settings, sees the same words the app applies anyway. The rule is also added
/// to whatever template is in use at assembly time, so a saved template gets it too — and a
/// template that already ends with it is not told twice.
pub const DEFAULT_DICTATION_CUSTOM_PROMPT_HIGHLIGHT: &str = concat!(
    "User requirement\n\n{{DICTATION_TEXT}}\n\nknowing that {{HIGHLIGHTS}}\n\n",
    output_only_rule!()
);
pub const DEFAULT_DICTATION_CUSTOM_PROMPT_NO_HIGHLIGHT: &str = concat!(
    "User requirement\n\n{{DICTATION_TEXT}}\n\n",
    output_only_rule!()
);

// ── Canal stop ───────────────────────────────────────────────────────────────

/// `SyncSender<()>` - envoyer () pour arrêter l'enregistrement.
type StopTx = std::sync::mpsc::SyncSender<()>;

// ── État partagé ─────────────────────────────────────────────────────────────

pub struct DictationActiveState {
    pub is_recording: Arc<AtomicBool>,
    /// Dictée en pause (micro ouvert mais échantillons ignorés).
    pub is_paused: Arc<AtomicBool>,
    /// Transcription whisper en cours après arrêt micro.
    pub is_processing: Arc<AtomicBool>,
    /// Un seul arrêt dictée à la fois (évite double ⌃D pendant stop_and_transcribe).
    pub stop_inflight: Arc<AtomicBool>,
    stop_tx: Mutex<Option<StopTx>>,
    /// Échantillons PCM i16 collectés (rempli par le thread d'enregistrement).
    samples: Mutex<Option<Arc<Mutex<Vec<i16>>>>>,
    /// Fréquence d'échantillonnage native du périphérique.
    sample_rate: Mutex<u32>,
    /// Code de langue pour whisper-cli (ex : "fr", "en", "auto").
    pub lang: Mutex<String>,
    /// Nom du fichier modèle actif (ex : "ggml-medium.bin"). Ignoré si provider != "local".
    pub model: Mutex<String>,
    /// Provider de transcription : "local", "openai:whisper-1", ou "kety:server" (backend premium).
    /// Par défaut "local" ; mis à jour par `set_dictation_provider_cmd` au boot puis à chaque changement.
    pub provider: Mutex<String>,
    /// Clé API OpenAI utilisée quand `provider = "openai:whisper-1"`.
    /// Mise à jour en même temps que `provider` (Settings → LLM API Key).
    pub openai_api_key: Mutex<String>,
    /// true si la dictée a été démarrée depuis le micro inline de la note tray.
    /// Le résultat est alors routé vers la fenêtre tray_note au lieu du contexte segment.
    pub tray_note_mode: Arc<AtomicBool>,
    /// True while the microphone in the HUD's follow-up chat owns the recording.
    ///
    /// The recording flags below are shared with the dictation shortcuts, the tray menu and the
    /// Fn key, and every one of those ends a recording by sending the transcript somewhere — the
    /// focused field, Copy History, a capture. The chat's microphone writes into a text box and
    /// nowhere else, so this flag marks the recording as spoken for: whoever else tries to stop it
    /// is turned away instead of taking the words somewhere the user never asked for them to go.
    pub hud_chat_mic_mode: Arc<AtomicBool>,
    /// Texte sélectionné au moment du démarrage de la dictée principale (⌃D).
    /// Prépendé au résultat de transcription : "{selection}\n\n{transcription}".
    pub initial_selection: Mutex<Option<String>>,
    /// Si vrai, le résultat de transcription est injecté dans le champ de saisie focalisé
    /// (coller) après réactivation de l'app au premier plan.
    /// Utilisé pour la dictée déclenchée par la touche Fn (mode « champ »).
    pub inject_into_field: Arc<AtomicBool>,
    /// Dictée démarrée depuis la touche Fn (historique dictation + tentative d'injection).
    pub fn_field_dictation: Arc<AtomicBool>,
    /// Post-traitement LLM après transcription (raccourci « custom dictation »).
    pub custom_dictation_postprocess: Arc<AtomicBool>,
    /// Modèle OpenAI `openai:…` ou `disabled` (sync depuis le client).
    pub dictation_custom_model: Mutex<String>,
    pub dictation_custom_prompt_highlight: Mutex<String>,
    pub dictation_custom_prompt_no_highlight: Mutex<String>,
    /// Incrémenté à chaque démarrage d’enregistrement (filets auto-stop multi-sessions).
    pub record_epoch: Arc<AtomicU64>,
}

impl DictationActiveState {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            is_processing: Arc::new(AtomicBool::new(false)),
            stop_inflight: Arc::new(AtomicBool::new(false)),
            stop_tx: Mutex::new(None),
            samples: Mutex::new(None),
            sample_rate: Mutex::new(16_000),
            lang: Mutex::new("en".to_string()),
            model: Mutex::new(String::new()), // "" = disabled until store restores a saved model
            provider: Mutex::new("local".to_string()),
            openai_api_key: Mutex::new(String::new()),
            tray_note_mode: Arc::new(AtomicBool::new(false)),
            hud_chat_mic_mode: Arc::new(AtomicBool::new(false)),
            initial_selection: Mutex::new(None),
            inject_into_field: Arc::new(AtomicBool::new(false)),
            fn_field_dictation: Arc::new(AtomicBool::new(false)),
            custom_dictation_postprocess: Arc::new(AtomicBool::new(false)),
            dictation_custom_model: Mutex::new("disabled".to_string()),
            dictation_custom_prompt_highlight: Mutex::new(
                DEFAULT_DICTATION_CUSTOM_PROMPT_HIGHLIGHT.to_string(),
            ),
            dictation_custom_prompt_no_highlight: Mutex::new(
                DEFAULT_DICTATION_CUSTOM_PROMPT_NO_HIGHLIGHT.to_string(),
            ),
            record_epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

// SAFETY: `cpal::Stream` n'est jamais stocké dans cet état - il vit uniquement
// dans le thread d'enregistrement et y est droppé avant le retour.
unsafe impl Send for DictationActiveState {}
unsafe impl Sync for DictationActiveState {}

// ── Démarrage ────────────────────────────────────────────────────────────────

/// Démarre l'enregistrement en arrière-plan ; retourne immédiatement.
pub fn start_dictation(app: &tauri::AppHandle, state: &DictationActiveState) -> Result<(), String> {
    if state.is_recording.load(Ordering::SeqCst) {
        return Err("Dictée déjà en cours.".into());
    }

    let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);

    // Partage des échantillons entre le thread cpal et stop_and_transcribe.
    let shared_samples: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
    let shared_samples_thread = Arc::clone(&shared_samples);

    // Enregistre le canal stop + les échantillons.
    *state.stop_tx.lock().map_err(|e| e.to_string())? = Some(tx);
    *state.samples.lock().map_err(|e| e.to_string())? = Some(shared_samples);

    state.record_epoch.fetch_add(1, Ordering::SeqCst);
    state.is_recording.store(true, Ordering::SeqCst);

    let app2 = app.clone();
    let is_recording = Arc::clone(&state.is_recording);
    let is_paused = Arc::clone(&state.is_paused);
    is_paused.store(false, Ordering::SeqCst);
    let sample_rate_cell: Arc<Mutex<u32>> = {
        // On passe par un Arc séparé pour ne pas capturer &state (non-Send).
        let sr = *state.sample_rate.lock().map_err(|e| e.to_string())?;
        Arc::new(Mutex::new(sr))
    };
    let sample_rate_out = Arc::clone(&sample_rate_cell);

    // Stocke l'Arc du sample_rate dans le state pour que stop_and_transcribe
    // puisse le lire plus tard.
    // On réutilise le champ sample_rate du state comme valeur initiale ; le
    // thread le met à jour via sample_rate_cell puis on le copie dans state
    // après la jointure (cf. stop_and_transcribe).
    //
    // Pour éviter une capture de &state dans le thread, on transmet le
    // sample_rate via un second Arc partagé entre les deux côtés.

    std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        eprintln!("[kts:dictation] thread démarré");

        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                eprintln!("[kts:dictation] aucun périphérique d'entrée");
                is_recording.store(false, Ordering::SeqCst);
                let _ = app2.emit(EVT_ERROR, "Aucun périphérique d'entrée audio disponible.");
                return;
            }
        };

        eprintln!(
            "[kts:dictation] périphérique : {}",
            device.name().unwrap_or_else(|_| "inconnu".into())
        );

        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[kts:dictation] config audio : {e}");
                is_recording.store(false, Ordering::SeqCst);
                let _ = app2.emit(EVT_ERROR, format!("Config audio : {e}"));
                return;
            }
        };

        let sr = config.sample_rate().0;
        eprintln!(
            "[kts:dictation] sample_rate={sr}, channels={}, format={:?}",
            config.channels(),
            config.sample_format()
        );
        if let Ok(mut g) = sample_rate_cell.lock() {
            *g = sr;
        }

        let channels = config.channels() as usize;
        let samples_cb = Arc::clone(&shared_samples_thread);
        let is_paused_cb = Arc::clone(&is_paused);

        fn err_fn(e: cpal::StreamError) {
            eprintln!("[kts:dictation] erreur stream: {e}");
        }

        use cpal::SampleFormat;
        let sample_format = config.sample_format();
        let stream_config: cpal::StreamConfig = config.into();
        let stream = match sample_format {
            SampleFormat::I16 => build_stream_i16(&device, &stream_config, channels, samples_cb, Arc::clone(&is_paused_cb), err_fn),
            SampleFormat::F32 => build_stream_f32(&device, &stream_config, channels, samples_cb, Arc::clone(&is_paused_cb), err_fn),
            SampleFormat::U16 => build_stream_u16(&device, &stream_config, channels, samples_cb, Arc::clone(&is_paused_cb), err_fn),
            fmt => {
                eprintln!("[kts:dictation] format non pris en charge : {fmt:?}");
                is_recording.store(false, Ordering::SeqCst);
                let _ = app2.emit(EVT_ERROR, format!("Format audio non pris en charge : {fmt:?}"));
                return;
            }
        };

        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[kts:dictation] build_stream : {e}");
                is_recording.store(false, Ordering::SeqCst);
                let _ = app2.emit(EVT_ERROR, format!("Impossible d'ouvrir le flux audio : {e}"));
                return;
            }
        };

        if let Err(e) = stream.play() {
            eprintln!("[kts:dictation] stream.play() : {e}");
            is_recording.store(false, Ordering::SeqCst);
            let _ = app2.emit(EVT_ERROR, format!("Démarrage enregistrement : {e}"));
            return;
        }

        eprintln!("[kts:dictation] enregistrement en cours…");
        // Son puis event : le HUD aligne le chrono sur `EVT_STARTED` (micro déjà ouvert).
        crate::play_dictation_recording_started_sound();
        let _ = app2.emit(EVT_STARTED, serde_json::Value::Null);

        // Bloque jusqu'à réception du signal stop.
        let _ = rx.recv();

        // Stoppe et drop le stream (cpal::Stream n'est pas Send → drop ici dans le thread).
        drop(stream);
        // Même signal que le début (Glass) : fin de capture, juste avant transcription / sauvegarde.
        crate::play_dictation_recording_started_sound();

        eprintln!("[kts:dictation] stream droppé, enregistrement terminé");
        // Le flag is_recording est mis à false par stop_and_transcribe après la jointure.
    });

    // Partage le sample_rate avec stop_and_transcribe via un Arc global one-shot.
    // Le thread met à jour sample_rate_cell une fois la config connue ;
    // stop_and_transcribe le lit après la pause qui laisse le temps au thread de démarrer.
    SAMPLE_RATE_ARC.lock()
        .map_err(|e| e.to_string())?
        .replace(sample_rate_out);

    Ok(())
}

// ── Contournement Send pour sample_rate_out ──────────────────────────────────

// `Arc<Mutex<u32>>` est Send - on peut le stocker dans un Mutex global.
static SAMPLE_RATE_ARC: std::sync::LazyLock<Mutex<Option<Arc<Mutex<u32>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

// ── Builders de streams ───────────────────────────────────────────────────────

fn build_stream_i16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    samples: Arc<Mutex<Vec<i16>>>,
    is_paused: Arc<AtomicBool>,
    err_fn: impl Fn(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    use cpal::traits::DeviceTrait;
    device.build_input_stream(
        config,
        move |data: &[i16], _| {
            if is_paused.load(Ordering::Relaxed) { return; }
            let mono = stereo_to_mono_i16(data, channels);
            if let Ok(mut g) = samples.lock() {
                g.extend_from_slice(&mono);
            }
        },
        err_fn,
        None,
    )
}

fn build_stream_f32(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    samples: Arc<Mutex<Vec<i16>>>,
    is_paused: Arc<AtomicBool>,
    err_fn: impl Fn(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    use cpal::traits::DeviceTrait;
    device.build_input_stream(
        config,
        move |data: &[f32], _| {
            if is_paused.load(Ordering::Relaxed) { return; }
            let mono: Vec<i16> = stereo_to_mono_f32(data, channels)
                .iter()
                .map(|&s| f32_to_i16(s))
                .collect();
            if let Ok(mut g) = samples.lock() {
                g.extend_from_slice(&mono);
            }
        },
        err_fn,
        None,
    )
}

fn build_stream_u16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    samples: Arc<Mutex<Vec<i16>>>,
    is_paused: Arc<AtomicBool>,
    err_fn: impl Fn(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    use cpal::traits::DeviceTrait;
    device.build_input_stream(
        config,
        move |data: &[u16], _| {
            if is_paused.load(Ordering::Relaxed) { return; }
            let mono: Vec<i16> = stereo_to_mono_u16(data, channels)
                .iter()
                .map(|&s| u16_to_i16(s))
                .collect();
            if let Ok(mut g) = samples.lock() {
                g.extend_from_slice(&mono);
            }
        },
        err_fn,
        None,
    )
}

// ── Conversion audio ──────────────────────────────────────────────────────────

#[inline]
fn f32_to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

#[inline]
fn u16_to_i16(s: u16) -> i16 {
    (s as i32 - 32768) as i16
}

fn stereo_to_mono_i16(data: &[i16], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|ch| {
            let sum: i32 = ch.iter().map(|&s| s as i32).sum();
            (sum / channels as i32) as i16
        })
        .collect()
}

fn stereo_to_mono_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|ch| ch.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn stereo_to_mono_u16(data: &[u16], channels: usize) -> Vec<u16> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|ch| {
            let sum: u32 = ch.iter().map(|&s| s as u32).sum();
            (sum / channels as u32) as u16
        })
        .collect()
}

// ── Arrêt + transcription ─────────────────────────────────────────────────────

/// Envoie le signal stop, attend la fin du thread, écrit le WAV, lance whisper-cli.
pub fn stop_and_transcribe(
    app: &tauri::AppHandle,
    state: &DictationActiveState,
) -> Result<String, String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("Aucune dictée en cours.".into());
    }

    // Envoie stop.
    {
        let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }

    eprintln!("[kts:dictation] signal stop envoyé, attente thread…");

    // Petite pause pour laisser le thread drop le stream et finir.
    std::thread::sleep(std::time::Duration::from_millis(200));

    state.is_recording.store(false, Ordering::SeqCst);

    let _ = app.emit(EVT_STOPPED, serde_json::Value::Null);

    // Récupère les échantillons.
    let samples_arc = {
        let mut guard = state.samples.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("Aucun échantillon audio disponible.")?
    };
    let samples = samples_arc.lock().map_err(|e| e.to_string())?.clone();

    eprintln!("[kts:dictation] {} échantillons collectés", samples.len());

    if samples.is_empty() {
        return Err("Aucun son enregistré (durée trop courte ?).".into());
    }

    // Récupère le sample rate depuis l'Arc global.
    let sample_rate = {
        let guard = SAMPLE_RATE_ARC.lock().map_err(|e| e.to_string())?;
        if let Some(ref arc) = *guard {
            *arc.lock().map_err(|e| e.to_string())?
        } else {
            16_000u32
        }
    };

    eprintln!("[kts:dictation] sample_rate={sample_rate}");

    // Écrit le WAV.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let wav_path = kety_audio_dir(app)?.join(format!("kts-dictation-{ts}.wav"));
    let wav_path_str = wav_path.to_str().ok_or("Chemin WAV dictée non UTF-8")?;

    write_wav(wav_path_str, &samples, sample_rate)?;
    eprintln!("[kts:dictation] WAV écrit → {}", wav_path.display());

    let lang = state.lang.lock().map_err(|e| e.to_string())?.clone();
    let provider = state
        .provider
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    let transcript = if provider == "openai:whisper-1" {
        let api_key = state
            .openai_api_key
            .lock()
            .map_err(|e| e.to_string())?
            .clone();
        eprintln!("[kts:dictation] provider=cloud (openai whisper-1), langue={lang}…");
        let result = crate::cloud_transcribe::transcribe_dictation(
            &api_key,
            std::path::Path::new(wav_path_str),
            &lang,
        );
        let _ = std::fs::remove_file(wav_path_str);
        result?
    } else {
        // provider = "local" (défaut) → whisper-cli.
        let whisper_bin = crate::kety_paths::whisper_bin_path(app);
        let model_filename = state.model.lock().map_err(|e| e.to_string())?.clone();
        let whisper_model = crate::kety_paths::whisper_model_for(app, &model_filename);

        if !whisper_bin.exists() {
            let _ = std::fs::remove_file(wav_path_str);
            return Err(format!(
                "whisper-cli introuvable ({}). Installez Whisper depuis Settings → Voice dictation.",
                whisper_bin.display()
            ));
        }
        if !whisper_model.exists() {
            let _ = std::fs::remove_file(wav_path_str);
            return Err(format!(
                "Modèle Whisper introuvable ({}). Téléchargez-le depuis Settings → Voice dictation.",
                whisper_model.display()
            ));
        }

        eprintln!("[kts:dictation] provider=local, langue={lang}…");
        let output = std::process::Command::new(&whisper_bin)
            .args([
                "-m", whisper_model.to_str().unwrap_or(""),
                "-f", wav_path_str,
                "-nt", "--print-progress", "0",
                "-l", &lang,
            ])
            .output()
            .map_err(|e| format!("Impossible de lancer whisper-cli : {e}"))?;

        let _ = std::fs::remove_file(wav_path_str);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("whisper-cli a échoué : {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        eprintln!("[kts:dictation] whisper stdout ({} car.)", stdout.len());

        crate::transcript_clean::whisper_stdout_to_transcript(&stdout, &lang)
    };

    eprintln!("[kts:dictation] transcription : {transcript:?}");

    Ok(transcript)
}

// ── Écriture WAV ──────────────────────────────────────────────────────────────

// ── Pause / Resume ────────────────────────────────────────────────────────────

pub fn pause_dictation(state: &DictationActiveState) -> Result<(), String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("Aucune dictée en cours.".into());
    }
    state.is_paused.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn resume_dictation(state: &DictationActiveState) -> Result<(), String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("Aucune dictée en cours.".into());
    }
    state.is_paused.store(false, Ordering::SeqCst);
    Ok(())
}

// ── Discard ───────────────────────────────────────────────────────────────────

/// Arrête l'enregistrement sans transcription ni sauvegarde.
pub fn discard_dictation(state: &DictationActiveState) -> Result<(), String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Ok(());
    }
    state.is_paused.store(false, Ordering::SeqCst);
    // Envoie le signal stop au thread cpal.
    {
        let mut guard = state.stop_tx.lock().map_err(|e| e.to_string())?;
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
    state.is_recording.store(false, Ordering::SeqCst);
    // Vide les échantillons accumulés.
    if let Ok(mut guard) = state.samples.lock() {
        *guard = None;
    }
    Ok(())
}

fn write_wav(path: &str, samples: &[i16], sample_rate: u32) -> Result<(), String> {
    use hound::{WavSpec, WavWriter};
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        WavWriter::create(path, spec).map_err(|e| format!("Création WAV : {e}"))?;
    for &s in samples {
        writer
            .write_sample(s)
            .map_err(|e| format!("Écriture échantillon WAV : {e}"))?;
    }
    writer.finalize().map_err(|e| format!("Finalisation WAV : {e}"))?;
    Ok(())
}

