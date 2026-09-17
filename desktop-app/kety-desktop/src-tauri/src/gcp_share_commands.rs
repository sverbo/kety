//! Tauri commands for per-profile GCP bucket sharing configuration.

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GcpShareConfigInfo {
    pub bucket_name: String,
    pub client_email: String,
}

/// Loads this profile's bucket name + service account, with a friendly error if sharing
/// hasn't been set up yet — reused by every command that needs to talk to the bucket.
pub(crate) fn load_config_and_sa(
    app: &tauri::AppHandle,
    user_id: &str,
) -> Result<(String, crate::gcp_share::ServiceAccount), String> {
    let config_path = crate::kety_paths::gcp_share_config_path(app, user_id)?;
    let sa_path = crate::kety_paths::gcp_share_service_account_path(app, user_id)?;
    let config_bytes = std::fs::read(&config_path)
        .map_err(|_| "Sharing is not set up for this profile yet.".to_string())?;
    let config: serde_json::Value = serde_json::from_slice(&config_bytes).map_err(|e| e.to_string())?;
    let bucket_name = config
        .get("bucket_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if bucket_name.is_empty() {
        return Err("Sharing is not set up for this profile yet.".to_string());
    }
    let sa_bytes = std::fs::read(&sa_path)
        .map_err(|_| "Sharing is not set up for this profile yet.".to_string())?;
    let sa = crate::gcp_share::parse_service_account(&String::from_utf8_lossy(&sa_bytes))?;
    Ok((bucket_name, sa))
}

#[tauri::command]
pub fn gcp_share_set_config_cmd(
    app: tauri::AppHandle,
    user_id: String,
    bucket_name: String,
    service_account_path: String,
) -> Result<GcpShareConfigInfo, String> {
    let json_content = std::fs::read_to_string(&service_account_path)
        .map_err(|e| format!("Could not read the selected file: {e}"))?;
    let sa = crate::gcp_share::parse_service_account(&json_content)?;

    let sa_dest = crate::kety_paths::gcp_share_service_account_path(&app, &user_id)?;
    std::fs::write(&sa_dest, &json_content).map_err(|e| format!("Write service account file: {e}"))?;

    let bucket_name = bucket_name.trim().to_string();
    let config_path = crate::kety_paths::gcp_share_config_path(&app, &user_id)?;
    let config = serde_json::json!({ "bucket_name": bucket_name });
    std::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Write share config: {e}"))?;

    Ok(GcpShareConfigInfo { bucket_name, client_email: sa.client_email })
}

#[tauri::command]
pub fn gcp_share_get_config_cmd(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<Option<GcpShareConfigInfo>, String> {
    // Distinguish "not configured yet" (no config file on disk — the common, expected case)
    // from "configured but broken" (config file exists but fails to load/parse, e.g. a
    // corrupted or hand-edited service account JSON). The former is Ok(None); the latter is
    // a real Err so the frontend can surface it instead of silently hiding every Share button.
    let config_path = crate::kety_paths::gcp_share_config_path(&app, &user_id)?;
    if !config_path.exists() {
        return Ok(None);
    }
    match load_config_and_sa(&app, &user_id) {
        Ok((bucket_name, sa)) => Ok(Some(GcpShareConfigInfo { bucket_name, client_email: sa.client_email })),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn gcp_share_remove_config_cmd(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    let config_path = crate::kety_paths::gcp_share_config_path(&app, &user_id)?;
    let sa_path = crate::kety_paths::gcp_share_service_account_path(&app, &user_id)?;
    let _ = std::fs::remove_file(config_path);
    let _ = std::fs::remove_file(sa_path);
    Ok(())
}

#[tauri::command]
pub fn gcp_share_test_connection_cmd(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    let (bucket_name, sa) = load_config_and_sa(&app, &user_id)?;
    crate::gcp_share::test_connection(&sa, &bucket_name, &user_id)
}

#[tauri::command]
pub fn gcp_share_create_link_cmd(
    app: tauri::AppHandle,
    user_id: String,
    source_path: String,
    download_filename: String,
    expiry_seconds: u32,
    index: tauri::State<crate::local_index::LocalIndexState>,
) -> Result<crate::local_index::ShareLinkRow, String> {
    let (bucket_name, sa) = load_config_and_sa(&app, &user_id)?;
    let result = crate::gcp_share::create_share_link(
        &sa,
        &bucket_name,
        &user_id,
        std::path::Path::new(&source_path),
        &download_filename,
        expiry_seconds,
    )?;

    let now = chrono::Utc::now();
    let expires_at = (now + chrono::Duration::seconds(expiry_seconds.clamp(1, 604_800) as i64))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let row = crate::local_index::ShareLinkRow {
        id: uuid::Uuid::new_v4().to_string(),
        blob_key: result.blob_key,
        download_filename,
        signed_url: result.signed_url,
        expires_at,
        revoked_at: None,
        created_at: now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
    };

    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    crate::local_index::insert_share_link(conn, &row)?;
    Ok(row)
}

#[tauri::command]
pub fn gcp_share_list_links_cmd(
    app: tauri::AppHandle,
    user_id: String,
    index: tauri::State<crate::local_index::LocalIndexState>,
) -> Result<Vec<crate::local_index::ShareLinkRow>, String> {
    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    crate::local_index::list_share_links(conn)
}

#[tauri::command]
pub fn gcp_share_revoke_link_cmd(
    app: tauri::AppHandle,
    user_id: String,
    share_id: String,
    index: tauri::State<crate::local_index::LocalIndexState>,
) -> Result<crate::local_index::ShareLinkRow, String> {
    let (bucket_name, sa) = load_config_and_sa(&app, &user_id)?;

    let row = {
        let mut guard = index.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.get_for(&app, &user_id, None)?;
        crate::local_index::get_share_link(conn, &share_id)?
    };

    // Real delete first — only mark revoked locally once the object is actually gone.
    crate::gcp_share::delete_object(&sa, &bucket_name, &row.blob_key)?;

    let mut guard = index.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.get_for(&app, &user_id, None)?;
    crate::local_index::mark_share_link_revoked(conn, &share_id)?;
    crate::local_index::get_share_link(conn, &share_id)
}
