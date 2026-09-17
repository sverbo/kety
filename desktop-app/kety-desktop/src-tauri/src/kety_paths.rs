//! Arborescence unique des artefacts Kety sous le dossier local de l'app.
//!
//! `{app_local_data_dir}/kety/`
//! - `kety-session-store.json` - sessions, notes, OCR (plugin store, front)
//! - `kety-settings.json` - positions HUD et fenêtre note de contexte, etc.
//! - `captures/` - PNG, MP4
//! - `audio/` - WAV temporaires (dictée, extraction audio écran)
//! - `qwen/models/` - GGUF Qwen2.5 (téléchargement manuel, usage futur)

use tauri::Manager;

const KETY_DIR: &str = "kety";
const CAPTURES_SUB: &str = "captures";
const AUDIO_SUB: &str = "audio";
const DOCUMENTS_SUB: &str = "documents";

/// Chemin relatif au dossier données app pour [`tauri_plugin_store::StoreExt`].
pub const SETTINGS_STORE_FILE: &str = "kety/kety-settings.json";

/// Store principal (sessions, préférences UI, flag « attacher le focus hors session »).
pub const SESSION_STORE_FILE: &str = "kety/kety-session-store.json";

pub fn kety_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join(KETY_DIR))
}

pub fn kety_captures_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let d = kety_dir(app)?.join(CAPTURES_SUB);
    std::fs::create_dir_all(&d).map_err(|e| format!("Création kety/captures : {e}"))?;
    Ok(d)
}

pub fn kety_audio_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let d = kety_dir(app)?.join(AUDIO_SUB);
    std::fs::create_dir_all(&d).map_err(|e| format!("Création kety/audio : {e}"))?;
    Ok(d)
}

pub fn kety_documents_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let d = kety_dir(app)?.join(DOCUMENTS_SUB);
    std::fs::create_dir_all(&d).map_err(|e| format!("Création kety/documents : {e}"))?;
    Ok(d)
}

// ── Whisper paths ─────────────────────────────────────────────────────────────

const WHISPER_SUB: &str = "whisper";
const WHISPER_MODELS_SUB: &str = "models";

pub fn whisper_models_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let d = kety_dir(app)?.join(WHISPER_SUB).join(WHISPER_MODELS_SUB);
    std::fs::create_dir_all(&d).map_err(|e| format!("Création kety/whisper/models : {e}"))?;
    Ok(d)
}

/// Destination path for a model file in app-local-data (creates dirs).
pub fn whisper_model_dest(app: &tauri::AppHandle, filename: &str) -> Result<std::path::PathBuf, String> {
    Ok(whisper_models_dir(app)?.join(filename))
}

/// Resolves whisper-cli: bundled resource first, then compile-time vendor (dev fallback).
pub fn whisper_bin_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    // Production: bundled in Contents/Resources/vendor/whisper-cli
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("vendor").join("whisper-cli");
        if p.exists() {
            return p;
        }
    }
    // Dev fallback: src-tauri/vendor/whisper-cli
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/vendor/whisper-cli"))
}

/// Resolves ocr-tool: bundled resource first, then compile-time vendor (dev fallback).
pub fn ocr_bin_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("vendor").join("ocr-tool");
        if p.exists() {
            return p;
        }
    }
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/vendor/ocr-tool"))
}

/// Resolves a model by filename from app-local-data (single canonical location).
pub fn whisper_model_for(app: &tauri::AppHandle, filename: &str) -> std::path::PathBuf {
    kety_dir(app)
        .map(|d| d.join(WHISPER_SUB).join(WHISPER_MODELS_SUB).join(filename))
        .unwrap_or_else(|_| std::path::PathBuf::from(filename))
}

/// Lists model filenames installed in app-local-data.
pub fn list_installed_models(app: &tauri::AppHandle) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(dir) = kety_dir(app).map(|d| d.join(WHISPER_SUB).join(WHISPER_MODELS_SUB)) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".bin") {
                    found.push(name);
                }
            }
        }
    }
    found
}

/// Whether Whisper is ready to run dictation with the given model.
/// Returns false if model_filename is empty (disabled).
pub fn whisper_is_functional(app: &tauri::AppHandle, model_filename: &str) -> bool {
    if model_filename.is_empty() {
        return false;
    }
    whisper_bin_path(app).exists() && whisper_model_for(app, model_filename).exists()
}

// ── Qwen GGUF paths ─────────────────────────────────────────────────────────

const QWEN_SUB: &str = "qwen";
const QWEN_MODELS_SUB: &str = "models";

pub fn qwen_models_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let d = kety_dir(app)?.join(QWEN_SUB).join(QWEN_MODELS_SUB);
    std::fs::create_dir_all(&d).map_err(|e| format!("Création kety/qwen/models : {e}"))?;
    Ok(d)
}

pub fn qwen_model_dest(app: &tauri::AppHandle, filename: &str) -> Result<std::path::PathBuf, String> {
    Ok(qwen_models_dir(app)?.join(filename))
}

/// Chemin absolu attendu pour un GGUF (pour une future intégration inference locale).
#[allow(dead_code)]
pub fn qwen_model_for(app: &tauri::AppHandle, filename: &str) -> std::path::PathBuf {
    kety_dir(app)
        .map(|d| d.join(QWEN_SUB).join(QWEN_MODELS_SUB).join(filename))
        .unwrap_or_else(|_| std::path::PathBuf::from(filename))
}

// ── Embed (embedding) model paths ────────────────────────────────────────────

const EMBED_SUB: &str = "embed";
const EMBED_MODELS_SUB: &str = "models";

pub fn embed_models_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let d = kety_dir(app)?.join(EMBED_SUB).join(EMBED_MODELS_SUB);
    std::fs::create_dir_all(&d).map_err(|e| format!("create kety/embed/models: {e}"))?;
    Ok(d)
}

pub fn embed_model_dest(app: &tauri::AppHandle, filename: &str) -> Result<std::path::PathBuf, String> {
    Ok(embed_models_dir(app)?.join(filename))
}

pub fn embed_model_for(app: &tauri::AppHandle, filename: &str) -> std::path::PathBuf {
    kety_dir(app)
        .map(|d| d.join(EMBED_SUB).join(EMBED_MODELS_SUB).join(filename))
        .unwrap_or_else(|_| std::path::PathBuf::from(filename))
}

pub fn list_installed_embed_models(app: &tauri::AppHandle) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(dir) = kety_dir(app).map(|d| d.join(EMBED_SUB).join(EMBED_MODELS_SUB)) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".gguf") {
                    found.push(name);
                }
            }
        }
    }
    found
}

// ── Local index DB path ───────────────────────────────────────────────────────

const LOCAL_INDEX_SUB: &str = "local-index";
const LOCAL_INDEX_ASSISTANTS_SUB: &str = "assistants";
const LOCAL_INDEX_DB_FILE: &str = "index.db";

pub fn local_index_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let d = kety_dir(app)?.join(LOCAL_INDEX_SUB);
    std::fs::create_dir_all(&d).map_err(|e| format!("create kety/local-index: {e}"))?;
    Ok(d)
}

/// Map anything outside `[alnum]-_` to `_`, so a value coming from outside the app
/// (a profile id, an imported assistant id) can never escape its directory.
fn sanitize_local_index_segment(value: &str, label: &str) -> Result<String, String> {
    let safe = value
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    if safe.is_empty() {
        return Err(format!("{label} must not be empty for local index path"));
    }
    Ok(safe)
}

fn sanitize_local_index_user_id(user_id: &str) -> Result<String, String> {
    sanitize_local_index_segment(user_id, "user_id")
}

/// Directory holding one index, relative to the `local-index` root.
///
/// `assistant_id: None` is the profile's own index and keeps the layout existing
/// installations already have on disk — `{user_id}/`. `Some(id)` is an index
/// imported into that profile — `{user_id}/assistants/{assistant_id}/`.
///
/// Pure: computes a path, touches no filesystem.
///
/// `pub(crate)` for `index_import`, which must resolve an assistant's directory
/// *without* creating it — `local_index_db_path` below `create_dir_all`s as a
/// side effect of computing, and an importer that called it would have put a
/// directory on disk before its first validation had run.
pub(crate) fn local_index_dir_in(
    base: &std::path::Path,
    user_id: &str,
    assistant_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let mut d = base.join(sanitize_local_index_user_id(user_id)?);
    if let Some(assistant_id) = assistant_id {
        let safe = sanitize_local_index_segment(assistant_id, "assistant_id")?;
        d = d.join(LOCAL_INDEX_ASSISTANTS_SUB).join(safe);
    }
    Ok(d)
}

/// What a caller is told when it asks for an imported assistant that is not on
/// disk. User-facing: this is the message a stale tab or an in-flight read ends
/// up showing.
pub(crate) fn missing_assistant_message() -> String {
    "We could not find this shared knowledge on your computer. It may have been removed — take it out of your list and import it again.".to_string()
}

/// [`local_index_db_path`] against an explicit `local-index` root, so the rule
/// below can be tested without an `AppHandle`.
///
/// **An imported assistant is never created here.** The profile's own index
/// (`None`) is created on first use — that is how a new profile gets a database
/// at all — but `Some(id)` only ever *resolves*: no `create_dir_all`, and a
/// missing database is an error rather than an empty new one.
///
/// The difference matters because an `assistant_id` outlives the thing it names.
/// A read can arrive after the assistant was deleted — a request already in
/// flight, a tab the UI has not refreshed — and a path function that creates as a
/// side effect would answer it by building `{user}/assistants/{id}/` and a blank
/// `index.db` inside it. That is an assistant folder with no registry entry:
/// invisible to the list, unopenable, unremovable, and taking up disk. Refusing
/// is the whole point.
///
/// **This rule is only half of it, and the other half is not here.** A path that
/// refuses to create says nothing about what happens to a directory that *does*
/// exist: the layer above — `local_index::open_or_recreate_db` — used to answer a
/// failed open by deleting the directory and rebuilding it, which for an imported
/// assistant meant erasing the only copy of its captures and its `artefacts/` and
/// leaving a blank database behind. That is now refused too, by
/// `local_index::IndexKind`, and the two refusals are what together make a read on
/// an imported index incapable of changing what is on disk. Neither is sufficient
/// alone.
pub(crate) fn local_index_db_path_in(
    base: &std::path::Path,
    user_id: &str,
    assistant_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let d = local_index_dir_in(base, user_id, assistant_id)?;
    let db = d.join(LOCAL_INDEX_DB_FILE);
    if assistant_id.is_some() {
        if !db.is_file() {
            return Err(missing_assistant_message());
        }
        return Ok(db);
    }
    std::fs::create_dir_all(&d).map_err(|e| format!("create local-index user dir: {e}"))?;
    Ok(db)
}

/// One DB per (profile, assistant) pair.
/// `None` → `kety/local-index/{user_id}/index.db` (the profile's own index),
/// created on first use.
/// `Some` → `kety/local-index/{user_id}/assistants/{assistant_id}/index.db`,
/// which must already exist — see [`local_index_db_path_in`].
/// Both ids must be non-empty; both are sanitized to avoid path traversal.
pub fn local_index_db_path(
    app: &tauri::AppHandle,
    user_id: &str,
    assistant_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    local_index_db_path_in(&local_index_dir(app)?, user_id, assistant_id)
}

/// `kety/local-index/{user_id}/gcp-share-config.json` — bucket name for this profile's GCP sharing.
pub fn gcp_share_config_path(app: &tauri::AppHandle, user_id: &str) -> Result<std::path::PathBuf, String> {
    let safe = sanitize_local_index_user_id(user_id)?;
    let d = local_index_dir(app)?.join(&safe);
    std::fs::create_dir_all(&d).map_err(|e| format!("create local-index user dir: {e}"))?;
    Ok(d.join("gcp-share-config.json"))
}

/// `kety/local-index/{user_id}/gcp-service-account.json` — the copied service account key for this profile.
pub fn gcp_share_service_account_path(app: &tauri::AppHandle, user_id: &str) -> Result<std::path::PathBuf, String> {
    let safe = sanitize_local_index_user_id(user_id)?;
    let d = local_index_dir(app)?.join(&safe);
    std::fs::create_dir_all(&d).map_err(|e| format!("create local-index user dir: {e}"))?;
    Ok(d.join("gcp-service-account.json"))
}

/// Fichiers `.gguf` présents dans le dossier app (pour l'UI).
pub fn list_installed_qwen_models(app: &tauri::AppHandle) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(dir) = kety_dir(app).map(|d| d.join(QWEN_SUB).join(QWEN_MODELS_SUB)) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".gguf") {
                    found.push(name);
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Component, Path, PathBuf};

    fn db_path_in(base: &str, user_id: &str, assistant_id: Option<&str>) -> PathBuf {
        local_index_dir_in(Path::new(base), user_id, assistant_id)
            .expect("path should resolve")
            .join(LOCAL_INDEX_DB_FILE)
    }

    /// The profile's own index must stay exactly where it is today: adding the
    /// assistant dimension must not move any existing installation.
    #[test]
    fn none_keeps_the_current_layout() {
        assert_eq!(
            db_path_in("/base", "user-42", None),
            Path::new("/base/user-42/index.db"),
        );
    }

    /// The failure this guards: a read meant for an imported assistant must not
    /// land on the profile's own database.
    #[test]
    fn assistant_resolves_elsewhere_than_the_profile_itself() {
        let own = db_path_in("/base", "user-42", None);
        let imported = db_path_in("/base", "user-42", Some("alice-index"));
        assert_ne!(own, imported);
        assert_eq!(
            imported,
            Path::new("/base/user-42/assistants/alice-index/index.db"),
        );
    }

    #[test]
    fn two_assistants_of_one_profile_resolve_apart() {
        assert_ne!(
            db_path_in("/base", "user-42", Some("alice")),
            db_path_in("/base", "user-42", Some("bob")),
        );
    }

    #[test]
    fn same_assistant_id_under_two_profiles_resolves_apart() {
        assert_ne!(
            db_path_in("/base", "user-1", Some("alice")),
            db_path_in("/base", "user-2", Some("alice")),
        );
    }

    #[test]
    fn assistant_id_cannot_traverse_out_of_its_directory() {
        let p = db_path_in("/base", "user-42", Some("../../etc"));
        assert!(!p.components().any(|c| c == Component::ParentDir), "{p:?}");
        assert!(p.starts_with("/base/user-42/assistants"), "{p:?}");
        assert_eq!(p, Path::new("/base/user-42/assistants/______etc/index.db"));
    }

    fn test_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kts-paths-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// **A read must not conjure an assistant.**
    ///
    /// An `assistant_id` outlives the assistant: a request already in flight, or
    /// a tab the UI has not refreshed, can ask for one that was just deleted. A
    /// path function that `create_dir_all`s as a side effect answers that by
    /// building the folder and letting SQLite put a blank database in it — an
    /// assistant no registry lists, that nothing can open, offer or remove.
    #[test]
    fn an_assistant_that_is_not_on_disk_is_refused_rather_than_created() {
        let root = test_root("assistant-not-created");
        let err = local_index_db_path_in(&root, "user-42", Some("never-imported")).unwrap_err();
        assert_eq!(err, missing_assistant_message());
        // And it left nothing behind on the way to saying so.
        assert!(
            !root.join("user-42").exists(),
            "resolving a missing assistant created {:?}",
            root.join("user-42"),
        );
    }

    /// The other half: an assistant that *is* there resolves as before.
    #[test]
    fn an_assistant_already_on_disk_resolves() {
        let root = test_root("assistant-on-disk");
        let dir = root.join("user-42").join("assistants").join("alice");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(LOCAL_INDEX_DB_FILE), b"SQLite format 3\0").unwrap();
        assert_eq!(
            local_index_db_path_in(&root, "user-42", Some("alice")).unwrap(),
            dir.join(LOCAL_INDEX_DB_FILE),
        );
    }

    /// The profile's own index must keep being created on first use — that is how
    /// a new profile gets a database at all, and the guard above must not touch it.
    #[test]
    fn the_profiles_own_index_is_still_created_on_first_use() {
        let root = test_root("own-index-created");
        let db = local_index_db_path_in(&root, "user-42", None).unwrap();
        assert_eq!(db, root.join("user-42").join(LOCAL_INDEX_DB_FILE));
        assert!(db.parent().unwrap().is_dir(), "the profile's folder was not created");
    }

    #[test]
    fn empty_ids_are_rejected() {
        assert!(local_index_dir_in(Path::new("/base"), "", None).is_err());
        assert!(local_index_dir_in(Path::new("/base"), "user-42", Some("")).is_err());
        // A non-empty id made only of illegal characters still sanitizes to a
        // non-empty segment, so it is accepted — and contained.
        assert!(local_index_dir_in(Path::new("/base"), "user-42", Some("/")).is_ok());
    }
}
