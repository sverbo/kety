//! Local SQLite index Tauri commands (captures, tags, search, sqlite inspector).

use crate::{embed_setup, local_index, EmbedLockState};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSaveCaptureReq {
    id: String,
    user_id: Option<String>,
    raw_text: Option<String>,
    explanation: Option<String>,
    title: Option<String>,
    kind: String,
    sub_kind: Option<String>,
    local_path: Option<String>,
    tag_ids: Option<Vec<String>>,
    sensitive_state: Option<String>,
    created_at: Option<String>,
    meta: Option<String>,
    raw_content: Option<Vec<String>>,
    app_name: Option<String>,
    window_name: Option<String>,
    size_kb: Option<i64>,
    process_doc_index_doc: Option<bool>,
    index_meet_raw_transcript: Option<bool>,
    kety_server_path: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSaveTagReq {
    id: String,
    name: String,
    description: String,
    color: String,
    auto_assign_apps: Vec<String>,
    created_at: String,
}

// ── SQLite inspector types ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SqliteTableData {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
}

#[derive(serde::Serialize)]
pub struct SqliteExecuteResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    rows_affected: i64,
}

// ── Commands ──────────────────────────────────────────────────────────────────
//
// Read and write split by signature, not by a runtime check.
//
// The commands that only read an index take an `assistant_id: Option<String>`:
// `None` is the profile's own index, `Some(id)` an index imported from someone
// else. The commands that add, change or remove content take no such parameter,
// so they have no way to name an imported index — an imported index is read-only
// because nothing on the write side can address one, not because someone
// remembered to check. Adding the parameter to a write command would silently
// destroy that guarantee; do not.
//
// Two commands sit on the read side despite writing rows: `local_embed_missing_cmd`
// and `local_clear_embed_errors_cmd`. They only ever add vectors (and clear failed
// ones) so a foreign index is searchable when the recipient does not have the
// sender's embedding model. They never add a capture, never add a chunk, and never
// change content.

#[tauri::command]
pub fn local_index_capture_cmd(
    app: tauri::AppHandle,
    user_id: String,
    req: local_index::IndexCaptureRequest,
    embed_lock: tauri::State<'_, EmbedLockState>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<(), String> {
    let _embed_guard = embed_lock.0.blocking_lock();
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    local_index::index_capture(&app, conn, &req)
}

#[tauri::command]
pub fn local_hard_delete_capture_cmd(
    app: tauri::AppHandle,
    user_id: String,
    capture_id: String,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<Option<String>, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    local_index::hard_delete_capture(conn, &capture_id)
}

#[tauri::command]
pub fn local_index_stats_cmd(
    app: tauri::AppHandle,
    user_id: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<local_index::LocalIndexStats, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    local_index::get_stats(conn)
}

#[tauri::command]
pub fn local_unindex_captures_cmd(
    app: tauri::AppHandle,
    user_id: String,
    capture_ids: Vec<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<(), String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    local_index::unindex_captures(conn, &capture_ids)
}

#[tauri::command]
pub fn local_reindex_captures_cmd(
    app: tauri::AppHandle,
    user_id: String,
    capture_ids: Vec<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<(), String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    local_index::requeue_captures(conn, &capture_ids)
}

#[tauri::command]
pub fn local_index_state_counts_cmd(
    app: tauri::AppHandle,
    user_id: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<local_index::IndexStateCounts, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    local_index::count_index_states(conn)
}

/// Index one batch of pending captures for `user_id`, returning how many were indexed.
///
/// Shared by `local_index_pending_cmd` (the frontend's "index it now" trigger) and
/// the background loop in `auto_index`, so both go through exactly the same steps.
///
/// Two lock disciplines, both load-bearing:
/// - the embed lock is the async mutex that serialises embedding, so a manual index
///   and a background tick queue behind each other instead of racing;
/// - the connection mutex is a std `Mutex`. It is taken only to read the DB path and
///   released before any `.await`, and the connection used for embedding is opened
///   fresh inside `spawn_blocking`. Never hold it across an await, and never embed
///   while it is held.
pub(crate) async fn index_pending_for_user(
    app: &tauri::AppHandle,
    user_id: &str,
    openai_api_key: Option<String>,
    limit: usize,
    embed_lock: &EmbedLockState,
    index: &local_index::LocalIndexState,
) -> Result<usize, String> {
    let _embed_guard = embed_lock.0.lock().await;
    let db_path = {
        let mut guard = index.0.lock().map_err(|e| e.to_string())?;
        guard.db_path_for(app, user_id, None)?
    };
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Ask the cheap question first. `open_migrated_db` below rebuilds `chunks_fts`
        // from every row of `chunks` and `stat`s every capture with a local path, and
        // the background loop reaches this line every fifteen seconds whether or not a
        // capture is waiting. On an idle app that is the entire cost of the loop, paid
        // to learn there is nothing to do — and invisible, because the answer is `Ok(0)`.
        //
        // A capture that arrives between this peek and the open below is not lost: it
        // stays `pending` in the database and the next tick finds it, fifteen seconds
        // later. That is the same delay the peek returning "nothing waiting" already
        // means, so the window costs nothing that was not already the loop's cadence.
        //
        // Only a definite "nothing is pending" skips. `None` — no database yet, a
        // schema older than `index_state`, an unreadable file — takes the full path,
        // which is the one equipped to answer.
        if local_index::any_capture_pending(&db_path) == Some(false) {
            return Ok(0);
        }
        // open_migrated_db, not a bare open: this runs on every auto-index tick and
        // must not fail on a profile whose DB predates the index_state columns.
        // Own: there is no `assistant_id` here and this indexes the profile's captures.
        let conn = local_index::open_migrated_db(&db_path, local_index::IndexKind::Own)?;
        let model: String = conn
            .query_row("SELECT value FROM meta WHERE key='active_embed_model'", [], |r| r.get(0))
            .unwrap_or_default();
        local_index::index_pending_captures(
            &app_clone, &conn, &model, openai_api_key.as_deref(), limit,
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking panic: {e}"))?
}

/// Index pending captures on demand. Polling lives in Rust (`auto_index`); this
/// command stays so the app can index immediately after a capture is added instead
/// of waiting for the next background tick.
#[tauri::command]
pub async fn local_index_pending_cmd(
    app: tauri::AppHandle,
    user_id: String,
    openai_api_key: Option<String>,
    limit: Option<usize>,
    embed_lock: tauri::State<'_, EmbedLockState>,
    index: tauri::State<'_, local_index::LocalIndexState>,
) -> Result<usize, String> {
    index_pending_for_user(
        &app,
        &user_id,
        openai_api_key,
        limit.unwrap_or(10),
        &embed_lock,
        &index,
    )
    .await
}

#[tauri::command]
pub fn local_model_coverage_cmd(
    app: tauri::AppHandle,
    user_id: String,
    embed_model: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<local_index::ModelCoverage, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    local_index::model_coverage(conn, &embed_model)
}

#[tauri::command]
pub fn local_coverage_by_model_cmd(
    app: tauri::AppHandle,
    user_id: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<Vec<local_index::ModelCoverage>, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    local_index::coverage_by_model(conn)
}

/// Embed the chunks that have no vector for `embed_model`.
///
/// On the read side even though it writes: it only ever *adds* vectors, which is
/// what makes an imported index searchable when the recipient does not run the
/// sender's embedding model. It adds no capture, adds no chunk, and changes no
/// content — so pointing it at an imported index does not make that index writable.
#[tauri::command]
pub async fn local_embed_missing_cmd(
    app: tauri::AppHandle,
    user_id: String,
    embed_model: String,
    openai_api_key: Option<String>,
    limit: Option<usize>,
    assistant_id: Option<String>,
    embed_lock: tauri::State<'_, EmbedLockState>,
    index: tauri::State<'_, local_index::LocalIndexState>,
) -> Result<local_index::EmbedMissingResult, String> {
    let _embed_guard = embed_lock.0.lock().await;
    let db_path = {
        let mut guard = index.0.lock().map_err(|e| e.to_string())?;
        guard.db_path_for(&app, &user_id, assistant_id.as_deref())?
    };
    // Derived from the same `assistant_id` the path was: this command is the other
    // door onto an imported index, and opening one as `Own` would delete it on a
    // failed open exactly as `get_for` used to.
    let kind = local_index::IndexKind::of(assistant_id.as_deref());
    let limit = limit.unwrap_or(25);
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = local_index::open_migrated_db(&db_path, kind)?;
        local_index::embed_missing_for_model(
            &app_clone, &conn, &embed_model, openai_api_key.as_deref(), limit,
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking panic: {e}"))?
}

/// Clear the failure markers left by a previous indexing pass for one model, so the
/// user can explicitly retry them. Deletes only this model's `status='error'` rows:
/// no chunk and no other model's vectors are touched. That is why it pairs with
/// `local_embed_missing_cmd` on the read side and may name an `assistant_id`.
#[tauri::command]
pub fn local_clear_embed_errors_cmd(
    app: tauri::AppHandle,
    user_id: String,
    embed_model: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<usize, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    local_index::clear_error_embeddings_for_model(conn, &embed_model)
}

#[tauri::command]
pub fn local_save_capture_cmd(
    app: tauri::AppHandle,
    user_id: String,
    req: LocalSaveCaptureReq,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<(), String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let tag_ids_json = req.tag_ids.as_ref().map(|ids| serde_json::to_string(ids).unwrap_or_default());
    let raw_content_json = req.raw_content.as_ref().map(|v| serde_json::to_string(v).unwrap_or_default());
    let do_save = |conn: &rusqlite::Connection| local_index::save_capture(
        conn,
        &req.id,
        req.user_id.as_deref().or(Some(user_id.as_str())),
        req.raw_text.as_deref(),
        req.explanation.as_deref(),
        req.title.as_deref(),
        &req.kind,
        req.sub_kind.as_deref(),
        req.local_path.as_deref(),
        tag_ids_json.as_deref(),
        req.sensitive_state.as_deref().unwrap_or("normal"),
        req.created_at.as_deref(),
        req.meta.as_deref(),
        raw_content_json.as_deref(),
        req.app_name.as_deref(),
        req.window_name.as_deref(),
        req.size_kb,
        req.process_doc_index_doc,
        req.index_meet_raw_transcript,
        req.kety_server_path.as_deref(),
    );
    let result = do_save(guard.get_for(&app, &user_id, None)?);
    if let Err(ref e) = result {
        if e.contains("malformed") || e.contains("corrupt") || e.contains("write probe") {
            eprintln!("[db] save_capture: DB corrupted, force-deleting file and retrying");
            match guard.force_recreate_for(&app, &user_id, None) {
                Err(e2) => {
                    eprintln!("[db] force_recreate_for failed: {e2}");
                    crate::play_context_fail_sound();
                    return Err(e2);
                }
                Ok(conn) => {
                    let retry = do_save(conn);
                    if retry.is_err() { crate::play_context_fail_sound(); }
                    return retry;
                }
            }
        }
        crate::play_context_fail_sound();
    }
    result
}

#[tauri::command]
pub fn local_list_captures_cmd(
    app: tauri::AppHandle,
    user_id: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<Vec<local_index::LocalCaptureRow>, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    local_index::list_captures_for_user(conn, &user_id)
}

#[tauri::command]
pub fn local_save_tag_cmd(
    app: tauri::AppHandle,
    user_id: String,
    req: LocalSaveTagReq,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<(), String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    let apps_json = serde_json::to_string(&req.auto_assign_apps).unwrap_or_else(|_| "[]".to_string());
    local_index::save_tag(conn, &user_id, &req.id, &req.name, &req.description, &req.color, &apps_json, &req.created_at)
}

#[tauri::command]
pub fn local_list_tags_cmd(
    app: tauri::AppHandle,
    user_id: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<Vec<local_index::TagRow>, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    local_index::list_tags_for_user(conn, &user_id)
}

#[tauri::command]
pub fn local_delete_tag_cmd(
    app: tauri::AppHandle,
    user_id: String,
    tag_id: String,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<(), String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    local_index::delete_tag(conn, &user_id, &tag_id)
}

#[tauri::command]
pub fn local_distinct_tag_ids_cmd(
    app: tauri::AppHandle,
    user_id: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<Vec<String>, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    Ok(local_index::get_distinct_tag_ids(conn))
}

#[tauri::command]
pub fn local_distinct_tag_ids_for_model_cmd(
    app: tauri::AppHandle,
    user_id: String,
    embed_model: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<Vec<String>, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    Ok(local_index::get_distinct_tag_ids_for_embed_model(conn, &embed_model))
}

#[tauri::command]
pub fn local_index_diag_cmd(
    app: tauri::AppHandle,
    user_id: String,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<local_index::IndexDiag, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, assistant_id.as_deref())?;
    Ok(local_index::get_index_diag(conn))
}

/// Shared embedding + hybrid search used by both `local_search_cmd` and `mcp_api`.
/// Embeds `embed_query` with `embed_model_override` if given, otherwise falls back to
/// the active embedding model from the DB meta table, then runs hybrid vector+BM25 RRF search.
/// `query` is the original user query (stored in SearchRequest for logging/BM25 fallback).
/// `embed_query` may differ when the router has reformulated it.
/// `assistant_id` selects which index is searched: `None` the profile's own,
/// `Some(id)` one imported from someone else. Searching is pure reading.
#[allow(clippy::too_many_arguments)]
pub(crate) fn embed_and_hybrid_search(
    app: &tauri::AppHandle,
    user_id: &str,
    assistant_id: Option<&str>,
    query: &str,
    embed_query: &str,
    openai_key: Option<&str>,
    embed_model_override: Option<&str>,
    tag_ids: Option<Vec<String>>,
    keyword_terms: Option<Vec<String>>,
    top_k: usize,
    expand: local_index::ExpandConfig,
    index: &local_index::LocalIndexState,
) -> Result<Vec<local_index::SearchHit>, String> {
    let (active_model, active_dim) = {
        let mut guard = index.0.lock().map_err(|e| e.to_string())?;
        let c = guard.get_for(app, user_id, assistant_id)?;
        let meta_model: String = c.query_row("SELECT value FROM meta WHERE key='active_embed_model'", [], |r| r.get(0))
            .map_err(|e| format!("meta read: {e}"))?;
        // The assistant's model wins; meta is the fallback for callers that have none.
        let model = match embed_model_override.map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => m.to_string(),
            None => meta_model,
        };
        let dim = if model.is_empty() { 0 } else { local_index::resolve_embed_dim(&model).unwrap_or(0) };
        (model, dim)
    };

    if active_model.is_empty() {
        return Err("No embedding model configured. Set one in Settings → Local index.".to_string());
    }
    if active_dim == 0 {
        return Err(format!(
            "This assistant is set to use the \"{active_model}\" model, which this app doesn't recognize. Choose a different model for this assistant."
        ));
    }

    let query_embedding = if active_model.starts_with("openai:") {
        let key = openai_key.filter(|k| !k.is_empty())
            .ok_or("OpenAI API key required for OpenAI embedding model")?;
        local_index::embed_via_openai(key, embed_query)?
    } else {
        let info = embed_setup::model_by_id(&active_model)
            .ok_or_else(|| format!("Unknown embed model: {active_model}"))?;
        local_index::embed_via_llama(app, info.filename, embed_query, 4)?
    };

    let req = local_index::SearchRequest {
        query: query.to_string(),
        query_embedding,
        top_k,
        embed_model: active_model,
        keyword_terms,
        tag_ids,
        expand,
    };

    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(app, user_id, assistant_id)?;
    local_index::search_hybrid(conn, &req)
}

#[tauri::command]
pub fn local_search_cmd(
    app: tauri::AppHandle,
    user_id: String,
    query: String,
    mode: String,
    openai_api_key: Option<String>,
    tag_ids: Option<Vec<String>>,
    chat_history: Option<Vec<serde_json::Value>>,
    embed_model: Option<String>,
    assistant_id: Option<String>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<Vec<local_index::SearchHit>, String> {
    let mut embed_query = query.clone();
    let mut keyword_terms: Option<Vec<String>> = None;

    if mode == "api" {
        if let Some(key) = openai_api_key.as_deref().filter(|k| !k.is_empty()) {
            let history_pairs: Vec<(String, String)> = chat_history.as_deref().unwrap_or(&[])
                .iter()
                .filter_map(|v| {
                    let role = v.get("role")?.as_str()?.to_string();
                    let content = v.get("content")?.as_str()?.to_string();
                    Some((role, content))
                })
                .collect();
            match local_index::call_chat_router(key, &query, &history_pairs) {
                Ok(router) => {
                    eprintln!("[router] need_more_context={} reformulated={:?} keywords={:?}",
                        router.need_more_context, router.reformulated_for_embedding, router.keyword_terms_for_search);
                    if !router.need_more_context {
                        eprintln!("[router] skipping retrieval");
                        return Ok(vec![]);
                    }
                    if let Some(ref reformulated) = router.reformulated_for_embedding {
                        if !reformulated.trim().is_empty() {
                            embed_query = reformulated.clone();
                        }
                    }
                    keyword_terms = router.keyword_terms_for_search;
                }
                Err(e) => {
                    eprintln!("[router] error (falling back to direct retrieval): {e}");
                }
            }
        }
    }

    let top_k = if mode == "api" { local_index::top_k_api() } else { local_index::top_k_local() };
    let expand = if mode == "api" { local_index::ExpandConfig::api() } else { local_index::ExpandConfig::local() };

    embed_and_hybrid_search(
        &app, &user_id, assistant_id.as_deref(), &query, &embed_query,
        openai_api_key.as_deref(), embed_model.as_deref(), tag_ids, keyword_terms, top_k, expand, &index,
    )
}

#[tauri::command]
pub fn local_pack_context_cmd(
    hits: Vec<local_index::SearchHit>,
    mode: String,
) -> String {
    let budget = if mode == "api" { local_index::token_budget_api() } else { local_index::token_budget_local() };
    local_index::pack_context(&hits, budget)
}

// ── SQLite inspector ──────────────────────────────────────────────────────────
//
// Profile-only, deliberately. These commands must NEVER take an `assistant_id`.
// `sqlite_execute_cmd` is a raw arbitrary-SQL channel: pointing it at an imported
// index would hand a write path into a store whose whole guarantee is that it is
// read-only. Do not "complete the pattern" by adding the parameter here.

#[tauri::command]
pub fn sqlite_list_tables_cmd(
    app: tauri::AppHandle,
    user_id: String,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<Vec<String>, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).map_err(|e| e.to_string())?;
    let tables: Vec<String> = stmt.query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tables)
}

#[tauri::command]
pub fn sqlite_query_table_cmd(
    app: tauri::AppHandle,
    user_id: String,
    table: String,
    sort_col: Option<String>,
    sort_desc: Option<bool>,
    limit: Option<i64>,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<SqliteTableData, String> {
    if !table.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err("Invalid table name".to_string());
    }
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;

    let mut col_stmt = conn.prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| e.to_string())?;
    let columns: Vec<String> = col_stmt.query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let order_clause = if let Some(ref col) = sort_col {
        if columns.contains(col) {
            let dir = if sort_desc.unwrap_or(false) { "DESC" } else { "ASC" };
            format!("ORDER BY \"{}\" {}", col, dir)
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let row_limit = limit.unwrap_or(500);
    let sql = format!("SELECT * FROM {} {} LIMIT {}", table, order_clause, row_limit);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let col_count = columns.len();
    let rows: Vec<Vec<Option<String>>> = stmt.query_map([], |r| {
        let mut cells = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let v: Option<String> = match r.get_ref(i).unwrap_or(rusqlite::types::ValueRef::Null) {
                rusqlite::types::ValueRef::Null => None,
                rusqlite::types::ValueRef::Integer(n) => Some(n.to_string()),
                rusqlite::types::ValueRef::Real(f) => Some(f.to_string()),
                rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                rusqlite::types::ValueRef::Blob(b) => Some(format!("<blob {} bytes>", b.len())),
            };
            cells.push(v);
        }
        Ok(cells)
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(SqliteTableData { columns, rows })
}

#[tauri::command]
pub fn sqlite_execute_cmd(
    app: tauri::AppHandle,
    user_id: String,
    sql: String,
    index: tauri::State<local_index::LocalIndexState>,
) -> Result<SqliteExecuteResult, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("Empty query".to_string());
    }
    let upper = trimmed.to_uppercase();
    let is_select = upper.starts_with("SELECT") || upper.starts_with("EXPLAIN") || upper.starts_with("PRAGMA") || upper.starts_with("WITH");
    if is_select {
        let mut stmt = conn.prepare(trimmed).map_err(|e| e.to_string())?;
        let columns: Vec<String> = (0..stmt.column_count())
            .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
            .collect();
        let col_count = columns.len();
        let rows: Vec<Vec<Option<String>>> = stmt.query_map([], |r| {
            let mut cells = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let v: Option<String> = match r.get_ref(i).unwrap_or(rusqlite::types::ValueRef::Null) {
                    rusqlite::types::ValueRef::Null => None,
                    rusqlite::types::ValueRef::Integer(n) => Some(n.to_string()),
                    rusqlite::types::ValueRef::Real(f) => Some(f.to_string()),
                    rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                    rusqlite::types::ValueRef::Blob(b) => Some(format!("<blob {} bytes>", b.len())),
                };
                cells.push(v);
            }
            Ok(cells)
        }).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
        Ok(SqliteExecuteResult { columns, rows, rows_affected: 0 })
    } else {
        conn.execute_batch(trimmed).map_err(|e| e.to_string())?;
        let rows_affected = conn.changes() as i64;
        Ok(SqliteExecuteResult { columns: vec![], rows: vec![], rows_affected })
    }
}
