//! Local HTTP listener: Chrome extension posts Google Meet captions into Kety.
//!
//! Secret: `KETY_MEET_BRIDGE_TOKEN` (env) overrides `meetBridgeToken` in the session store.
//! If neither is set, a UUID is generated once and saved to `meetBridgeToken` on first startup.
//! Port: `KETY_MEET_BRIDGE_PORT` (env) overrides `meetBridgePort` in store (default **17171**).
//! The listener binds once at startup; changing the port in Settings requires restarting Kety.
//! The secret is re-read from env/store on every request (no restart needed when the token changes).
//!
//! Endpoints (after `Authorization: Bearer …`):
//! - `GET /v1/chrome-extension-config` → `{ "autoSendMeetCaptures": bool }` - mirrors Kety
//!   Settings → Chrome extension. When true, the extension may POST non-manual caption updates
//!   (if enabled in a build) and **auto-syncs** the stored transcript when the Meet tab closes.
//! - `POST /v1/google-meet-captions` → JSON `{ segmentId, text, manual?: bool }`

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
use tiny_http::{Header, Method, Response, Server};
use zip::write::FileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

use crate::http_auth::bearer_matches;
use crate::kety_paths;

const DEFAULT_PORT: u16 = 17171;
const PATH_CAPTIONS: &str = "/v1/google-meet-captions";
const PATH_CONFIG: &str = "/v1/chrome-extension-config";
const STORE_KEY_AUTO: &str = "chromeExtensionAutoMeetCaptures";
const STORE_KEY_TOKEN: &str = "meetBridgeToken";
const STORE_KEY_PORT: &str = "meetBridgePort";

fn read_auto_send_meet_captures(app: &tauri::AppHandle) -> bool {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return true;
    };
    store
        .get(STORE_KEY_AUTO)
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn json_response(code: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let bytes = body.as_bytes().to_vec();
    let mut r = Response::from_data(bytes)
        .with_status_code(code)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
                .unwrap(),
        );
    r.add_header(
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
    );
    r.add_header(
        Header::from_bytes(
            &b"Access-Control-Allow-Headers"[..],
            &b"Authorization, Content-Type"[..],
        )
        .unwrap(),
    );
    r.add_header(
        Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..]).unwrap(),
    );
    r
}

fn read_body(req: &mut tiny_http::Request) -> Result<String, String> {
    let mut buf = Vec::new();
    req.as_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("read body: {e}"))?;
    String::from_utf8(buf).map_err(|e| format!("utf-8 body: {e}"))
}

fn url_path(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

/// Env token wins; otherwise non-empty session store string.
pub fn meet_bridge_token_for_request(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(t) = std::env::var("KETY_MEET_BRIDGE_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return None;
    };
    store.get(STORE_KEY_TOKEN).and_then(|v| {
        v.as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

fn meet_bridge_port_from_store(app: &tauri::AppHandle) -> Option<u16> {
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return None;
    };
    store
        .get(STORE_KEY_PORT)
        .and_then(|v| v.as_u64())
        .map(|u| u as u16)
        .filter(|&p| p > 0)
}

/// Port for HTTP binding at process start: env overrides store, then default.
fn meet_bridge_bind_port(app: &tauri::AppHandle) -> u16 {
    if let Ok(s) = std::env::var("KETY_MEET_BRIDGE_PORT") {
        if let Ok(p) = s.trim().parse::<u16>() {
            if p > 0 {
                return p;
            }
        }
    }
    meet_bridge_port_from_store(app).unwrap_or(DEFAULT_PORT)
}

/// Port value for presets / extension zip (env overrides store).
pub fn meet_bridge_effective_port(app: &tauri::AppHandle) -> u16 {
    if let Ok(s) = std::env::var("KETY_MEET_BRIDGE_PORT") {
        if let Ok(p) = s.trim().parse::<u16>() {
            if p > 0 {
                return p;
            }
        }
    }
    meet_bridge_port_from_store(app).unwrap_or(DEFAULT_PORT)
}

/// If env token is unset and store has no token, generate one and persist.
pub fn ensure_meet_bridge_token_persisted(app: &tauri::AppHandle) {
    if let Ok(t) = std::env::var("KETY_MEET_BRIDGE_TOKEN") {
        if !t.trim().is_empty() {
            return;
        }
    }
    let Ok(store) = app.store(kety_paths::SESSION_STORE_FILE) else {
        return;
    };
    let existing = store.get(STORE_KEY_TOKEN).and_then(|v| {
        v.as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });
    if existing.is_some() {
        return;
    }
    let new_t = uuid::Uuid::new_v4().to_string();
    let _ = store.set(STORE_KEY_TOKEN, json!(new_t));
    let _ = store.save();
}

fn handle_get_config(app: &tauri::AppHandle, req: tiny_http::Request) -> Result<(), std::io::Error> {
    let on = read_auto_send_meet_captures(app);
    let body = serde_json::json!({ "autoSendMeetCaptures": on }).to_string();
    let _ = req.respond(json_response(200, &body));
    Ok(())
}

fn handle_post_captions(
    app: &tauri::AppHandle,
    mut req: tiny_http::Request,
) -> Result<(), std::io::Error> {
    let body = match read_body(&mut req) {
        Ok(b) => b,
        Err(e) => {
            let msg = serde_json::json!({ "ok": false, "error": "bad_request", "detail": e }).to_string();
            let _ = req.respond(json_response(400, &msg));
            return Ok(());
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            let msg =
                serde_json::json!({ "ok": false, "error": "invalid_json", "detail": e.to_string() })
                    .to_string();
            let _ = req.respond(json_response(400, &msg));
            return Ok(());
        }
    };

    let manual = parsed
        .get("manual")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);

    if !manual && !read_auto_send_meet_captures(app) {
        let msg = serde_json::json!({
            "ok": false,
            "error": "auto_send_disabled",
            "detail": "Meet auto-capture is off in Kety → Settings → Chrome extension. Non-manual posts are rejected; close-tab auto-sync is off too-use Sync with app in the extension, or turn the setting on."
        })
        .to_string();
        let _ = req.respond(json_response(403, &msg));
        return Ok(());
    }

    let segment_id = parsed
        .get("segmentId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let text = parsed
        .get("text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let result = crate::capture_dispatch::upsert_google_meet_caption(app, &segment_id, &text, manual);
    match result {
        Ok(()) => {
            let _ = req.respond(json_response(200, r#"{"ok":true}"#));
        }
        Err(e) => {
            let msg = serde_json::json!({ "ok": false, "error": "rejected", "detail": e }).to_string();
            let _ = req.respond(json_response(422, &msg));
        }
    }
    Ok(())
}

fn handle_one(app: &tauri::AppHandle, req: tiny_http::Request) -> Result<(), std::io::Error> {
    if req.method() == &Method::Options {
        let _ = req.respond(json_response(204, ""));
        return Ok(());
    }

    let Some(expected_token) = meet_bridge_token_for_request(app) else {
        let msg = serde_json::json!({
            "ok": false,
            "error": "meet_bridge_not_configured",
            "detail": "No Meet listener secret yet. Open Kety → Settings → Chrome extension and save a secret (or restart Kety once so one is generated automatically)."
        })
        .to_string();
        let _ = req.respond(json_response(503, &msg));
        return Ok(());
    };

    if !bearer_matches(&req, &expected_token) {
        let _ = req.respond(json_response(
            401,
            r#"{"ok":false,"error":"unauthorized"}"#,
        ));
        return Ok(());
    }

    let path = url_path(req.url());
    match (req.method(), path) {
        (&Method::Get, PATH_CONFIG) => handle_get_config(app, req),
        (&Method::Post, PATH_CAPTIONS) => handle_post_captions(app, req),
        _ => {
            let _ = req.respond(json_response(
                404,
                r#"{"ok":false,"error":"not_found"}"#,
            ));
            Ok(())
        }
    }
}

pub fn maybe_spawn_meet_bridge(app: tauri::AppHandle) {
    ensure_meet_bridge_token_persisted(&app);

    let port = meet_bridge_bind_port(&app);
    let addr = format!("127.0.0.1:{port}");
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[kty:meet-bridge] could not listen on http://{addr}: {e}");
            return;
        }
    };

    eprintln!(
        "[kty:meet-bridge] listening on http://127.0.0.1:{port} - GET {PATH_CONFIG} , POST {PATH_CAPTIONS} (Authorization: Bearer …)"
    );

    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            if let Err(e) = handle_one(&app, req) {
                eprintln!("[kty:meet-bridge] response error: {e}");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    });
}

fn reveal_exported_file(path: &Path) {
    #[cfg(target_os = "macos")]
    if let Some(s) = path.to_str() {
        let _ = std::process::Command::new("open").args(["-R", s]).status();
    }
    #[cfg(target_os = "windows")]
    if let Some(s) = path.to_str() {
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{s}"))
            .status();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(parent) = path.parent().and_then(|p| p.to_str()) {
        let _ = std::process::Command::new("xdg-open").arg(parent).status();
    }
}

fn resolve_chrome_extension_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("chrome-extension");
        if p.join("manifest.json").is_file() {
            return Ok(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../chrome-extension");
    if dev.join("manifest.json").is_file() {
        return Ok(dev);
    }
    Err(
        "Chrome extension folder not found (expected bundled Resources/chrome-extension or ../../../chrome-extension)."
            .to_string(),
    )
}

fn zip_entry_name(root: &Path, file: &Path) -> Result<String, String> {
    let rel = file.strip_prefix(root).map_err(|e| e.to_string())?;
    let s = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if s.is_empty() {
        return Err("empty zip entry".to_string());
    }
    Ok(s)
}

fn collect_extension_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut stack = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(dir) = stack.pop() {
        let rd = fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for ent in rd {
            let ent = ent.map_err(|e| format!("dir entry: {e}"))?;
            let p = ent.path();
            let ft = ent
                .file_type()
                .map_err(|e| format!("file_type: {e}"))?;
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                if p.file_name().and_then(|n| n.to_str()) == Some("kety-bridge-preset.json") {
                    continue;
                }
                files.push(p);
            }
        }
    }
    Ok(files)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeExtensionExportResult {
    pub path: String,
    pub bridge_token: String,
    pub bridge_port: u16,
}

/// Writes `kety-google-meet-extension.zip` to Downloads (with numeric suffix if needed), including
/// `kety-bridge-preset.json`. Ensures a listener secret exists in the store (generates one if needed)
/// so the ZIP always matches what Kety uses.
pub fn export_chrome_extension_zip(app: &tauri::AppHandle) -> Result<ChromeExtensionExportResult, String> {
    ensure_meet_bridge_token_persisted(app);
    let token = meet_bridge_token_for_request(app).ok_or_else(|| {
        "Could not resolve Meet listener secret after ensuring defaults.".to_string()
    })?;
    let port = meet_bridge_effective_port(app);
    let src = resolve_chrome_extension_dir(app)?;
    let files = collect_extension_files(&src)?;

    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Downloads folder unavailable: {e}"))?;
    let base_name = "kety-google-meet-extension.zip";
    let mut path: PathBuf = dir.join(base_name);
    if path.exists() {
        for i in 1..10_000 {
            let candidate = dir.join(format!("kety-google-meet-extension-{i}.zip"));
            if !candidate.exists() {
                path = candidate;
                break;
            }
        }
    }

    let file = File::create(&path).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let opts: FileOptions<'_, ()> =
        FileOptions::default().compression_method(CompressionMethod::Deflated);

    for fp in &files {
        let name = zip_entry_name(&src, fp)?;
        let mut f = File::open(fp).map_err(|e| format!("open {}: {e}", fp.display()))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| format!("read {}: {e}", fp.display()))?;
        zip.start_file(name, opts)
            .map_err(|e| format!("zip start_file: {e}"))?;
        zip.write_all(&buf)
            .map_err(|e| format!("zip write: {e}"))?;
    }

    let preset = serde_json::json!({
        "presetVersion": 1,
        "bridgeToken": token,
        "bridgePort": port,
    });
    let preset_bytes = serde_json::to_vec_pretty(&preset).map_err(|e| e.to_string())?;
    zip.start_file("kety-bridge-preset.json", opts)
        .map_err(|e| format!("zip preset: {e}"))?;
    zip.write_all(&preset_bytes)
        .map_err(|e| format!("zip preset write: {e}"))?;
    zip.finish().map_err(|e| format!("zip finish: {e}"))?;

    let path_str = path
        .to_str()
        .ok_or_else(|| "Export path is not valid UTF-8".to_string())?
        .to_string();
    reveal_exported_file(Path::new(&path_str));
    Ok(ChromeExtensionExportResult {
        path: path_str,
        bridge_token: token,
        bridge_port: port,
    })
}
