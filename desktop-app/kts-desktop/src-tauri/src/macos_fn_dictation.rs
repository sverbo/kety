//! Touche Fn / Globe : dictée « champ » (écoute CGEvent FlagsChanged, bit SecondaryFn).
//! N'utilise pas `RegisterEventHotKey` (pas de scancode Fn) - tap CoreGraphics en ListenOnly.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use tauri::{Emitter, Manager};
use core_graphics::event::{
    CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult,
};
use tauri::AppHandle;

/// Horodatage (ms) du dernier front Fn/Globe (appui), pour relâchement long ≥ 2 s.
static FN_DICTATION_PRESS_MS: AtomicU64 = AtomicU64::new(0);

pub(super) fn spawn_fn_dictation_listener(app: AppHandle, shortcut_enabled: Arc<AtomicBool>) {
    std::thread::Builder::new()
        .name("kts-fn-dictation-tap".into())
        .spawn(move || {
            let prev_fn_down = Arc::new(std::sync::Mutex::new(false));
            let prev_for_cb = Arc::clone(&prev_fn_down);
            let app_cb = app.clone();
            let enabled_cb = Arc::clone(&shortcut_enabled);

            let tap = match CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::FlagsChanged],
                move |_proxy, _etype, event| {
                    if !enabled_cb.load(Ordering::SeqCst) {
                        return CallbackResult::Keep;
                    }
                    let flags = event.get_flags();
                    let fn_down = flags.contains(CGEventFlags::CGEventFlagSecondaryFn);

                    let mut prev = match prev_for_cb.lock() {
                        Ok(g) => g,
                        Err(_) => return CallbackResult::Keep,
                    };
                    if fn_down == *prev {
                        return CallbackResult::Keep;
                    }
                    *prev = fn_down;
                    drop(prev);

                    let app = app_cb.clone();
                    if fn_down {
                        handle_fn_pressed(&app);
                    } else {
                        handle_fn_released(&app);
                    }
                    CallbackResult::Keep
                },
            ) {
                Ok(t) => t,
                Err(()) => {
                    eprintln!(
                        "[kts:fn-dictation] impossible de créer le CGEventTap (Accessibility requise ?)"
                    );
                    return;
                }
            };

            let loop_source = match tap.mach_port().create_runloop_source(0) {
                Ok(s) => s,
                Err(()) => {
                    eprintln!("[kts:fn-dictation] create_runloop_source a échoué");
                    return;
                }
            };

            let rl = CFRunLoop::get_current();
            rl.add_source(&loop_source, unsafe { kCFRunLoopCommonModes });
            tap.enable();
            CFRunLoop::run_current();
        })
        .expect("kts-fn-dictation thread spawn");
}

fn handle_fn_pressed(app: &AppHandle) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FN_DICTATION_PRESS_MS.store(now_ms, Ordering::SeqCst);

    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(dict_state) = app2.try_state::<crate::dictation::DictationActiveState>() else {
            return;
        };
        let Some(sr_state) = app2.try_state::<crate::screen_record::ScreenRecordState>() else {
            return;
        };

        if dict_state.is_recording.load(Ordering::SeqCst) {
            if !dict_state.fn_field_dictation.load(Ordering::SeqCst) {
                return;
            }
            let app3 = app2.clone();
            std::thread::spawn(move || {
                if let Err(e) = crate::dictation_commands::stop_dictation_cmd(app3.clone(), app3.state()) {
                    eprintln!("[kts:dictation] stop via Fn (toggle): {e}");
                }
            });
            return;
        }

        if dict_state.is_processing.load(Ordering::SeqCst)
            || sr_state.is_recording.load(Ordering::SeqCst)
            || sr_state.is_processing.load(Ordering::SeqCst)
        {
            crate::tray_commands::warn_hud_busy(&app2);
            return;
        }

        if !crate::dictation_commands::dictation_is_functional(&app2) {
            let _ = app2.emit(crate::whisper_setup::EVT_NOT_INSTALLED, ());
            return;
        }

        let app3 = app2.clone();
        std::thread::spawn(move || {
            if let Err(e) = crate::dictation_commands::start_dictation_fn_hotkey(&app3) {
                eprintln!("[kts:dictation] start via Fn: {e}");
            }
        });
    });
}

fn handle_fn_released(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(dict_state) = app2.try_state::<crate::dictation::DictationActiveState>() else {
            return;
        };
        if !dict_state.is_recording.load(Ordering::SeqCst) {
            return;
        }
        if !dict_state.fn_field_dictation.load(Ordering::SeqCst) {
            return;
        }
        let press_ms = FN_DICTATION_PRESS_MS.load(Ordering::SeqCst);
        if press_ms == 0 {
            return;
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let held_ms = now_ms.saturating_sub(press_ms);
        eprintln!("[kts:dictation] relâchement Fn, tenu={held_ms}ms");
        if held_ms < 2000 {
            return;
        }
        let app3 = app2.clone();
        std::thread::spawn(move || {
            if let Err(e) = crate::dictation_commands::stop_dictation_cmd(app3.clone(), app3.state()) {
                eprintln!("[kts:dictation] stop via relâchement Fn: {e}");
            }
        });
    });
}
