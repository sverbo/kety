fn main() {
    tauri_build::build();

    // ── Compilation du tool OCR Swift (Vision.framework, macOS uniquement) ────
    #[cfg(target_os = "macos")]
    compile_ocr_tool();
    // ── Screen Capture Kit (Swift) → libkts_screen_capture.dylib ───────────────
    #[cfg(target_os = "macos")]
    compile_sck_dylib();
}

#[cfg(target_os = "macos")]
fn compile_ocr_tool() {
    use std::process::Command;

    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let source = format!("{manifest}/vendor-src/ocr.swift");
    let out = format!("{manifest}/vendor/ocr-tool");

    // Recompile si la source change.
    println!("cargo:rerun-if-changed={source}");

    // Vérifie si le binaire existe et est plus récent que la source.
    let needs_build = || -> bool {
        let src_time = std::fs::metadata(&source)
            .and_then(|m| m.modified())
            .ok();
        let bin_time = std::fs::metadata(&out)
            .and_then(|m| m.modified())
            .ok();
        match (src_time, bin_time) {
            (Some(s), Some(b)) => s > b,
            _ => true,
        }
    };

    if !needs_build() {
        return;
    }

    println!("cargo:warning=Compilation de vendor/ocr-tool (Swift + Vision.framework)…");

    let status = Command::new("swiftc")
        .args([
            "-O",
            "-framework", "Vision",
            "-framework", "CoreGraphics",
            "-framework", "Foundation",
            &source,
            "-o", &out,
        ])
        .status()
        .expect("swiftc introuvable - Xcode Command Line Tools requis (xcode-select --install)");

    if !status.success() {
        panic!("Échec de la compilation de ocr.swift - voir les erreurs ci-dessus.");
    }

    println!("cargo:warning=vendor/ocr-tool compilé avec succès.");
}

/// Capture écran native (ScreenCaptureKit + AVAssetWriter), chargée au même niveau que l’exécutable.
#[cfg(target_os = "macos")]
fn compile_sck_dylib() {
    use std::path::Path;
    use std::process::Command;

    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let src = format!("{manifest}/vendor-src/kts_screen_capture.swift");
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let dylib = format!("{out_dir}/libkts_screen_capture.dylib");

    println!("cargo:rerun-if-changed={src}");

    let target = std::env::var("TARGET").unwrap();
    let swift_target = if target.contains("aarch64") {
        "arm64-apple-macos12.3"
    } else if target.contains("x86_64") {
        "x86_64-apple-macos12.3"
    } else {
        panic!("kts_screen_capture.swift : cible {target} non prise en charge (macOS arm64/x86_64 uniquement).");
    };

    println!("cargo:warning=Compilation libkts_screen_capture.dylib (Screen Capture Kit)…");

    let status = Command::new("swiftc")
        .args([
            "-O",
            "-target",
            swift_target,
            "-framework",
            "ScreenCaptureKit",
            "-framework",
            "AVFoundation",
            "-framework",
            "CoreMedia",
            "-framework",
            "CoreVideo",
            "-framework",
            "CoreAudio",
            "-framework",
            "Foundation",
            "-emit-library",
            "-o",
            &dylib,
            &src,
        ])
        .status()
        .expect("swiftc introuvable - Xcode Command Line Tools requis.");

    if !status.success() {
        panic!("Échec de la compilation de kts_screen_capture.swift - voir les erreurs ci-dessus.");
    }

    let _ = Command::new("install_name_tool")
        .args(["-id", "@rpath/libkts_screen_capture.dylib", &dylib])
        .status();

    // Re-signe le dylib en ad-hoc (pas de Team ID) pour que DYLD accepte de le
    // charger depuis un binaire principal lui aussi ad-hoc (pas de Team ID).
    // Sans ça, macOS 13+ / CSM rejette le chargement avec "different Team IDs".
    let _ = Command::new("codesign")
        .args(["--force", "--sign", "-", &dylib])
        .status();

    println!("cargo:rustc-link-search=native={out_dir}");
    println!("cargo:rustc-link-lib=dylib=kts_screen_capture");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Resources");

    let profile = std::env::var("PROFILE").unwrap();
    let dest_dir = Path::new(&manifest)
        .join("..")
        .join("target")
        .join(&profile);
    let _ = std::fs::create_dir_all(&dest_dir);
    let _ = std::fs::copy(&dylib, dest_dir.join("libkts_screen_capture.dylib"));

    let res_dir = Path::new(&manifest).join("resources");
    let _ = std::fs::create_dir_all(&res_dir);
    let _ = std::fs::copy(&dylib, res_dir.join("libkts_screen_capture.dylib"));

    println!("cargo:warning=libkts_screen_capture.dylib prêt (target/{profile} + resources/).");
}
