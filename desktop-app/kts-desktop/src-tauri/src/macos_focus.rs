//! Échantillon de l’app et de la fenêtre au premier plan (macOS), sans capture d’écran.
//! Les titres de fenêtre via Quartz nécessitent souvent la permission « Enregistrement d’écran ».

use core::ffi::c_void;
use core::ptr;

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::dictionary::CFDictionaryGetValueIfPresent;
use core_graphics::display::CGDisplay;
use core_graphics::window::{
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
};
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSBundle, NSString};
use serde::Serialize;
use std::borrow::Cow;
use std::ffi::CStr;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSample {
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub process_id: i32,
    pub app_hidden: bool,
    pub activation_policy: i32,
    pub bundle_path: Option<String>,
    pub executable_path: Option<String>,
    pub window_number: Option<u32>,
    pub window_name: Option<String>,
    pub window_owner_name: Option<String>,
    pub window_layer: Option<i32>,
    pub window_bounds: Option<WindowBounds>,
    pub window_alpha: Option<f64>,
}

fn ns_string_to_opt_string(ns: Option<objc2::rc::Retained<NSString>>) -> Option<String> {
    let s = ns?;
    let ptr = s.UTF8String();
    if ptr.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .ok()
        .map(str::to_owned)
}

fn ns_url_path(url: Option<objc2::rc::Retained<objc2_foundation::NSURL>>) -> Option<String> {
    ns_string_to_opt_string(url.and_then(|u| u.path()))
}

fn cfstring_to_string(cf: &CFString) -> String {
    Cow::from(cf).into_owned()
}

fn dict_cfstring(dict: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<String> {
    let k = CFString::from_static_string(key);
    dict.find(&k)
        .and_then(|v| (*v).clone().downcast::<CFString>())
        .map(|s| cfstring_to_string(&s))
}

fn dict_i32(dict: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<i32> {
    let k = CFString::from_static_string(key);
    dict.find(&k)
        .and_then(|v| (*v).clone().downcast::<CFNumber>())
        .and_then(|n| n.to_i32())
}

fn dict_f64(dict: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<f64> {
    let k = CFString::from_static_string(key);
    dict.find(&k)
        .and_then(|v| (*v).clone().downcast::<CFNumber>())
        .and_then(|n| n.to_f64())
}

/// Dictionnaire « plist » dont les clés sont des `CFString` (ex. `kCGWindowBounds` → sous-dict).
unsafe fn cf_dictionary_get_f64(dict: CFDictionaryRef, key: &'static str) -> Option<f64> {
    let k = CFString::from_static_string(key);
    let mut val: *const c_void = ptr::null();
    if CFDictionaryGetValueIfPresent(dict, k.as_CFTypeRef().cast(), &mut val) == 0 {
        return None;
    }
    if val.is_null() {
        return None;
    }
    CFType::wrap_under_get_rule(val)
        .downcast::<CFNumber>()
        .and_then(|n| n.to_f64())
}

fn dict_bounds(dict: &CFDictionary<CFString, CFType>) -> Option<WindowBounds> {
    let k = CFString::from_static_string("kCGWindowBounds");
    let bounds_dict: CFDictionary = dict.find(&k).and_then(|v| (*v).clone().downcast::<CFDictionary>())?;
    let dref = bounds_dict.as_concrete_TypeRef();
    let x = unsafe { cf_dictionary_get_f64(dref, "X")? };
    let y = unsafe { cf_dictionary_get_f64(dref, "Y")? };
    let width = unsafe { cf_dictionary_get_f64(dref, "Width")? };
    let height = unsafe { cf_dictionary_get_f64(dref, "Height")? };
    Some(WindowBounds {
        x,
        y,
        width,
        height,
    })
}

/// Première fenêtre à l’écran (ordre z global) appartenant au PID donné, calque « normal » (0).
fn top_window_row_for_pid(windows: &core_foundation::array::CFArray<*const std::ffi::c_void>, pid: i32) -> Option<CFDictionary<CFString, CFType>> {
    let count = windows.len();
    for i in 0..count {
        let ptr = *windows.get(i)?;
        if ptr.is_null() {
            continue;
        }
        let dict: CFDictionary<CFString, CFType> = unsafe {
            CFDictionary::wrap_under_get_rule(ptr as CFDictionaryRef)
        };
        let owner_pid = dict_i32(&dict, "kCGWindowOwnerPID")?;
        if owner_pid != pid {
            continue;
        }
        let layer = dict_i32(&dict, "kCGWindowLayer").unwrap_or(0);
        if layer != 0 {
            continue;
        }
        return Some(dict);
    }
    None
}

/// Bundle identifier of this process (reste correct si le nom affiché de l’app change).
pub fn self_bundle_identifier() -> Option<String> {
    let bundle = NSBundle::mainBundle();
    ns_string_to_opt_string(bundle.bundleIdentifier())
}

pub fn sample_frontmost_focus() -> Option<FocusSample> {
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;

    let app_name = ns_string_to_opt_string(app.localizedName());
    let bundle_id = ns_string_to_opt_string(app.bundleIdentifier());
    let process_id = app.processIdentifier();
    let app_hidden = app.isHidden();
    let activation_policy = app.activationPolicy().0 as i32;
    let bundle_path = ns_url_path(app.bundleURL());
    let executable_path = ns_url_path(app.executableURL());

    let window_list = CGDisplay::window_list_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        None,
    );

    let mut window_number = None;
    let mut window_name = None;
    let mut window_owner_name = None;
    let mut window_layer = None;
    let mut window_bounds = None;
    let mut window_alpha = None;

    if let Some(windows) = window_list {
        if let Some(row) = top_window_row_for_pid(&windows, process_id) {
            window_number = dict_i32(&row, "kCGWindowNumber").map(|n| n as u32);
            window_name = dict_cfstring(&row, "kCGWindowName").filter(|s| !s.is_empty());
            window_owner_name = dict_cfstring(&row, "kCGWindowOwnerName");
            window_layer = dict_i32(&row, "kCGWindowLayer");
            window_bounds = dict_bounds(&row);
            window_alpha = dict_f64(&row, "kCGWindowAlpha");
        }
    }
    // kCGWindowName nécessite Screen Recording ; fallback via Accessibility (AXTitle).
    if window_name.is_none() {
        window_name = crate::macos_ax_selection::window_title_via_accessibility(process_id);
    }

    Some(FocusSample {
        app_name,
        bundle_id,
        process_id,
        app_hidden,
        activation_policy,
        bundle_path,
        executable_path,
        window_number,
        window_name,
        window_owner_name,
        window_layer,
        window_bounds,
        window_alpha,
    })
}

/// Centre of the frontmost window, so the HUD lands on the display the user is *working* on rather
/// than the one the pointer happens to be over.
///
/// **Global logical points, top-left origin** — `kCGWindowBounds` is in points, not backing pixels,
/// and this is the same space as `CGDisplayBounds`. It is not the space Tauri calls physical; see
/// [`crate::hud_display`] for what happens when the two are confused.
pub fn frontmost_key_window_center_point() -> Option<(f64, f64)> {
    let sample = sample_frontmost_focus()?;
    let b = sample.window_bounds.as_ref()?;
    Some((b.x + b.width * 0.5, b.y + b.height * 0.5))
}

/// Stable context for Google Meet captions from the Chrome extension (avoid frontmost = Kety, etc.).
pub fn google_meet_bridge_focus_sample() -> FocusSample {
    FocusSample {
        app_name: Some("Google Chrome".to_string()),
        bundle_id: Some("com.google.Chrome".to_string()),
        process_id: 0,
        app_hidden: false,
        activation_policy: 0,
        bundle_path: None,
        executable_path: None,
        window_number: None,
        window_name: Some("Google Meet".to_string()),
        window_owner_name: Some("Google Chrome".to_string()),
        window_layer: None,
        window_bounds: None,
        window_alpha: None,
    }
}

/// PID de l'app frontmost courante (0 si inconnu).
/// Appel léger : pas de requête Quartz ni d'AX.
pub fn frontmost_pid() -> i32 {
    let workspace = NSWorkspace::sharedWorkspace();
    workspace
        .frontmostApplication()
        .map(|a| a.processIdentifier())
        .unwrap_or(0)
}

/// Réactive une app par son PID (typiquement pour rendre le focus à l'app
/// qui était au premier plan avant que l'utilisateur ait cliqué le HUD).
/// Ne fait rien si `pid` ≤ 0 ou si l'app n'est plus en vie.
pub fn reactivate_app_by_pid(pid: i32) {
    if pid <= 0 {
        return;
    }
    if let Some(running_app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        // ActivateIgnoringOtherApps (1<<1) = passe devant toutes les autres fenêtres.
        #[allow(deprecated)]
        let opts = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
        let _ = running_app.activateWithOptions(opts);
    }
}

pub fn fingerprint(sample: &FocusSample) -> String {
    format!(
        "{}|{}|{}|{}",
        sample.bundle_id.as_deref().unwrap_or(""),
        sample.process_id,
        sample.window_number.unwrap_or(0),
        sample.window_name.as_deref().unwrap_or("")
    )
}
