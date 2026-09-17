//! Minimal Google Cloud Storage client: OAuth2 (self-signed JWT), V4 signed URLs,
//! and simple media upload/delete — no cloud SDK, talks to the REST APIs directly.

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC};
use rsa::pkcs8::DecodePrivateKey;
use rsa::{Pkcs1v15Sign, RsaPrivateKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize, Clone)]
pub struct ServiceAccount {
    #[serde(rename = "type")]
    pub type_: String,
    pub client_email: String,
    pub private_key: String,
    pub private_key_id: String,
    pub token_uri: String,
}

pub fn parse_service_account(json: &str) -> Result<ServiceAccount, String> {
    let sa: ServiceAccount =
        serde_json::from_str(json).map_err(|e| format!("Invalid service account JSON: {e}"))?;
    if sa.type_ != "service_account" {
        return Err(format!(
            "This JSON file is not a service account key (type = \"{}\")",
            sa.type_
        ));
    }
    if sa.client_email.trim().is_empty() || sa.private_key.trim().is_empty() {
        return Err("Service account JSON is missing client_email or private_key".to_string());
    }
    Ok(sa)
}

/// RSA-SHA256 (PKCS#1 v1.5) sign — deterministic, no RNG required.
fn rsa_sha256_sign(private_key_pem: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let key = RsaPrivateKey::from_pkcs8_pem(private_key_pem)
        .map_err(|e| format!("Invalid service account private key: {e}"))?;
    let hashed = Sha256::digest(data);
    key.sign(Pkcs1v15Sign::new::<Sha256>(), &hashed)
        .map_err(|e| format!("RSA sign failed: {e}"))
}

const GCS_UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

fn url_encode_component(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, GCS_UNRESERVED).to_string()
}

/// Encodes a `/`-separated object key one segment at a time, leaving `/` unescaped —
/// used for the *path* portion of a signed URL. Contrast with `url_encode_component`,
/// which escapes `/` too and is used for the JSON API's `DELETE .../o/{object}` path.
fn url_encode_path_segment(object_key: &str) -> String {
    object_key
        .split('/')
        .map(url_encode_component)
        .collect::<Vec<_>>()
        .join("/")
}

/// Builds the canonical request path and sorted, percent-encoded query string shared by
/// signature computation and the final URL. Split out from `sign_v4_get_url` so the
/// deterministic, key-independent parts are unit-testable without an RSA key.
/// Returns: (canonical_path, canonical_query_string, timestamp, credential_scope)
fn build_v4_canonical_path_and_query(
    sa: &ServiceAccount,
    bucket: &str,
    object_key: &str,
    expires_in_secs: u32,
    response_content_disposition: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> (String, String, String, String) {
    let expires_in_secs = expires_in_secs.clamp(1, 604_800);
    let timestamp = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let credential_scope = format!("{date}/auto/storage/goog4_request");
    let credential = format!("{}/{}", sa.client_email, credential_scope);

    let canonical_path = format!("/{bucket}/{}", url_encode_path_segment(object_key));

    let mut query_params: Vec<(&str, String)> = vec![
        ("X-Goog-Algorithm", "GOOG4-RSA-SHA256".to_string()),
        ("X-Goog-Credential", credential),
        ("X-Goog-Date", timestamp.clone()),
        ("X-Goog-Expires", expires_in_secs.to_string()),
        ("X-Goog-SignedHeaders", "host".to_string()),
        (
            "response-content-disposition",
            response_content_disposition.to_string(),
        ),
    ];
    query_params.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_query_string = query_params
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode_component(k), url_encode_component(v)))
        .collect::<Vec<_>>()
        .join("&");

    (canonical_path, canonical_query_string, timestamp, credential_scope)
}

/// Generates a GCS V4 signed GET URL. `expires_in_secs` is clamped to Google's hard
/// 604800s (7 day) maximum — signatures requesting longer simply stop working after 7
/// days regardless of what was asked for, so clamping up front avoids handing out a URL
/// that silently breaks later.
pub fn sign_v4_get_url(
    sa: &ServiceAccount,
    bucket: &str,
    object_key: &str,
    expires_in_secs: u32,
    response_content_disposition: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<String, String> {
    let (canonical_path, canonical_query_string, timestamp, credential_scope) =
        build_v4_canonical_path_and_query(
            sa,
            bucket,
            object_key,
            expires_in_secs,
            response_content_disposition,
            now,
        );

    let host = "storage.googleapis.com";
    let canonical_headers = format!("host:{host}\n");
    let canonical_request = format!(
        "GET\n{canonical_path}\n{canonical_query_string}\n{canonical_headers}\nhost\nUNSIGNED-PAYLOAD"
    );
    let hashed_canonical_request = hex::encode(Sha256::digest(canonical_request.as_bytes()));

    let string_to_sign =
        format!("GOOG4-RSA-SHA256\n{timestamp}\n{credential_scope}\n{hashed_canonical_request}");

    let signature = rsa_sha256_sign(&sa.private_key, string_to_sign.as_bytes())?;
    let signature_hex = hex::encode(signature);

    Ok(format!(
        "https://{host}{canonical_path}?{canonical_query_string}&X-Goog-Signature={signature_hex}"
    ))
}

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

fn build_oauth_jwt(sa: &ServiceAccount, now: chrono::DateTime<chrono::Utc>) -> Result<String, String> {
    let header = serde_json::json!({ "alg": "RS256", "typ": "JWT" });
    let iat = now.timestamp();
    let exp = iat + 3600;
    let claims = serde_json::json!({
        "iss": sa.client_email,
        "scope": "https://www.googleapis.com/auth/devstorage.read_write",
        "aud": sa.token_uri,
        "iat": iat,
        "exp": exp,
    });
    let header_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).map_err(|e| e.to_string())?);
    let claims_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|e| e.to_string())?);
    let signing_input = format!("{header_b64}.{claims_b64}");
    let signature = rsa_sha256_sign(&sa.private_key, signing_input.as_bytes())?;
    let signature_b64 = URL_SAFE_NO_PAD.encode(signature);
    Ok(format!("{signing_input}.{signature_b64}"))
}

/// Exchanges a fresh self-signed JWT for an OAuth2 access token. Not cached — share
/// creation/revocation is infrequent enough that a token fetch per operation is fine.
pub fn fetch_access_token(sa: &ServiceAccount) -> Result<String, String> {
    let jwt = build_oauth_jwt(sa, chrono::Utc::now())?;
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(&sa.token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", jwt.as_str()),
        ])
        .send()
        .map_err(|e| format!("OAuth token request failed: {e}"))?;
    let status = resp.status();
    let body_text = resp
        .text()
        .map_err(|e| format!("OAuth token response read failed: {e}"))?;
    let body: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| {
            let preview = if body_text.chars().count() > 500 {
                format!("{}...", body_text.chars().take(500).collect::<String>())
            } else {
                body_text.clone()
            };
            format!("OAuth token response parse failed ({status}): {e}\nRaw response: {preview}")
        })?;
    if !status.is_success() {
        let msg = body
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Google rejected the service account credentials ({status}): {msg}"));
    }
    body.get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "OAuth response missing access_token".to_string())
}

fn content_type_for_extension(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".mp4" => "video/mp4",
        ".mov" => "video/quicktime",
        ".pdf" => "application/pdf",
        ".zip" => "application/zip",
        ".txt" => "text/plain",
        ".md" => "text/markdown",
        _ => "application/octet-stream",
    }
}

/// Streams `file_path` to the bucket via GCS's simple media upload — no size buffering,
/// the request body is read directly from disk.
pub fn upload_object(
    sa: &ServiceAccount,
    bucket: &str,
    object_key: &str,
    file_path: &std::path::Path,
    content_type: &str,
) -> Result<(), String> {
    let access_token = fetch_access_token(sa)?;
    let file = std::fs::File::open(file_path).map_err(|e| format!("Open file for upload: {e}"))?;
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o"))
        .query(&[("uploadType", "media"), ("name", object_key)])
        .bearer_auth(access_token)
        .header("Content-Type", content_type)
        .body(file)
        .send()
        .map_err(|e| format!("Upload request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("Upload failed ({status}): {body}"));
    }
    Ok(())
}

/// Deletes an object from the bucket. A 404 (already gone) counts as success — the goal
/// is "this object is not accessible", which is already true.
pub fn delete_object(sa: &ServiceAccount, bucket: &str, object_key: &str) -> Result<(), String> {
    let access_token = fetch_access_token(sa)?;
    let client = reqwest::blocking::Client::new();
    let resp = client
        .delete(format!(
            "https://storage.googleapis.com/storage/v1/b/{bucket}/o/{}",
            url_encode_component(object_key)
        ))
        .bearer_auth(access_token)
        .send()
        .map_err(|e| format!("Delete request failed: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 404 || status.is_success() {
        return Ok(());
    }
    let body = resp.text().unwrap_or_default();
    Err(format!("Delete failed ({status}): {body}"))
}

/// Uploads a 0-byte object under `{profile_id}/.kts-connectivity-test` then deletes it —
/// validates the service account really has create+delete permission on this bucket.
pub fn test_connection(sa: &ServiceAccount, bucket: &str, profile_id: &str) -> Result<(), String> {
    let object_key = format!("{profile_id}/.kts-connectivity-test");
    let tmp = std::env::temp_dir().join(format!("kts-gcp-test-{}", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, b"").map_err(|e| format!("Could not create local test file: {e}"))?;
    let upload_result = upload_object(sa, bucket, &object_key, &tmp, "application/octet-stream");
    let _ = std::fs::remove_file(&tmp);
    upload_result?;
    delete_object(sa, bucket, &object_key)
}

pub struct ShareLinkResult {
    pub blob_key: String,
    pub signed_url: String,
}

/// Uploads `source_path` under a fresh `{profile_id}/{uuid}{ext}` key and returns a
/// signed download URL. `download_filename` only affects what the recipient's browser
/// names the file (via Content-Disposition) — it never touches the bucket's object key.
pub fn create_share_link(
    sa: &ServiceAccount,
    bucket: &str,
    profile_id: &str,
    source_path: &std::path::Path,
    download_filename: &str,
    expiry_seconds: u32,
) -> Result<ShareLinkResult, String> {
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let blob_key = format!("{profile_id}/{}{ext}", uuid::Uuid::new_v4());
    let content_type = content_type_for_extension(&ext);
    upload_object(sa, bucket, &blob_key, source_path, content_type)?;

    let safe_filename = download_filename.replace('"', "");
    let disposition = format!("attachment; filename=\"{safe_filename}\"");
    let signed_url = sign_v4_get_url(sa, bucket, &blob_key, expiry_seconds, &disposition, chrono::Utc::now())?;

    Ok(ShareLinkResult { blob_key, signed_url })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::EncodePrivateKey;

    const SAMPLE_JSON: &str = r#"{
        "type": "service_account",
        "client_email": "test@example-project.iam.gserviceaccount.com",
        "private_key": "-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----\n",
        "private_key_id": "abc123",
        "token_uri": "https://oauth2.googleapis.com/token"
    }"#;

    #[test]
    fn parse_service_account_reads_fields() {
        let sa = parse_service_account(SAMPLE_JSON).unwrap();
        assert_eq!(sa.client_email, "test@example-project.iam.gserviceaccount.com");
        assert_eq!(sa.token_uri, "https://oauth2.googleapis.com/token");
    }

    #[test]
    fn parse_service_account_rejects_wrong_type() {
        let json = SAMPLE_JSON.replace("service_account", "authorized_user");
        let err = parse_service_account(&json).unwrap_err();
        assert!(err.contains("not a service account key"), "unexpected error: {err}");
    }

    #[test]
    fn rsa_sha256_sign_round_trips_with_public_key() {
        let mut rng = rand::thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("keygen");
        let pem = priv_key
            .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
            .expect("encode pem")
            .to_string();

        let data = b"string-to-sign example payload";
        let signature = rsa_sha256_sign(&pem, data).expect("sign");

        let pub_key = rsa::RsaPublicKey::from(&priv_key);
        let hashed = Sha256::digest(data);
        pub_key
            .verify(Pkcs1v15Sign::new::<Sha256>(), &hashed, &signature)
            .expect("signature must verify against the matching public key");
    }

    #[test]
    fn v4_canonical_query_string_matches_expected() {
        let sa = ServiceAccount {
            type_: "service_account".to_string(),
            client_email: "test@example-project.iam.gserviceaccount.com".to_string(),
            private_key: String::new(), // unused by this assertion — see next test for signing
            private_key_id: "abc123".to_string(),
            token_uri: "https://oauth2.googleapis.com/token".to_string(),
        };
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-15T10:30:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);

        let (canonical_path, canonical_query_string, timestamp, credential_scope) =
            build_v4_canonical_path_and_query(
                &sa,
                "my-bucket",
                "profile-123/abc.png",
                3600,
                "attachment; filename=\"photo.png\"",
                now,
            );

        assert_eq!(canonical_path, "/my-bucket/profile-123/abc.png");
        assert_eq!(
            canonical_query_string,
            "X-Goog-Algorithm=GOOG4-RSA-SHA256\
             &X-Goog-Credential=test%40example-project.iam.gserviceaccount.com%2F20260115%2Fauto%2Fstorage%2Fgoog4_request\
             &X-Goog-Date=20260115T103000Z\
             &X-Goog-Expires=3600\
             &X-Goog-SignedHeaders=host\
             &response-content-disposition=attachment%3B%20filename%3D%22photo.png%22"
        );
        assert_eq!(timestamp, "20260115T103000Z");
        assert_eq!(credential_scope, "20260115/auto/storage/goog4_request");
    }

    #[test]
    fn v4_expires_clamps_to_7_days() {
        let sa = ServiceAccount {
            type_: "service_account".to_string(),
            client_email: "test@example-project.iam.gserviceaccount.com".to_string(),
            private_key: String::new(), // unused by this assertion
            private_key_id: "abc123".to_string(),
            token_uri: "https://oauth2.googleapis.com/token".to_string(),
        };
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-15T10:30:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);

        // Pass an out-of-range expiry (999_999 seconds, much larger than 604_800)
        let (_canonical_path, canonical_query_string, _timestamp, _credential_scope) =
            build_v4_canonical_path_and_query(
                &sa,
                "my-bucket",
                "test.txt",
                999_999, // Should be clamped to 604_800
                "attachment",
                now,
            );

        // Verify the query string contains the clamped value, not the requested one
        assert!(
            canonical_query_string.contains("X-Goog-Expires=604800"),
            "Expected X-Goog-Expires=604800 in query string, got: {canonical_query_string}"
        );
        assert!(
            !canonical_query_string.contains("999999"),
            "Out-of-range value 999999 should not appear in query string"
        );
    }

    #[test]
    fn sign_v4_get_url_produces_well_formed_url() {
        let mut rng = rand::thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("keygen");
        let pem = priv_key
            .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
            .expect("encode pem")
            .to_string();
        let sa = ServiceAccount {
            type_: "service_account".to_string(),
            client_email: "test@example-project.iam.gserviceaccount.com".to_string(),
            private_key: pem,
            private_key_id: "abc123".to_string(),
            token_uri: "https://oauth2.googleapis.com/token".to_string(),
        };
        let now = chrono::Utc::now();

        let url = sign_v4_get_url(
            &sa,
            "my-bucket",
            "profile-123/abc.png",
            3600,
            "attachment; filename=\"photo.png\"",
            now,
        )
        .expect("signing must succeed");

        assert!(url.starts_with("https://storage.googleapis.com/my-bucket/profile-123/abc.png?"));
        assert!(url.contains("X-Goog-Algorithm=GOOG4-RSA-SHA256"));
        assert!(url.contains("X-Goog-Expires=3600"));
        let sig_part = url.split("X-Goog-Signature=").nth(1).expect("signature present");
        assert_eq!(sig_part.len(), 512, "2048-bit RSA signature must be 512 hex chars");
    }

    #[test]
    fn oauth_jwt_has_three_base64url_segments() {
        let mut rng = rand::thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("keygen");
        let pem = priv_key
            .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
            .expect("encode pem")
            .to_string();
        let sa = ServiceAccount {
            type_: "service_account".to_string(),
            client_email: "test@example-project.iam.gserviceaccount.com".to_string(),
            private_key: pem,
            private_key_id: "abc123".to_string(),
            token_uri: "https://oauth2.googleapis.com/token".to_string(),
        };

        let jwt = build_oauth_jwt(&sa, chrono::Utc::now()).expect("build jwt");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT must have header.claims.signature");

        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let claims_bytes = URL_SAFE_NO_PAD.decode(parts[1]).expect("claims must be base64url");
        let claims: serde_json::Value = serde_json::from_slice(&claims_bytes).expect("claims must be JSON");
        assert_eq!(claims["iss"], "test@example-project.iam.gserviceaccount.com");
        assert_eq!(claims["scope"], "https://www.googleapis.com/auth/devstorage.read_write");
        assert_eq!(claims["aud"], "https://oauth2.googleapis.com/token");
    }

    // ── Live end-to-end test against a real bucket ────────────────────────────
    //
    // Ignored by default: it needs real credentials and real network access. Run it
    // deliberately, with both env vars set:
    //
    //   KTS_GCP_SA_PATH=/path/to/service-account.json \
    //   KTS_GCP_BUCKET=your-bucket-name \
    //   cargo test --lib gcp_live_round_trip -- --ignored --nocapture
    //
    // Everything it creates lives under a throwaway `kts-live-test-{uuid}/` prefix and is
    // deleted before the test returns, so a passing run leaves the bucket as it found it.

    #[test]
    #[ignore = "needs real GCP credentials; see the comment above for how to run it"]
    fn gcp_live_round_trip() {
        let sa_path = std::env::var("KTS_GCP_SA_PATH")
            .expect("set KTS_GCP_SA_PATH to your service-account JSON file");
        let bucket =
            std::env::var("KTS_GCP_BUCKET").expect("set KTS_GCP_BUCKET to your bucket name");

        let sa_json = std::fs::read_to_string(&sa_path)
            .unwrap_or_else(|e| panic!("could not read {sa_path}: {e}"));
        let sa = parse_service_account(&sa_json).expect("service account JSON must parse");
        eprintln!("[live] service account: {}", sa.client_email);
        eprintln!("[live] bucket: {bucket}");

        // Namespaced so a failed run is trivially identifiable and removable by hand.
        let profile_id = format!("kts-live-test-{}", uuid::Uuid::new_v4());

        // 1. OAuth + create + delete permission, the same check the Settings button runs.
        test_connection(&sa, &bucket, &profile_id).expect("test_connection must succeed");
        eprintln!("[live] 1/5 test_connection OK (OAuth + upload + delete)");

        // 2. Upload a real file and mint a signed URL for it.
        let body = format!("kety live share test {}\n", uuid::Uuid::new_v4());
        let tmp = std::env::temp_dir().join(format!("kts-live-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, &body).expect("write temp file");

        let share = create_share_link(&sa, &bucket, &profile_id, &tmp, "rapport final.txt", 3600)
            .expect("create_share_link must succeed");
        let _ = std::fs::remove_file(&tmp);
        eprintln!("[live] 2/5 uploaded + signed: {}", share.blob_key);

        // From here on the object exists remotely: clean it up even if an assertion fails,
        // so a failing run doesn't leave litter in the user's bucket.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let client = reqwest::blocking::Client::new();

            // 3. The signed URL must actually download, with the right bytes and filename.
            let resp = client.get(&share.signed_url).send().expect("GET signed URL");
            assert!(
                resp.status().is_success(),
                "signed URL must download, got {}: {}",
                resp.status(),
                resp.text().unwrap_or_default()
            );
            let disposition = resp
                .headers()
                .get("content-disposition")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            assert!(
                disposition.contains("rapport final.txt"),
                "Content-Disposition must carry the download filename, got: {disposition:?}"
            );
            assert_eq!(
                resp.text().expect("read body"),
                body,
                "downloaded bytes must match what was uploaded"
            );
            eprintln!("[live] 3/5 signed URL downloads correctly, filename + bytes match");

            // 4. Revoke.
            delete_object(&sa, &bucket, &share.blob_key).expect("delete_object must succeed");
            eprintln!("[live] 4/5 revoked (object deleted)");

            // 5. The previously-working URL must now be dead — this is what "revoke" means.
            let after = client.get(&share.signed_url).send().expect("GET after revoke");
            assert!(
                !after.status().is_success(),
                "signed URL must stop working after revoke, still got {}",
                after.status()
            );
            eprintln!("[live] 5/5 signed URL is dead after revoke ({})", after.status());
        }));

        // Idempotent: delete_object treats 404 as success, so this is safe after step 4.
        let _ = delete_object(&sa, &bucket, &share.blob_key);

        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }
}
