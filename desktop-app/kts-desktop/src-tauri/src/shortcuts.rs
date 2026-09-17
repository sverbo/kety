//! Raccourcis globaux macOS - modificateurs fixes ⌘⌥, **lettre** configurable par action.
//!
//! Source unique pour enregistrement, libellés menu tray et UI Settings.

#![cfg(target_os = "macos")]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

/// Modificateurs communs : ⌘ Command + ⌥ Option
pub const HOTKEY_MODIFIERS: Modifiers = Modifiers::from_bits_truncate(
    Modifiers::META.bits() | Modifiers::ALT.bits(),
);

/// Legacy focus-session tray toggle (⌘⌥+`recording_toggle`). When false, that shortcut is not registered - keep handler + `KEY_RECORDING_TOGGLE` for a future revival; align with `LEGACY_FOCUS_SESSION_START_ENABLED` in `src/appConstants.tsx`.
pub const REGISTER_RECORDING_TOGGLE_SHORTCUT: bool = false;

// ── Valeurs par défaut (lettres historiques) ───────────────────────────────

pub const KEY_CONTEXT_TEXT: Code = Code::KeyV;
pub const KEY_CONTEXT_HIGHLIGHT: Code = Code::KeyC;
pub const KEY_NOTE_WINDOW: Code = Code::KeyX;
pub const KEY_SCREENSHOT: Code = Code::KeyB;
pub const KEY_RECORDING_TOGGLE: Code = Code::KeyN;
pub const KEY_DICTATION: Code = Code::KeyD;
pub const KEY_SCREEN_RECORD: Code = Code::KeyS;
pub const KEY_ASSISTANT: Code = Code::KeyF;
pub const KEY_OPEN_APP: Code = Code::KeyK;
pub const KEY_CUSTOM_DICTATION: Code = Code::KeyE;
pub const KEY_TEXT_TRANSFORM: Code = Code::KeyT;

/// Objet complet envoyé par le client lors d’un « Save » des lettres (tous les champs requis).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyKeyLettersFull {
    pub context_text: String,
    pub context_highlight: String,
    pub note_window: String,
    pub screenshot: String,
    pub recording_toggle: String,
    pub dictation: String,
    pub custom_dictation: String,
    pub screen_record: String,
    pub assistant: String,
    pub open_app: String,
    pub text_transform: String,
}

/// Lettres persistées (camelCase JSON). Chaque champ est une seule lettre A-Z.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyKeyLettersJson {
    #[serde(default)]
    pub context_text: Option<String>,
    #[serde(default)]
    pub context_highlight: Option<String>,
    #[serde(default)]
    pub note_window: Option<String>,
    #[serde(default)]
    pub screenshot: Option<String>,
    #[serde(default)]
    pub recording_toggle: Option<String>,
    #[serde(default)]
    pub dictation: Option<String>,
    #[serde(default)]
    pub custom_dictation: Option<String>,
    #[serde(default)]
    pub screen_record: Option<String>,
    #[serde(default)]
    pub assistant: Option<String>,
    #[serde(default)]
    pub open_app: Option<String>,
    #[serde(default)]
    pub text_transform: Option<String>,
}

/// Codes résolus après fusion defaults + store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HotkeyResolvedCodes {
    pub context_text: Code,
    pub context_highlight: Code,
    pub note_window: Code,
    pub screenshot: Code,
    pub recording_toggle: Code,
    pub dictation: Code,
    pub custom_dictation: Code,
    pub screen_record: Code,
    pub assistant: Code,
    pub open_app: Code,
    pub text_transform: Code,
}

impl Default for HotkeyResolvedCodes {
    fn default() -> Self {
        Self {
            context_text: KEY_CONTEXT_TEXT,
            context_highlight: KEY_CONTEXT_HIGHLIGHT,
            note_window: KEY_NOTE_WINDOW,
            screenshot: KEY_SCREENSHOT,
            recording_toggle: KEY_RECORDING_TOGGLE,
            dictation: KEY_DICTATION,
            custom_dictation: KEY_CUSTOM_DICTATION,
            screen_record: KEY_SCREEN_RECORD,
            assistant: KEY_ASSISTANT,
            open_app: KEY_OPEN_APP,
            text_transform: KEY_TEXT_TRANSFORM,
        }
    }
}

impl HotkeyResolvedCodes {
    /// Une lettre A-Z → `Code::Key*`.
    pub fn parse_letter(s: &str) -> Result<Code, String> {
        let t = s.trim();
        if t.len() != 1 {
            return Err(format!(
                "Une seule lettre attendue (A-Z), reçu : {t:?}"
            ));
        }
        let c = t
            .chars()
            .next()
            .ok_or_else(|| "lettre vide".to_string())?;
        let u = c.to_ascii_uppercase();
        if !('A'..='Z').contains(&u) {
            return Err(format!("Lettre hors plage A-Z : {u}"));
        }
        letter_upper_to_code(u).ok_or_else(|| format!("Touche non supportée : {u}"))
    }

    pub fn from_json_partial(raw: &serde_json::Value) -> Result<Self, String> {
        let partial: HotkeyKeyLettersJson = serde_json::from_value(raw.clone())
            .map_err(|e| format!("JSON raccourcis : {e}"))?;
        let mut out = Self::default();
        if let Some(ref s) = partial.context_text {
            out.context_text = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.context_highlight {
            out.context_highlight = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.note_window {
            out.note_window = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.screenshot {
            out.screenshot = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.recording_toggle {
            out.recording_toggle = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.dictation {
            out.dictation = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.custom_dictation {
            out.custom_dictation = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.screen_record {
            out.screen_record = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.assistant {
            out.assistant = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.open_app {
            out.open_app = Self::parse_letter(s)?;
        }
        if let Some(ref s) = partial.text_transform {
            out.text_transform = Self::parse_letter(s)?;
        }
        out.validate_unique()?;
        Ok(out)
    }

    /// Remplace entièrement à partir d’un objet JSON **complet** (toutes les clés).
    pub fn from_json_full(raw: &serde_json::Value) -> Result<Self, String> {
        let j: HotkeyKeyLettersFull = serde_json::from_value(raw.clone())
            .map_err(|e| format!("JSON raccourcis : {e}"))?;
        let out = Self {
            context_text: Self::parse_letter(&j.context_text)?,
            context_highlight: Self::parse_letter(&j.context_highlight)?,
            note_window: Self::parse_letter(&j.note_window)?,
            screenshot: Self::parse_letter(&j.screenshot)?,
            recording_toggle: Self::parse_letter(&j.recording_toggle)?,
            dictation: Self::parse_letter(&j.dictation)?,
            custom_dictation: Self::parse_letter(&j.custom_dictation)?,
            screen_record: Self::parse_letter(&j.screen_record)?,
            assistant: Self::parse_letter(&j.assistant)?,
            open_app: Self::parse_letter(&j.open_app)?,
            text_transform: Self::parse_letter(&j.text_transform)?,
        };
        out.validate_unique()?;
        Ok(out)
    }

    fn validate_unique(&self) -> Result<(), String> {
        let codes = [
            self.context_text,
            self.context_highlight,
            self.note_window,
            self.screenshot,
            self.recording_toggle,
            self.dictation,
            self.custom_dictation,
            self.screen_record,
            self.assistant,
            self.open_app,
            self.text_transform,
        ];
        let set: HashSet<_> = codes.iter().copied().collect();
        if set.len() != codes.len() {
            return Err(
                "Deux actions utilisent la même lettre : choisissez des lettres distinctes."
                    .into(),
            );
        }
        Ok(())
    }

    pub fn to_shortcuts_vec(&self) -> Vec<Shortcut> {
        let mut out = vec![
            Shortcut::new(Some(HOTKEY_MODIFIERS), self.context_text),
            Shortcut::new(Some(HOTKEY_MODIFIERS), self.context_highlight),
            Shortcut::new(Some(HOTKEY_MODIFIERS), self.note_window),
            Shortcut::new(Some(HOTKEY_MODIFIERS), self.screenshot),
        ];
        if REGISTER_RECORDING_TOGGLE_SHORTCUT {
            out.push(Shortcut::new(
                Some(HOTKEY_MODIFIERS),
                self.recording_toggle,
            ));
        }
        out.push(Shortcut::new(Some(HOTKEY_MODIFIERS), self.dictation));
        out.push(Shortcut::new(
            Some(HOTKEY_MODIFIERS),
            self.custom_dictation,
        ));
        out.push(Shortcut::new(Some(HOTKEY_MODIFIERS), self.screen_record));
        out.push(Shortcut::new(Some(HOTKEY_MODIFIERS), self.assistant));
        out.push(Shortcut::new(Some(HOTKEY_MODIFIERS), self.open_app));
        out.push(Shortcut::new(Some(HOTKEY_MODIFIERS), self.text_transform));
        out
    }
}

fn letter_upper_to_code(c: char) -> Option<Code> {
    match c {
        'A' => Some(Code::KeyA),
        'B' => Some(Code::KeyB),
        'C' => Some(Code::KeyC),
        'D' => Some(Code::KeyD),
        'E' => Some(Code::KeyE),
        'F' => Some(Code::KeyF),
        'G' => Some(Code::KeyG),
        'H' => Some(Code::KeyH),
        'I' => Some(Code::KeyI),
        'J' => Some(Code::KeyJ),
        'K' => Some(Code::KeyK),
        'L' => Some(Code::KeyL),
        'M' => Some(Code::KeyM),
        'N' => Some(Code::KeyN),
        'O' => Some(Code::KeyO),
        'P' => Some(Code::KeyP),
        'Q' => Some(Code::KeyQ),
        'R' => Some(Code::KeyR),
        'S' => Some(Code::KeyS),
        'T' => Some(Code::KeyT),
        'U' => Some(Code::KeyU),
        'V' => Some(Code::KeyV),
        'W' => Some(Code::KeyW),
        'X' => Some(Code::KeyX),
        'Y' => Some(Code::KeyY),
        'Z' => Some(Code::KeyZ),
        _ => None,
    }
}

fn code_to_letter(code: Code) -> char {
    key_letter(code).unwrap_or('?')
}

fn key_letter(code: Code) -> Option<char> {
    match code {
        Code::KeyA => Some('A'),
        Code::KeyB => Some('B'),
        Code::KeyC => Some('C'),
        Code::KeyD => Some('D'),
        Code::KeyE => Some('E'),
        Code::KeyF => Some('F'),
        Code::KeyG => Some('G'),
        Code::KeyH => Some('H'),
        Code::KeyI => Some('I'),
        Code::KeyJ => Some('J'),
        Code::KeyK => Some('K'),
        Code::KeyL => Some('L'),
        Code::KeyM => Some('M'),
        Code::KeyN => Some('N'),
        Code::KeyO => Some('O'),
        Code::KeyP => Some('P'),
        Code::KeyQ => Some('Q'),
        Code::KeyR => Some('R'),
        Code::KeyS => Some('S'),
        Code::KeyT => Some('T'),
        Code::KeyU => Some('U'),
        Code::KeyV => Some('V'),
        Code::KeyW => Some('W'),
        Code::KeyX => Some('X'),
        Code::KeyY => Some('Y'),
        Code::KeyZ => Some('Z'),
        _ => None,
    }
}

fn modifiers_menu_prefix(mods: Modifiers) -> String {
    let mut s = String::new();
    if mods.contains(Modifiers::META) {
        s.push('⌘');
    }
    if mods.contains(Modifiers::ALT) {
        s.push('⌥');
    }
    if mods.contains(Modifiers::CONTROL) {
        s.push('⌃');
    }
    if mods.contains(Modifiers::SHIFT) {
        s.push('⇧');
    }
    s
}

/// Suffixe menu tray, ex. ` (⌘⌥V)`.
pub fn menu_suffix_for_code(code: Code) -> String {
    let letter = code_to_letter(code);
    let p = modifiers_menu_prefix(HOTKEY_MODIFIERS);
    format!(" ({p}{letter})")
}

/// Libellé complet, ex. `"⌘⌥V"`.
pub fn shortcut_key(code: Code) -> String {
    let letter = code_to_letter(code);
    let p = modifiers_menu_prefix(HOTKEY_MODIFIERS);
    format!("{p}{letter}")
}
