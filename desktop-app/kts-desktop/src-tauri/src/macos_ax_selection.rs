//! Texte sélectionné dans l’UI au premier plan, via macOS Accessibility (AX)
//! ou via simulation ⌘C + presse-papiers (fallback universel).

use core_foundation::base::{CFRelease, TCFType};
use core_foundation::string::CFString;
use std::ffi::c_void;
use std::ptr;

// ── CGEvent keyboard simulation (⌘V) ─────────────────────────────────────────

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceCreate(state_id: i32) -> *const c_void;
    fn CGEventCreateKeyboardEvent(source: *const c_void, keycode: u16, keydown: bool) -> *const c_void;
    fn CGEventSetFlags(event: *const c_void, flags: u64);
    fn CGEventPost(tap_location: i32, event: *const c_void);
    fn CGEventPostToPid(pid: i32, event: *const c_void);
}

const KVK_ANSI_C: u16 = 8;
const KVK_ANSI_V: u16 = 9;
const KCG_EVENT_FLAG_MASK_COMMAND: u64 = 0x0010_0000;
const KCG_HID_EVENT_TAP: i32 = 0;
const KCG_EVENT_SOURCE_STATE_HID_SYSTEM: i32 = 1;

unsafe fn simulate_cmd_key(keycode: u16) {
    let source = CGEventSourceCreate(KCG_EVENT_SOURCE_STATE_HID_SYSTEM);
    let ev_down = CGEventCreateKeyboardEvent(source, keycode, true);
    if !ev_down.is_null() {
        CGEventSetFlags(ev_down, KCG_EVENT_FLAG_MASK_COMMAND);
        CGEventPost(KCG_HID_EVENT_TAP, ev_down);
        CFRelease(ev_down as *const c_void);
    }
    let ev_up = CGEventCreateKeyboardEvent(source, keycode, false);
    if !ev_up.is_null() {
        CGEventSetFlags(ev_up, 0);
        CGEventPost(KCG_HID_EVENT_TAP, ev_up);
        CFRelease(ev_up as *const c_void);
    }
    if !source.is_null() {
        CFRelease(source as *const c_void);
    }
}

/// Simule une frappe ⌘C via CGEventPost (copier la sélection).
unsafe fn simulate_cmd_c_to_pid(pid: i32) {
    let source = CGEventSourceCreate(KCG_EVENT_SOURCE_STATE_HID_SYSTEM);
    let ev_down = CGEventCreateKeyboardEvent(source, KVK_ANSI_C, true);
    if !ev_down.is_null() {
        CGEventSetFlags(ev_down, KCG_EVENT_FLAG_MASK_COMMAND);
        CGEventPostToPid(pid, ev_down);
        CFRelease(ev_down as *const c_void);
    }
    let ev_up = CGEventCreateKeyboardEvent(source, KVK_ANSI_C, false);
    if !ev_up.is_null() {
        CGEventSetFlags(ev_up, 0);
        CGEventPostToPid(pid, ev_up);
        CFRelease(ev_up as *const c_void);
    }
    if !source.is_null() {
        CFRelease(source as *const c_void);
    }
}

/// Simule une frappe ⌘V via CGEventPost (coller depuis le presse-papiers).
unsafe fn simulate_cmd_v() { simulate_cmd_key(KVK_ANSI_V); }

/// Simule ⌘C ciblé sur `target_pid`, lit le presse-papiers résultant, restaure l'ancien contenu.
/// Utiliser `CGEventPostToPid` garantit que la copie va à la bonne app même si KTS
/// a brièvement pris le focus au moment de l'interception du raccourci global.
/// Retourne le texte sélectionné, ou None si le presse-papiers n'a pas changé.
pub fn read_selection_via_copy(target_pid: i32) -> Option<String> {
    // Kety simule ⌘C ici : éviter que l’historique « copy history » prenne ce contenu pour une copie utilisateur.
    crate::clipboard_copy_history_suppress_for_ms(700);
    let previous = arboard::Clipboard::new().ok().and_then(|mut c| c.get_text().ok());

    unsafe { simulate_cmd_c_to_pid(target_pid); }

    // Laisse le temps à l'app cible de traiter ⌘C et mettre à jour le presse-papiers.
    std::thread::sleep(std::time::Duration::from_millis(100));

    let after = arboard::Clipboard::new().ok().and_then(|mut c| c.get_text().ok());

    // Restaure le presse-papiers.
    if let Ok(mut clip) = arboard::Clipboard::new() {
        match &previous {
            Some(prev) => { let _ = clip.set_text(prev.clone()); }
            None => { let _ = clip.clear(); }
        }
    }

    // Si le presse-papiers n'a pas changé, rien n'était sélectionné.
    if after == previous {
        eprintln!("[kts:selection] ⌘C → clipboard inchangé (pid={target_pid}), rien sélectionné");
        return None;
    }

    after.filter(|s| !s.trim().is_empty())
}

type AXUIElementRef = *const c_void;
type CFTypeRef = *const c_void;

const AX_OK: i32 = 0;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> i32;
}

struct CfReleaseGuard(CFTypeRef);

impl Drop for CfReleaseGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CFRelease(self.0);
            }
        }
    }
}


/// Retourne le titre de la fenêtre focalisée pour le processus `pid` via l’API AX.
/// Fonctionne sans permission Screen Recording (utilise Accessibility à la place).
pub fn window_title_via_accessibility(pid: i32) -> Option<String> {
    unsafe {
        let app_elem = AXUIElementCreateApplication(pid);
        if app_elem.is_null() {
            return None;
        }
        let _app_guard = CfReleaseGuard(app_elem as CFTypeRef);

        let attr_window = CFString::from_static_string("AXFocusedWindow");
        let mut window: CFTypeRef = ptr::null();
        let err = AXUIElementCopyAttributeValue(
            app_elem,
            attr_window.as_concrete_TypeRef() as CFTypeRef,
            &mut window,
        );
        if err != AX_OK || window.is_null() {
            return None;
        }
        let _window_guard = CfReleaseGuard(window);

        let attr_title = CFString::from_static_string("AXTitle");
        let mut title: CFTypeRef = ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window as AXUIElementRef,
            attr_title.as_concrete_TypeRef() as CFTypeRef,
            &mut title,
        );
        if err != AX_OK || title.is_null() {
            return None;
        }

        let cf = CFString::wrap_under_create_rule(title as *const _);
        let s = cf.to_string();
        if s.is_empty() { None } else { Some(s) }
    }
}

/// Rôle `AXRole` de l’élément UI actuellement focalisé (toute app), si l’API Accessibility le fournit.
pub fn focused_ui_ax_role() -> Option<String> {
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return None;
        }
        let _sys_guard = CfReleaseGuard(sys as CFTypeRef);

        let attr_focused = CFString::from_static_string("AXFocusedUIElement");
        let mut focused: CFTypeRef = ptr::null();
        let err = AXUIElementCopyAttributeValue(
            sys,
            attr_focused.as_concrete_TypeRef() as CFTypeRef,
            &mut focused,
        );
        if err != AX_OK || focused.is_null() {
            return None;
        }
        let _focused_guard = CfReleaseGuard(focused);

        let attr_role = CFString::from_static_string("AXRole");
        let mut role_val: CFTypeRef = ptr::null();
        let err = AXUIElementCopyAttributeValue(
            focused as AXUIElementRef,
            attr_role.as_concrete_TypeRef() as CFTypeRef,
            &mut role_val,
        );
        if err != AX_OK || role_val.is_null() {
            return None;
        }
        let role_cf = CFString::wrap_under_create_rule(role_val as *const _);
        Some(role_cf.to_string())
    }
}

/// Injecte `text` dans l’élément focalisé via presse-papiers + simulation ⌘V.
/// Sauvegarde et restaure le contenu précédent du presse-papiers.
/// Retourne vrai si les événements ont pu être postés.
pub fn insert_text_via_paste(text: &str) -> bool {
    // Dictée injectée : presse-papiers rempli puis restauré - ne doit pas compter comme « copie » utilisateur.
    crate::clipboard_copy_history_suppress_for_ms(500);
    // Sauvegarde du presse-papiers actuel.
    let previous = arboard::Clipboard::new().ok().and_then(|mut c| c.get_text().ok());

    // Place le texte dans le presse-papiers.
    let Ok(mut clip) = arboard::Clipboard::new() else {
        return false;
    };
    if clip.set_text(text).is_err() {
        return false;
    }

    // Simule ⌘V.
    unsafe { simulate_cmd_v(); }
    eprintln!("[kts:dictation] ⌘V simulé pour injection dans le champ focalisé");

    // L’app lit le presse-papiers quasi-immédiatement ; 60 ms suffisent amplement.
    std::thread::sleep(std::time::Duration::from_millis(60));
    if let Some(prev) = previous {
        let _ = arboard::Clipboard::new().and_then(|mut c| c.set_text(prev));
    } else {
        // Vide le presse-papiers si rien n’était stocké avant.
        let _ = arboard::Clipboard::new().and_then(|mut c| c.clear());
    }

    true
}

/// Retourne le texte sélectionné exposé par AX pour l’élément UI focalisé (toute app).
pub fn selected_text_via_accessibility() -> Option<String> {
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return None;
        }
        let _sys_guard = CfReleaseGuard(sys as CFTypeRef);

        let attr_focused = CFString::from_static_string("AXFocusedUIElement");
        let mut focused: CFTypeRef = ptr::null();
        let err = AXUIElementCopyAttributeValue(
            sys,
            attr_focused.as_concrete_TypeRef() as CFTypeRef,
            &mut focused,
        );
        if err != AX_OK || focused.is_null() {
            return None;
        }
        let _focused_guard = CfReleaseGuard(focused);

        let attr_text = CFString::from_static_string("AXSelectedText");
        let mut selected: CFTypeRef = ptr::null();
        let err = AXUIElementCopyAttributeValue(
            focused as AXUIElementRef,
            attr_text.as_concrete_TypeRef() as CFTypeRef,
            &mut selected,
        );
        if err != AX_OK || selected.is_null() {
            return None;
        }

        let cf = CFString::wrap_under_create_rule(selected as *const _);
        let s = cf.to_string();
        Some(s)
    }
}
