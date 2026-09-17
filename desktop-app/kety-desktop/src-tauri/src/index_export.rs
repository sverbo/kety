//! Build a self-contained, filtered copy of the local index for sharing.
//!
//! The export is always a **freshly created** database that rows are inserted
//! into — never a copy of the user's index with the unwanted rows deleted.
//! SQLite keeps deleted content in freed pages, so a "copy then DELETE" export
//! would ship captures the user believed they had excluded.
//!
//! The copy is done with cross-database `INSERT ... SELECT` from the source
//! index attached as `src`, so no row ever round-trips through Rust.

use rusqlite::{params, Connection};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};

// The same guard the captures export uses, so a path that came out of the
// database can never name an entry outside `artefacts/`.
use crate::upload_commands::validate_zip_entry_path;

/// Bumped whenever the archive layout or schema changes in a way an older
/// importer could not read. The importer refuses versions it does not know.
pub const EXPORT_FORMAT_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub export_id: String,
    pub format_version: u32,
    pub name: String,
    pub embed_model: String,
    pub capture_count: i64,
    pub chunk_count: i64,
    pub exported_at: String,
}

/// Columns of `captures`, named explicitly on both sides of the copy.
/// `SELECT *` must never be used here: several columns were added by
/// `ALTER TABLE` migrations, so the physical column order of an older source
/// database does not match the order in `create_schema`.
const CAPTURE_COLS: &str = "id,user_id,raw_text,explanation,title,kind,sub_kind,local_path,tag_ids,\
sensitive_state,created_at,indexed_at,index_state,index_error,meta,raw_content,app_name,window_name,\
size_kb,size_media_kb,process_doc_index_doc,index_meet_raw_transcript,kety_server_path";


/// Top-level `captures.meta` keys that may travel, by name. An **allowlist**:
/// `meta` is rebuilt from these keys — plus `contextFocus`, filtered key by key
/// through `CONTEXT_FOCUS_KEYS` — rather than having the known-bad ones
/// removed, so a key added to `meta` later does not ship itself by default.
///
/// Together they are the exact set the app writes (`captureStoreHelpers.ts`:
/// `noteToSaveReq`, `imageToSaveReq`, `videoToSaveReq`) minus `thumbnailPath`,
/// an absolute path to the sender's generated video thumbnail.
///
/// `json_patch('{}', json_object(…))` is what turns the `json_object` into an
/// allowlist result that keeps today's shapes: RFC 7396 merge-patch drops every
/// member whose value is JSON null, at every depth, so a key the source did not
/// have arrives absent instead of arriving as an explicit `null`.
const META_TOP_LEVEL_KEYS: [&str; 3] = ["lang", "fileSize", "summary"];

/// `contextFocus` keys that may travel. The type is `OffSessionContextFocus`
/// in `appTypes.ts`; everything it declares is listed here or deliberately
/// absent:
///
/// * `bundlePath`, `executablePath` — never travel. The focused app's bundle
///   and binary, which may sit under the sender's home folder.
/// * `processId`, `windowNumber` — never travel. Both are counters handed out
///   by the sender's own OS, so both say something about that machine — how
///   long it had been up, how much it had been running — and neither means
///   anything on the recipient's. The same reasoning that made `windowBounds`
///   opt-in. Their consumers already cope with them being absent
///   (`captureStoreHelpers.ts` defaults them to `0` and `null`).
/// * `windowName`, `windowBounds` — travel only when the export was asked for
///   them (see `capture_cols_src`). A window title routinely spells out the OS
///   account and machine name (`sverbo@Samuels-MacBook-Pro: ~/Desktop/Codes`),
///   a folder layout, a client's name or a mail subject; `windowBounds`
///   fingerprints the sender's display geometry and tells a recipient nothing.
/// * the rest — the focused app's identity and how its window was presented,
///   which describe the capture and name neither the sender nor a path.
const CONTEXT_FOCUS_KEYS: [&str; 7] = [
    "appName",
    "bundleId",
    "appHidden",
    "activationPolicy",
    "windowOwnerName",
    "windowLayer",
    "windowAlpha",
];

/// Keys added to `CONTEXT_FOCUS_KEYS` when window titles are opted in.
const CONTEXT_FOCUS_WINDOW_KEYS: [&str; 2] = ["windowName", "windowBounds"];

/// The same list as `CAPTURE_COLS`, but every column that names the sender — or
/// points at a file only the sender has — is replaced. The export is read by a
/// stranger's assistant, so a column that is merely *useless* to them is still
/// a leak.
///
/// * `user_id` → NULL. The recipient's profile owns the imported captures.
///   (`list_captures_for_user` has an `IS NULL` branch, so a NULL-owned capture
///   is visible to whoever opens the index.)
/// * `local_path` → its **basename only**. The directories are the leak — an
///   absolute path on the sender's machine, `/Users/<sender-account>/…`, is on
///   every image, video and document — but the column cannot simply be NULLed,
///   see the comment at that column below.
/// * `kety_server_path` → NULL. The sender's object path in their cloud
///   storage: a pointer the recipient can neither follow nor should see.
/// * `index_error` → NULL. Free-form text from the sender's indexing run,
///   which routinely embeds absolute paths.
/// * `indexed_at` → NULL. When the sender's indexing sweep last touched this
///   row: bookkeeping for their machine, and a record of when it was awake.
///   `created_at` is a different matter and MUST keep travelling — it is when
///   the capture happened, which is the recipient's whole sense of time here.
/// * `index_state` → `'pending'`. The outcome of that same sweep, and the same
///   class of thing as the timestamp above: it describes a run on the sender's
///   machine, not a property of the capture. Copied verbatim, a capture the
///   sender's indexer gave up on arrives marked `'failed'` with no reason beside
///   it — `index_error` is NULLed — and no way to retry, because an imported
///   index is read-only; and one the sender happened to be indexing at that very
///   moment arrives marked `'indexing'`, claiming a worker is on it that does not
///   exist on this machine. `'pending'` is the honest value and it is also
///   self-correcting: `init_db`'s backfill flips a pending row to `'indexed'` on
///   the recipient's first open when the archive brought vectors for it, and
///   leaves it pending when it did not.
/// * `window_name` → NULL unless `include_window_titles`. See
///   `CONTEXT_FOCUS_KEYS` for why a window title is sender-identifying.
/// * `meta` → rebuilt from the allowlist above, so only
///   `contextFocus`, `lang`, `fileSize` and `summary` can travel, and
///   `contextFocus` only through `CONTEXT_FOCUS_KEYS`. Meta that is not valid
///   JSON cannot be filtered key by key, so it is dropped whole: an
///   unparseable blob is exactly where a stray path hides.
///
/// What travels, precisely:
///
/// * stripped (`include_window_titles == false`, the default the UI passes):
///   the app's name (`app_name`, `contextFocus.appName`, `bundleId`), the
///   capture's own text and `lang`/`fileSize`/`summary`, and the media
///   filename with no directory. No window title, no display geometry, no
///   directory, no identifier of the sender.
/// * kept (`include_window_titles == true`): all of the above plus
///   `captures.window_name`, `contextFocus.windowName` and
///   `contextFocus.windowBounds`, verbatim. The caller has decided the titles
///   are part of what they mean to share.
fn capture_cols_src(include_window_titles: bool) -> String {
    let window_name = if include_window_titles {
        "window_name"
    } else {
        "NULL"
    };
    let meta = meta_allowlist_sql(include_window_titles);
    format!(
        // `local_path` is the basename, NOT NULL, and NOT the sender's path.
        // Two consumers depend on exactly that, in opposite directions:
        //   * `captureStoreHelpers.ts` (`captureRowsToOffSession`) does
        //     `if (!row.localPath) continue;` for kind 'image' and 'video'.
        //     A NULL here drops every exported screenshot and recording from
        //     the recipient's UI, silently, even though its text, OCR and
        //     vectors all arrived. A truthy basename renders the capture; if
        //     the media did not travel the app shows its "file not available on
        //     this computer" placeholder, which is the honest outcome.
        //   * the archive step that copies media into `artefacts/` MUST read
        //     the media paths from the SOURCE index, never from this export —
        //     here they no longer resolve to anything on disk.
        // `index_state` → 'pending', beside the `indexed_at` NULL: both describe
        // the sender's indexing sweep, not the capture. See the module doc.
        "id,NULL,raw_text,explanation,title,kind,sub_kind,NULL,tag_ids,\
         sensitive_state,created_at,NULL,'pending',NULL,{meta},\
         raw_content,app_name,{window_name},\
         size_kb,size_media_kb,process_doc_index_doc,index_meet_raw_transcript,NULL"
    )
}

/// SQL expression rebuilding `meta` from the allowlisted keys only.
fn meta_allowlist_sql(include_window_titles: bool) -> String {
    let window_keys: &[&str] = if include_window_titles {
        &CONTEXT_FOCUS_WINDOW_KEYS
    } else {
        &[]
    };
    let focus_keys = CONTEXT_FOCUS_KEYS.iter().chain(window_keys.iter());
    // `meta -> '$.x'` rather than `json_extract`: the `->` operator yields the
    // JSON representation, so a boolean stays `true`/`false` instead of
    // arriving as 1/0, and an object stays an object.
    let focus = focus_keys
        .map(|k| format!("'{k}', meta -> '$.contextFocus.{k}'"))
        .collect::<Vec<_>>()
        .join(",");
    let top = META_TOP_LEVEL_KEYS
        .iter()
        .map(|k| format!("'{k}', meta -> '$.{k}'"))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "CASE WHEN meta IS NULL OR json_valid(meta) = 0 THEN NULL ELSE json_patch('{{}}', json_object(\
         'contextFocus', CASE WHEN json_type(meta,'$.contextFocus') = 'object' \
         THEN json_patch('{{}}', json_object({focus})) ELSE NULL END,{top})) END"
    )
}

/// Build a filtered index at `dest_path` containing only `capture_ids`
/// (and the chunks, embeddings and tags they need) taken from `src_path`.
///
/// `selected_tag_ids` is the set of tags the sender ticked in the curation UI.
/// A capture travels because it matched **any** ticked tag, but it must not
/// carry the tags the sender deliberately unticked: a tag name and description
/// are the sender's own words, and a tag list is a habit fingerprint in exactly
/// the way `tags.auto_assign_apps` was. So every exported capture's `tag_ids` is
/// cut down to this set, and only what survives that cut gets a `tags` row.
/// The list is an **allowlist**: an empty one means no tag travels at all, which
/// is the right answer when the sender ticked only the "No tag" chip. (That chip
/// is a UI-side concept for captures carrying no tags; it has no tag id and needs
/// no representation here — an untagged capture simply has nothing to filter.)
///
/// `include_window_titles` is the sender's explicit choice to ship the titles
/// of the windows their captures were taken from. Pass `false` unless the user
/// asked for them: a title is free text written by whatever app was focused and
/// routinely carries the sender's account name, machine name or folder layout.
pub fn build_export_db(
    src_path: &Path,
    dest_path: &Path,
    capture_ids: &[String],
    selected_tag_ids: &[String],
    name: &str,
    include_window_titles: bool,
) -> Result<ExportManifest, String> {
    if capture_ids.is_empty() {
        return Err("Nothing to export: no captures were selected.".to_string());
    }
    let src_str = src_path
        .to_str()
        .ok_or_else(|| "The knowledge index path contains characters we cannot read.".to_string())?;

    // `ATTACH DATABASE` *creates* the file when it is missing, so a wrong or
    // absent source would attach an empty database: every copy below would
    // match nothing, and a junk zero-byte database would be left behind at
    // `src_path` — at the exact location the app expects the real index. The
    // empty result is caught downstream now (`copy_all` refuses to ship an
    // export that copied nothing), but the file conjured at `src_path` would
    // not be, so refuse here, before anything on disk is touched.
    if !src_path.is_file() {
        return Err(
            "We could not find your knowledge index, so there is nothing to export.".to_string(),
        );
    }

    // Start from a clean slate. Stale WAL/SHM sidecars are removed too: SQLite
    // would replay an orphaned WAL into the new file, reviving rows we never
    // meant to export.
    remove_db_files(dest_path)?;
    if let Some(dir) = dest_path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not prepare the export folder: {e}"))?;
    }

    let dest = Connection::open(dest_path)
        .map_err(|e| format!("Could not create the export file: {e}"))?;
    // Deliberately NOT WAL, unlike every other database this app opens. The
    // export is packaged by zipping `index.db` alone, so a surviving `-wal`
    // sidecar would mean an archive holding a truncated database. A rollback
    // journal is gone the moment the transaction commits, which makes the file
    // self-contained by construction rather than by remembering to checkpoint.
    dest.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Could not configure the export file: {e}"))?;

    // Exactly the schema the app creates for a normal index, so the recipient
    // can open the exported file with the ordinary index-opening code.
    crate::local_index::create_schema(&dest)?;

    // Bind the path — never format it into the SQL string.
    // Prefer a read-only URI so this code path cannot modify the sender's index
    // even by accident. A WAL database needs a writable `-shm` index file just
    // to be *read*, so the read-only attach fails outright when no other
    // connection is holding the index open and the sidecars are gone. Fall back
    // to an ordinary attach in that case: nothing below writes to `src`, and the
    // existence check above already ruled out attaching something into being.
    if dest
        .execute("ATTACH DATABASE ?1 AS src", params![read_only_uri(src_str)])
        .is_err()
    {
        dest.execute("ATTACH DATABASE ?1 AS src", params![src_str])
            .map_err(|e| format!("Could not read your knowledge index: {e}"))?;
    }

    let built = copy_all(
        &dest,
        capture_ids,
        selected_tag_ids,
        name,
        include_window_titles,
    )
    .and_then(|manifest| rewrite_media_names(&dest).map(|()| manifest));

    // Detach in both the success and failure case, so the export file is never
    // left holding a reference to the sender's database.
    let _ = dest.execute_batch("DETACH DATABASE src");

    match built {
        Ok(manifest) => Ok(manifest),
        Err(e) => {
            drop(dest);
            let _ = remove_db_files(dest_path);
            Err(e)
        }
    }
}

/// Fill in `captures.local_path` for the exported media, from the same rule
/// that names the archive entries.
///
/// The copy leaves the column NULL: the sender's directories must not travel,
/// and the exported name is derived from the capture id, which SQL has no
/// business recomputing. Writing it here keeps `exported_media_name` the single
/// source of truth — the archive entry and the database value are produced by
/// one function, so they cannot drift apart.
///
/// Only image and video captures get a value, because only those have a file in
/// `artefacts/`. Anything else keeps NULL rather than a reference to a file the
/// recipient will never have.
fn rewrite_media_names(dest: &Connection) -> Result<(), String> {
    let rows: Vec<(String, String)> = {
        let mut stmt = dest
            .prepare(
                "SELECT c.id, s.local_path \
                 FROM main.captures c JOIN src.captures s ON s.id = c.id \
                 WHERE c.kind IN ('image','video') \
                   AND s.local_path IS NOT NULL AND s.local_path != ''",
            )
            .map_err(|e| format!("Could not list the capture files: {e}"))?;
        let mapped = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("Could not list the capture files: {e}"))?;
        mapped.filter_map(|r| r.ok()).collect()
    };
    for (id, src_path) in rows {
        let name = exported_media_name(&id, &src_path);
        dest.execute(
            "UPDATE main.captures SET local_path = ?1 WHERE id = ?2",
            params![name, id],
        )
        .map_err(|e| format!("Could not name an exported file: {e}"))?;
    }
    Ok(())
}

fn copy_all(
    dest: &Connection,
    capture_ids: &[String],
    selected_tag_ids: &[String],
    name: &str,
    include_window_titles: bool,
) -> Result<ExportManifest, String> {
    dest.execute_batch("BEGIN")
        .map_err(|e| format!("Could not start writing the export: {e}"))?;

    // 1. captures — one bound statement per selected id. Once this is done,
    //    `main.captures` *is* the exported set, so every later filter can just
    //    refer to it instead of re-binding the id list.
    {
        let cols_src = capture_cols_src(include_window_titles);
        let sql = format!(
            "INSERT OR IGNORE INTO main.captures ({CAPTURE_COLS}) \
             SELECT {cols_src} FROM src.captures WHERE id = ?1"
        );
        let mut stmt = dest
            .prepare(&sql)
            .map_err(|e| format!("Could not prepare the capture copy: {e}"))?;
        for id in capture_ids {
            stmt.execute(params![id])
                .map_err(|e| format!("Could not copy a capture: {e}"))?;
        }
    }

    // 1b. tags — `captures.tag_ids` travelled verbatim in the copy above, so an
    //     exported capture still lists every tag it carries, including the ones
    //     whose chip the sender unticked. Cut each list down to what was ticked
    //     BEFORE anything reads it: `referenced_tag_ids` below decides which
    //     `tags` rows (name, description, colour — the sender's own words) get
    //     copied, and it reads these same values.
    let selected_tags: BTreeSet<String> = selected_tag_ids.iter().cloned().collect();
    filter_capture_tags(dest, &selected_tags)?;

    // 2. chunks of those captures.
    dest.execute(
        "INSERT INTO main.chunks (id,capture_id,seq,chunk_text,chunk_type,overlap_before,overlap_after) \
         SELECT c.id,c.capture_id,c.seq,c.chunk_text,c.chunk_type,c.overlap_before,c.overlap_after \
         FROM src.chunks c \
         WHERE c.capture_id IN (SELECT id FROM main.captures)",
        [],
    )
    .map_err(|e| format!("Could not copy the indexed text: {e}"))?;

    // 3. embeddings of those chunks — successful ones only. A row with
    //    status <> 'ok' holds an empty blob and would arrive as phantom
    //    coverage: counted as indexed while containing nothing.
    //
    //    `error_msg` → NULL, the same class of free-form, path-bearing text as
    //    `captures.index_error`. It happens to be NULL on every `status='ok'`
    //    row that today's writers produce, which is exactly why copying it
    //    would look harmless right up until a writer starts filling it in.
    //
    //    `created_at` → emptied. It is when the sender's machine ran an
    //    embedding pass, so a row of them maps out the hours that machine was
    //    awake — and it tells the recipient nothing, since it is not when
    //    anything was captured. Emptied rather than NULLed only because
    //    `create_schema` declares the column NOT NULL and the recipient opens
    //    this file with that same schema; nothing reads the column.
    dest.execute(
        "INSERT INTO main.chunk_embeddings (id,chunk_id,embed_model,embed_dim,embedding,created_at,status,error_msg) \
         SELECT e.id,e.chunk_id,e.embed_model,e.embed_dim,e.embedding,'',e.status,NULL \
         FROM src.chunk_embeddings e \
         WHERE e.status = 'ok' AND e.chunk_id IN (SELECT id FROM main.chunks)",
        [],
    )
    .map_err(|e| format!("Could not copy the search vectors: {e}"))?;

    // 4. tags actually referenced by the exported captures, AFTER step 1b cut
    //    the unticked ones out — so a tag the sender excluded never reaches
    //    this list and never gets a row. `tag_ids` is a JSON array string,
    //    parsed the same way `get_distinct_tag_ids` does.
    //
    //    `user_id` is NULLed purely for privacy: the sender's user id must not
    //    travel. Unlike captures, this does *not* make the tags visible —
    //    `list_tags_for_user` filters on `WHERE user_id = ?1` with no `IS NULL`
    //    branch, so a NULL-owned tag is exactly as invisible as a sender-owned
    //    one. That is deliberate and correct here.
    //
    //    IMPORT MUST REWRITE `tags.user_id` to the recipient's id. Skip that and
    //    every imported capture renders unknown tag chips: the capture still
    //    lists the tag ids, but the tag rows behind them are never returned.
    //
    //    `auto_assign_apps` → literal `'[]'`, not the source value. It's a JSON
    //    array of the sender's applications, so copying it verbatim is a leak —
    //    but the sharper reason is that it is a *live rule*, not a fact about
    //    the exported captures: on import it would start auto-tagging the
    //    recipient's own future captures with the sender's app list. A shared
    //    body of knowledge must not silently change how the recipient's app
    //    behaves. The column is `NOT NULL DEFAULT '[]'`, so an empty array is a
    //    valid "no auto-assign rules" state.
    let tag_ids = referenced_tag_ids(dest)?;
    {
        let mut stmt = dest
            .prepare(
                "INSERT OR IGNORE INTO main.tags (id,user_id,name,description,color,auto_assign_apps,created_at) \
                 SELECT id,NULL,name,description,color,'[]',created_at \
                 FROM src.tags WHERE id = ?1",
            )
            .map_err(|e| format!("Could not prepare the tag copy: {e}"))?;
        for id in &tag_ids {
            stmt.execute(params![id])
                .map_err(|e| format!("Could not copy a tag: {e}"))?;
        }
    }

    // 5. meta — the model that the *copied* embeddings were actually made with,
    //    which is not necessarily the model the sender has active today.
    let (embed_model, embed_dim) = majority_embed_model(dest)?;
    dest.execute(
        "INSERT INTO main.meta(key,value) VALUES ('active_embed_model', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![embed_model],
    )
    .map_err(|e| format!("Could not record the export settings: {e}"))?;
    dest.execute(
        "INSERT INTO main.meta(key,value) VALUES ('active_embed_dim', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![embed_dim.to_string()],
    )
    .map_err(|e| format!("Could not record the export settings: {e}"))?;

    // 6. chunks_fts — keyword search for the recipient. Created with the exact
    //    statement `init_db` uses, and filled with the same column list
    //    `index_capture` writes.
    dest.execute_batch("
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
            chunk_text,
            chunk_type UNINDEXED,
            capture_id UNINDEXED,
            chunk_id UNINDEXED,
            tokenize = 'unicode61'
        );
    ")
    .map_err(|e| format!("Could not prepare keyword search: {e}"))?;
    dest.execute(
        "INSERT INTO main.chunks_fts(chunk_text, chunk_type, capture_id, chunk_id) \
         SELECT chunk_text, chunk_type, capture_id, id FROM main.chunks",
        [],
    )
    .map_err(|e| format!("Could not build keyword search: {e}"))?;

    // Counts of what was actually copied, not of what was asked for: a capture
    // id that no longer exists in the source is silently skipped above.
    let capture_count: i64 = dest
        .query_row("SELECT COUNT(*) FROM main.captures", [], |r| r.get(0))
        .map_err(|e| format!("Could not count the exported captures: {e}"))?;
    let chunk_count: i64 = dest
        .query_row("SELECT COUNT(*) FROM main.chunks", [], |r| r.get(0))
        .map_err(|e| format!("Could not count the exported text: {e}"))?;

    // Nothing matched. The source existed and was a real database, so the
    // `is_file` guard let us through, yet not one selected id is in it: a
    // stale selection, or the wrong index. Returning Ok here would hand the
    // user a well-formed, shareable, empty file and call it an export.
    // Failing rolls the transaction back and deletes the file upstream.
    if capture_count == 0 {
        return Err(
            "None of the captures you picked are in your knowledge index any more, so there is nothing to export."
                .to_string(),
        );
    }

    dest.execute_batch("COMMIT")
        .map_err(|e| format!("Could not finish writing the export: {e}"))?;

    Ok(ExportManifest {
        export_id: uuid::Uuid::new_v4().to_string(),
        format_version: EXPORT_FORMAT_VERSION,
        name: name.to_string(),
        embed_model,
        capture_count,
        chunk_count,
        exported_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
    })
}

/// Cut every exported capture's `tag_ids` down to the tags the sender ticked.
///
/// Runs on `main.captures` — the copy — so the sender's own index is untouched.
/// A value that is not a JSON array of strings is replaced by an empty array
/// rather than kept: an unparseable `tag_ids` is exactly where an excluded tag
/// id would survive. A NULL stays NULL, which already means "no tags".
///
/// Fails closed: with an empty `selected` nothing survives, because the caller
/// passing no tags means the sender ticked no tag chip.
fn filter_capture_tags(dest: &Connection, selected: &BTreeSet<String>) -> Result<(), String> {
    let rows: Vec<(String, String)> = {
        let mut stmt = dest
            .prepare("SELECT id, tag_ids FROM main.captures WHERE tag_ids IS NOT NULL")
            .map_err(|e| format!("Could not read the capture tags: {e}"))?;
        let mapped = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("Could not read the capture tags: {e}"))?;
        mapped.filter_map(|r| r.ok()).collect()
    };
    for (id, tag_ids) in rows {
        let kept: Vec<String> = serde_json::from_str::<Vec<String>>(&tag_ids)
            .unwrap_or_default()
            .into_iter()
            .filter(|t| selected.contains(t))
            .collect();
        let json = serde_json::to_string(&kept).unwrap_or_else(|_| "[]".to_string());
        if json == tag_ids {
            continue;
        }
        dest.execute(
            "UPDATE main.captures SET tag_ids = ?1 WHERE id = ?2",
            params![json, id],
        )
        .map_err(|e| format!("Could not filter the capture tags: {e}"))?;
    }
    Ok(())
}

/// Tag ids mentioned by the captures already copied into `main`, after
/// `filter_capture_tags` has removed the ones the sender did not tick.
/// `tag_ids` is a nullable JSON array string such as `'["id1","id2"]'`.
fn referenced_tag_ids(dest: &Connection) -> Result<BTreeSet<String>, String> {
    let mut stmt = dest
        .prepare(
            "SELECT tag_ids FROM main.captures \
             WHERE tag_ids IS NOT NULL AND tag_ids != 'null' AND tag_ids != '[]'",
        )
        .map_err(|e| format!("Could not read the capture tags: {e}"))?;
    let mut ids: BTreeSet<String> = BTreeSet::new();
    let rows = stmt
        .query_map([], |row| row.get::<_, Option<String>>(0))
        .map_err(|e| format!("Could not read the capture tags: {e}"))?;
    for row in rows.flatten().flatten() {
        if let Ok(arr) = serde_json::from_str::<Vec<String>>(&row) {
            for id in arr {
                if !id.is_empty() {
                    ids.insert(id);
                }
            }
        }
    }
    Ok(ids)
}

/// The model behind the most copied embeddings, with its dimension.
/// Grouping by (model, dim) keeps the dimension consistent with the model that
/// wins; ties are broken by model name so the result is deterministic.
/// Returns `("", 0)` when nothing embeddable was copied — the same values
/// `create_schema` seeds `meta` with.
fn majority_embed_model(dest: &Connection) -> Result<(String, i64), String> {
    let row = dest
        .query_row(
            "SELECT embed_model, embed_dim FROM main.chunk_embeddings \
             GROUP BY embed_model, embed_dim \
             ORDER BY COUNT(*) DESC, embed_model ASC \
             LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => String::new(),
            other => other.to_string(),
        });
    match row {
        Ok(v) => Ok(v),
        Err(msg) if msg.is_empty() => Ok((String::new(), 0)),
        Err(msg) => Err(format!("Could not determine the embedding model: {msg}")),
    }
}

/// A `file:` URI that attaches `path` read-only.
///
/// Every byte outside the unreserved URI set is percent-encoded, so a path
/// holding a space, `?` or `#` cannot be misread as URI syntax. `/` is kept
/// literal because it is the path separator the URI wants anyway.
fn read_only_uri(path: &str) -> String {
    let mut uri = String::from("file:");
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                uri.push(b as char)
            }
            _ => uri.push_str(&format!("%{b:02X}")),
        }
    }
    uri.push_str("?mode=ro");
    uri
}

/// Delete a database file and its WAL/SHM sidecars, if present.
fn remove_db_files(path: &Path) -> Result<(), String> {
    for suffix in ["", "-wal", "-shm"] {
        let mut p = path.as_os_str().to_os_string();
        p.push(suffix);
        let p = std::path::PathBuf::from(p);
        if p.exists() {
            std::fs::remove_file(&p)
                .map_err(|e| format!("Could not replace the previous export file: {e}"))?;
        }
    }
    Ok(())
}

// ── Packaging: the archive the recipient actually receives ────────────────────

/// What an export produced.
///
/// The count is carried back deliberately: a file whose name trips the entry
/// guard, or that has been deleted since it was captured, is skipped rather
/// than failing the whole export — so without this the sender could tick
/// "include files", ship an archive with none of them, and never be told.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// Where the finished archive is.
    pub path: String,
    /// Media files actually written into `artefacts/`.
    pub media_written: usize,
    /// Media files that were meant to travel but could not.
    pub media_skipped: usize,
}

/// One media file on its way into the archive.
pub(crate) struct MediaEntry {
    /// Where the file lives on the **sender's** disk. Read from the sender's
    /// own index, never from the export — see `media_entries_from_source`.
    pub(crate) disk_path: String,
    /// Where it lands inside the ZIP: `artefacts/images/…` or
    /// `artefacts/videos/…`, matching what the captures export already writes
    /// (`recordingsZipPipeline.ts`).
    pub(crate) zip_path: String,
}

/// The exported name of a capture's media file: `{capture_id}.{ext}`.
///
/// Named from the capture id rather than from the source filename, which fixes
/// three things at once. Two captures whose files share a name (`~/Desktop/a.png`
/// and `~/Downloads/a.png`) no longer collapse into one archive entry with both
/// rows pointing at it — which would have shown the recipient one capture's
/// screenshot under another capture's text. A Windows source path
/// (`C:\\Users\\someone\\a.png`) no longer travels whole, which a `/`-only split
/// would have let through and which is the very leak this module exists to
/// prevent. And characters that are legal on macOS but rejected by Windows
/// extractors (`?`, `*`, `|`, control characters) can no longer reach the entry
/// name, where they would have left the recipient's database pointing at a file
/// that never extracted.
///
/// The result is collision-free (ids are primary keys), separator-free and says
/// nothing about the sender — but only the first two of those hold for *any*
/// capture id. The third holds because of what currently reaches this function
/// and nothing more: `media_entries_from_source` selects `kind IN ('image',
/// 'video')`, and those ids are UUIDs. **Document ids are not.** `App.tsx` mints
/// them as `pdf-${Date.now()}-…`, so the moment `artefacts/` is extended to
/// documents — already a planned follow-up — every archive entry name starts
/// carrying the sender's clock to the millisecond, which is a record of when
/// their machine was awake and exactly the class of thing `indexed_at` is NULLed
/// to keep out. Whoever extends the media kinds owes this function an id scheme
/// that does not, or a rewrite here that ignores the id entirely.
///
/// The extension is kept, lower cased, so the recipient's app can still tell a
/// `.png` from a `.mov`.
///
/// This is the ONLY rule. The exported `captures.local_path` column is written
/// from this same function rather than from a parallel SQL expression, so the
/// archive entry and the database value cannot drift apart.
fn exported_media_name(capture_id: &str, local_path: &str) -> String {
    let base = local_path.rsplit(['/', '\\']).next().unwrap_or(local_path);
    match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && ext.len() <= 16 => {
            format!("{capture_id}.{}", ext.to_ascii_lowercase())
        }
        _ => capture_id.to_string(),
    }
}

/// The media files belonging to `capture_ids`, read from the **source** index.
///
/// Read from the source and not from the freshly built export, deliberately:
/// the export's `local_path` is a bare basename (the sender's directories are
/// stripped for privacy — see `capture_cols_src`), so every path taken from
/// there would fail to open and the archive would quietly ship no media at all.
/// The source index still holds the full path.
pub(crate) fn media_entries_from_source(
    src: &Connection,
    capture_ids: &[String],
) -> Result<Vec<MediaEntry>, String> {
    let mut stmt = src
        .prepare(
            "SELECT kind, local_path FROM captures \
             WHERE id = ?1 AND kind IN ('image','video') \
             AND local_path IS NOT NULL AND local_path != ''",
        )
        .map_err(|e| format!("Could not look up the capture files: {e}"))?;

    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut entries: Vec<MediaEntry> = Vec::new();
    for id in capture_ids {
        let row = stmt
            .query_row(params![id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => String::new(),
                other => other.to_string(),
            });
        let (kind, local_path) = match row {
            Ok(v) => v,
            // No media on this capture (a note, a document, or no file at all).
            Err(msg) if msg.is_empty() => continue,
            Err(msg) => return Err(format!("Could not look up the capture files: {msg}")),
        };
        let folder = if kind == "image" { "images" } else { "videos" };
        // Same function that writes the recipient's `captures.local_path`
        // (see `rewrite_media_names`), so the entry and the database value are
        // one rule and cannot drift apart.
        let zip_path = format!("artefacts/{folder}/{}", exported_media_name(id, &local_path));

        // A path out of the database is data, not a name we may trust: the
        // guard is what stops one from addressing a location of its own
        // choosing inside the archive. Skipped rather than fatal — a file
        // whose own name trips the guard is no more worth failing the whole
        // export over than a file that has been deleted, and both end the same
        // way for the recipient: the app's "file not available" placeholder.
        if validate_zip_entry_path(&zip_path).is_err() {
            eprintln!("[index-export] skipping media with an unusable name: {zip_path}");
            continue;
        }
        // Entry names are derived from capture ids, which are unique, so this
        // can no longer fire for two different captures. Kept as a cheap
        // assertion that the naming rule stayed injective.
        if !seen.insert(zip_path.clone()) {
            continue;
        }
        entries.push(MediaEntry { disk_path: local_path, zip_path });
    }
    Ok(entries)
}

/// Write the finished archive at `zip_path`: the export database, its manifest,
/// and whatever media survives `artefacts/`.
/// Returns how many media entries were actually written, so the caller can tell
/// the sender when some of what they ticked did not make it.
pub(crate) fn write_export_zip(
    db_path: &Path,
    manifest: &ExportManifest,
    media: &[MediaEntry],
    zip_path: &Path,
) -> Result<usize, String> {
    if let Some(dir) = zip_path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not prepare the export folder: {e}"))?;
    }
    // Streamed straight to the file rather than assembled in a `Vec` first:
    // a recording is routinely hundreds of megabytes, and the whole archive
    // would otherwise have to fit in memory twice over.
    let file = std::fs::File::create(zip_path)
        .map_err(|e| format!("Could not create the export archive: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("index.db", opts)
        .map_err(|e| format!("Could not add the index to the archive: {e}"))?;
    let mut db = std::fs::File::open(db_path)
        .map_err(|e| format!("Could not read the export we just built: {e}"))?;
    std::io::copy(&mut db, &mut zip)
        .map_err(|e| format!("Could not add the index to the archive: {e}"))?;
    drop(db);

    let manifest_json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Could not describe the export: {e}"))?;
    zip.start_file("manifest.json", opts)
        .map_err(|e| format!("Could not add the export details: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("Could not add the export details: {e}"))?;

    let mut written = 0usize;
    for entry in media {
        let src = Path::new(&entry.disk_path);
        // Checked again here, right before the name is used, so the guard
        // cannot be bypassed by a future caller assembling entries elsewhere.
        validate_zip_entry_path(&entry.zip_path)?;
        let len = match std::fs::metadata(src) {
            // Missing media is normal: the file may have been moved or deleted
            // long after it was indexed. The capture still travels with its
            // text and vectors; only the picture is absent.
            Err(_) => continue,
            Ok(m) if !m.is_file() => continue,
            Ok(m) => m.len(),
        };
        let mut r = match std::fs::File::open(src) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[index-export] skipping unreadable media {}: {e}", entry.disk_path);
                continue;
            }
        };
        // Zip64 only where it is needed: without it a member over 4 GiB cannot
        // be written at all, and with it unconditionally, every entry carries
        // the extension for the sake of a size almost none of them reach.
        let entry_opts = opts.large_file(len >= u32::MAX as u64);
        zip.start_file(&entry.zip_path, entry_opts)
            .map_err(|e| format!("Could not add {} to the archive: {e}", entry.zip_path))?;
        std::io::copy(&mut r, &mut zip)
            .map_err(|e| format!("Could not add {} to the archive: {e}", entry.zip_path))?;
        written += 1;
    }

    let mut file = zip
        .finish()
        .map_err(|e| format!("Could not finish the export archive: {e}"))?;
    // `zip.finish()` is what writes the central directory and hands the file
    // back; the archive is complete at that point. This flush does nothing —
    // `Write::flush` on a `std::fs::File` is a no-op, because a `File` holds no
    // buffer of its own — and is kept only so that a future buffered writer
    // slipped in between here and the file would still be drained.
    file.flush()
        .map_err(|e| format!("Could not finish the export archive: {e}"))?;
    Ok(written)
}

/// The archive's filename, built from the name the user gave the export. Free
/// text becomes a filename here, so everything outside a conservative ASCII set
/// is replaced rather than escaped.
///
/// This is the ONLY place the export's name becomes a filename. The archive is
/// staged in the temp folder under this name, and "Save the file" copies it to
/// Downloads keeping its basename (`copy_local_file_to_downloads_cmd`), so what
/// the user typed reaches Downloads without a second sanitising rule that could
/// disagree with this one.
fn downloads_file_name(name: &str) -> String {
    let mut safe = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            safe.push(c);
        } else if !safe.ends_with('-') {
            safe.push('-');
        }
        if safe.len() >= 60 {
            break;
        }
    }
    let safe = safe.trim_matches('-');
    if safe.is_empty() {
        "kety-index.zip".to_string()
    } else {
        format!("kety-index-{safe}.zip")
    }
}

/// `dir/file_name`, or the first free `dir/stem-N.zip` when that is taken.
///
/// Naming the staged archive after the export means two exports called the same
/// thing want the same path, so this is what keeps a second one from writing
/// over the first while the first is still waiting to be sent.
fn free_path_in(dir: &Path, file_name: &str) -> PathBuf {
    let path = dir.join(file_name);
    if !path.exists() {
        return path;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("kety-index");
    for i in 1..10_000u32 {
        let candidate = dir.join(format!("{stem}-{i}.zip"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

/// Build a shareable archive from `capture_ids` and return its path.
///
/// The archive lands in a temp file named after the export, which the caller
/// owns and must delete once it has been sent or abandoned. Naming it after the
/// export is not cosmetic: both ways of sending it end up using that basename —
/// "Save the file" copies it to Downloads under it — so a `kts-index-export-
/// <uuid>.zip` here is what the recipient would have ended up with.
///
/// `selected_tag_ids` are the tag chips the sender left ticked. Captures carry
/// only these tags out, and only these tags get a `tags` row — see
/// `build_export_db`.
///
/// `include_window_titles` is the sender's explicit choice to ship window
/// titles, which routinely name their account, machine or folders. The curation
/// UI defaults it to false.
///
/// The building happens on a blocking worker, never on the thread that answers
/// the command — the same treatment, for the same reason, as the import side. A
/// synchronous `#[tauri::command]` runs on the main thread, which on macOS is the
/// one driving the webview; this one builds a whole SQLite database, copies every
/// selected media file and deflates a ZIP that can run to gigabytes. On the main
/// thread that is the window frozen for the length of the export, with no
/// progress and no way to tell it apart from a crash.
#[tauri::command]
pub async fn build_index_export_cmd(
    app: tauri::AppHandle,
    user_id: String,
    capture_ids: Vec<String>,
    selected_tag_ids: Vec<String>,
    name: String,
    include_media: bool,
    include_window_titles: bool,
    index: tauri::State<'_, crate::local_index::LocalIndexState>,
) -> Result<ExportResult, String> {
    // The source index, and the media paths, under one lock.
    //
    // `get_for` before `db_path_for`: the latter only computes a
    // path, and the copy below names every column explicitly, so a profile
    // whose file predates a migration would fail on a missing column. Opening
    // it through the pool runs the migrations first.
    //
    // Scoped so the guard is dropped before the await below. `LocalIndexState` is
    // a std `Mutex`: held across an await it would make this future non-`Send`
    // and, worse, keep the one pooled connection locked for the whole export —
    // every read in the app blocked behind a multi-gigabyte ZIP. What crosses the
    // boundary is a path and a list of paths, not the connection.
    let (src_path, media) = {
        let mut guard = index.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.get_for(&app, &user_id, None)?;
        let media = if include_media {
            media_entries_from_source(conn, &capture_ids)?
        } else {
            Vec::new()
        };
        let path = guard.db_path_for(&app, &user_id, None)?;
        (path, media)
    };

    tauri::async_runtime::spawn_blocking(move || {
        // The database is built to its own temp file first: it is one member of
        // the archive, not the archive.
        let staged_db = std::env::temp_dir().join(format!("kts-index-export-{}.db", uuid::Uuid::new_v4()));

        let manifest = build_export_db(
            &src_path,
            &staged_db,
            &capture_ids,
            &selected_tag_ids,
            &name,
            include_window_titles,
        )?;

        // Staged under the name the user typed, not under a uuid. The temp file's
        // basename is not private to this function: "Save the file" copies it to
        // Downloads as-is, so a uuid here is a uuid on the user's disk and in what
        // they hand to someone else.
        let dest = free_path_in(&std::env::temp_dir(), &downloads_file_name(&name));

        let written = write_export_zip(&staged_db, &manifest, &media, &dest);

        // The staged database is a full, unencrypted copy of everything being
        // shared. It goes whether the archive succeeded or not.
        let _ = remove_db_files(&staged_db);

        let media_written = match written {
            Ok(n) => n,
            Err(e) => {
                // Never leave a half-written archive behind: it is a valid path to
                // something that would upload or open as a broken file.
                let _ = std::fs::remove_file(&dest);
                return Err(e);
            }
        };

        let dest_str = dest
            .to_str()
            .ok_or_else(|| "The export path contains characters we cannot read.".to_string())?
            .to_string();
        Ok(ExportResult {
            path: dest_str,
            media_written,
            media_skipped: media.len().saturating_sub(media_written),
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking panic: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "EXCLUDED-CAPTURE-SECRET-TEXT";
    const KEPT: &str = "kept capture text";
    /// Stands in for every absolute path the sender's machine puts in a row.
    const SENDER_PATH: &str = "/Users/sender-account/Pictures/shot.png";
    /// What `SENDER_PATH` is allowed to shrink to: the filename, no folders.
    const SENDER_BASENAME: &str = "shot.png";
    /// A window title of the kind a terminal or editor writes: the sender's OS
    /// account, their machine name and their folder layout, in one string.
    const SENDER_WINDOW: &str = "sender-account@Senders-MacBook-Pro: ~/Desktop/Clients/acme";
    /// A `meta` key nobody has allowlisted. Stands in for the next field
    /// someone adds: with a denylist it would ship itself.
    const UNKNOWN_META_KEY_VALUE: &str = "UNKNOWN-META-KEY-/Users/sender-account/notes";
    /// When the sender's indexing sweep ran — `captures.indexed_at` and
    /// `chunk_embeddings.created_at`. A record of when their machine was awake.
    const SENDER_SWEEP_AT: &str = "2026-03-14T02:17:31.000Z";
    /// When the capture itself happened. This one MUST travel.
    const CAPTURED_AT: &str = "2026-01-01T00:00:00.000Z";
    /// Counters from the sender's OS: which process, which window. Both
    /// describe that machine's session and mean nothing on the recipient's.
    const SENDER_PROCESS_ID: u32 = 40321;
    const SENDER_WINDOW_NUMBER: u32 = 90887;

    /// `captures.meta` as the app writes it (`captureStoreHelpers.ts`), carrying
    /// the top-level `thumbnailPath`, the two paths nested in `contextFocus`,
    /// the window fields — and one key the allowlist has never heard of.
    fn sender_meta() -> String {
        format!(
            "{{\"contextFocus\":{{\"appName\":\"Slack\",\"bundleId\":\"com.tinyspeck.slackmacgap\",\
             \"processId\":{SENDER_PROCESS_ID},\"windowNumber\":{SENDER_WINDOW_NUMBER},\
             \"appHidden\":false,\"windowName\":\"{SENDER_WINDOW}\",\
             \"windowBounds\":{{\"x\":0,\"y\":25,\"width\":1728,\"height\":1079}},\
             \"windowOwnerName\":null,\
             \"bundlePath\":\"{SENDER_PATH}\",\"executablePath\":\"{SENDER_PATH}\"}},\
             \"lang\":\"en\",\"fileSize\":4096,\"summary\":\"a short summary\",\
             \"thumbnailPath\":\"{SENDER_PATH}\",\"sourceDocumentPath\":\"{UNKNOWN_META_KEY_VALUE}\"}}"
        )
    }

    /// A source index holding two captures: `keep` (tag t-keep, one embedded
    /// chunk plus one failed embedding) and `drop` (tag t-drop, secret text).
    /// Both carry the sender's user id and the sender's absolute paths.
    fn make_source(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("source.db");
        let conn = Connection::open(&path).unwrap();
        crate::local_index::create_schema(&conn).unwrap();
        for (id, text) in [("keep", KEPT), ("drop", SECRET)] {
            conn.execute(
                "INSERT INTO captures(id,user_id,raw_text,kind,tag_ids,created_at,indexed_at,\
                 local_path,kety_server_path,index_error,meta,app_name,window_name) \
                 VALUES (?1,'sender-user',?2,'image',?3,?9,?10,?4,?5,?6,?7,'Slack',?8)",
                params![
                    id,
                    text,
                    format!("[\"t-{id}\"]"),
                    SENDER_PATH,
                    format!("users/sender-user/{id}.png"),
                    format!("could not read {SENDER_PATH}"),
                    sender_meta(),
                    SENDER_WINDOW,
                    CAPTURED_AT,
                    SENDER_SWEEP_AT,
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO chunks(id,capture_id,seq,chunk_text,chunk_type) VALUES (?1,?2,0,?3,'raw_text')",
                params![format!("chunk-{id}"), id, text],
            )
            .unwrap();
            // A *successful* embedding that still carries error text: today's
            // writers leave `error_msg` NULL on an 'ok' row, so only an
            // explicit NULL in the copy keeps it that way tomorrow.
            conn.execute(
                "INSERT INTO chunk_embeddings(id,chunk_id,embed_model,embed_dim,embedding,created_at,status,error_msg) \
                 VALUES (?1,?2,'test-model',4,?3,?5,'ok',?4)",
                params![
                    format!("emb-{id}"),
                    format!("chunk-{id}"),
                    vec![1u8, 2, 3, 4],
                    format!("retried after {SENDER_PATH} timed out"),
                    SENDER_SWEEP_AT,
                ],
            )
            .unwrap();
            // `auto_assign_apps` is the sender's live auto-tagging rule, not a
            // fact about the exported captures — it must never survive export.
            conn.execute(
                "INSERT INTO tags(id,user_id,name,auto_assign_apps,created_at) \
                 VALUES (?1,'sender-user',?2,'[\"Slack\",\"Mail\"]','2026-01-01T00:00:00.000Z')",
                params![format!("t-{id}"), format!("tag {id}")],
            )
            .unwrap();
        }
        // A second chunk of `keep` whose embedding failed: empty blob, status='error'.
        conn.execute(
            "INSERT INTO chunks(id,capture_id,seq,chunk_text,chunk_type) \
             VALUES ('chunk-keep-2','keep',1,'second kept chunk','raw_text')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunk_embeddings(id,chunk_id,embed_model,embed_dim,embedding,created_at,status,error_msg) \
             VALUES ('emb-keep-2','chunk-keep-2','test-model',4,X'',?1,'error','boom')",
            params![SENDER_SWEEP_AT],
        )
        .unwrap();
        path
    }

    /// Every tag the fixture has, all ticked — the "the sender excluded no tag"
    /// case, which is what the tests that are not about tag filtering assume.
    fn all_tags() -> Vec<String> {
        vec!["t-keep".to_string(), "t-drop".to_string()]
    }

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kts-export-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn exports_only_the_selected_captures_and_their_rows() {
        let dir = scratch_dir("selected");
        let src = make_source(&dir);
        let dest = dir.join("export.db");

        let manifest =
            build_export_db(&src, &dest, &["keep".to_string()], &all_tags(), "My export", false).unwrap();
        assert_eq!(manifest.capture_count, 1);
        assert_eq!(manifest.chunk_count, 2);
        assert_eq!(manifest.embed_model, "test-model");
        assert_eq!(manifest.format_version, EXPORT_FORMAT_VERSION);
        assert_eq!(manifest.name, "My export");
        assert!(!manifest.export_id.is_empty());
        assert!(manifest.exported_at.ends_with('Z'));

        let out = Connection::open(&dest).unwrap();
        let ids: Vec<String> = out
            .prepare("SELECT id FROM captures")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids, vec!["keep".to_string()]);

        // The sender's user id must not travel with the captures.
        let owner: Option<String> = out
            .query_row("SELECT user_id FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(owner, None);

        // Only embeddings that succeeded: the empty-blob error row is dropped.
        let embs: Vec<String> = out
            .prepare("SELECT chunk_id FROM chunk_embeddings")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(embs, vec!["chunk-keep".to_string()]);

        // Only tags the exported captures reference.
        let tags: Vec<String> = out
            .prepare("SELECT id FROM tags")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(tags, vec!["t-keep".to_string()]);

        let model: String = out
            .query_row("SELECT value FROM meta WHERE key='active_embed_model'", [], |r| r.get(0))
            .unwrap();
        let dim: String = out
            .query_row("SELECT value FROM meta WHERE key='active_embed_dim'", [], |r| r.get(0))
            .unwrap();
        assert_eq!((model.as_str(), dim.as_str()), ("test-model", "4"));

        // Keyword search works for the recipient, and finds only exported text.
        let hits: i64 = out
            .query_row("SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH 'kept'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 2);

        drop(out);

        // The recipient opens the file with the ordinary index-opening code:
        // it must pass schema creation + migrations untouched.
        let reopened = Connection::open(&dest).unwrap();
        // As the recipient opens it: an imported index, not their own.
        crate::local_index::init_db(&reopened, crate::local_index::IndexKind::Imported).unwrap();
        let after: i64 = reopened
            .query_row("SELECT COUNT(*) FROM captures", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 1);
        let fts_after: i64 = reopened
            .query_row("SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH 'kept'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fts_after, 2);
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    #[test]
    fn excluded_capture_text_is_absent_from_the_file_bytes() {
        let dir = scratch_dir("bytes");
        let src = make_source(&dir);
        let dest = dir.join("export.db");
        build_export_db(&src, &dest, &["keep".to_string()], &all_tags(), "My export", false).unwrap();

        // `.unwrap()`, never a silent skip: a main database file we cannot read
        // is a failure, not a reason to pass having scanned nothing.
        let bytes = std::fs::read(&dest).unwrap();

        // Positive control. Without it an empty — or garbage — export would sail
        // through every assertion below, since absent text is trivially absent.
        assert!(
            contains(&bytes, KEPT),
            "the kept capture's text is missing: the export is empty or unreadable, \
             so the leak checks below would prove nothing"
        );

        // The basename is the one part of the sender's path that may travel,
        // so assert on the directories: everything up to the last separator.
        let sender_dir = SENDER_PATH.strip_suffix(SENDER_BASENAME).unwrap();

        // The whole point of building a fresh DB instead of copy-then-delete:
        // excluded text must not survive anywhere in the file, not even in
        // pages that SQLite considers free. Nor may anything naming the sender.
        for (label, needle) in [
            ("excluded capture text", SECRET),
            ("the sender's folders", sender_dir),
            ("a window title", SENDER_WINDOW),
            ("a meta key nobody allowlisted", UNKNOWN_META_KEY_VALUE),
            ("when the sender's machine was indexing", SENDER_SWEEP_AT),
            ("the sender's process id", &SENDER_PROCESS_ID.to_string()),
            ("the sender's window number", &SENDER_WINDOW_NUMBER.to_string()),
        ] {
            assert!(!contains(&bytes, needle), "{label} leaked into {}", dest.display());
        }

        // The capture's own date is the counterexample: stripping timestamps
        // must not have taken the one the recipient needs.
        assert!(contains(&bytes, CAPTURED_AT), "the capture's own date stopped travelling");
    }

    /// A tag whose chip the sender unticked. The name alone is the leak: a tag
    /// taxonomy tells a recipient what the sender is up to, the same way
    /// `tags.auto_assign_apps` did.
    const UNTICKED_TAG_NAME: &str = "Job-hunt-UNTICKED";
    const UNTICKED_TAG_DESC: &str = "roles I am quietly applying for";

    #[test]
    fn a_tag_the_sender_unticked_does_not_travel() {
        let dir = scratch_dir("untickedtag");
        let src = make_source(&dir);
        {
            let conn = Connection::open(&src).unwrap();
            // `keep` carries both tags. It travels because `t-keep` is ticked —
            // that part is correct — but it must not carry `t-drop` with it.
            conn.execute(
                "UPDATE captures SET tag_ids = '[\"t-keep\",\"t-drop\"]' WHERE id='keep'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE tags SET name = ?1, description = ?2 WHERE id='t-drop'",
                params![UNTICKED_TAG_NAME, UNTICKED_TAG_DESC],
            )
            .unwrap();
        }
        let dest = dir.join("export.db");
        let manifest = build_export_db(
            &src,
            &dest,
            &["keep".to_string()],
            &["t-keep".to_string()],
            "x",
            false,
        )
        .unwrap();
        // The capture still travelled: matching on any ticked tag is right.
        assert_eq!(manifest.capture_count, 1);

        let out = Connection::open(&dest).unwrap();
        // The capture's own tag list is cut down, not just the `tags` table —
        // otherwise the id is still there for an importer to resurrect.
        let tag_ids: String = out
            .query_row("SELECT tag_ids FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tag_ids, r#"["t-keep"]"#);
        let tags: Vec<String> = out
            .prepare("SELECT id FROM tags")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(tags, vec!["t-keep".to_string()]);
        drop(out);

        let bytes = std::fs::read(&dest).unwrap();
        // Positive controls: the export is real, and a *ticked* tag's name does
        // travel — so the absences below are the filter working, not an empty
        // file or a fixture whose tags never had names.
        assert!(contains(&bytes, KEPT), "the export is empty or unreadable");
        assert!(contains(&bytes, "tag keep"), "no ticked tag name travelled at all");

        for (label, needle) in [
            ("the unticked tag's name", UNTICKED_TAG_NAME),
            ("the unticked tag's description", UNTICKED_TAG_DESC),
            ("the unticked tag's id", "t-drop"),
        ] {
            assert!(!contains(&bytes, needle), "{label} leaked into {}", dest.display());
        }
    }

    #[test]
    fn ticking_only_the_no_tag_chip_ships_no_tags_at_all() {
        // "No tag" is a UI-side chip for captures carrying no tags: it has no
        // tag id, so it reaches the backend as an empty selected-tag list. That
        // has to fail closed — no tag survives, no `tags` row is written.
        let dir = scratch_dir("notagchip");
        let src = make_source(&dir);
        let dest = dir.join("export.db");
        build_export_db(&src, &dest, &["keep".to_string()], &[], "x", false).unwrap();

        let out = Connection::open(&dest).unwrap();
        let tag_ids: String = out
            .query_row("SELECT tag_ids FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tag_ids, "[]");
        let tags: i64 = out.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(tags, 0);
        drop(out);
        assert!(!contains(&std::fs::read(&dest).unwrap(), "tag keep"));
    }

    /// `index_state` is the outcome of the sender's indexing sweep, the same
    /// class of thing as the `indexed_at` NULLed beside it. A capture the
    /// sender's indexer gave up on must not arrive marked `'failed'`: the reason
    /// does not travel (`index_error` is NULLed) and an imported index is
    /// read-only, so there is nothing the recipient could do about it.
    ///
    /// `'indexing'` is the same rule for a sharper reason: it means "a worker on the
    /// sender's machine is on this capture right now", which is never true of the
    /// recipient's copy, and nothing in an imported index would ever clear it — the
    /// crash-recovery reset is the recipient's, and it fires on their first open.
    #[test]
    fn the_senders_indexing_outcome_does_not_travel() {
        for sender_state in ["failed", "indexing"] {
            let dir = scratch_dir(&format!("index-state-{sender_state}"));
            let src = make_source(&dir);
            {
                let conn = Connection::open(&src).unwrap();
                conn.execute(
                    "UPDATE captures SET index_state=?1 WHERE id='keep'",
                    rusqlite::params![sender_state],
                )
                .unwrap();
            }
            let dest = dir.join("export.db");
            build_export_db(&src, &dest, &["keep".to_string()], &all_tags(), "My export", false)
                .unwrap();

            let out = Connection::open(&dest).unwrap();
            let state: String = out
                .query_row("SELECT index_state FROM captures WHERE id='keep'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(state, "pending", "the sender's '{sender_state}' travelled");
        }

        let dir = scratch_dir("index-state");
        let src = make_source(&dir);
        let dest = dir.join("export.db");
        build_export_db(&src, &dest, &["keep".to_string()], &all_tags(), "My export", false).unwrap();
        let out = Connection::open(&dest).unwrap();

        // And it self-corrects on the recipient's first open: the archive brought
        // a usable vector for this capture, so `init_db`'s backfill marks it
        // indexed rather than leaving it queued for a pass that cannot run.
        crate::local_index::init_db(&out, crate::local_index::IndexKind::Imported).unwrap();
        let state: String = out
            .query_row("SELECT index_state FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state, "indexed");
    }

    /// `meta` of the exported `keep` capture, parsed.
    fn exported_meta(out: &Connection) -> serde_json::Value {
        let meta: String = out
            .query_row("SELECT meta FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        serde_json::from_str(&meta).unwrap()
    }

    #[test]
    fn sender_paths_and_identifiers_do_not_travel() {
        let dir = scratch_dir("paths");
        let src = make_source(&dir);
        let dest = dir.join("export.db");
        build_export_db(&src, &dest, &["keep".to_string()], &all_tags(), "My export", false).unwrap();

        let out = Connection::open(&dest).unwrap();
        for col in ["user_id", "kety_server_path", "index_error", "window_name", "indexed_at"] {
            let v: Option<String> = out
                .query_row(
                    &format!("SELECT {col} FROM captures WHERE id='keep'"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(v, None, "{col} still carries the sender");
        }

        // `local_path` becomes `{capture_id}.{ext}` — the sender's filename is
        // gone along with the folders. Not NULL:
        // `captureRowsToOffSession` drops an image or video row whose
        // `localPath` is falsy, so a NULL here would hide the capture entirely.
        let local_path: Option<String> = out
            .query_row("SELECT local_path FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(local_path.as_deref(), Some("keep.png"));
        assert!(
            !local_path.as_deref().unwrap().contains("shot"),
            "the sender's filename travelled"
        );

        // Error text on a *successful* embedding is dropped, not trusted to be
        // empty.
        let err: Option<String> = out
            .query_row("SELECT error_msg FROM chunk_embeddings WHERE id='emb-keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(err, None, "chunk_embeddings.error_msg still carries the sender");

        // When the sender's embedding pass ran is bookkeeping for their machine
        // — a row of these maps the hours it was awake. The column is NOT NULL
        // in the shared schema, so it is emptied rather than NULLed.
        let emb_created: String = out
            .query_row("SELECT created_at FROM chunk_embeddings WHERE id='emb-keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(emb_created, "", "chunk_embeddings.created_at still dates the sender's sweep");

        // But when the CAPTURE happened must still travel: it is the whole of
        // the recipient's sense of when any of this is from.
        let created_at: Option<String> = out
            .query_row("SELECT created_at FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            created_at.as_deref(),
            Some(CAPTURED_AT),
            "the capture's own date stopped travelling"
        );

        // `meta` is rebuilt from the allowlist: what describes the capture
        // stays, the paths, the window fields and anything unrecognised go.
        let meta = exported_meta(&out);
        let focus = &meta["contextFocus"];
        assert_eq!(focus["appName"], "Slack");
        assert_eq!(focus["bundleId"], "com.tinyspeck.slackmacgap");
        // `->` keeps JSON types: a boolean must not arrive as 0/1.
        assert_eq!(focus["appHidden"], serde_json::Value::Bool(false));
        assert_eq!(meta["lang"], "en");
        assert_eq!(meta["fileSize"], 4096);
        assert_eq!(meta["summary"], "a short summary");
        for gone in ["thumbnailPath", "sourceDocumentPath"] {
            assert_eq!(meta.get(gone), None, "meta.{gone} survived the allowlist");
        }
        for gone in [
            "bundlePath",
            "executablePath",
            "windowName",
            "windowBounds",
            // Counters from the sender's OS session, the same class as
            // `windowBounds`: they fingerprint that machine and mean nothing
            // on the recipient's.
            "processId",
            "windowNumber",
        ] {
            assert_eq!(focus.get(gone), None, "contextFocus.{gone} survived the allowlist");
        }
        // A key the source had as JSON null arrives absent, not as null — the
        // shape consumers already handle with `?? null`.
        assert_eq!(focus.get("windowOwnerName"), None);

        // `create_schema` also creates `share_links` — the sender's signed
        // download URLs. Nothing copies into it and nothing ever should.
        let links: i64 = out
            .query_row("SELECT COUNT(*) FROM share_links", [], |r| r.get(0))
            .unwrap();
        assert_eq!(links, 0, "the sender's share links travelled with the export");

        // Tags travel unowned too, and the import path has to re-own them.
        let tag_owner: Option<String> = out
            .query_row("SELECT user_id FROM tags WHERE id='t-keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tag_owner, None);

        // `auto_assign_apps` must not travel: on import it becomes a live rule
        // that would auto-tag the *recipient's* own future captures, not just
        // reveal the sender's app usage. The source tag carries a non-empty
        // list; the exported tag must carry the empty-rules default instead.
        let auto_assign_apps: String = out
            .query_row(
                "SELECT auto_assign_apps FROM tags WHERE id='t-keep'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            auto_assign_apps, "[]",
            "the sender's auto-assign rules travelled with the export"
        );
    }

    #[test]
    fn window_titles_travel_only_when_the_export_asks_for_them() {
        let dir = scratch_dir("windows");
        let src = make_source(&dir);

        // Opted in: the column and both `contextFocus` window fields survive
        // untouched, because the sender decided they are part of the share.
        let kept = dir.join("kept.db");
        build_export_db(&src, &kept, &["keep".to_string()], &all_tags(), "x", true).unwrap();
        let out = Connection::open(&kept).unwrap();
        let col: Option<String> = out
            .query_row("SELECT window_name FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(col.as_deref(), Some(SENDER_WINDOW));
        let meta = exported_meta(&out);
        assert_eq!(meta["contextFocus"]["windowName"], SENDER_WINDOW);
        assert_eq!(meta["contextFocus"]["windowBounds"]["width"], 1728);
        // Opting in to titles opts in to nothing else.
        assert_eq!(meta["contextFocus"].get("bundlePath"), None);
        assert_eq!(meta.get("thumbnailPath"), None);
        drop(out);

        // And the title really is in the bytes when asked for — so the absence
        // asserted in the stripped case below is the stripping at work, not a
        // fixture that never carried a title.
        assert!(contains(&std::fs::read(&kept).unwrap(), SENDER_WINDOW));

        // Left out (the default the UI passes): gone from both places.
        let stripped = dir.join("stripped.db");
        build_export_db(&src, &stripped, &["keep".to_string()], &all_tags(), "x", false).unwrap();
        let out = Connection::open(&stripped).unwrap();
        let col: Option<String> = out
            .query_row("SELECT window_name FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(col, None);
        let meta = exported_meta(&out);
        assert_eq!(meta["contextFocus"].get("windowName"), None);
        assert_eq!(meta["contextFocus"].get("windowBounds"), None);
        drop(out);
        assert!(!contains(&std::fs::read(&stripped).unwrap(), SENDER_WINDOW));
    }

    #[test]
    fn the_export_is_self_contained_on_disk() {
        let dir = scratch_dir("selfcontained");
        let src = make_source(&dir);
        let dest = dir.join("export.db");
        build_export_db(&src, &dest, &["keep".to_string()], &all_tags(), "x", false).unwrap();

        // Only `index.db` is packaged, so every byte has to be in it: a
        // surviving sidecar would mean an archive with a truncated database.
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut p = dest.as_os_str().to_os_string();
            p.push(suffix);
            let p = std::path::PathBuf::from(p);
            assert!(!p.exists(), "{} was left next to the export", p.display());
        }

        // Nothing in the export points back at the sender's index: it still
        // reads after that database is gone.
        std::fs::remove_file(&src).unwrap();
        let out = Connection::open(&dest).unwrap();

        // Not WAL. Closing the build connection cleanly happens to checkpoint
        // and delete the sidecar, which is why the absence check above passes
        // either way — but that is luck, not design: an unclean exit mid-export
        // leaves a `-wal` the zip would not carry. The journal mode lives in
        // the database header, so this reads exactly what the recipient's
        // SQLite will see.
        let mode: String = out.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(
            mode, "delete",
            "the export is in WAL mode; zipping index.db alone can then ship a truncated database"
        );
        let captures: i64 = out
            .query_row("SELECT COUNT(*) FROM captures", [], |r| r.get(0))
            .unwrap();
        assert_eq!(captures, 1);
        let hits: i64 = out
            .query_row("SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH 'kept'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 2);
    }

    #[test]
    fn refuses_an_export_that_copied_nothing() {
        let dir = scratch_dir("nomatch");
        let src = make_source(&dir);
        let dest = dir.join("export.db");
        match build_export_db(&src, &dest, &["no-such-capture".to_string()], &all_tags(), "x", false) {
            Err(e) => assert_eq!(
                e,
                "None of the captures you picked are in your knowledge index any more, \
                 so there is nothing to export."
            ),
            Ok(_) => panic!("an export that copied nothing must be refused, not shipped empty"),
        }
        assert!(!dest.exists(), "an empty export file was left behind to be shared");
    }

    #[test]
    fn meta_that_is_not_json_is_dropped_rather_than_shipped() {
        let dir = scratch_dir("badmeta");
        let src = make_source(&dir);
        {
            let conn = Connection::open(&src).unwrap();
            conn.execute(
                "UPDATE captures SET meta = ?1 WHERE id='keep'",
                params![format!("not json at all {SENDER_PATH}")],
            )
            .unwrap();
        }
        let dest = dir.join("export.db");
        build_export_db(&src, &dest, &["keep".to_string()], &all_tags(), "x", false).unwrap();

        let out = Connection::open(&dest).unwrap();
        let meta: Option<String> = out
            .query_row("SELECT meta FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(meta, None);
    }

    #[test]
    fn exports_from_a_wal_source_with_no_sidecars() {
        // A read-only attach of a WAL database fails when its `-shm` is gone.
        // The export must still work, so this covers the fallback attach.
        let dir = scratch_dir("wal");
        let src = make_source(&dir);
        {
            let conn = Connection::open(&src).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        }
        for suffix in ["-wal", "-shm"] {
            let mut p = src.as_os_str().to_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
        }

        let dest = dir.join("export.db");
        let manifest = build_export_db(&src, &dest, &["keep".to_string()], &all_tags(), "x", false).unwrap();
        assert_eq!(manifest.capture_count, 1);
    }

    #[test]
    fn refuses_a_missing_source_index() {
        let dir = scratch_dir("missing");
        let missing = dir.join("no-such-index.db");
        match build_export_db(&missing, &dir.join("export.db"), &["keep".to_string()], &all_tags(), "x", false) {
            Err(e) => assert_eq!(
                e,
                "We could not find your knowledge index, so there is nothing to export."
            ),
            Ok(_) => panic!("a missing source index must be refused, not silently exported empty"),
        }
        // And no junk database was conjured at the source path by ATTACH.
        assert!(!missing.exists(), "ATTACH created an empty source database");
    }

    #[test]
    fn refuses_an_empty_selection() {
        let dir = scratch_dir("empty");
        let src = make_source(&dir);
        match build_export_db(&src, &dir.join("export.db"), &[], &all_tags(), "x", false) {
            Err(e) => assert_eq!(e, "Nothing to export: no captures were selected."),
            Ok(_) => panic!("an empty selection must be refused"),
        }
    }

    // ── Packaging ─────────────────────────────────────────────────────────────

    const MEDIA_BYTES: &[u8] = b"\x89PNG\r\n\x1a\n-pretend-this-is-a-screenshot";

    /// Point `keep` at a real file on disk, under a directory that stands in
    /// for the sender's home folder, and return that path.
    fn give_keep_real_media(dir: &Path, src: &Path) -> std::path::PathBuf {
        let media_dir = dir.join("sender-home").join("Pictures");
        std::fs::create_dir_all(&media_dir).unwrap();
        let media = media_dir.join(SENDER_BASENAME);
        std::fs::write(&media, MEDIA_BYTES).unwrap();
        let conn = Connection::open(src).unwrap();
        conn.execute(
            "UPDATE captures SET local_path = ?1 WHERE id='keep'",
            params![media.to_str().unwrap()],
        )
        .unwrap();
        media
    }

    /// Entry names in the archive, and the bytes of one named entry.
    fn zip_names(path: &Path) -> Vec<String> {
        let f = std::fs::File::open(path).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect()
    }
    fn zip_bytes(path: &Path, name: &str) -> Vec<u8> {
        use std::io::Read;
        let f = std::fs::File::open(path).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        let mut e = z.by_name(name).unwrap_or_else(|_| panic!("{name} is not in the archive"));
        let mut out = Vec::new();
        e.read_to_end(&mut out).unwrap();
        out
    }

    /// The whole packaging step, minus the AppHandle the command needs: build
    /// the database, collect the media from the SOURCE, write the archive.
    fn package(dir: &Path, src: &Path, ids: &[String]) -> std::path::PathBuf {
        let staged = dir.join("staged.db");
        let manifest = build_export_db(src, &staged, ids, &all_tags(), "My export", false).unwrap();
        let conn = Connection::open(src).unwrap();
        let media = media_entries_from_source(&conn, ids).unwrap();
        let zip_path = dir.join("export.zip");
        write_export_zip(&staged, &manifest, &media, &zip_path).unwrap();
        let _ = remove_db_files(&staged);
        zip_path
    }

    #[test]
    fn the_archive_carries_the_index_the_manifest_and_the_media() {
        let dir = scratch_dir("zip");
        let src = make_source(&dir);
        let media = give_keep_real_media(&dir, &src);
        let zip_path = package(&dir, &src, &["keep".to_string()]);

        let names = zip_names(&zip_path);
        assert!(names.contains(&"index.db".to_string()), "no index.db in {names:?}");
        assert!(names.contains(&"manifest.json".to_string()), "no manifest.json in {names:?}");

        // The media is there, byte for byte — not merely an entry of the right
        // name holding nothing.
        let entry = "artefacts/images/keep.png".to_string();
        assert!(names.contains(&entry), "no media in {names:?}");
        assert_eq!(zip_bytes(&zip_path, &entry), MEDIA_BYTES);

        // The archived database is the real one and still opens.
        let extracted = dir.join("extracted.db");
        std::fs::write(&extracted, zip_bytes(&zip_path, "index.db")).unwrap();
        let out = Connection::open(&extracted).unwrap();
        let captures: i64 = out
            .query_row("SELECT COUNT(*) FROM captures", [], |r| r.get(0))
            .unwrap();
        assert_eq!(captures, 1);

        // THE point of reading media paths from the source: the archived entry
        // has to be exactly what the archived database says `local_path` is.
        // Take a media path from the export instead and this is where it shows
        // — the export's paths are bare basenames that open nothing.
        let local_path: String = out
            .query_row("SELECT local_path FROM captures WHERE id='keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(entry, format!("artefacts/images/{local_path}"));
        // And the sender's folders are still absent from the archived database
        // even though we just read the full path out of their index.
        let sender_dir = media.parent().unwrap().to_str().unwrap();
        assert!(!contains(&zip_bytes(&zip_path, "index.db"), sender_dir));

        let manifest: serde_json::Value =
            serde_json::from_slice(&zip_bytes(&zip_path, "manifest.json")).unwrap();
        assert_eq!(manifest["formatVersion"], 1);
        assert_eq!(manifest["name"], "My export");
        assert_eq!(manifest["captureCount"], 1);
        assert_eq!(manifest["chunkCount"], 2);
        assert_eq!(manifest["embedModel"], "test-model");
        assert!(manifest["exportId"].as_str().is_some_and(|s| !s.is_empty()));
    }

    #[test]
    fn media_that_is_gone_from_disk_does_not_fail_the_export() {
        let dir = scratch_dir("zipmissing");
        let src = make_source(&dir);
        // `keep` still points at the sender's fictional path: nothing is there.
        let zip_path = package(&dir, &src, &["keep".to_string()]);
        let names = zip_names(&zip_path);
        assert_eq!(names, vec!["index.db".to_string(), "manifest.json".to_string()]);
    }

    #[test]
    fn media_is_collected_only_for_the_exported_captures() {
        let dir = scratch_dir("zipselect");
        let src = make_source(&dir);
        give_keep_real_media(&dir, &src);
        let conn = Connection::open(&src).unwrap();

        let entries = media_entries_from_source(&conn, &["keep".to_string()]).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].zip_path, "artefacts/images/keep.png");

        // The excluded capture's media must not be collected, even though its
        // row is right there in the same source index.
        let entries = media_entries_from_source(&conn, &["drop".to_string()]).unwrap();
        assert_eq!(entries.len(), 1, "fixture changed: 'drop' should still have a path");
        let none = media_entries_from_source(&conn, &["no-such-capture".to_string()]).unwrap();
        assert!(none.is_empty());

        // A video goes to artefacts/videos, a note nowhere.
        conn.execute("UPDATE captures SET kind='video' WHERE id='keep'", []).unwrap();
        let entries = media_entries_from_source(&conn, &["keep".to_string()]).unwrap();
        assert_eq!(entries[0].zip_path, "artefacts/videos/keep.png");
        conn.execute("UPDATE captures SET kind='note' WHERE id='keep'", []).unwrap();
        assert!(media_entries_from_source(&conn, &["keep".to_string()]).unwrap().is_empty());
    }

    #[test]
    fn a_path_from_the_database_cannot_escape_the_artefacts_folder() {
        let dir = scratch_dir("zipescape");
        let src = make_source(&dir);
        let conn = Connection::open(&src).unwrap();
        let entries_for = |p: &str| {
            conn.execute("UPDATE captures SET local_path = ?1 WHERE id='keep'", params![p])
                .unwrap();
            media_entries_from_source(&conn, &["keep".to_string()]).unwrap()
        };

        // Traversal cannot survive naming by capture id: the source path is
        // read only for its extension, so nothing of it reaches the entry name.
        for defused in [
            ("/etc/passwd/../../../../etc/cron.d/evil", "artefacts/images/keep"),
            ("../../../../evil.sh", "artefacts/images/keep.sh"),
        ] {
            let entries = entries_for(defused.0);
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].zip_path, defused.1, "{} escaped", defused.0);
        }

        // Paths that used to need the guard — one ending in `..`, and a
        // Windows path with no `/` to split on — are now defused earlier: the
        // entry is named from the capture id, so none of the path survives to
        // be dangerous. They still produce an entry, and that entry is safe.
        for evil in ["/Users/sender-account/Pictures/..", "..", r"..\..\Windows\evil.exe"] {
            let entries = entries_for(evil);
            for e in &entries {
                assert!(e.zip_path.starts_with("artefacts/"), "{evil} escaped");
                assert!(!e.zip_path.contains(".."), "{evil} kept a traversal");
                assert!(!e.zip_path.contains("Windows"), "{evil} kept the sender's path");
            }
        }

        // Whatever the path, the entry stays inside artefacts/ and carries no `..`.
        for any in [
            "/etc/passwd/../../../../etc/cron.d/evil",
            "../../../../evil.sh",
            "/Users/sender-account/Pictures/shot.png",
            "no-separator-at-all.png",
        ] {
            for e in entries_for(any) {
                assert!(e.zip_path.starts_with("artefacts/") && !e.zip_path.contains(".."));
            }
        }
    }

    #[test]
    fn two_captures_whose_files_share_a_name_produce_two_entries() {
        let dir = scratch_dir("zipdupe");
        let src = make_source(&dir);
        let conn = Connection::open(&src).unwrap();
        conn.execute(
            "UPDATE captures SET local_path = '/Users/sender-account/Other/' || ?1 WHERE id='drop'",
            params![SENDER_BASENAME],
        )
        .unwrap();
        let entries =
            media_entries_from_source(&conn, &["keep".to_string(), "drop".to_string()]).unwrap();
        // Naming by capture id keeps them apart. Under the old basename rule
        // these collapsed into one entry and BOTH rows pointed at it, so the
        // recipient saw one capture's screenshot under the other's text.
        assert_eq!(entries.len(), 2, "same-named files must not collide");
        assert_ne!(entries[0].zip_path, entries[1].zip_path);
        assert!(entries.iter().all(|e| !e.zip_path.contains(SENDER_BASENAME)));
    }

    #[test]
    fn the_archive_name_is_built_from_the_export_name() {
        // This names the staged archive, and "Save the file" copies it to
        // Downloads under the same basename — so typing "Q3 onboarding" is what
        // the user gets there, not a uuid.
        assert_eq!(downloads_file_name("Q3 onboarding"), "kety-index-Q3-onboarding.zip");
        // Free text, so anything at all can arrive: no separators, no traversal,
        // no leading dot, and always a name.
        assert_eq!(downloads_file_name("../../etc/passwd"), "kety-index-etc-passwd.zip");
        assert_eq!(downloads_file_name("   "), "kety-index.zip");
        assert_eq!(downloads_file_name(""), "kety-index.zip");
        assert_eq!(downloads_file_name("é…é"), "kety-index.zip");
        let long = downloads_file_name(&"a".repeat(500));
        assert!(long.len() < 80, "{long} is too long to be a filename");
    }

    #[test]
    fn the_archive_basename_matches_the_rule_the_database_uses() {
        // The exported media name must carry nothing about the sender, must be
        // unique per capture, and must survive a Windows extractor. There is
        // only one rule now — the SQL half was removed, so there is nothing
        // left to drift out of sync with.
        let id = "9f1c2e7a-0000-4000-8000-000000000001";
        let other = "9f1c2e7a-0000-4000-8000-000000000002";

        // A POSIX path keeps only its extension.
        assert_eq!(
            exported_media_name(id, "/Users/someone/Pictures/shot.PNG"),
            format!("{id}.png")
        );
        // A Windows path does NOT travel whole. Splitting on '/' alone used to
        // let the sender's account name and folder layout through here.
        let win = exported_media_name(id, r"C:\Users\someone\Pictures\shot.png");
        assert_eq!(win, format!("{id}.png"));
        assert!(!win.contains("someone"), "the sender's account name travelled");
        assert!(!win.contains('\\') && !win.contains(':'));

        // Two captures whose files share a filename no longer collide, so one
        // capture can never render the other's screenshot.
        assert_ne!(
            exported_media_name(id, "/Desktop/image.png"),
            exported_media_name(other, "/Downloads/image.png"),
        );

        // Characters legal on macOS but rejected by Windows extractors cannot
        // reach the entry name.
        for bad in ["/a/what?.png", "/a/star*.png", "/a/pipe|.png", "/a/qu\"ote.png"] {
            let n = exported_media_name(id, bad);
            assert_eq!(n, format!("{id}.png"), "{bad} leaked its filename");
        }

        // No extension, and a dotfile, stay sane rather than producing a
        // trailing dot or an empty stem.
        assert_eq!(exported_media_name(id, "/a/noext"), id);
        assert_eq!(exported_media_name(id, "/a/.hidden"), id);
    }
}
