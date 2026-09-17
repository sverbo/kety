//! Selection transform: run a user-defined prompt on selected text, inject result, optionally save to history.

use tauri::Manager;
use tauri_plugin_store::StoreExt;

use crate::{capture_dispatch, kety_paths, ContextNoteSource};

// ── Store keys ────────────────────────────────────────────────────────────────

pub const TEXT_ACTIONS_KEY: &str = "textActions";
pub const TEXT_ACTIONS_SAVE_HISTORY_KEY: &str = "textTransformSaveToHistory";

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TextAction {
    pub id: String,
    pub title: String,
    pub prompt: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextActionsConfig {
    pub actions: Vec<TextAction>,
    pub save_to_history: bool,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

pub fn load_text_actions(app: &tauri::AppHandle) -> Vec<TextAction> {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return vec![];
    };
    let Some(raw) = store.get(TEXT_ACTIONS_KEY) else {
        return default_text_actions();
    };
    serde_json::from_value(raw).unwrap_or_else(|_| default_text_actions())
}

pub fn load_save_to_history(app: &tauri::AppHandle) -> bool {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return false;
    };
    store.get(TEXT_ACTIONS_SAVE_HISTORY_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn default_text_actions() -> Vec<TextAction> {
    vec![
        TextAction {
            id: "translate-en".to_string(),
            title: "Translate to English".to_string(),
            prompt: "Translate the following text to English without reformulating it:\n\n{context}".to_string(),
        },
        TextAction {
            id: "correct-same-language".to_string(),
            title: "Correct (same language)".to_string(),
            prompt: "Correct grammar and spelling in the following text, keeping it in the same language and without rephrasing or changing its meaning:\n\n{context}".to_string(),
        },
        TextAction {
            id: "rephrase-same-language".to_string(),
            title: "Rephrase (same language)".to_string(),
            prompt: "Rephrase the following text in the same language to improve clarity and flow, keeping the meaning intact:\n\n{context}".to_string(),
        },
    ]
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_text_actions_config_cmd(app: tauri::AppHandle) -> TextActionsConfig {
    TextActionsConfig {
        actions: load_text_actions(&app),
        save_to_history: load_save_to_history(&app),
    }
}

#[tauri::command]
pub fn save_text_actions_cmd(
    app: tauri::AppHandle,
    actions: Vec<TextAction>,
    save_to_history: bool,
) -> Result<(), String> {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return Err("Store unavailable.".into());
    };
    let actions_val = serde_json::to_value(&actions).map_err(|e| e.to_string())?;
    store.set(TEXT_ACTIONS_KEY, actions_val);
    store.set(TEXT_ACTIONS_SAVE_HISTORY_KEY, serde_json::Value::Bool(save_to_history));
    store.save().map_err(|e| format!("Store save: {e}"))
}

/// Run a prompt (already has {context} substituted) using the custom dictation model.
#[tauri::command]
pub async fn run_text_action_cmd(
    app: tauri::AppHandle,
    prompt: String,
    qwen_state: tauri::State<'_, crate::QwenLocalModelState>,
    dict_state: tauri::State<'_, crate::DictationActiveState>,
) -> Result<String, String> {
    let model = dict_state.dictation_custom_model.lock().map_err(|e| e.to_string())?.clone();
    let api_key = dict_state.openai_api_key.lock().map_err(|e| e.to_string())?.clone();
    if model.is_empty() || model == "disabled" {
        return Err("No model configured. Set a model in Settings → Custom dictation.".into());
    }
    let qwen_sel = qwen_state.0.lock().map_err(|e| e.to_string())?.clone();
    // Everything that comes through here ends up in the user's document: the selection transform
    // pastes it, and the HUD follow-up chat exists to produce a version worth pasting. Adding the
    // rule to the assembled prompt covers the actions users have already saved, which changing
    // the default actions could not.
    let prompt = crate::local_llm::with_output_only_rule(&prompt);
    tauri::async_runtime::spawn_blocking(move || {
        crate::local_llm::run_raw_prompt(
            &app,
            &qwen_sel,
            Some(&model),
            &prompt,
            2048,
            if api_key.is_empty() { None } else { Some(api_key.as_str()) },
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Paste `result_text` into the focused field, and optionally dispatch to capture history.
#[tauri::command]
pub fn insert_text_result_cmd(
    app: tauri::AppHandle,
    result_text: String,
    action_title: String,
    save_to_history: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(presenter) = app.try_state::<crate::HudPresenterState>() {
            presenter.suppress_next_reopen.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        if let Some(hud) = app.get_webview_window("dictation_hud") {
            let _ = hud.hide();
        }
        crate::hud_commands::reactivate_previous_frontmost(&app);
        std::thread::sleep(std::time::Duration::from_millis(200));
        crate::macos_ax_selection::insert_text_via_paste(&result_text);
        if save_to_history {
            let explanation = format!("Selection transform: {action_title}");
            capture_dispatch::dispatch_context_note(
                &app,
                &result_text,
                Some(explanation),
                ContextNoteSource::TextTransform,
                None,
            )?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, result_text, action_title, save_to_history);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_text_actions_matches_spec() {
        let actions = default_text_actions();
        assert_eq!(actions.len(), 3);

        assert_eq!(actions[0].id, "translate-en");
        assert_eq!(actions[0].title, "Translate to English");
        assert_eq!(
            actions[0].prompt,
            "Translate the following text to English without reformulating it:\n\n{context}"
        );

        assert_eq!(actions[1].id, "correct-same-language");
        assert_eq!(actions[1].title, "Correct (same language)");
        assert_eq!(
            actions[1].prompt,
            "Correct grammar and spelling in the following text, keeping it in the same language and without rephrasing or changing its meaning:\n\n{context}"
        );

        assert_eq!(actions[2].id, "rephrase-same-language");
        assert_eq!(actions[2].title, "Rephrase (same language)");
        assert_eq!(
            actions[2].prompt,
            "Rephrase the following text in the same language to improve clarity and flow, keeping the meaning intact:\n\n{context}"
        );
    }
}
