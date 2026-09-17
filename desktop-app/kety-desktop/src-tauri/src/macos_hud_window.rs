//! macOS : arrondi natif du `NSWindow` (fenêtre sans décorations + transparente : le seul CSS laisse les coins carrés au niveau du cadre).

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSColor, NSView, NSWindow};
use tauri::WebviewWindow;

/// Aligné sur `border-radius` du shell HUD (`DictationHud.css`).
const HUD_CORNER_RADIUS: f64 = 11.0;

pub fn apply_hud_rounded_corners(hud: &WebviewWindow) {
    let res = hud.with_webview(|w| {
        // ── WKWebView transparent ─────────────────────────────────────────
        // `transparent: true` dans tauri.conf.json rend la NSWindow transparente,
        // mais la WKWebView conserve son propre fond blanc par défaut.
        let wv_ptr = w.inner() as *mut AnyObject;
        if !wv_ptr.is_null() {
            // SAFETY : pointeur WKWebView valide fourni par wry.
            unsafe {
                let _: () = msg_send![&*wv_ptr, setOpaque: false];
                let _: () = msg_send![&*wv_ptr, _setDrawsBackground: false];
            }
        }

        // ── NSWindow transparent (force, au cas où Tauri ne le fait pas) ──
        let ptr = w.ns_window();
        if ptr.is_null() {
            return;
        }
        // SAFETY : pointeur `NSWindow` valide pour cette webview (wry).
        let window = unsafe { &*(ptr as *const NSWindow) };
        unsafe {
            let _: () = msg_send![window, setOpaque: false];
            let clear = NSColor::clearColor();
            let _: () = msg_send![window, setBackgroundColor: &*clear];
        }

        // ── Coins arrondis natifs ─────────────────────────────────────────
        let Some(content) = window.contentView() else {
            return;
        };
        let view: &NSView = &*content;
        view.setWantsLayer(true);
        let Some(layer) = view.layer() else {
            return;
        };
        layer.setCornerRadius(HUD_CORNER_RADIUS);
        layer.setMasksToBounds(true);
    });
    if let Err(e) = res {
        eprintln!("[kts:hud] coins arrondis natifs : {e}");
    }
}
