//! Local MCP API — tiny_http server on 127.0.0.1:47847
//!
//! Speaks the **Streamable HTTP** transport (MCP spec 2025-03-26 and later):
//! one endpoint, `POST /mcp`, carrying a single JSON-RPC message per request.
//! It replaces the deprecated two-endpoint HTTP+SSE shape (`GET /sse` plus
//! `POST /message?sessionId=…`), which was removed rather than kept alongside.
//!
//! Every tool call is answered synchronously from the local index, so the
//! server always replies `Content-Type: application/json` with a single JSON
//! object. The spec allows exactly this as the alternative to opening an SSE
//! stream, and it keeps the server free of per-connection state.
//!
//! Routes:
//!   GET    /health  → `{"status":"ok"}`, open, says only that the app is up
//!   POST   /mcp     → MCP JSON-RPC (requires `Authorization: Bearer <token>`)
//!   GET    /mcp     → 405: no server-initiated stream is offered
//!   DELETE /mcp     → 405: sessions are not used, so there is none to end
//!
//! Security: loopback keeps nobody out — every local process reaches it, and so
//! does any web page the user opens, since the browser runs on this machine.
//! So: a bearer token on every MCP route, no `Access-Control-Allow-Origin`
//! header at all, and any request carrying an `Origin` header is refused with
//! 403 (only a browser sends one; no MCP client is a browser). The token is
//! re-read from env/store on every request, so regenerating it in Settings
//! takes effect immediately, with no restart.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_store::StoreExt;

use crate::http_auth::{self, AuthOutcome};
use crate::kety_paths;

pub const MCP_PORT: u16 = 47847;

/// The single MCP endpoint required by the Streamable HTTP transport.
const MCP_PATH: &str = "/mcp";

/// Env override wins over the stored token, mirroring `meet_bridge`.
const ENV_TOKEN: &str = "KETY_MCP_TOKEN";
const STORE_KEY_TOKEN: &str = "mcpApiToken";

/// Protocol versions this server will answer `initialize` with. If the client
/// asks for one of these, it is echoed back; otherwise it is told `PREFERRED`.
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// The version whose semantics this server implements, used when a client asks
/// for something unrecognised.
const PREFERRED_PROTOCOL_VERSION: &str = "2025-06-18";

/// Frontend's local-profile session store (see `appStore.ts` / `sessionStoreUser.ts`
/// in the React app). The MCP HTTP server runs outside any per-request Tauri
/// `invoke()` call, so it has no other way to learn which local profile is
/// active — it reads the same on-disk store the frontend already persists to.
const FRONTEND_SESSION_STORE_FILE: &str = "kts/kts-session-store.json";
const ACTIVE_PROFILE_STORE_KEY: &str = "kts:activeProfileId";

/// Set once the listener has actually bound, so Settings can tell the user
/// whether the port is live instead of guessing.
static LISTENING: AtomicBool = AtomicBool::new(false);

// ── Types ─────────────────────────────────────────────────────────────────────

type Resp = tiny_http::Response<std::io::Cursor<Vec<u8>>>;

// ── Token ─────────────────────────────────────────────────────────────────────

/// Env token wins; otherwise the non-empty stored token.
///
/// Resolved on **every** request rather than cached, so a token regenerated in
/// Settings applies to the very next call without restarting the app.
pub fn mcp_token_for_request(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(t) = std::env::var(ENV_TOKEN) {
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

/// True when `KETY_MCP_TOKEN` is set, in which case Settings cannot change the
/// token — the environment overrides whatever is stored.
fn token_is_from_env() -> bool {
    std::env::var(ENV_TOKEN)
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false)
}

/// Generates and stores a token on first run, unless the env var supplies one.
pub fn ensure_mcp_token_persisted(app: &tauri::AppHandle) {
    if token_is_from_env() {
        return;
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
    let _ = store.set(STORE_KEY_TOKEN, json!(uuid::Uuid::new_v4().to_string()));
    let _ = store.save();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// A JSON response. Carries no CORS header: nothing that legitimately talks to
/// this server is a browser, so granting a web origin read access would only
/// help a hostile page.
fn json_resp(status: u16, body: Value) -> Resp {
    let data = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    tiny_http::Response::from_data(data)
        .with_status_code(tiny_http::StatusCode(status))
        .with_header(tiny_http::Header::from_bytes(b"Content-Type", b"application/json").unwrap())
}

/// An empty response, for the 202 and 405 cases that must not carry a body.
fn empty_resp(status: u16) -> Resp {
    tiny_http::Response::from_data(Vec::new()).with_status_code(tiny_http::StatusCode(status))
}

/// A JSON-RPC error response with no `id`, which the spec allows as the body of
/// an HTTP error for a message the server could not accept.
fn rpc_error_body(code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": Value::Null,
        "error": { "code": code, "message": message }
    })
}

fn get_user_id(app: &tauri::AppHandle) -> Option<String> {
    let store = app.store(FRONTEND_SESSION_STORE_FILE).ok()?;
    let uid = store.get(ACTIVE_PROFILE_STORE_KEY)?.as_str()?.to_string();
    if uid.is_empty() { None } else { Some(uid) }
}

fn read_body(req: &mut tiny_http::Request) -> String {
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    body
}

/// Picks the `protocolVersion` to answer `initialize` with: the client's own
/// choice when recognised, otherwise the version this server implements.
fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
    match requested {
        Some(v) => SUPPORTED_PROTOCOL_VERSIONS
            .iter()
            .find(|s| **s == v)
            .copied()
            .unwrap_or(PREFERRED_PROTOCOL_VERSION),
        None => PREFERRED_PROTOCOL_VERSION,
    }
}

/// The spec requires `400 Bad Request` for an unsupported `MCP-Protocol-Version`
/// header. An absent header means a pre-header client, which is fine.
fn protocol_version_header_ok(value: Option<&str>) -> bool {
    match value {
        None => true,
        Some(v) => {
            let v = v.trim();
            v.is_empty() || SUPPORTED_PROTOCOL_VERSIONS.contains(&v)
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

// Kept for Tauri ACL compatibility (no longer invoked).
#[tauri::command]
pub fn get_mcp_server_path_cmd(_app: tauri::AppHandle) -> String {
    String::new()
}

/// What Settings needs to show the MCP section: whether the port is live,
/// whether a profile is active, and the token to copy into a client config.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpApiInfo {
    pub listening: bool,
    pub authenticated: bool,
    pub port: u16,
    pub token: String,
    /// True when `KETY_MCP_TOKEN` is set, so Settings can explain why the
    /// regenerate button will not work.
    pub token_from_env: bool,
}

/// Reads the current MCP API state. Called over Tauri `invoke`, not over HTTP,
/// so the Settings screen never has to make a cross-origin request to the
/// listener — which is what lets the listener refuse every `Origin` outright.
#[tauri::command]
pub fn mcp_api_info_cmd(app: tauri::AppHandle) -> McpApiInfo {
    ensure_mcp_token_persisted(&app);
    McpApiInfo {
        listening: LISTENING.load(Ordering::Relaxed),
        authenticated: get_user_id(&app).is_some(),
        port: MCP_PORT,
        token: mcp_token_for_request(&app).unwrap_or_default(),
        token_from_env: token_is_from_env(),
    }
}

/// Replaces the stored token with a fresh one. The old token stops working on
/// the next request, because the token is re-read per request.
#[tauri::command]
pub fn regenerate_mcp_api_token_cmd(app: tauri::AppHandle) -> Result<String, String> {
    if token_is_from_env() {
        return Err(
            "Your access key is set by the KETY_MCP_TOKEN environment variable, so it can't be changed here. Remove that variable and restart Kety to manage the key from this screen."
                .to_string(),
        );
    }
    let store = app
        .store(kety_paths::SESSION_STORE_FILE)
        .map_err(|_| "Could not open Kety's settings store to save a new access key.".to_string())?;
    let fresh = uuid::Uuid::new_v4().to_string();
    store.set(STORE_KEY_TOKEN, json!(fresh.clone()));
    store
        .save()
        .map_err(|_| "Could not save the new access key.".to_string())?;
    Ok(fresh)
}

// ── Server startup ────────────────────────────────────────────────────────────

pub fn start_mcp_api_server(app: tauri::AppHandle) {
    ensure_mcp_token_persisted(&app);
    std::thread::spawn(move || {
        let addr = format!("127.0.0.1:{MCP_PORT}");
        let server = match tiny_http::Server::http(&addr) {
            Ok(s) => s,
            Err(e) => { eprintln!("[mcp] bind failed: {e}"); return; }
        };
        LISTENING.store(true, Ordering::Relaxed);
        eprintln!("[mcp] listening on http://{addr}{MCP_PATH} (Authorization: Bearer …)");
        for req in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || handle_req(app, req));
        }
    });
}

// ── Request dispatch ──────────────────────────────────────────────────────────

fn handle_req(app: tauri::AppHandle, mut req: tiny_http::Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or(&url).to_string();
    let method = req.method().to_string();

    let origin = http_auth::header_value(&req, "Origin").map(str::to_string);

    // Nothing that legitimately reaches this server is a browser, so an Origin
    // header means a web page is probing the port. Refuse before doing any work
    // — and before looking at the token, so a page cannot use the response to
    // tell a right token from a wrong one.
    if origin.as_deref().map(|o| !o.trim().is_empty()).unwrap_or(false) {
        let _ = req.respond(json_resp(
            403,
            rpc_error_body(-32600, "Requests from a web browser are not accepted."),
        ));
        return;
    }

    // `/health` stays open: it answers only "the app is up", with no user id, no
    // sign-in state and no data. Anything more would be a free probe for a
    // hostile local process.
    if method == "GET" && path == "/health" {
        let _ = req.respond(json_resp(200, json!({ "status": "ok" })));
        return;
    }

    // Every MCP route needs the token.
    let expected = mcp_token_for_request(&app);
    let authorization = http_auth::header_value(&req, "Authorization").map(str::to_string);
    match http_auth::check_request_auth(None, authorization.as_deref(), expected.as_deref()) {
        AuthOutcome::Allowed => {}
        AuthOutcome::NotConfigured => {
            let _ = req.respond(json_resp(
                503,
                rpc_error_body(
                    -32600,
                    "Kety has no access key yet. Open Kety, go to Settings and copy the key from the MCP section.",
                ),
            ));
            return;
        }
        // Never say which part was wrong, and never echo the token back.
        _ => {
            let _ = req.respond(json_resp(
                401,
                rpc_error_body(
                    -32600,
                    "Missing or invalid access key. Copy the key from Kety's Settings, MCP section.",
                ),
            ));
            return;
        }
    }

    if path != MCP_PATH {
        let _ = req.respond(json_resp(404, rpc_error_body(-32600, "Not found.")));
        return;
    }

    let protocol_header = http_auth::header_value(&req, "MCP-Protocol-Version").map(str::to_string);
    if !protocol_version_header_ok(protocol_header.as_deref()) {
        let _ = req.respond(json_resp(
            400,
            rpc_error_body(-32600, "Unsupported MCP protocol version."),
        ));
        return;
    }

    match method.as_str() {
        "POST" => {
            let body = read_body(&mut req);
            let _ = req.respond(handle_streamable_post(&app, &body));
        }
        // The spec lets a server decline the server-initiated stream with 405.
        // Every response here is produced synchronously on the POST, so there is
        // nothing this stream would ever carry.
        "GET" => {
            let _ = req.respond(empty_resp(405));
        }
        // No session id is issued, so there is no session for a client to end.
        "DELETE" => {
            let _ = req.respond(empty_resp(405));
        }
        _ => {
            let _ = req.respond(empty_resp(405));
        }
    }
}

// ── Streamable HTTP: the single POST endpoint ─────────────────────────────────

/// Handles one JSON-RPC message posted to the MCP endpoint.
///
/// Per the transport spec: a *request* gets `200` with a single JSON object,
/// while a *notification* or *response* — neither of which carries an `id` —
/// gets `202 Accepted` with no body.
fn handle_streamable_post(app: &tauri::AppHandle, body: &str) -> Resp {
    let msg: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => {
            return json_resp(400, rpc_error_body(-32700, "Parse error."));
        }
    };

    let Some(id) = msg.get("id").filter(|v| !v.is_null()).cloned() else {
        // A notification (or a response to something we never asked). Accepted,
        // with nothing to say back.
        return empty_resp(202);
    };

    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    let result = match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(|v| v.as_str());
            Ok(json!({
                "protocolVersion": negotiate_protocol_version(requested),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "kety-mcp", "version": "1.0.0" }
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools_list()),
        "tools/call" => tools_call(app, &params),
        _ => Err((-32601, format!("Method not found: {method}"))),
    };

    let payload = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    };
    json_resp(200, payload)
}

// ── Tool definitions ──────────────────────────────────────────────────────────

fn tools_list() -> Value {
    json!({ "tools": [
        {
            "name": "check_connection",
            "description": "Check whether the Kety desktop app is running and the user is authenticated. Call this first.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] }
        },
        {
            "name": "list_assistants",
            "description": "List accessible knowledge bases: the user's own and any shared assistants.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] }
        },
        {
            "name": "list_tags",
            "description": "List available tags with their names and descriptions.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] }
        },
        {
            "name": "search",
            "description": "Search the Kety knowledge base using the configured embedding model + BM25 hybrid search (same as the in-app AI assistant, fast, offline).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query." },
                    "tagIds": { "type": "array", "items": { "type": "string" }, "description": "Optional tag IDs to filter results." }
                },
                "required": ["query"]
            }
        }
    ]})
}

fn tools_call(app: &tauri::AppHandle, params: &Value) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or((-32602, "missing tool name".to_string()))?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    let run = || -> Result<String, String> {
        Ok(match name {
            "check_connection" => {
                serde_json::to_string_pretty(&connection_status(app)).unwrap_or_default()
            }
            "list_assistants" => {
                serde_json::to_string_pretty(&list_assistants(app)?).unwrap_or_default()
            }
            "list_tags" => serde_json::to_string_pretty(&list_tags(app)?).unwrap_or_default(),
            "search" => {
                let query = args
                    .get("query")
                    .and_then(|q| q.as_str())
                    .ok_or("missing query")?;
                let tag_ids = args.get("tagIds").and_then(|t| t.as_array()).map(|arr| {
                    arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()
                });
                serde_json::to_string_pretty(&do_search(app, query, tag_ids)?).unwrap_or_default()
            }
            _ => return Err(format!("Unknown tool: {name}")),
        })
    };

    match run() {
        Ok(text) => Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": false })),
        // A tool that fails is reported inside the result, not as a protocol
        // error — that is what lets the model read the message and react.
        Err(e) => Ok(json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
    }
}

// ── check_connection ──────────────────────────────────────────────────────────

/// Richer than `/health`: this one is behind the token, so it may name the
/// active profile.
fn connection_status(app: &tauri::AppHandle) -> Value {
    let uid = get_user_id(app);
    json!({ "status": "ok", "authenticated": uid.is_some(), "userId": uid })
}

// ── list_assistants ───────────────────────────────────────────────────────────

fn list_assistants(app: &tauri::AppHandle) -> Result<Value, String> {
    let user_id = get_user_id(app)
        .ok_or_else(|| "Not authenticated. Open the Kety app and sign in.".to_string())?;

    let list = vec![json!({
        "id": null,
        "name": "My knowledge base",
        "description": "Your own captured knowledge — notes, screenshots, documents, and recordings.",
        "owner": "self",
        "userId": user_id,
    })];

    Ok(json!({ "assistants": list }))
}

// ── list_tags ─────────────────────────────────────────────────────────────────

fn list_tags(app: &tauri::AppHandle) -> Result<Value, String> {
    let user_id = get_user_id(app)
        .ok_or_else(|| "Not authenticated. Open the Kety app and sign in.".to_string())?;

    let db_path = crate::kety_paths::local_index_db_path(app, &user_id, None)
        .map_err(|e| format!("DB path: {e}"))?;

    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| format!("DB open: {e}"))?;

    let tags = crate::local_index::list_tags_for_user(&conn, &user_id)
        .map_err(|e| format!("List tags: {e}"))?;

    let result: Vec<Value> = tags.iter().map(|t| json!({
        "id": t.id,
        "name": t.name,
        "description": if t.description.is_empty() { Value::Null } else { t.description.clone().into() },
        "color": t.color,
    })).collect();

    Ok(json!({ "tags": result }))
}

// ── search ────────────────────────────────────────────────────────────────────

fn do_search(
    app: &tauri::AppHandle,
    query: &str,
    tag_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    let user_id = get_user_id(app)
        .ok_or_else(|| "Not authenticated. Open the Kety app and sign in.".to_string())?;

    if query.trim().is_empty() {
        return Err("query must not be empty".to_string());
    }

    search_local(app, query, &tag_ids, &user_id)
}

fn search_local(
    app: &tauri::AppHandle,
    query: &str,
    tag_ids: &Option<Vec<String>>,
    user_id: &str,
) -> Result<Value, String> {
    let index = app.try_state::<crate::local_index::LocalIndexState>()
        .ok_or("Local index state not available")?;

    // Read OpenAI API key from session store (only used if the active model needs it).
    // The same store `get_user_id` reads: the per-profile `u:<id>:openAiApiKey` key is
    // written by the frontend into `kts/`, and the legacy `kety/` store does not hold it.
    let openai_key: Option<String> = {
        let store = app.store(FRONTEND_SESSION_STORE_FILE)
            .map_err(|e| format!("Session store: {e}"))?;
        store.get(format!("u:{}:openAiApiKey", user_id))
            .and_then(|v| v.as_str().map(String::from))
            .filter(|s| !s.trim().is_empty())
    };

    // MCP client is Claude Code — large context window, always use API-mode params.
    // No assistant context here, so no embed model override: falls back to meta.active_embed_model.
    // No assistant selection over MCP yet: always the profile's own index.
    let hits = crate::local_index_commands::embed_and_hybrid_search(
        app, user_id, None, query, query,
        openai_key.as_deref(), None, tag_ids.clone(), None,
        crate::local_index::top_k_api(), crate::local_index::ExpandConfig::api(), &index,
    )?;

    let hit_values: Vec<Value> = hits.iter().map(|h| json!({
        "captureId": h.capture_id,
        "text": h.chunk_text,
        "title": h.title,
        "kind": h.kind,
        "score": h.score,
    })).collect();

    Ok(json!({ "hits": hit_values, "source": "local" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_echoes_a_version_the_client_asked_for() {
        assert_eq!(negotiate_protocol_version(Some("2025-11-25")), "2025-11-25");
        assert_eq!(negotiate_protocol_version(Some("2025-03-26")), "2025-03-26");
        assert_eq!(negotiate_protocol_version(Some("2024-11-05")), "2024-11-05");
    }

    #[test]
    fn negotiation_falls_back_for_unknown_or_absent_versions() {
        assert_eq!(negotiate_protocol_version(None), PREFERRED_PROTOCOL_VERSION);
        assert_eq!(
            negotiate_protocol_version(Some("1999-01-01")),
            PREFERRED_PROTOCOL_VERSION
        );
    }

    #[test]
    fn protocol_version_header_accepts_known_versions_and_absence() {
        assert!(protocol_version_header_ok(None));
        assert!(protocol_version_header_ok(Some("")));
        assert!(protocol_version_header_ok(Some("2025-06-18")));
        assert!(protocol_version_header_ok(Some(" 2025-11-25 ")));
    }

    #[test]
    fn protocol_version_header_rejects_an_unsupported_version() {
        assert!(!protocol_version_header_ok(Some("2023-01-01")));
        assert!(!protocol_version_header_ok(Some("nonsense")));
    }
}
