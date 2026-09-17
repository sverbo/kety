//! Capture plein écran : CoreGraphics dans le processus (TCC = l’app), puis repli `screencapture`.

use std::io::Cursor;
use std::path::PathBuf;

use core_graphics::color_space::CGColorSpace;
use core_graphics::context::CGContext;
use core_graphics::display::{CGDisplay, CGRectInfinite};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::{CGImage, CGImageAlphaInfo, CGImageByteOrderInfo};
use core_graphics::window::{
    create_image, kCGNullWindowID, kCGWindowImageBestResolution, kCGWindowListOptionOnScreenOnly,
};
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use tauri::Manager as _;
use crate::kety_paths::kety_captures_dir;

// Sur macOS (little-endian), PremultipliedFirst + ByteOrder32Little = BGRA en mémoire.
const BITMAP_INFO: u32 = (CGImageAlphaInfo::CGImageAlphaPremultipliedFirst as u32)
    | (CGImageByteOrderInfo::CGImageByteOrder32Little as u32);

fn cgimage_to_rgba_bytes(cg: &CGImage) -> Result<(Vec<u8>, usize, usize), String> {
    let width = cg.width();
    let height = cg.height();
    if width == 0 || height == 0 {
        return Err("Capture vide (0×0).".into());
    }
    let cs = CGColorSpace::create_device_rgb();
    let bytes_per_row = width * 4;
    let mut data = vec![0u8; bytes_per_row * height];
    let ctx = CGContext::create_bitmap_context(
        Some(data.as_mut_ptr() as *mut std::ffi::c_void),
        width,
        height,
        8,
        bytes_per_row,
        &cs,
        BITMAP_INFO,
    );
    let rect = CGRect::new(
        &CGPoint::new(0.0, 0.0),
        &CGSize::new(width as f64, height as f64),
    );
    ctx.draw_image(rect, cg);
    ctx.flush();

    // CoreGraphics produit du BGRA sur macOS (little-endian) ; on permute R et B pour obtenir RGBA.
    for pixel in data.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Ok((data, width, height))
}

fn rgba_to_png_bytes(data: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new(Cursor::new(&mut out))
        .write_image(data, width as u32, height as u32, ExtendedColorType::Rgba8)
        .map_err(|e| format!("Encodage PNG : {e}"))?;
    Ok(out)
}

fn cgimage_to_png_bytes(cg: &CGImage) -> Result<Vec<u8>, String> {
    let width = cg.width();
    let height = cg.height();
    eprintln!(
        "[kts:opt-b] cgimage_to_png_bytes: {}×{} px, bits/px={}",
        width,
        height,
        cg.bits_per_pixel()
    );
    let (data, w, h) = cgimage_to_rgba_bytes(cg)?;
    let out = rgba_to_png_bytes(&data, w, h)?;
    eprintln!("[kts:opt-b] PNG encodé, {} octets", out.len());
    Ok(out)
}

fn capture_cgimage() -> Option<CGImage> {
    let main = CGDisplay::main().image();
    if let Some(ref img) = main {
        eprintln!(
            "[kts:opt-b] CGDisplay::main().image() → Some ({}×{})",
            img.width(),
            img.height()
        );
        return main;
    }
    eprintln!("[kts:opt-b] CGDisplay::main().image() → None (permission ou échec CG)");
    let composite = unsafe {
        create_image(
            CGRectInfinite,
            kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
            kCGWindowImageBestResolution,
        )
    };
    if let Some(ref img) = composite {
        eprintln!(
            "[kts:opt-b] CGWindowListCreateImage (CGRectInfinite) → Some ({}×{})",
            img.width(),
            img.height()
        );
    } else {
        eprintln!("[kts:opt-b] CGWindowListCreateImage (CGRectInfinite) → None");
    }
    composite
}

fn screencapture_to_path(path: &std::path::Path) -> Result<(), String> {
    eprintln!(
        "[kts:opt-b] repli: /usr/sbin/screencapture -x -t png → {}",
        path.display()
    );
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "png"])
        .arg(path)
        .status()
        .map_err(|e| format!("screencapture : {e}"))?;
    if status.success() {
        eprintln!("[kts:opt-b] screencapture: succès (exit 0)");
        return Ok(());
    }
    let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
    eprintln!("[kts:opt-b] screencapture: échec, code de sortie={code}");
    Err(format!(
        "screencapture a échoué (code {code}) - permission Enregistrement d’écran ?"
    ))
}

/// Ouvre le sélecteur interactif macOS (comme Cmd+Shift+4) et retourne le chemin PNG.
/// Retourne `Ok(None)` si l'utilisateur a annulé (Échap).
pub fn capture_interactive_png(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = kety_captures_dir(app)?;
    let name = format!(
        "{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );
    let path = dir.join(&name);
    eprintln!("[kts:opt-b] capture interactive → {}", path.display());

    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-t", "png"])
        .arg(&path)
        .status()
        .map_err(|e| format!("screencapture : {e}"))?;

    if !status.success() {
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        return Err(format!("screencapture a échoué (code {code})"));
    }
    // L'utilisateur a appuyé sur Échap : screencapture sort avec 0 mais ne crée pas le fichier.
    if !path.exists() {
        eprintln!("[kts:opt-b] capture annulée (pas de fichier)");
        return Ok(None);
    }
    eprintln!("[kts:opt-b] capture interactive OK ({} octets)", std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0));
    Ok(Some(path))
}

/// Captures only the Kety app window bounds as a base64-encoded PNG.
/// Gets the main window position and size, captures the full screen via
/// CoreGraphics, then crops the RGBA buffer to the window rect.
pub fn capture_as_base64_png(app: &tauri::AppHandle) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    eprintln!("[feedback:screenshot] capture_as_base64_png: start");

    // Get main window geometry in physical pixels
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let pos = win.outer_position().map_err(|e: tauri::Error| e.to_string())?;
    let size = win.outer_size().map_err(|e: tauri::Error| e.to_string())?;
    eprintln!(
        "[feedback:screenshot] window pos=({},{}) size={}×{}",
        pos.x, pos.y, size.width, size.height
    );

    let cg = capture_cgimage().ok_or_else(|| {
        let msg = "Screen capture unavailable - please grant Screen Recording permission in System Settings › Privacy & Security.".to_string();
        eprintln!("[feedback:screenshot] capture_cgimage() returned None: {msg}");
        msg
    })?;
    let (rgba, full_w, full_h) = cgimage_to_rgba_bytes(&cg)?;
    eprintln!("[feedback:screenshot] full screen {}×{}", full_w, full_h);

    // Clamp window rect to screen bounds
    let x0 = (pos.x.max(0) as usize).min(full_w);
    let y0 = (pos.y.max(0) as usize).min(full_h);
    let crop_w = (size.width as usize).min(full_w.saturating_sub(x0));
    let crop_h = (size.height as usize).min(full_h.saturating_sub(y0));

    if crop_w == 0 || crop_h == 0 {
        return Err("Window is outside the screen bounds.".to_string());
    }

    // Copy cropped rows
    let stride = full_w * 4;
    let mut cropped = Vec::with_capacity(crop_w * crop_h * 4);
    for row in 0..crop_h {
        let src = (y0 + row) * stride + x0 * 4;
        cropped.extend_from_slice(&rgba[src..src + crop_w * 4]);
    }

    let png = rgba_to_png_bytes(&cropped, crop_w, crop_h)?;
    eprintln!(
        "[feedback:screenshot] cropped {}×{}, PNG {} bytes, encoding base64…",
        crop_w, crop_h, png.len()
    );
    let b64 = STANDARD.encode(&png);
    eprintln!("[feedback:screenshot] done, base64 len={}", b64.len());
    Ok(b64)
}

pub fn capture_fullscreen_png(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = kety_captures_dir(app)?;
    eprintln!(
        "[kts:opt-b] capture_fullscreen_png: captures_dir={}",
        dir.display()
    );
    let name = format!(
        "{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );
    let path = dir.join(&name);
    eprintln!("[kts:opt-b] fichier cible={}", path.display());

    if let Some(cg) = capture_cgimage() {
        eprintln!("[kts:opt-b] voie CoreGraphics + encodage PNG interne");
        let bytes = cgimage_to_png_bytes(&cg)?;
        std::fs::write(&path, &bytes).map_err(|e| format!("Écriture PNG : {e}"))?;
        eprintln!(
            "[kts:opt-b] écrit {} octets sur disque",
            bytes.len()
        );
        return Ok(path);
    }

    eprintln!("[kts:opt-b] aucune CGImage - tentative screencapture");
    screencapture_to_path(&path)?;
    let len = std::fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(0);
    eprintln!("[kts:opt-b] fichier screencapture {} octets", len);
    Ok(path)
}
