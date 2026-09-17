//! macOS : focus et z-order de la fenêtre note de contexte.

use objc2::msg_send;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSWindow};
use tauri::{Runtime, WebviewWindow};

/// Active l'app KTS et donne le focus clavier à la fenêtre note.
/// Doit être appelé sur le thread principal.
pub fn activate_and_focus<R: Runtime>(tray_note: &WebviewWindow<R>) {
    // 1. Active l'application (obligatoire pour que makeKeyAndOrderFront fonctionne
    //    depuis un raccourci global où KTS n'est pas l'app de premier plan).
    unsafe {
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("[kts:tray-note] activate_and_focus: not on main thread (NSApplication)");
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let _: () = msg_send![&*app, activateIgnoringOtherApps: true];
    }

    // 2. Donne le focus clavier à la note.
    let _ = tray_note.with_webview(|w| {
        let ptr = w.ns_window();
        if ptr.is_null() {
            return;
        }
        let window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        window.makeKeyAndOrderFront(None);
    });

}
