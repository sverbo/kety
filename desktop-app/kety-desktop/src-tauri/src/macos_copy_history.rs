//! Historique « Copy history » sur macOS : enregistrement uniquement après une frappe **⌘C**
//! explicite (sans ⌥ ni ⌃), puis lecture différée du presse-papiers. Évite le polling qui
//! traitait tout changement (autres apps, ou Kety via `read_selection_via_copy` / `copy_text_to_clipboard`).
//!
//! Nécessite l’accessibilité (CGEventTap en ListenOnly, comme la dictée Fn).

use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_graphics::event::{
    CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField, KeyCode,
};
use std::time::Duration;
use tauri::AppHandle;

pub fn spawn_cmd_c_copy_history_listener(app: AppHandle) {
    std::thread::Builder::new()
        .name("kts-copy-history-cmdc".into())
        .spawn(move || {
            let app_cb = app.clone();
            let tap = match CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::KeyDown],
                move |_proxy, etype, event| {
                    if !matches!(etype, CGEventType::KeyDown) {
                        return CallbackResult::Keep;
                    }
                    if !crate::clipboard_monitor_is_enabled() {
                        return CallbackResult::Keep;
                    }
                    if crate::clipboard_copy_history_is_suppressed() {
                        return CallbackResult::Keep;
                    }
                    if event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT) != 0 {
                        return CallbackResult::Keep;
                    }
                    if event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE)
                        != KeyCode::ANSI_C as i64
                    {
                        return CallbackResult::Keep;
                    }
                    let flags = event.get_flags();
                    if !flags.contains(CGEventFlags::CGEventFlagCommand) {
                        return CallbackResult::Keep;
                    }
                    if flags.contains(CGEventFlags::CGEventFlagAlternate)
                        || flags.contains(CGEventFlags::CGEventFlagControl)
                    {
                        return CallbackResult::Keep;
                    }

                    let app2 = app_cb.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(150));
                        crate::capture_clipboard_for_user_copy_history(&app2);
                    });

                    CallbackResult::Keep
                },
            ) {
                Ok(t) => t,
                Err(()) => {
                    eprintln!(
                        "[kts:copy-history] CGEventTap (⌘C) impossible - accessibilité macOS requise. \
                         Activez-la pour l’app : l’historique des copies ne s’enregistrera pas sans ce tap."
                    );
                    return;
                }
            };

            let loop_source = match tap.mach_port().create_runloop_source(0) {
                Ok(s) => s,
                Err(()) => {
                    eprintln!("[kts:copy-history] create_runloop_source a échoué");
                    return;
                }
            };

            let rl = CFRunLoop::get_current();
            rl.add_source(&loop_source, unsafe { kCFRunLoopCommonModes });
            tap.enable();
            CFRunLoop::run_current();
        })
        .expect("kts-copy-history thread spawn");
}
