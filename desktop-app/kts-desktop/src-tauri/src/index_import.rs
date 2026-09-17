//! Validate a shared knowledge archive and adopt it as a read-only assistant.
//!
//! Everything here happens to a file that came from somewhere else — a link
//! that can point anywhere, or an archive a stranger handed over — and ends
//! with that file being opened by SQLite. Two rules shape the whole module:
//!
//! 1. **Nothing is adopted until every check has passed.** All work happens in
//!    a scratch directory under the system temp folder, held by `ScratchDir`,
//!    which deletes itself on every path out of the function including the
//!    early returns. The assistant's directory under `local-index/` is not
//!    created until the last check is behind us, so a rejected archive cannot
//!    leave a half-imported assistant behind. Should the final move itself
//!    fail, the directory it had started to fill is removed again.
//! 2. **A crafted archive must not write outside the scratch directory.** Every
//!    entry name in the central directory is checked *before the first byte is
//!    extracted*, not entry by entry as extraction proceeds — so an archive
//!    whose tenth member escapes cannot have its first nine written out.

use rusqlite::{params, Connection};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::index_export::{ExportManifest, EXPORT_FORMAT_VERSION};
use crate::kety_paths::local_index_dir_in;
// The same guard the export writes its entries with. Reused rather than
// restated: an importer that checked a *different* rule than the exporter
// applies is exactly how a traversal survives a refactor.
use crate::upload_commands::validate_zip_entry_path;

/// Hard ceiling on a downloaded archive, refused **while streaming** rather
/// than after the whole body has landed on disk.
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Hard ceiling on how many members an archive may declare.
///
/// The byte cap does not cover this. An archive of millions of *zero-byte*
/// `artefacts/` entries declares nothing, inflates to nothing, and so passes both
/// the declared-size fast path and the cumulative byte cap — while asking this
/// process to create one file per entry in the temp folder. Cost per entry is a
/// filesystem operation, not a byte, so the guard has to count entries.
///
/// Where the number comes from: an export carries `manifest.json`, `index.db`,
/// and at most **one media file per capture** (`index_export::write_export_zip`
/// writes a single entry per capture that has one). So the entry count of an
/// honest archive is the sender's capture count plus two. A hundred thousand
/// leaves room for a knowledge index far larger than any real one while still
/// bounding this loop at something a laptop shrugs off.
const MAX_ARCHIVE_ENTRIES: usize = 100_000;

/// The two members every shared archive must have, and the folder its media
/// lives in. These names are written by `index_export::write_export_zip`.
const MANIFEST_ENTRY: &str = "manifest.json";
const DB_ENTRY: &str = "index.db";
const MEDIA_DIR: &str = "artefacts";

/// The first 16 bytes of every SQLite database file, header string included
/// terminator. Checked before a connection is opened, so a file that is not a
/// database is never handed to SQLite at all.
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// What an import produced: enough for the caller to name the new assistant and
/// to address it afterwards (`assistant_id` is the second half of the index key
/// — see `kety_paths::local_index_db_path`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAssistant {
    pub assistant_id: String,
    pub name: String,
    pub export_id: String,
    pub capture_count: i64,
    pub embed_model: String,
    pub imported_at: String,
}

// ── Scratch space ─────────────────────────────────────────────────────────────

/// A temp directory that deletes itself when it goes out of scope.
///
/// This is what makes "leave nothing behind" true for *every* failure, rather
/// than for the failures somebody remembered to write a cleanup line for. The
/// validation pipeline has a dozen early returns; none of them needs to know
/// about cleanup.
struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("kts-index-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("We could not prepare a temporary folder for the import: {e}"))?;
        Ok(Self { path })
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// ── 1. Getting the bytes ──────────────────────────────────────────────────────

fn too_big_message() -> String {
    "This shared index is larger than 2 GB, which is more than we will download.".to_string()
}

/// What an archive that inflates past the cap is refused with. Separate from
/// `too_big_message` because the sizes being talked about are different things:
/// one is what came down the wire, the other is what it turned into.
fn unpacked_too_big_message() -> String {
    "This shared index unpacks to more than 2 GB, which is more than we will import.".to_string()
}

/// What a file already on this machine is refused with when it is over the cap.
/// Separate from `too_big_message` because nothing was downloaded.
fn file_too_big_message() -> String {
    "This shared index is larger than 2 GB, which is more than we will import.".to_string()
}

/// What an archive holding an implausible number of members is refused with.
/// The count itself would mean nothing to the person reading it.
fn too_many_entries_message() -> String {
    "This shared index contains far more files than a knowledge index ever does, so we did not import it.".to_string()
}

/// The chunk `copy_capped` reads with. Named so a test can state a cap in whole
/// chunks and assert the exact number of bytes that reached the sink.
const COPY_BUF_BYTES: usize = 64 * 1024;

/// Copy `r` into `w`, refusing past `cap` bytes, with `too_big` as the refusal.
///
/// The check is on the running total and happens *before* the chunk is written,
/// so an oversized body is abandoned mid-stream: at most `cap` bytes ever reach
/// the disk, and the remote side never gets to finish sending. Checking a
/// `Content-Length` header instead would be checking a number the sender chose.
///
/// Returns the number of bytes written, which is what lets a caller extracting
/// many members cap their **sum** rather than each member on its own.
fn copy_capped_with<R: Read, W: Write>(
    r: &mut R,
    w: &mut W,
    cap: u64,
    too_big: fn() -> String,
) -> Result<u64, String> {
    let mut buf = vec![0u8; COPY_BUF_BYTES];
    let mut total: u64 = 0;
    loop {
        let n = r
            .read(&mut buf)
            .map_err(|e| format!("We could not read the shared index: {e}"))?;
        if n == 0 {
            return Ok(total);
        }
        total = total.saturating_add(n as u64);
        if total > cap {
            return Err(too_big());
        }
        w.write_all(&buf[..n])
            .map_err(|e| format!("We could not save the shared index: {e}"))?;
    }
}

/// `copy_capped_with`, for the download path.
fn copy_capped<R: Read, W: Write>(r: &mut R, w: &mut W, cap: u64) -> Result<u64, String> {
    copy_capped_with(r, w, cap, too_big_message)
}

/// Download `url` to `dest`, refusing anything past `MAX_ARCHIVE_BYTES`.
fn download_archive(url: &str, dest: &Path) -> Result<(), String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("We can only open a shared index from an http:// or https:// link.".to_string());
    }

    let resp = ureq::get(url)
        .call()
        .map_err(|e| format!("We could not download the shared index: {e}"))?;
    let status = resp.status();
    if !(200..300).contains(&status) {
        // Same "sentence: detail" shape as every other message here, so the
        // frontend's `friendlyMessage` drops the status code before a person sees
        // it and keeps it in the console, where it is worth having.
        return Err(format!(
            "We could not download the shared index: the server answered HTTP {status}."
        ));
    }
    // An announced size over the cap lets us refuse without downloading at all.
    // It is an optimisation, never the guard: the streaming cap below is what
    // actually holds, because this header is whatever the server chose to say.
    if let Some(len) = resp
        .header("Content-Length")
        .and_then(|v| v.trim().parse::<u64>().ok())
    {
        if len > MAX_ARCHIVE_BYTES {
            return Err(too_big_message());
        }
    }

    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("We could not save the downloaded index: {e}"))?;
    copy_capped(&mut resp.into_reader(), &mut file, MAX_ARCHIVE_BYTES)?;
    file.flush()
        .map_err(|e| format!("We could not save the downloaded index: {e}"))?;
    Ok(())
}

// ── 2/3. Shape: the archive and its entries ───────────────────────────────────

/// Whether an entry may be extracted, decided from its name alone.
///
/// The two top-level members are matched as **exact literals** — a literal has
/// nothing to traverse — and everything else must satisfy
/// `validate_zip_entry_path`, the very guard the export writes its media entries
/// with: no `..`, no absolute path, and nothing outside `artefacts/`. An entry
/// that is neither is refused rather than ignored, because an archive carrying a
/// member this build has never heard of is not an archive this build made.
fn validate_import_entry_name(name: &str) -> Result<(), String> {
    if name == MANIFEST_ENTRY || name == DB_ENTRY {
        return Ok(());
    }
    validate_zip_entry_path(name).map_err(|_| {
        // The name itself is remote input and means nothing to the person
        // reading the dialog; it belongs in the log, not on screen.
        eprintln!("[index-import] refused an archive entry we will not write: {name}");
        "This shared index contains a file we will not write, so we did not import it.".to_string()
    })
}

/// Extract the archive at `archive` into `into`, writing at most `cap` bytes
/// **in total**.
///
/// Two passes, deliberately. The first reads only the central directory and
/// checks every entry name; the second writes. A single pass that checked each
/// name just before writing it would still have written everything ahead of the
/// offending entry — which for an archive that leads with a plausible
/// `index.db` and ends with `../../…` is most of the attack.
///
/// `cap` is the **sum** over every member, not a per-member allowance. A
/// per-member cap is no cap at all: an archive of a thousand `artefacts/` entries
/// that each inflate to just under it passes every individual check and still
/// fills the temp volume. It is a parameter rather than a constant so a test can
/// state a cap it can actually reach; the pipeline passes `MAX_ARCHIVE_BYTES`.
///
/// `entry_cap` is the same idea one dimension over — see `MAX_ARCHIVE_ENTRIES` —
/// and is a parameter for the same reason: a test that had to build a hundred
/// thousand members to reach the real ceiling would cost more than it proves.
fn extract_archive_capped(archive: &Path, into: &Path, cap: u64) -> Result<(), String> {
    extract_archive_capped_with(archive, into, cap, MAX_ARCHIVE_ENTRIES)
}

fn extract_archive_capped_with(
    archive: &Path,
    into: &Path,
    cap: u64,
    entry_cap: usize,
) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("We could not open the shared index: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| "This file is not a shared index archive, so we did not import it.".to_string())?;

    // Pass 1 — names only. Nothing has been written at this point.
    //
    // The count comes first, **before** the names are collected. Every line below
    // this one costs something per member: `file_names()` copies each name into a
    // second allocation, the declared-size loop reads each central-directory
    // record, and the write pass creates a file per entry. An archive of millions
    // of empty `artefacts/` members passes every *byte* check there is, so this is
    // the only guard standing between it and that work.
    if zip.len() > entry_cap {
        eprintln!(
            "[index-import] refused an archive declaring {} entries (ceiling {entry_cap})",
            zip.len()
        );
        return Err(too_many_entries_message());
    }
    let names: Vec<String> = zip.file_names().map(|n| n.to_string()).collect();
    for name in &names {
        validate_import_entry_name(name)?;
    }
    if !names.iter().any(|n| n == MANIFEST_ENTRY) {
        return Err(
            "This archive does not look like a shared knowledge index (its details are missing), so we did not import it."
                .to_string(),
        );
    }
    if !names.iter().any(|n| n == DB_ENTRY) {
        return Err(
            "This archive does not contain a knowledge index, so we did not import it.".to_string(),
        );
    }
    // A fast path for an honest sender, and nothing more. `size()` is the
    // uncompressed size the *sender wrote into the central directory*, so an
    // archive that admits to being too big can be turned away before a byte is
    // inflated — but one that declares 0 on every entry sails through this and
    // is stopped only by the running total in the write pass below. That total
    // is the guard; this is an optimisation.
    //
    // An entry whose header cannot be read is an error rather than a zero: a
    // `.ok()` here would have scored exactly the unreadable entries at nothing.
    let mut declared: u64 = 0;
    for i in 0..zip.len() {
        let size = zip
            .by_index_raw(i)
            .map(|f| f.size())
            .map_err(|_| "This file is not a shared index archive, so we did not import it.".to_string())?;
        declared = declared.saturating_add(size);
    }
    if declared > cap {
        return Err(unpacked_too_big_message());
    }

    std::fs::create_dir_all(into)
        .map_err(|e| format!("We could not prepare the import folder: {e}"))?;

    // Pass 2 — write. `written` is the whole point: every member draws from one
    // shared allowance, so N members of `cap - 1` bytes each cannot add up to
    // N × cap on disk.
    let mut written: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("We could not read the shared index: {e}"))?;
        let name = entry.name().to_string();
        // Checked a second time, here, where the name is actually turned into a
        // path. The pass above is what makes the guard total; this one is what
        // keeps it true if someone later reorders these loops.
        validate_import_entry_name(&name)?;
        let dest = into.join(&name);
        if entry.is_dir() || name.ends_with('/') {
            std::fs::create_dir_all(&dest)
                .map_err(|e| format!("We could not prepare the import folder: {e}"))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("We could not prepare the import folder: {e}"))?;
        }
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("We could not unpack the shared index: {e}"))?;
        let remaining = cap.saturating_sub(written);
        written = written.saturating_add(copy_capped_with(
            &mut entry,
            &mut out,
            remaining,
            unpacked_too_big_message,
        )?);
    }
    Ok(())
}

// ── 4. The manifest ───────────────────────────────────────────────────────────

fn read_manifest(path: &Path) -> Result<ExportManifest, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("We could not read this shared index's details: {e}"))?;
    let manifest: ExportManifest = serde_json::from_str(&text).map_err(|_| {
        "This shared index's details are not in a format we understand, so we did not import it."
            .to_string()
    })?;
    if manifest.format_version != EXPORT_FORMAT_VERSION {
        return Err(format!(
            "This shared index was made in format version {} and this version of the app can only read version {}. Ask the sender to export it again, or update the app.",
            manifest.format_version, EXPORT_FORMAT_VERSION
        ));
    }
    Ok(manifest)
}

// ── 5. The SQLite header ──────────────────────────────────────────────────────

/// `index.db` must begin with SQLite's header string before a connection is
/// opened on it. `Connection::open` on a non-database is not itself dangerous,
/// but it is the first thing in this pipeline that hands the file to a parser,
/// and the cheapest possible check goes first.
fn check_sqlite_header(path: &Path) -> Result<(), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("We could not read the knowledge index in this archive: {e}"))?;
    let mut head = [0u8; 16];
    file.read_exact(&mut head).map_err(|_| {
        "The knowledge index in this archive is not a database, so we did not import it.".to_string()
    })?;
    if &head != SQLITE_MAGIC {
        return Err(
            "The knowledge index in this archive is not a database, so we did not import it."
                .to_string(),
        );
    }
    Ok(())
}

// ── 6. The schema ─────────────────────────────────────────────────────────────

/// Table → column names, as `create_schema` itself produces them.
///
/// Built by running `create_schema` into an in-memory database and reading the
/// result back, rather than by restating the table list here. A second copy of
/// the schema in this file would drift the first time a column is added, and it
/// would drift silently — the importer would keep accepting archives that the
/// rest of the app can no longer read, or start refusing ones it can.
fn canonical_schema() -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    let conn = Connection::open_in_memory()
        .map_err(|e| format!("We could not check this shared index: {e}"))?;
    crate::local_index::create_schema(&conn)?;
    let tables: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .map_err(|e| format!("We could not check this shared index: {e}"))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("We could not check this shared index: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("We could not check this shared index: {e}"))?
    };
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for t in tables {
        let cols = columns_of(&conn, &t)?;
        out.insert(t, cols);
    }
    Ok(out)
}

/// Column names of `table`, or an empty set when the table does not exist.
///
/// `table` is always one of *our* names — it comes from `canonical_schema`,
/// never from the file being inspected — which is what makes formatting it into
/// the PRAGMA safe. (`PRAGMA table_info` takes no bound parameter.) The quoting
/// is belt and braces.
fn columns_of(conn: &Connection, table: &str) -> Result<BTreeSet<String>, String> {
    let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("We could not check this shared index: {e}"))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("We could not check this shared index: {e}"))?;
    rows.collect::<Result<BTreeSet<_>, _>>()
        .map_err(|e| format!("We could not check this shared index: {e}"))
}

/// What was wrong with an archive's schema, in the terms the **log** wants.
///
/// Deliberately not the terms the user gets. `auto_assign_apps` is a column name
/// this codebase chose; a person holding an archive somebody sent them cannot do
/// anything with it, and the next thing they would do is paste it somewhere.
/// They are told the archive is not a valid shared index — the one fact they can
/// act on — and the detail goes to the log, where the person who can act on it
/// is actually looking.
#[derive(Debug, PartialEq, Eq)]
enum SchemaFault {
    MissingTable(String),
    MissingColumn { table: String, column: String },
    NotATable { name: String, kind: String },
    Trigger(String),
}

impl SchemaFault {
    fn detail(&self) -> String {
        match self {
            SchemaFault::MissingTable(t) => format!("no \"{t}\" table"),
            SchemaFault::MissingColumn { table, column } => {
                format!("\"{table}\" has no \"{column}\" column")
            }
            SchemaFault::NotATable { name, kind } => {
                format!("\"{name}\" is a {kind}, not a table")
            }
            SchemaFault::Trigger(n) => format!("the archive ships a trigger ({n})"),
        }
    }
}

fn not_a_shared_index_message() -> String {
    "This archive is not a valid shared knowledge index, so we did not import it.".to_string()
}

/// Every table and column `create_schema` produces must be present, as a real
/// table, in a file carrying no triggers.
///
/// Presence, not equality: an archive may carry more than the canonical schema
/// (the export adds `chunks_fts` and its shadow tables, and a future migration
/// may add a column), and refusing those would refuse valid archives. What must
/// never happen is the reverse — an index missing something the reading code
/// selects by name.
///
/// Two things `PRAGMA table_info` alone does not settle, both read straight out
/// of the archive's own `sqlite_master`:
///
/// - **`type='table'`.** `table_info` answers for a VIEW exactly as it does for
///   a table, columns and all, so the loop below would happily approve an
///   archive presenting `captures` and `tags` as views over something else
///   entirely. A genuine export has no views at all.
/// - **No triggers.** The import runs `UPDATE tags SET user_id` and
///   `UPDATE captures SET user_id` on this file, which is precisely the
///   statement a trigger shipped inside the archive would be sitting on. Nothing
///   this app writes creates one, so refusing the lot costs a valid archive
///   nothing.
///
/// `Ok(None)` is a clean archive, `Ok(Some(fault))` a refused one, and `Err` a
/// check that could not be run at all — three outcomes that must not collapse
/// into two, because "we could not look" is not "we looked and it was fine".
fn inspect_schema(conn: &Connection) -> Result<Option<SchemaFault>, String> {
    if let Some(name) = first_trigger(conn)? {
        return Ok(Some(SchemaFault::Trigger(name)));
    }
    for (table, expected) in canonical_schema()? {
        match object_kind(conn, &table)? {
            None => return Ok(Some(SchemaFault::MissingTable(table))),
            Some(kind) if kind != "table" => {
                return Ok(Some(SchemaFault::NotATable { name: table, kind }))
            }
            Some(_) => {}
        }
        let found = columns_of(conn, &table)?;
        if found.is_empty() {
            return Ok(Some(SchemaFault::MissingTable(table)));
        }
        for col in &expected {
            if !found.contains(col) {
                return Ok(Some(SchemaFault::MissingColumn {
                    table,
                    column: col.clone(),
                }));
            }
        }
    }
    Ok(None)
}

/// The `sqlite_master` type of `name` — `table`, `view`, `index`… — or `None`
/// when the archive has no object by that name. The name is bound, never
/// formatted in.
fn object_kind(conn: &Connection, name: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT type FROM sqlite_master WHERE name = ?1",
        params![name],
        |r| r.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("We could not check this shared index: {other}")),
    })
}

fn first_trigger(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT name FROM sqlite_master WHERE type='trigger' LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("We could not check this shared index: {other}")),
    })
}

fn check_schema(conn: &Connection) -> Result<(), String> {
    match inspect_schema(conn)? {
        None => Ok(()),
        Some(fault) => {
            eprintln!(
                "[index-import] refused a shared index: {}",
                fault.detail()
            );
            Err(not_a_shared_index_message())
        }
    }
}

// ── The ownership rewrite ─────────────────────────────────────────────────────

/// Give the imported rows to the profile doing the importing.
///
/// `tags.user_id` is the load-bearing one. The export NULLs it on purpose (the
/// sender's id must not travel), and `list_tags_for_user` filters on
/// `WHERE user_id = ?1` with **no `IS NULL` branch** — so without this every
/// imported capture renders its tag chips blank while the captures themselves
/// show up fine. See the warning comment in `index_export::copy_all` step 4.
///
/// `captures.user_id` is rewritten too. Its reader *does* have an `IS NULL`
/// branch, so those rows would survive either way; owning them explicitly says
/// whose they are now instead of leaving that to a predicate.
///
/// Finally, any `captures.tag_ids` entry with no matching `tags` row is dropped:
/// the sender may have deleted a tag after tagging a capture, and a chip id with
/// nothing behind it renders as nothing at all.
///
/// Runs in one transaction — this is the last thing done to the file before it
/// is adopted, and a half-rewritten index must not be what gets moved.
fn adopt_ownership(conn: &Connection, user_id: &str) -> Result<(), String> {
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("We could not prepare the imported index: {e}"))?;
    let done = (|| -> Result<(), String> {
        conn.execute("UPDATE tags SET user_id = ?1", params![user_id])
            .map_err(|e| format!("We could not prepare the imported tags: {e}"))?;
        conn.execute("UPDATE captures SET user_id = ?1", params![user_id])
            .map_err(|e| format!("We could not prepare the imported captures: {e}"))?;
        prune_dangling_tag_ids(conn)
    })();
    match done {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("We could not prepare the imported index: {e}")),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Drop tag ids that no `tags` row answers to.
///
/// Same shape as `index_export::filter_capture_tags`, and the same fail-closed
/// rule: a `tag_ids` value that is not a JSON array of strings becomes an empty
/// array rather than being left alone.
fn prune_dangling_tag_ids(conn: &Connection) -> Result<(), String> {
    let known: BTreeSet<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM tags")
            .map_err(|e| format!("We could not read the imported tags: {e}"))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("We could not read the imported tags: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let rows: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, tag_ids FROM captures WHERE tag_ids IS NOT NULL")
            .map_err(|e| format!("We could not read the imported capture tags: {e}"))?;
        let mapped = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("We could not read the imported capture tags: {e}"))?;
        mapped.filter_map(|r| r.ok()).collect()
    };
    for (id, tag_ids) in rows {
        let kept: Vec<String> = serde_json::from_str::<Vec<String>>(&tag_ids)
            .unwrap_or_default()
            .into_iter()
            .filter(|t| known.contains(t))
            .collect();
        let json = serde_json::to_string(&kept).unwrap_or_else(|_| "[]".to_string());
        if json == tag_ids {
            continue;
        }
        conn.execute(
            "UPDATE captures SET tag_ids = ?1 WHERE id = ?2",
            params![json, id],
        )
        .map_err(|e| format!("We could not tidy the imported capture tags: {e}"))?;
    }
    Ok(())
}

// ── 7. Adoption ───────────────────────────────────────────────────────────────

/// Move `from` to `to`, falling back to copy + delete across filesystems.
/// The temp folder and the app's data folder are usually the same volume, but
/// "usually" is not something a rename can be written against.
fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if from.is_dir() {
        copy_dir(from, to)?;
        let _ = std::fs::remove_dir_all(from);
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| format!("We could not store the imported index: {e}"))?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

/// The directories `create_dir_all(dir)` would have to make, deepest first.
///
/// `local_index_dir_in` returns `{root}/{user}/assistants/{id}`, so a single
/// `create_dir_all` can bring three levels into being — and a rollback that
/// removes only the leaf leaves `{root}/{user}/assistants/` sitting there empty,
/// debris from an import that was refused. The walk stops at the first ancestor
/// that already exists (that one is not ours to remove) and never climbs above
/// `root`.
fn dirs_to_create(root: &Path, dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut cur = Some(dir);
    while let Some(d) = cur {
        if d.exists() {
            break;
        }
        out.push(d.to_path_buf());
        if d == root {
            break;
        }
        cur = d.parent();
    }
    out
}

/// Undo a failed adoption: the assistant's directory and, above it, whatever
/// `created` says was brought into being only to hold it.
///
/// The leaf goes with `remove_dir_all` — it may be half filled, which is the
/// whole reason we are here. Its ancestors go with `remove_dir`, which refuses a
/// non-empty directory: an `assistants/` folder that already holds somebody
/// else's import is not ours to delete, and stopping on the first refusal is how
/// we say so. Failures are logged rather than dropped — a rollback that could
/// not run is exactly the case where somebody needs to know.
fn rollback_adoption(dest_dir: &Path, created: &[PathBuf]) {
    if let Err(e) = std::fs::remove_dir_all(dest_dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "[index-import] could not clean up {dest_dir:?} after a failed import: {e}"
            );
        }
    }
    for dir in created.iter().filter(|d| d.as_path() != dest_dir) {
        if let Err(e) = std::fs::remove_dir(dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[index-import] left {dir:?} in place after a failed import: {e}");
            }
            // Non-empty or unreadable: everything above it is non-empty too.
            break;
        }
    }
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to)
        .map_err(|e| format!("We could not store the imported files: {e}"))?;
    let entries = std::fs::read_dir(from)
        .map_err(|e| format!("We could not store the imported files: {e}"))?;
    for entry in entries.flatten() {
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir(&src, &dest)?;
        } else {
            std::fs::copy(&src, &dest)
                .map_err(|e| format!("We could not store the imported files: {e}"))?;
        }
    }
    Ok(())
}

// ── The name a shared index is listed and labelled under ──────────────────────

/// The label the profile's own knowledge answers under, in `App.tsx`
/// (`assistantContextTabs`, the `contextId: "self"` entry). Kept here as a
/// constant because this module has to refuse to produce it; if the tab is ever
/// relabelled, this follows.
const OWN_TAB_LABEL: &str = "Me";

/// What an imported index is called when its own name is unusable, or absent.
const FALLBACK_ASSISTANT_NAME: &str = "Shared knowledge";

/// A shared index that would otherwise be called exactly what the user's own
/// knowledge is called.
const DISAMBIGUATED_OWN_LABEL: &str = "Me (shared)";

/// Longest name a tab may carry. Long enough for any real title someone would
/// give an export, short enough that it cannot push the other tabs off screen.
const MAX_ASSISTANT_NAME_CHARS: usize = 60;

/// Characters that occupy no width and are therefore invisible in a tab label:
/// Unicode's format category (Cf), which `char::is_control` does **not** cover —
/// it is Cc only.
///
/// They matter twice over. A bidirectional override (U+202E) reorders everything
/// after it, so a stored name and the name on screen stop being the same string.
/// A zero-width space or joiner (U+200B, U+200D) splits a word without leaving a
/// mark, so `M<U+200B>e` is stored as something no comparison recognises and
/// rendered as `Me`. Both are ways to put a label on screen that is not the label
/// that was checked.
///
/// Removed rather than turned into a space, unlike Cc: these render as nothing at
/// all, so deleting them is what makes the cleaned name equal to what a reader
/// sees — which is the only thing the checks below can usefully be run against.
///
/// The full Cf list as of Unicode 15.1. Written out rather than pulled from a
/// crate: it is twenty-odd ranges that change about once a decade, against a new
/// dependency on a path that already refuses to trust its input.
fn is_invisible_format(c: char) -> bool {
    matches!(c as u32,
        0x00AD
        | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2
        | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F
        | 0xFEFF | 0xFFF9..=0xFFFB
        | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A
        | 0xE0001 | 0xE0020..=0xE007F)
}

/// Map a character that *renders* as an ASCII letter onto that letter.
///
/// Cyrillic `М` (U+041C) and Latin `M` are different codepoints that draw the
/// same glyph in every font a tab strip will ever use. `eq_ignore_ascii_case`
/// sees two unrelated strings; a person sees one word. Since the only question
/// being asked below is "will this look like the user's own tab", the comparison
/// has to be made on what is drawn, not on what is stored.
///
/// Covers the Cyrillic and Greek letters that are homoglyphs of Latin ones, plus
/// the fullwidth forms. Not a complete Unicode confusables table — the
/// mathematical alphanumerics and the many accented near-misses are out — so
/// this narrows the hole rather than closing it. It closes the one that is
/// trivially reachable: a name typed on a Cyrillic or Greek keyboard.
fn fold_confusable(c: char) -> char {
    match c as u32 {
        // Fullwidth Latin: U+FF21..U+FF3A is A..Z, U+FF41..U+FF5A is a..z.
        n @ 0xFF21..=0xFF3A => char::from(b'A' + (n - 0xFF21) as u8),
        n @ 0xFF41..=0xFF5A => char::from(b'a' + (n - 0xFF41) as u8),
        // Cyrillic capitals.
        0x0405 => 'S', 0x0406 => 'I', 0x0408 => 'J', 0x0410 => 'A', 0x0412 => 'B',
        0x0415 => 'E', 0x041A => 'K', 0x041C => 'M', 0x041D => 'H', 0x041E => 'O',
        0x0420 => 'P', 0x0421 => 'C', 0x0422 => 'T', 0x0423 => 'Y', 0x0425 => 'X',
        // Cyrillic small letters.
        0x0430 => 'a', 0x0435 => 'e', 0x043E => 'o', 0x0440 => 'p', 0x0441 => 'c',
        0x0443 => 'y', 0x0445 => 'x', 0x0455 => 's', 0x0456 => 'i', 0x0458 => 'j',
        0x04BB => 'h', 0x04CF => 'l', 0x0501 => 'd',
        // Greek capitals.
        0x0391 => 'A', 0x0392 => 'B', 0x0395 => 'E', 0x0396 => 'Z', 0x0397 => 'H',
        0x0399 => 'I', 0x039A => 'K', 0x039C => 'M', 0x039D => 'N', 0x039F => 'O',
        0x03A1 => 'P', 0x03A4 => 'T', 0x03A5 => 'Y', 0x03A7 => 'X',
        // Greek small letters.
        0x03BD => 'v', 0x03BF => 'o', 0x03C1 => 'p',
        _ => c,
    }
}

/// Would `name` be read as `target` by someone looking at the tab strip?
///
/// Folds the confusables, then lowercases with Unicode's rules rather than
/// ASCII's, so that a name reaching the fold as `Ｍｅ` and one reaching it as
/// `ME` both answer the same question.
fn looks_like(name: &str, target: &str) -> bool {
    let fold = |s: &str| -> String {
        s.chars().map(fold_confusable).flat_map(char::to_lowercase).collect()
    };
    fold(name) == fold(target)
}

/// Turn a proposed name into one that can safely be a registry entry and a tab
/// label.
///
/// The input is not trusted. It is either `manifest.name` — a string out of a
/// JSON file a stranger wrote — or what the user typed, and both used to travel
/// verbatim, unbounded, straight onto the tab strip. Three things have to hold:
///
/// - **Nothing that is not a visible character.** A newline or a tab in a tab
///   label is at best broken layout and at worst a name that renders as
///   something other than what is stored; they become spaces, and runs of
///   whitespace collapse to one. The invisible format characters
///   ([`is_invisible_format`]) are removed outright, because they render as
///   nothing and the cleaned name has to be what a reader will see.
/// - **Bounded.** An export can name itself with a paragraph. Truncated to
///   [`MAX_ASSISTANT_NAME_CHARS`] *characters*, not bytes, so a name in any
///   script is cut where a reader would cut it and never mid-codepoint.
/// - **Never "Me".** This is the one that matters. The feature's whole premise is
///   knowing whose knowledge is answering, and an archive that names itself `Me`
///   puts a second tab reading "Me" beside the user's own — a stranger's index
///   wearing the label of theirs. Registration happens before the rename screen,
///   so there is no moment where the user could have caught it. Disambiguated
///   rather than refused: the sender may simply have exported knowledge they
///   think of as theirs, and losing the import over a label would be worse than
///   relabelling it. The test is on what the label *looks* like
///   ([`looks_like`]), not on its bytes: an ASCII-exact check lets a Cyrillic
///   `Ме` through, and a second tab reading `Ме` is the same lie told in a
///   different alphabet.
///
/// The result is never empty.
fn assistant_display_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !is_invisible_format(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let bounded: String = collapsed.chars().take(MAX_ASSISTANT_NAME_CHARS).collect();
    let bounded = bounded.trim_end();
    if bounded.is_empty() {
        return FALLBACK_ASSISTANT_NAME.to_string();
    }
    if looks_like(bounded, OWN_TAB_LABEL) {
        return DISAMBIGUATED_OWN_LABEL.to_string();
    }
    bounded.to_string()
}

// ── The pipeline ──────────────────────────────────────────────────────────────

/// Validate a shared archive and, only if every check passes, adopt it as a new
/// read-only assistant of `user_id`.
///
/// `local_index_root` is the `local-index` folder — `kety_paths::local_index_dir`
/// in the app, a temp folder in the tests. The destination inside it is computed
/// by `local_index_dir_in`, the same function `local_index_db_path` uses, so the
/// imported index lands exactly where `get_for(app, user_id, Some(assistant_id))`
/// will later look for it.
///
/// `local_index_db_path` itself is deliberately *not* called: it needs an
/// `AppHandle` (which no unit test can build) and it `create_dir_all`s the
/// assistant's folder as a side effect of computing the path — which would put a
/// directory on disk before the first check had run, i.e. exactly the debris this
/// function exists to avoid.
pub fn import_shared_index(
    local_index_root: &Path,
    user_id: &str,
    source: &str,
    is_url: bool,
    name: Option<&str>,
) -> Result<ImportedAssistant, String> {
    import_shared_index_capped(
        local_index_root,
        user_id,
        source,
        is_url,
        name,
        MAX_ARCHIVE_BYTES,
    )
}

/// [`import_shared_index`] with the unpacked-size ceiling spelled out.
///
/// The cap is a parameter for one reason: a test cannot produce two gigabytes to
/// prove the ceiling holds, and a ceiling nothing ever reaches is a ceiling
/// nobody has checked. Every caller outside the tests goes through
/// `import_shared_index`, which passes `MAX_ARCHIVE_BYTES`.
fn import_shared_index_capped(
    local_index_root: &Path,
    user_id: &str,
    source: &str,
    is_url: bool,
    name: Option<&str>,
    cap: u64,
) -> Result<ImportedAssistant, String> {
    // 2. Everything below happens in here, and this goes away on every path out.
    let scratch = ScratchDir::new()?;

    // 1. The bytes.
    let archive = scratch.path.join("archive.zip");
    if is_url {
        download_archive(source, &archive)?;
    } else {
        let src = Path::new(source.trim());
        if !src.is_file() {
            return Err("We could not find that file, so there was nothing to import.".to_string());
        }
        // Capped exactly like the download path. A file picked on this machine is
        // not automatically a small one — it can be a mounted share, or a sparse
        // file somebody pointed the picker at — and `fs::copy` would fill the temp
        // volume before any of the checks below got to run.
        let mut from = std::fs::File::open(src)
            .map_err(|e| format!("We could not read that file: {e}"))?;
        let mut to = std::fs::File::create(&archive)
            .map_err(|e| format!("We could not prepare the import: {e}"))?;
        copy_capped_with(&mut from, &mut to, cap, file_too_big_message)?;
        to.flush()
            .map_err(|e| format!("We could not prepare the import: {e}"))?;
    }

    // 3. Shape — entry guard, then extraction.
    let unpacked = scratch.path.join("unpacked");
    extract_archive_capped(&archive, &unpacked, cap)?;
    // The archive is no longer needed and can be large. It is only removed once
    // extraction has returned, so the peak really was both copies at once — the
    // archive and everything unpacked out of it. Dropping it here shortens that
    // peak rather than preventing it, and frees the space before the database is
    // opened and moved into place.
    let _ = std::fs::remove_file(&archive);

    // 4. The manifest.
    let manifest = read_manifest(&unpacked.join(MANIFEST_ENTRY))?;

    // 5. The header, before SQLite sees the file.
    let db_path = unpacked.join(DB_ENTRY);
    check_sqlite_header(&db_path)?;

    // 6. The schema — and, while the file is still in the scratch folder, the
    //    ownership rewrite. Doing it here rather than after the move means a
    //    failure at this point still leaves nothing to undo.
    let adopted_captures: i64;
    {
        let conn = Connection::open(&db_path)
            .map_err(|_| "We could not open the knowledge index in this archive, so we did not import it.".to_string())?;
        // This file came from a stranger, and everything below reads its schema.
        // With trusted schema off, SQLite refuses to run the schema's own SQL —
        // generated columns, expression indexes, partial-index and CHECK
        // expressions — as anything but plain, innocuous functions. Views and
        // triggers are refused outright by `check_schema`; these are the ones it
        // does not look at, and this is what makes looking unnecessary.
        conn.set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA,
            false,
        )
        .map_err(|e| format!("We could not open the knowledge index in this archive: {e}"))?;
        // The export writes `journal_mode=DELETE`, so a genuine archive's
        // `index.db` is self-contained. Setting it again costs nothing there and
        // folds a WAL back into the file if the archive carried one, so that the
        // single file moved below is the whole database.
        conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("We could not open the knowledge index in this archive: {e}"))?;
        check_schema(&conn)?;
        adopt_ownership(&conn, user_id)?;
        // Counted from the database being adopted, never taken from the manifest.
        // The manifest is a JSON file the sender wrote; the number in it is what
        // the tab shows as "N captures", so on trust it is a sentence the app puts
        // on screen that a stranger chose. Nothing after this line adds or removes
        // a row, so the count and the file cannot drift apart.
        adopted_captures = conn
            .query_row("SELECT COUNT(*) FROM captures", [], |r| r.get::<_, i64>(0))
            .map_err(|e| format!("We could not read the knowledge in this archive: {e}"))?;
    }
    // Any sidecar SQLite may have left is scratch-only; it must not travel.
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut p = db_path.as_os_str().to_os_string();
        p.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }

    // 7. Adopt. This is the first line that writes outside the scratch folder.
    let assistant_id = uuid::Uuid::new_v4().to_string();
    let dest_dir = local_index_dir_in(local_index_root, user_id, Some(&assistant_id))?;
    // Taken *before* anything is created, because afterwards there is no telling
    // which of these levels we made and which were already there.
    let created = dirs_to_create(local_index_root, &dest_dir);
    let adopted = (|| -> Result<(), String> {
        std::fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("We could not create a place for the imported index: {e}"))?;
        move_path(&db_path, &dest_dir.join(DB_ENTRY))?;
        let media = unpacked.join(MEDIA_DIR);
        if media.is_dir() {
            move_path(&media, &dest_dir.join(MEDIA_DIR))?;
        }
        Ok(())
    })();
    if let Err(e) = adopted {
        // A half-filled assistant folder is worse than no assistant: the rest of
        // the app would treat it as a real one. The empty folders above it are
        // only debris, but they are debris this function made.
        rollback_adoption(&dest_dir, &created);
        return Err(e);
    }

    let chosen = assistant_display_name(
        name.map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&manifest.name),
    );

    Ok(ImportedAssistant {
        assistant_id,
        name: chosen,
        export_id: manifest.export_id,
        capture_count: adopted_captures,
        embed_model: manifest.embed_model,
        imported_at: chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    })
}

/// Import a shared knowledge index as a new read-only assistant of this profile.
///
/// `source` is either an http(s) link (`is_url`) or a path to an archive already
/// on this machine. `name` overrides the name the sender gave the export.
///
/// The work happens on a blocking worker, never on the thread that answers the
/// command. A synchronous `#[tauri::command]` runs on the main thread, which on
/// macOS is the one driving the webview: this one downloads up to 2 GB, unzips
/// it, opens SQLite and rewrites ownership, so on the main thread the window
/// stops painting for the whole import. The modal's "Adding this knowledge…"
/// notice and its "Adding…" button exist precisely to cover that wait, and
/// neither can reach the screen if the screen is frozen.
#[tauri::command]
pub async fn import_shared_index_cmd(
    app: tauri::AppHandle,
    user_id: String,
    source: String,
    is_url: bool,
    name: Option<String>,
) -> Result<ImportedAssistant, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::kety_paths::local_index_dir(&app)?;
        import_shared_index(&root, &user_id, &source, is_url, name.as_deref())
    })
    .await
    .map_err(|_| "We could not finish adding this shared knowledge. Please try again.".to_string())?
}

// ── Removing an assistant ─────────────────────────────────────────────────────

/// Delete one imported assistant outright — its database, its media, its folder.
///
/// This is the most dangerous function in the module. `local_index_dir_in(root,
/// user, Some(id))` builds `{root}/{user}/assistants/{id}`, and `remove_dir_all`
/// then follows whatever that came out as. Two `assistant_id` values are fatal,
/// and they are fatal in different ways — both were confirmed by removing the
/// guards and watching the tests below fail:
///
/// - `""` leaves nothing to join, so the path is `{root}/{user}/assistants/`
///   itself: **every** imported assistant, deleted at once.
/// - `".."` is the one the sanitiser disarms: as shipped it never reaches the
///   filesystem as `..` at all, because `local_index_dir_in` maps both dots to
///   `_` and the path comes out `{root}/{user}/assistants/__`. What makes it
///   fatal is what it would resolve to *without* that step — the profile's
///   **own** directory, the one holding `index.db`, every capture the user has
///   ever taken, their tags and their embeddings, none of it backed up
///   anywhere, with `"../.."` reaching the `local-index` root, i.e. every
///   profile on the machine. Lock 3 below states that as a post-condition on the
///   resolved path, so removing or loosening the sanitiser does not silently
///   re-open it.
///
/// An `assistant_id` arrives from the frontend registry, i.e. from a JSON file
/// on disk that a bad write or a hand edit can leave with an empty or odd field,
/// so "the caller will never pass a bad one" is not a property this function may
/// assume. Hence three locks on the same door, in order:
///
/// 1. the explicit empty check below, which also catches whitespace-only ids
///    that would sanitize to a valid-looking but meaningless `_` segment;
/// 2. `local_index_dir_in`, which maps `.`, `/` and everything else outside
///    `[alnum]-_` to `_` — this is what disarms `..` — and refuses an empty
///    segment itself;
/// 3. a post-condition on the resolved path: no `..` component survives in it,
///    and it is *strictly below* the profile's own directory. Stated in terms of
///    the two paths rather than the layout, so it keeps holding if the layout
///    changes. The `..` half is not redundant with `starts_with`:
///    `{profile}/assistants/..` starts with `{profile}` quite happily, because
///    `Path::starts_with` compares components without resolving them.
///
/// A missing directory is **not** an error — and *missing* is the only thing
/// forgiven here. The registry entry and the folder are two separate pieces of
/// state; if the folder is already gone, refusing would leave the user with an
/// entry they can never clear. But every *other* reason a look at the directory
/// can fail — no permission on an ancestor, a volume that is not mounted — must
/// be reported, because the caller drops the registry entry on `Ok(())` and the
/// folder would then come back invisible the moment the volume did.
pub fn delete_assistant(
    local_index_root: &Path,
    user_id: &str,
    assistant_id: &str,
) -> Result<(), String> {
    // Lock 1.
    if assistant_id.trim().is_empty() {
        return Err(
            "We cannot remove an assistant without knowing which one, so nothing was deleted."
                .to_string(),
        );
    }
    // Lock 2 — the same sanitization the read side resolves paths with, so this
    // deletes exactly the directory the app has been reading from.
    let dir = local_index_dir_in(local_index_root, user_id, Some(assistant_id))?;
    // Lock 3, two halves. `starts_with` compares components without resolving
    // them, so it alone would wave through `{profile}/assistants/..` — which the
    // filesystem reads as the profile's own directory. The `ParentDir` check is
    // what actually closes that, and it comes first for that reason.
    if dir
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        return Err("That assistant id is not one we will delete.".to_string());
    }
    let own = local_index_dir_in(local_index_root, user_id, None)?;
    if dir == own || !dir.starts_with(&own) {
        return Err(
            "That assistant is not one of yours, so nothing was deleted.".to_string(),
        );
    }

    // `exists()` collapses "it is not there" and "we could not look" into the
    // same `false`, and only the first of those may be forgiven. `symlink_metadata`
    // keeps them apart (and does not follow a symlink to answer, which `exists`
    // would). The middle arm is the one that matters: an unreadable ancestor or an
    // absent volume must not report success, or the caller clears the registry
    // entry for files that are still there.
    match std::fs::symlink_metadata(&dir) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(format!(
                "We could not reach this assistant's files, so nothing was deleted: {e}"
            ))
        }
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("We could not remove this assistant's files: {e}"))
}

/// Remove an imported assistant from this profile: database, media, everything.
///
/// Irreversible, and takes nothing with it but that one assistant — see
/// [`delete_assistant`] for why an empty `assistant_id` is refused rather than
/// resolved.
///
/// The cached connection goes **before** the files do. `LocalIndexConn` keys its
/// one open connection on `(user_id, assistant_id)` and nothing else invalidates
/// it, so a delete that left it in place would leave a live handle on unlinked
/// files: reads would keep hitting the cache and answering from a deleted
/// assistant, the blocks would stay allocated, and on Windows `remove_dir_all`
/// would not even get to run. `force_recreate_for` drops the connection before
/// touching files for exactly this reason.
///
/// The cache eviction is cheap and stays here; the `remove_dir_all` goes to a
/// blocking worker, for the same reason the import does — it walks an entire
/// media tree, and on the main thread that is the window frozen with a "Deleting…"
/// button that never renders.
#[tauri::command]
pub async fn delete_assistant_cmd(
    app: tauri::AppHandle,
    index: tauri::State<'_, crate::local_index::LocalIndexState>,
    user_id: String,
    assistant_id: String,
) -> Result<(), String> {
    {
        // Scoped so the guard is released before the await below: a lock held
        // across an await would make this future non-`Send` and, worse, hold the
        // index locked for the length of the delete.
        let mut guard = index
            .0
            .lock()
            .map_err(|_| "We could not reach your knowledge index, so nothing was deleted.".to_string())?;
        guard.drop_cached_for(&user_id, Some(&assistant_id));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::kety_paths::local_index_dir(&app)?;
        delete_assistant(&root, &user_id, &assistant_id)
    })
    .await
    .map_err(|_| {
        "We could not finish removing this shared knowledge. Please try the delete again."
            .to_string()
    })?
}

// ── Finding assistants nothing lists ──────────────────────────────────────────

/// An assistant directory on disk that the registry does not know about.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAssistant {
    /// The directory name, which is the `assistant_id` `delete_assistant` takes.
    pub assistant_id: String,
    /// How much it occupies, so the user can judge whether to bother.
    pub size_bytes: u64,
}

/// Bytes under `dir`, best effort — what cannot be read is counted as nothing.
/// Symlinks are never followed: their target is somebody else's storage.
fn bytes_under(dir: &Path) -> u64 {
    let mut total = 0u64;
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            total = total.saturating_add(bytes_under(&entry.path()));
        } else if kind.is_file() {
            total = total.saturating_add(entry.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }
    total
}

/// Assistant directories of `user_id` that no id in `known` accounts for.
///
/// The registry in the frontend store is the only thing that lists an imported
/// assistant, so any path that loses an entry while the files survive — a
/// corrupted store, a write that failed after the import, a hand edit — leaves a
/// folder that nothing can open, offer or remove, for good. This is the floor
/// under that: it makes the folder *visible*, addressable by the very
/// `assistant_id` `delete_assistant` takes.
///
/// It deliberately deletes nothing. An orphan may be an index the user would
/// rather re-register than lose, and this feature silently destroying a knowledge
/// index is the one outcome worth ruling out entirely.
///
/// `known` ids are compared as **directory names** — put through the same
/// sanitiser that produced the folder in the first place — so an id that is
/// spelled slightly differently in the registry than on disk does not make a
/// live assistant look abandoned.
pub fn list_orphan_assistants(
    local_index_root: &Path,
    user_id: &str,
    known: &[String],
) -> Result<Vec<OrphanAssistant>, String> {
    // Asked of the layout function rather than spelled out here: the folder this
    // walks has to be the folder an import writes into, and one literal
    // `"assistants"` in this file is how those two come apart.
    let assistants = local_index_dir_in(local_index_root, user_id, Some("probe"))?
        .parent()
        .ok_or_else(|| "We could not look through your imported knowledge.".to_string())?
        .to_path_buf();
    let known_dirs: BTreeSet<String> = known
        .iter()
        .filter_map(|id| local_index_dir_in(local_index_root, user_id, Some(id)).ok())
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();

    let entries = match std::fs::read_dir(&assistants) {
        Ok(e) => e,
        // Nothing imported yet, so nothing abandoned either.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("We could not look through your imported knowledge: {e}")),
    };
    let mut out: Vec<OrphanAssistant> = Vec::new();
    for entry in entries.flatten() {
        // `file_type` does not follow symlinks, so a link planted here is not
        // reported as an assistant and its target is never walked.
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if known_dirs.contains(&name) {
            continue;
        }
        out.push(OrphanAssistant {
            size_bytes: bytes_under(&entry.path()),
            assistant_id: name,
        });
    }
    out.sort_by(|a, b| a.assistant_id.cmp(&b.assistant_id));
    Ok(out)
}

/// List imported-knowledge folders on this profile that the given list does not
/// account for — so files left behind by a lost registry entry can be seen, and
/// removed with `delete_assistant_cmd`. Removes nothing itself.
///
/// Off the main thread like the other two: it walks every file of every imported
/// assistant to size them, which is unbounded by anything but how much the user
/// has imported.
#[tauri::command]
pub async fn list_orphan_assistants_cmd(
    app: tauri::AppHandle,
    user_id: String,
    known_assistant_ids: Vec<String>,
) -> Result<Vec<OrphanAssistant>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::kety_paths::local_index_dir(&app)?;
        list_orphan_assistants(&root, &user_id, &known_assistant_ids)
    })
    .await
    .map_err(|_| "We could not look through your imported knowledge.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index_export::build_export_db;

    const RECIPIENT: &str = "recipient-user";

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kts-import-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Where an assistant of `RECIPIENT` would land. Every failure test asserts
    /// this does not exist: an error that leaves debris has only half worked.
    fn assistants_root(root: &Path) -> PathBuf {
        root.join(RECIPIENT).join("assistants")
    }

    /// A source index with one capture, one tag, one embedded chunk — enough for
    /// `build_export_db` to produce a real archive.
    fn make_source(dir: &Path) -> PathBuf {
        let path = dir.join("source.db");
        let conn = Connection::open(&path).unwrap();
        crate::local_index::create_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO captures(id,user_id,raw_text,kind,tag_ids,created_at) \
             VALUES ('c1','sender-user','hello there','note','[\"t1\",\"t-gone\"]','2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks(id,capture_id,seq,chunk_text,chunk_type) \
             VALUES ('ch1','c1',0,'hello there','raw_text')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunk_embeddings(id,chunk_id,embed_model,embed_dim,embedding,created_at,status) \
             VALUES ('e1','ch1','test-model',4,?1,'2026-01-01T00:00:00.000Z','ok')",
            params![vec![1u8, 2, 3, 4]],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tags(id,user_id,name,created_at) \
             VALUES ('t1','sender-user','Sender tag','2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        path
    }

    /// Write a ZIP of `(entry name, bytes)` pairs, verbatim — including names a
    /// well-behaved writer would never produce.
    fn write_zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn manifest_json(format_version: u32) -> Vec<u8> {
        format!(
            "{{\"exportId\":\"x1\",\"formatVersion\":{format_version},\"name\":\"Shared stuff\",\
             \"embedModel\":\"test-model\",\"captureCount\":1,\"chunkCount\":1,\
             \"exportedAt\":\"2026-01-01T00:00:00.000Z\"}}"
        )
        .into_bytes()
    }

    /// A genuine archive built by `build_export_db`: its database, its manifest.
    fn build_real_archive(dir: &Path) -> (PathBuf, ExportManifest) {
        let src = make_source(dir);
        let db = dir.join("export.db");
        let manifest = build_export_db(
            &src,
            &db,
            &["c1".to_string()],
            &["t1".to_string()],
            "Shared stuff",
            false,
        )
        .unwrap();
        let zip_path = dir.join("shared.zip");
        write_zip(
            &zip_path,
            &[
                (DB_ENTRY, std::fs::read(&db).unwrap()),
                (
                    MANIFEST_ENTRY,
                    serde_json::to_vec(&manifest).unwrap(),
                ),
            ],
        );
        (zip_path, manifest)
    }

    fn import_from(root: &Path, zip_path: &Path) -> Result<ImportedAssistant, String> {
        import_shared_index(root, RECIPIENT, zip_path.to_str().unwrap(), false, None)
    }

    /// [`build_real_archive`] with the manifest edited after the fact, the way a
    /// sender who opened the ZIP could edit it. The database is untouched, so
    /// anything the importer reports that disagrees with it came from the JSON.
    fn build_archive_with_edited_manifest(
        dir: &Path,
        edit: impl FnOnce(&mut ExportManifest),
    ) -> PathBuf {
        let src = make_source(dir);
        let db = dir.join("export.db");
        let mut manifest = build_export_db(
            &src,
            &db,
            &["c1".to_string()],
            &["t1".to_string()],
            "Shared stuff",
            false,
        )
        .unwrap();
        edit(&mut manifest);
        let zip_path = dir.join("shared.zip");
        write_zip(
            &zip_path,
            &[
                (DB_ENTRY, std::fs::read(&db).unwrap()),
                (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap()),
            ],
        );
        zip_path
    }

    // ── The name a shared index is listed under ───────────────────────────────

    /// **An archive must not be able to call itself what the user's own
    /// knowledge is called.** The premise of the whole feature is knowing whose
    /// knowledge is answering, and registration happens before the rename screen,
    /// so a second tab reading "Me" is on screen before the user could object.
    #[test]
    fn an_archive_cannot_name_itself_me() {
        for claimed in ["Me", "me", "  ME  "] {
            assert_eq!(
                assistant_display_name(claimed),
                DISAMBIGUATED_OWN_LABEL,
                "an archive calling itself {claimed:?} kept the label",
            );
        }
        // End to end, through the real pipeline.
        let dir = scratch_dir("name-me");
        let zip_path = build_archive_with_edited_manifest(&dir, |m| m.name = "Me".to_string());
        let imported = import_from(&dir.join("local-index"), &zip_path).unwrap();
        assert_eq!(imported.name, DISAMBIGUATED_OWN_LABEL);
    }

    /// **Nor can it name itself something that merely looks like "Me".**
    ///
    /// The ASCII-exact check this replaces was closed for the honest case only:
    /// a sender who types `Me` was caught, a sender who types the same word with
    /// a Cyrillic `М` was not — and the tab strip draws the two identically, so
    /// the user is told exactly the thing the guard exists to prevent. Mixed
    /// alphabets are in here because that is what an actual attempt looks like;
    /// nobody switches keyboard layouts for both letters.
    #[test]
    fn an_archive_cannot_name_itself_something_that_looks_like_me() {
        let lookalikes = [
            "\u{041C}\u{0435}", // Cyrillic М + Cyrillic е
            "\u{041C}e",        // Cyrillic М + Latin e
            "M\u{0435}",        // Latin M + Cyrillic е
            "\u{039C}e",        // Greek Μ + Latin e
            "\u{FF2D}\u{FF45}", // fullwidth Ｍｅ
            "\u{041C}\u{0415}", // Cyrillic capitals, i.e. "ME"
        ];
        for claimed in lookalikes {
            assert_eq!(
                assistant_display_name(claimed),
                DISAMBIGUATED_OWN_LABEL,
                "an archive calling itself {claimed:?} kept a label that reads as \"Me\"",
            );
        }
        // A name that only *contains* those letters is a real name, not a
        // collision, and must survive untouched.
        assert_eq!(assistant_display_name("Memory"), "Memory");
    }

    /// Invisible characters are not a label.
    ///
    /// `char::is_control` is Cc only, so every one of these used to travel into
    /// the tab strip: a right-to-left override reorders what is drawn after it,
    /// and a zero-width space hides inside a word where no comparison can see it
    /// — including the "Me" check above, which is why the last case here matters
    /// more than the others.
    #[test]
    fn invisible_characters_never_reach_a_tab_label() {
        // Removed, not turned into a space: they render as nothing, so the
        // cleaned name is what a reader will actually see.
        assert_eq!(assistant_display_name("Sam\u{200B}ple"), "Sample");
        assert_eq!(assistant_display_name("\u{202E}Sample"), "Sample");
        assert_eq!(assistant_display_name("Sam\u{200D}\u{FEFF}ple"), "Sample");
        assert_eq!(assistant_display_name("Sam\u{E0041}ple"), "Sample");

        // A name made only of them has nothing to show, so it falls back.
        assert_eq!(
            assistant_display_name("\u{200B}\u{202E}\u{FEFF}"),
            FALLBACK_ASSISTANT_NAME,
        );

        // And it cannot be used to smuggle the own-tab label past the check.
        assert_eq!(assistant_display_name("M\u{200B}e"), DISAMBIGUATED_OWN_LABEL);
    }

    /// A name is bounded and single-line: an export can call itself a paragraph,
    /// and a tab label is neither the place for one nor for a newline.
    #[test]
    fn a_name_is_bounded_and_single_line() {
        let long = "x".repeat(500);
        let bounded = assistant_display_name(&long);
        assert_eq!(bounded.chars().count(), MAX_ASSISTANT_NAME_CHARS);

        assert_eq!(assistant_display_name("Two\nlines\tand   gaps"), "Two lines and gaps");

        // Cut by characters, never by bytes: a multi-byte name must not come back
        // broken mid-codepoint.
        let accents = "é".repeat(500);
        assert_eq!(
            assistant_display_name(&accents).chars().count(),
            MAX_ASSISTANT_NAME_CHARS,
        );
    }

    /// A name that is only whitespace, only control characters, or absent falls
    /// back rather than producing a nameless tab.
    #[test]
    fn an_unusable_name_falls_back() {
        for raw in ["", "   ", "\n\t\u{0}"] {
            assert_eq!(assistant_display_name(raw), FALLBACK_ASSISTANT_NAME, "{raw:?}");
        }
    }

    /// The name the user typed goes through the same rules. They are about what a
    /// tab label can be, not about who proposed it.
    #[test]
    fn the_users_own_name_is_bounded_too() {
        let dir = scratch_dir("name-user");
        let (zip_path, _) = build_real_archive(&dir);
        let imported = import_shared_index(
            &dir.join("local-index"),
            RECIPIENT,
            zip_path.to_str().unwrap(),
            false,
            Some("Me"),
        )
        .unwrap();
        assert_eq!(imported.name, DISAMBIGUATED_OWN_LABEL);
    }

    /// **"N captures" is counted, not quoted.** The manifest is JSON the sender
    /// wrote; the number in it is what the tab puts on screen, so taking it on
    /// trust lets a stranger choose a sentence the app shows as its own.
    #[test]
    fn the_capture_count_comes_from_the_database_not_the_manifest() {
        let dir = scratch_dir("count-lie");
        let zip_path = build_archive_with_edited_manifest(&dir, |m| m.capture_count = 9_999);
        let imported = import_from(&dir.join("local-index"), &zip_path).unwrap();
        assert_eq!(imported.capture_count, 1, "the manifest's number was believed");
    }

    // ── Guard 1: the size cap refuses while streaming ─────────────────────────

    /// A reader that remembers how much was pulled out of it, so a test can
    /// assert the body was *abandoned* rather than drained and then judged.
    struct CountingReader<R> {
        inner: R,
        consumed: u64,
    }

    impl<R: Read> Read for CountingReader<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.consumed += n as u64;
            Ok(n)
        }
    }

    #[test]
    fn oversized_download_is_refused_mid_stream() {
        // A whole number of chunks, so "stopped at the cap" is an exact figure
        // rather than "somewhere near it".
        let cap = 16 * COPY_BUF_BYTES as u64;
        let body = cap * 3;
        let mut src = CountingReader {
            inner: std::io::repeat(7u8).take(body),
            consumed: 0,
        };
        let mut sink: Vec<u8> = Vec::new();
        let err = copy_capped(&mut src, &mut sink, cap).unwrap_err();
        // The message the download path refuses with, stated once, here and in
        // the code — not a "2 GB" spelled out a second time in the test.
        assert_eq!(err, too_big_message());

        // The point of the guard, and the half that `<= cap` alone does not
        // make: it filled the allowance and stopped there. A read-everything-
        // then-reject implementation leaves `sink` empty, which passes any
        // `<= cap` assertion quite happily.
        assert_eq!(
            sink.len() as u64, cap,
            "the cap is not where it stopped writing"
        );
        // And it did not drain the body to find that out.
        assert!(
            src.consumed < body,
            "read the whole {body}-byte body before refusing it"
        );
        assert!(
            src.consumed <= cap + COPY_BUF_BYTES as u64,
            "read {} bytes to enforce a {cap}-byte cap",
            src.consumed
        );
    }

    // ── Guard 1b: the archive cannot inflate past the cap ─────────────────────

    /// Rewrite every central-directory record's `uncompressed size` field to 0,
    /// leaving the compressed sizes and the CRCs alone.
    ///
    /// This one function is the whole attack. `ZipFile::size()` reads that
    /// field, so an importer that sums those numbers and compares the total to
    /// its ceiling is comparing a number **the sender wrote**. The archive still
    /// extracts perfectly afterwards; it simply lies about how much comes out.
    fn lie_about_uncompressed_sizes(path: &Path) {
        let mut bytes = std::fs::read(path).unwrap();
        // Find the end-of-central-directory record, and the offset it points at.
        let eocd = (0..bytes.len().saturating_sub(21))
            .rev()
            .find(|&i| bytes[i..i + 4] == *b"PK\x05\x06")
            .expect("no end-of-central-directory record");
        let cd_start =
            u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as usize;

        let field = |b: &[u8], at: usize| u16::from_le_bytes(b[at..at + 2].try_into().unwrap()) as usize;
        let mut at = cd_start;
        let mut patched = 0;
        while at + 46 <= bytes.len() && bytes[at..at + 4] == *b"PK\x01\x02" {
            let name_len = field(&bytes, at + 28);
            let extra_len = field(&bytes, at + 30);
            let comment_len = field(&bytes, at + 32);
            bytes[at + 24..at + 28].copy_from_slice(&0u32.to_le_bytes());
            patched += 1;
            at += 46 + name_len + extra_len + comment_len;
        }
        assert!(patched > 0, "no central directory records were patched");
        std::fs::write(path, bytes).unwrap();
    }

    /// **The decompression-bomb test.**
    ///
    /// Every entry declares `uncompressed_size = 0`, so the declared-total
    /// pre-check passes unconditionally — that check reads the sender's own
    /// numbers and can never do anything else. Every entry is also comfortably
    /// under the cap *on its own*, so a per-entry cap passes too, four times
    /// over. Only a cap on the running **sum** of what has been written stops
    /// this, and stopping it is the difference between unpacking 1 MiB and
    /// unpacking as much as the sender feels like putting in the archive.
    #[test]
    fn an_archive_that_declares_nothing_cannot_inflate_past_the_cap() {
        let dir = scratch_dir("zip-bomb");
        let root = dir.join("local-index");
        // A stand-in for MAX_ARCHIVE_BYTES: two real gigabytes is not something
        // a test can produce, and an untested ceiling is not a ceiling.
        let cap = 1024 * 1024u64;
        let each = 400 * 1024; // under the cap on its own; four of them are not.

        let mut entries: Vec<(&str, Vec<u8>)> = vec![
            (DB_ENTRY, b"SQLite format 3\0rest".to_vec()),
            (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
        ];
        for name in [
            "artefacts/a.bin",
            "artefacts/b.bin",
            "artefacts/c.bin",
            "artefacts/d.bin",
        ] {
            entries.push((name, vec![0u8; each]));
        }
        let bomb = dir.join("bomb.zip");
        write_zip(&bomb, &entries);
        lie_about_uncompressed_sizes(&bomb);

        // The fixture is the attack and not an approximation of it: confirm the
        // archive really does declare nothing, and really does hold something.
        {
            let f = std::fs::File::open(&bomb).unwrap();
            let mut z = zip::ZipArchive::new(f).unwrap();
            for i in 0..z.len() {
                assert_eq!(
                    z.by_index_raw(i).unwrap().size(),
                    0,
                    "entry {i} still declares its size, so the pre-check would catch it"
                );
            }
            let mut real = Vec::new();
            z.by_name("artefacts/a.bin").unwrap().read_to_end(&mut real).unwrap();
            assert_eq!(real.len(), each, "the archive does not actually inflate");
        }

        let err = import_shared_index_capped(
            &root,
            RECIPIENT,
            bomb.to_str().unwrap(),
            false,
            None,
            cap,
        )
        .unwrap_err();
        assert_eq!(err, unpacked_too_big_message());
        // And it left nothing behind: no assistant, and not even the folders one
        // would have lived in.
        assert!(!assistants_root(&root).exists());
        assert!(!root.exists(), "the refused import left {root:?} behind");
    }

    /// The same bomb, watched at the level the cap actually lives at: what
    /// reaches the disk stays inside the allowance instead of reaching four
    /// times it.
    #[test]
    fn extraction_stops_once_the_total_reaches_the_cap() {
        let dir = scratch_dir("zip-bomb-bytes");
        let cap = 1024 * 1024u64;
        let each = 400 * 1024;
        let mut entries: Vec<(&str, Vec<u8>)> = vec![
            (DB_ENTRY, b"SQLite format 3\0rest".to_vec()),
            (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
        ];
        for name in ["artefacts/a.bin", "artefacts/b.bin", "artefacts/c.bin", "artefacts/d.bin"] {
            entries.push((name, vec![0u8; each]));
        }
        let bomb = dir.join("bomb.zip");
        write_zip(&bomb, &entries);
        lie_about_uncompressed_sizes(&bomb);

        let into = dir.join("unpacked");
        let err = extract_archive_capped(&bomb, &into, cap).unwrap_err();
        assert_eq!(err, unpacked_too_big_message());

        let on_disk = bytes_under(&into);
        assert!(
            on_disk <= cap,
            "unpacked {on_disk} bytes under a {cap}-byte cap"
        );
    }

    // ── Guard 1c: the archive cannot declare unlimited members ────────────────

    /// **The empty-entry bomb.**
    ///
    /// Every member is zero bytes, so the declared-size fast path sums to nothing
    /// and the cumulative byte cap is never approached — both *byte* guards pass,
    /// with room to spare. What the archive actually asks for is one file
    /// creation per member, which costs a filesystem operation each and no bytes
    /// at all. Only a ceiling on the entry **count** refuses it.
    ///
    /// The ceiling is a parameter here for the same reason the byte cap is: at
    /// `MAX_ARCHIVE_ENTRIES` the fixture would be a hundred thousand members, and
    /// a guard nothing ever reaches is a guard nobody has checked.
    #[test]
    fn an_archive_of_countless_empty_entries_is_refused_before_anything_is_written() {
        let dir = scratch_dir("entry-bomb");
        let entry_cap = 8usize;

        let mut entries: Vec<(&str, Vec<u8>)> = vec![
            (DB_ENTRY, b"SQLite format 3\0rest".to_vec()),
            (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
        ];
        let names: Vec<String> = (0..entry_cap * 4)
            .map(|i| format!("artefacts/{i}.bin"))
            .collect();
        for name in &names {
            entries.push((name.as_str(), Vec::new()));
        }
        let bomb = dir.join("entries.zip");
        write_zip(&bomb, &entries);

        // The fixture really is the attack: it declares nothing and unpacks to
        // nothing, so neither byte guard has anything to catch.
        {
            let f = std::fs::File::open(&bomb).unwrap();
            let mut z = zip::ZipArchive::new(f).unwrap();
            let declared: u64 = (0..z.len()).map(|i| z.by_index_raw(i).unwrap().size()).sum();
            assert!(
                declared < 1024,
                "{declared} declared bytes — the byte cap would have caught this"
            );
            assert!(z.len() > entry_cap);
        }

        let into = dir.join("unpacked");
        let err = extract_archive_capped_with(&bomb, &into, MAX_ARCHIVE_BYTES, entry_cap).unwrap_err();
        assert_eq!(err, too_many_entries_message());
        // Refused before the write pass, so not one of those files was created.
        assert!(!into.exists(), "the refused archive still unpacked into {into:?}");
    }

    /// The other side of it: an archive with as many members as the ceiling
    /// allows is still imported. A guard that refused a legitimate export would
    /// be no better than the hole it closes.
    #[test]
    fn an_archive_at_the_entry_ceiling_is_still_accepted() {
        let dir = scratch_dir("entry-ceiling");
        let root = dir.join("local-index");
        let (zip_path, _) = build_real_archive(&dir);
        let entries = {
            let f = std::fs::File::open(&zip_path).unwrap();
            zip::ZipArchive::new(f).unwrap().len()
        };
        let into = dir.join("unpacked");
        extract_archive_capped_with(&zip_path, &into, MAX_ARCHIVE_BYTES, entries).unwrap();
        assert!(into.join(DB_ENTRY).is_file());
        // And the whole pipeline, at the real ceiling.
        assert!(import_from(&root, &zip_path).is_ok());
    }

    // ── Guard 1d: a local file is capped like a downloaded one ────────────────

    /// The download path refuses past `MAX_ARCHIVE_BYTES` while streaming; a file
    /// already on this machine used to be copied with no ceiling at all. A picked
    /// file is not automatically a small one — a mounted share, a sparse file —
    /// and an uncapped copy fills the temp volume before a single check runs.
    #[test]
    fn a_local_file_over_the_cap_is_refused_like_a_download() {
        let dir = scratch_dir("local-too-big");
        let root = dir.join("local-index");
        let cap = 256 * 1024u64;
        let big = dir.join("huge.zip");
        std::fs::write(&big, vec![0u8; (cap * 4) as usize]).unwrap();

        let err = import_shared_index_capped(
            &root,
            RECIPIENT,
            big.to_str().unwrap(),
            false,
            None,
            cap,
        )
        .unwrap_err();
        // Refused for its size, not for being unreadable as an archive — which is
        // what an uncapped copy would have reported, after copying all of it.
        assert_eq!(err, file_too_big_message());
        assert!(!assistants_root(&root).exists());
    }

    // ── Guard 2: not a ZIP ────────────────────────────────────────────────────

    #[test]
    fn a_file_that_is_not_a_zip_is_refused() {
        let dir = scratch_dir("not-a-zip");
        let root = dir.join("local-index");
        let bogus = dir.join("shared.zip");
        std::fs::write(&bogus, b"this is definitely not a zip file").unwrap();

        let err = import_from(&root, &bogus).unwrap_err();
        assert!(err.contains("not a shared index archive"), "got: {err}");
        assert!(!assistants_root(&root).exists());
    }

    // ── Guard 3a: no manifest.json ────────────────────────────────────────────

    #[test]
    fn an_archive_without_a_manifest_is_refused() {
        let dir = scratch_dir("no-manifest");
        let root = dir.join("local-index");
        let (real, _) = build_real_archive(&dir);
        let db_bytes = {
            let f = std::fs::File::open(&real).unwrap();
            let mut z = zip::ZipArchive::new(f).unwrap();
            let mut e = z.by_name(DB_ENTRY).unwrap();
            let mut v = Vec::new();
            e.read_to_end(&mut v).unwrap();
            v
        };
        let broken = dir.join("no-manifest.zip");
        write_zip(&broken, &[(DB_ENTRY, db_bytes)]);

        let err = import_from(&root, &broken).unwrap_err();
        assert!(err.contains("its details are missing"), "got: {err}");
        assert!(!assistants_root(&root).exists());
    }

    // ── Guard 3b: no index.db ─────────────────────────────────────────────────

    #[test]
    fn an_archive_without_an_index_is_refused() {
        let dir = scratch_dir("no-index");
        let root = dir.join("local-index");
        let broken = dir.join("no-index.zip");
        write_zip(&broken, &[(MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION))]);

        let err = import_from(&root, &broken).unwrap_err();
        assert!(err.contains("does not contain a knowledge index"), "got: {err}");
        assert!(!assistants_root(&root).exists());
    }

    // ── Guard 4: unknown format version ───────────────────────────────────────

    #[test]
    fn an_unknown_format_version_is_refused_by_name() {
        let dir = scratch_dir("bad-version");
        let root = dir.join("local-index");
        let (real, _) = build_real_archive(&dir);
        let db_bytes = {
            let f = std::fs::File::open(&real).unwrap();
            let mut z = zip::ZipArchive::new(f).unwrap();
            let mut e = z.by_name(DB_ENTRY).unwrap();
            let mut v = Vec::new();
            e.read_to_end(&mut v).unwrap();
            v
        };
        let future = dir.join("future.zip");
        write_zip(
            &future,
            &[(DB_ENTRY, db_bytes), (MANIFEST_ENTRY, manifest_json(999))],
        );

        let err = import_from(&root, &future).unwrap_err();
        // Named, not obscure: both versions appear in the message.
        assert!(err.contains("999"), "got: {err}");
        assert!(
            err.contains(&EXPORT_FORMAT_VERSION.to_string()),
            "got: {err}"
        );
        assert!(!assistants_root(&root).exists());
    }

    // ── Guard 5: index.db is not a SQLite database ────────────────────────────

    #[test]
    fn an_index_that_is_not_sqlite_is_refused() {
        let dir = scratch_dir("not-sqlite");
        let root = dir.join("local-index");
        let bad = dir.join("not-sqlite.zip");
        write_zip(
            &bad,
            &[
                (DB_ENTRY, b"MZ\x90\x00 definitely not a database".to_vec()),
                (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
            ],
        );

        let err = import_from(&root, &bad).unwrap_err();
        assert!(err.contains("is not a database"), "got: {err}");
        assert!(!assistants_root(&root).exists());
    }

    // ── Guard 6: a real SQLite file with the wrong schema ─────────────────────

    #[test]
    fn a_sqlite_file_with_the_wrong_schema_is_refused() {
        let dir = scratch_dir("wrong-schema");
        let root = dir.join("local-index");
        let foreign = dir.join("foreign.db");
        {
            let conn = Connection::open(&foreign).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode=DELETE; CREATE TABLE notes(id TEXT, body TEXT);",
            )
            .unwrap();
        }
        // It really is a SQLite database — the header guard passes and the
        // schema guard is what refuses it.
        let bytes = std::fs::read(&foreign).unwrap();
        assert_eq!(&bytes[..16], SQLITE_MAGIC);

        let bad = dir.join("wrong-schema.zip");
        write_zip(
            &bad,
            &[
                (DB_ENTRY, bytes),
                (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
            ],
        );

        let err = import_from(&root, &bad).unwrap_err();
        // What the user is told says nothing about our table names.
        assert_eq!(err, not_a_shared_index_message());
        assert!(!assistants_root(&root).exists());

        // What the *log* is told is the specific fault, which is where a table
        // name is of any use to anybody.
        let conn = Connection::open(&foreign).unwrap();
        assert!(
            matches!(inspect_schema(&conn).unwrap(), Some(SchemaFault::MissingTable(_))),
            "a database of someone else's tables must be refused as missing ours"
        );
    }

    /// A schema that is *almost* right: every table, one column short. The
    /// column list has to be compared, not just the table list.
    #[test]
    fn an_index_missing_one_column_is_refused() {
        let dir = scratch_dir("missing-column");
        let root = dir.join("local-index");
        let nearly = dir.join("nearly.db");
        {
            let conn = Connection::open(&nearly).unwrap();
            crate::local_index::create_schema(&conn).unwrap();
            // `tags` without `auto_assign_apps`.
            conn.execute_batch(
                "PRAGMA journal_mode=DELETE;
                 DROP TABLE tags;
                 CREATE TABLE tags (
                    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    color TEXT NOT NULL DEFAULT '#6366f1',
                    created_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        }
        let bad = dir.join("missing-column.zip");
        write_zip(
            &bad,
            &[
                (DB_ENTRY, std::fs::read(&nearly).unwrap()),
                (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
            ],
        );

        let err = import_from(&root, &bad).unwrap_err();
        // The column name is the detail the log wants and the user cannot use,
        // so it must not be in what they are shown.
        assert_eq!(err, not_a_shared_index_message());
        assert!(
            !err.contains("auto_assign_apps"),
            "an internal column name reached the user: {err}"
        );
        assert!(!assistants_root(&root).exists());

        // The refusal is nonetheless the precise one, and says so where it
        // belongs.
        let conn = Connection::open(&nearly).unwrap();
        assert_eq!(
            inspect_schema(&conn).unwrap(),
            Some(SchemaFault::MissingColumn {
                table: "tags".to_string(),
                column: "auto_assign_apps".to_string(),
            })
        );
    }

    /// `PRAGMA table_info` answers for a VIEW exactly as it does for a table, so
    /// an archive presenting `captures` as a view over something else would pass
    /// a column check that asked only that. `sqlite_master.type` is what settles
    /// it.
    #[test]
    fn an_index_whose_tables_are_views_is_refused() {
        let dir = scratch_dir("views");
        let root = dir.join("local-index");
        let disguised = dir.join("views.db");
        {
            let conn = Connection::open(&disguised).unwrap();
            crate::local_index::create_schema(&conn).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode=DELETE;
                 ALTER TABLE captures RENAME TO captures_real;
                 CREATE VIEW captures AS SELECT * FROM captures_real;",
            )
            .unwrap();
            // The disguise really is convincing to a columns-only check.
            assert!(columns_of(&conn, "captures").unwrap().contains("user_id"));
        }
        let bad = dir.join("views.zip");
        write_zip(
            &bad,
            &[
                (DB_ENTRY, std::fs::read(&disguised).unwrap()),
                (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
            ],
        );

        let err = import_from(&root, &bad).unwrap_err();
        assert_eq!(err, not_a_shared_index_message());
        assert!(!assistants_root(&root).exists());

        let conn = Connection::open(&disguised).unwrap();
        assert_eq!(
            inspect_schema(&conn).unwrap(),
            Some(SchemaFault::NotATable {
                name: "captures".to_string(),
                kind: "view".to_string(),
            })
        );
    }

    /// The import runs `UPDATE tags SET user_id` on the archive's own database.
    /// A trigger shipped inside the archive would be waiting for exactly that,
    /// so a file carrying one is not opened for business at all.
    #[test]
    fn an_index_carrying_a_trigger_is_refused() {
        let dir = scratch_dir("trigger");
        let root = dir.join("local-index");
        let armed = dir.join("trigger.db");
        {
            let conn = Connection::open(&armed).unwrap();
            crate::local_index::create_schema(&conn).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode=DELETE;
                 CREATE TRIGGER on_tag_adoption AFTER UPDATE OF user_id ON tags
                 BEGIN DELETE FROM captures; END;",
            )
            .unwrap();
        }
        let bad = dir.join("trigger.zip");
        write_zip(
            &bad,
            &[
                (DB_ENTRY, std::fs::read(&armed).unwrap()),
                (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
            ],
        );

        let err = import_from(&root, &bad).unwrap_err();
        assert_eq!(err, not_a_shared_index_message());
        assert!(!assistants_root(&root).exists());

        let conn = Connection::open(&armed).unwrap();
        assert_eq!(
            inspect_schema(&conn).unwrap(),
            Some(SchemaFault::Trigger("on_tag_adoption".to_string()))
        );
    }

    /// The other side of the two checks above: a genuine export — FTS virtual
    /// table, shadow tables and all — must still be accepted by them.
    #[test]
    fn a_genuine_export_has_no_views_and_no_triggers() {
        let dir = scratch_dir("schema-clean");
        let src = make_source(&dir);
        let db = dir.join("export.db");
        build_export_db(
            &src,
            &db,
            &["c1".to_string()],
            &["t1".to_string()],
            "Shared stuff",
            false,
        )
        .unwrap();
        let conn = Connection::open(&db).unwrap();
        assert_eq!(inspect_schema(&conn).unwrap(), None);
    }

    // ── Guard 7: an entry name that escapes the directory ─────────────────────

    #[test]
    fn an_entry_that_escapes_the_directory_is_refused_before_extraction() {
        let dir = scratch_dir("escape");
        let root = dir.join("local-index");
        let (real, _) = build_real_archive(&dir);
        let db_bytes = {
            let f = std::fs::File::open(&real).unwrap();
            let mut z = zip::ZipArchive::new(f).unwrap();
            let mut e = z.by_name(DB_ENTRY).unwrap();
            let mut v = Vec::new();
            e.read_to_end(&mut v).unwrap();
            v
        };
        let evil = dir.join("evil.zip");
        // The escaping entry is written LAST on purpose: a one-pass importer
        // that validated each name just before writing it would already have
        // written the two members ahead of it.
        write_zip(
            &evil,
            &[
                (DB_ENTRY, db_bytes),
                (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
                ("../../kts-import-escape.txt", b"pwned".to_vec()),
            ],
        );
        // Confirm the fixture really carries the name we think it does — a zip
        // writer that silently normalised it would make this test vacuous.
        {
            let f = std::fs::File::open(&evil).unwrap();
            let z = zip::ZipArchive::new(f).unwrap();
            assert!(z.file_names().any(|n| n.contains("..")));
        }

        let err = import_from(&root, &evil).unwrap_err();
        assert!(err.contains("we will not write"), "got: {err}");
        assert!(!assistants_root(&root).exists());
        // And nowhere near where the name pointed.
        assert!(!std::env::temp_dir().join("kts-import-escape.txt").exists());
        assert!(!dir.join("kts-import-escape.txt").exists());
    }

    /// An absolute entry name is the other half of the same guard.
    #[test]
    fn an_absolute_entry_name_is_refused() {
        let dir = scratch_dir("absolute");
        let root = dir.join("local-index");
        let evil = dir.join("absolute.zip");
        write_zip(
            &evil,
            &[
                (DB_ENTRY, b"SQLite format 3\0rest".to_vec()),
                (MANIFEST_ENTRY, manifest_json(EXPORT_FORMAT_VERSION)),
                ("/etc/kts-import-absolute.txt", b"pwned".to_vec()),
            ],
        );

        let err = import_from(&root, &evil).unwrap_err();
        assert!(err.contains("we will not write"), "got: {err}");
        assert!(!assistants_root(&root).exists());
    }

    // ── The success path ──────────────────────────────────────────────────────

    #[test]
    fn a_real_archive_imports_and_its_tags_belong_to_the_importer() {
        let dir = scratch_dir("success");
        let root = dir.join("local-index");
        let (zip_path, manifest) = build_real_archive(&dir);

        let imported = import_from(&root, &zip_path).unwrap();
        assert_eq!(imported.name, "Shared stuff");
        assert_eq!(imported.export_id, manifest.export_id);
        assert_eq!(imported.capture_count, 1);
        assert_eq!(imported.embed_model, "test-model");
        assert!(imported.imported_at.ends_with('Z'));
        assert!(!imported.assistant_id.is_empty());

        // Exactly where `local_index_db_path(app, user, Some(id))` will look.
        let db = assistants_root(&root)
            .join(&imported.assistant_id)
            .join(DB_ENTRY);
        assert!(db.is_file(), "no index at {db:?}");

        let conn = Connection::open(&db).unwrap();

        // The load-bearing assertion: `list_tags_for_user` has no `IS NULL`
        // branch, so a tag that is not owned by the importer is invisible.
        let tags = crate::local_index::list_tags_for_user(&conn, RECIPIENT).unwrap();
        assert_eq!(tags.len(), 1, "imported tags are invisible to the importer");
        assert_eq!(tags[0].id, "t1");
        assert_eq!(tags[0].user_id.as_deref(), Some(RECIPIENT));

        // And the captures are owned explicitly rather than by an IS NULL branch.
        let owner: Option<String> = conn
            .query_row("SELECT user_id FROM captures WHERE id='c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(owner.as_deref(), Some(RECIPIENT));

        // `t-gone` had no `tags` row — the sender deleted it after tagging —
        // so it must not survive as a chip id with nothing behind it.
        let tag_ids: String = conn
            .query_row("SELECT tag_ids FROM captures WHERE id='c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tag_ids, "[\"t1\"]");
    }

    // ── The exporter and the importer, meeting ────────────────────────────────

    const MEDIA_BYTES: &[u8] = b"\x89PNG\r\n\x1a\n-pretend-this-is-a-screenshot";

    /// An archive built by the **export** module end to end — `build_export_db`
    /// for the database, `media_entries_from_source` for the media,
    /// `write_export_zip` for the packaging — rather than assembled by hand in
    /// this file.
    ///
    /// Every other fixture here writes its own ZIP, which is fine for testing a
    /// guard against a shape chosen to trip it, and useless for testing that the
    /// two halves of the feature fit. A hand-built fixture is this module's idea
    /// of what an export looks like; if that idea were wrong, every test would
    /// keep passing and every real archive would fail.
    fn build_exported_archive_with_media(dir: &Path) -> PathBuf {
        let src = make_source(dir);
        // An image capture pointing at a real file, under a stand-in for the
        // sender's home folder — a path the export has to strip on the way out.
        let sender_pictures = dir.join("sender-home").join("Pictures");
        std::fs::create_dir_all(&sender_pictures).unwrap();
        let on_disk = sender_pictures.join("Screenshot 2026-01-02.png");
        std::fs::write(&on_disk, MEDIA_BYTES).unwrap();
        {
            let conn = Connection::open(&src).unwrap();
            conn.execute(
                "INSERT INTO captures(id,user_id,raw_text,kind,local_path,tag_ids,created_at) \
                 VALUES ('c2','sender-user','a screenshot','image',?1,'[\"t1\"]','2026-01-02T00:00:00.000Z')",
                params![on_disk.to_str().unwrap()],
            )
            .unwrap();
        }

        let ids = vec!["c1".to_string(), "c2".to_string()];
        let staged = dir.join("staged.db");
        let manifest = build_export_db(
            &src,
            &staged,
            &ids,
            &["t1".to_string()],
            "Shared stuff",
            false,
        )
        .unwrap();
        let conn = Connection::open(&src).unwrap();
        let media = crate::index_export::media_entries_from_source(&conn, &ids).unwrap();
        assert_eq!(media.len(), 1, "the export found no media to send");
        let zip_path = dir.join("exported.zip");
        let written =
            crate::index_export::write_export_zip(&staged, &manifest, &media, &zip_path).unwrap();
        assert_eq!(written, 1, "the export wrote no media into the archive");
        zip_path
    }

    /// **The test the module was missing.**
    ///
    /// Everything else in this file feeds the importer an archive this file
    /// wrote. This one feeds it the exporter's actual output, so the question it
    /// answers is the one no other test asks: do the two halves meet? It is also
    /// the only test that carries media, and therefore the only one that takes
    /// `artefacts/` through extraction, validation and adoption to the place the
    /// app will later look for a picture.
    #[test]
    fn a_real_export_imports_whole_media_and_all() {
        let dir = scratch_dir("export-roundtrip");
        let root = dir.join("local-index");
        let zip_path = build_exported_archive_with_media(&dir);

        let imported = import_from(&root, &zip_path).unwrap();
        // The manifest the exporter wrote is what the importer reported back.
        assert_eq!(imported.name, "Shared stuff");
        assert_eq!(imported.capture_count, 2);
        assert_eq!(imported.embed_model, "test-model");

        let assistant = assistants_root(&root).join(&imported.assistant_id);
        let db = assistant.join(DB_ENTRY);
        assert!(db.is_file(), "no index at {db:?}");
        let conn = Connection::open(&db).unwrap();

        // The captures survived the round trip.
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM captures", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "the exported captures did not arrive");

        // Usable by the importing profile, which is the property neither half
        // can demonstrate alone: the export NULLs `tags.user_id` and
        // `list_tags_for_user` has no `IS NULL` branch, so this assertion fails
        // the moment either side changes its mind about who owns an imported row.
        let tags = crate::local_index::list_tags_for_user(&conn, RECIPIENT).unwrap();
        assert_eq!(tags.len(), 1, "imported tags are invisible to the importer");
        assert_eq!(tags[0].id, "t1");

        // And the media landed beside the database, under the name the exported
        // row points at. The entry name and the column are written by one
        // function on the export side (`exported_media_name`); this is where it
        // is proved they still agree after the archive has been through the
        // importer.
        let local_path: String = conn
            .query_row("SELECT local_path FROM captures WHERE id='c2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            local_path, "c2.png",
            "the sender's own path travelled instead of the exported name"
        );
        let media = assistant.join(MEDIA_DIR).join("images").join(&local_path);
        assert!(media.is_file(), "no media at {media:?}");
        assert_eq!(
            std::fs::read(&media).unwrap(),
            MEDIA_BYTES,
            "the media arrived, but not intact"
        );
    }

    /// Two imports of the same archive are two assistants, not one overwriting
    /// the other.
    #[test]
    fn importing_twice_makes_two_assistants() {
        let dir = scratch_dir("twice");
        let root = dir.join("local-index");
        let (zip_path, _) = build_real_archive(&dir);

        let a = import_from(&root, &zip_path).unwrap();
        let b = import_from(&root, &zip_path).unwrap();
        assert_ne!(a.assistant_id, b.assistant_id);
        assert!(assistants_root(&root).join(&a.assistant_id).join(DB_ENTRY).is_file());
        assert!(assistants_root(&root).join(&b.assistant_id).join(DB_ENTRY).is_file());
    }

    /// The scratch folder deletes itself, which is what makes "leaves nothing
    /// behind" hold for every early return rather than for the ones someone
    /// wrote a cleanup line for.
    ///
    /// Tested on `ScratchDir` itself rather than by scanning the temp folder
    /// before and after an import: the suite runs in parallel, so another
    /// import test's scratch folder would show up in such a scan and make it
    /// flaky for a reason that has nothing to do with cleanup.
    #[test]
    fn the_scratch_folder_deletes_itself() {
        let scratch = ScratchDir::new().unwrap();
        let path = scratch.path.clone();
        std::fs::write(path.join("archive.zip"), b"some downloaded bytes").unwrap();
        std::fs::create_dir_all(path.join("unpacked")).unwrap();
        assert!(path.is_dir());
        drop(scratch);
        assert!(!path.exists(), "scratch folder survived at {path:?}");
    }

    // ── Adoption, and undoing a failed one ────────────────────────────────────

    /// A failed adoption must leave the tree as it found it — and
    /// `create_dir_all` brings *three* levels into being, not one. Removing only
    /// the leaf leaves `{root}/{user}/assistants/` behind, an empty folder the
    /// user never asked for from an import that was refused.
    #[test]
    fn a_failed_adoption_removes_every_folder_it_created() {
        let dir = scratch_dir("rollback");
        let root = dir.join("local-index");
        let dest = local_index_dir_in(&root, RECIPIENT, Some("assistant-1")).unwrap();

        let created = dirs_to_create(&root, &dest);
        assert_eq!(
            created.len(),
            4,
            "expected the assistant's folder, assistants/, the profile and the root: {created:?}"
        );

        // Adopt half an assistant, then fail.
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join(DB_ENTRY), b"half a database").unwrap();
        rollback_adoption(&dest, &created);

        assert!(!dest.exists(), "the half-filled assistant folder survived");
        assert!(!assistants_root(&root).exists(), "an empty assistants/ was left behind");
        assert!(!root.exists(), "the refused import left {root:?} behind");
    }

    /// The other half of the same rule: a rollback removes what *it* created and
    /// nothing else. `assistants/` already holding somebody's import is not
    /// debris, and `remove_dir` on a non-empty folder is how that is said.
    #[test]
    fn a_rollback_leaves_folders_it_did_not_create() {
        let dir = scratch_dir("rollback-shared");
        let root = dir.join("local-index");
        let (zip_path, _) = build_real_archive(&dir);
        let keeper = import_from(&root, &zip_path).unwrap();

        let dest = local_index_dir_in(&root, RECIPIENT, Some("assistant-2")).unwrap();
        let created = dirs_to_create(&root, &dest);
        assert_eq!(
            created,
            vec![dest.clone()],
            "only the assistant's own folder is ours to remove: {created:?}"
        );
        std::fs::create_dir_all(&dest).unwrap();
        rollback_adoption(&dest, &created);

        assert!(!dest.exists());
        assert!(
            assistants_root(&root)
                .join(&keeper.assistant_id)
                .join(DB_ENTRY)
                .is_file(),
            "a rollback took an assistant that was already there"
        );
    }

    /// `move_path` falls back to a copy when the scratch folder and the app's
    /// data folder sit on different volumes. No test machine arranges that, so
    /// the fallback is exercised directly rather than left to a rename that
    /// always succeeds — media is a *directory*, and this is the branch that
    /// carries it across.
    #[test]
    fn copy_dir_carries_a_nested_tree() {
        let dir = scratch_dir("copy-dir");
        let from = dir.join("artefacts");
        std::fs::create_dir_all(from.join("images")).unwrap();
        std::fs::create_dir_all(from.join("videos").join("deeper")).unwrap();
        std::fs::write(from.join("images").join("a.png"), MEDIA_BYTES).unwrap();
        std::fs::write(from.join("videos").join("deeper").join("b.mov"), b"mov").unwrap();

        let to = dir.join("adopted").join("artefacts");
        copy_dir(&from, &to).unwrap();

        assert_eq!(std::fs::read(to.join("images").join("a.png")).unwrap(), MEDIA_BYTES);
        assert_eq!(
            std::fs::read(to.join("videos").join("deeper").join("b.mov")).unwrap(),
            b"mov"
        );
        // A copy, not a move: `move_path` removes the source itself afterwards.
        assert!(from.join("images").join("a.png").is_file());
    }

    /// A link that is not http(s) never reaches the network stack.
    #[test]
    fn a_non_http_link_is_refused() {
        let dir = scratch_dir("scheme");
        let root = dir.join("local-index");
        let err = import_shared_index(&root, RECIPIENT, "file:///etc/passwd", true, None).unwrap_err();
        assert!(err.contains("http://"), "got: {err}");
        assert!(!assistants_root(&root).exists());
    }

    // ── Deleting an assistant ─────────────────────────────────────────────────

    /// The profile's own index, as it exists on a real installation: the
    /// database plus the two sidecars that live beside it. Every deletion test
    /// asserts this survives, because this is what an unguarded
    /// `remove_dir_all` would take.
    fn make_own_index(root: &Path) -> PathBuf {
        let own = root.join(RECIPIENT);
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join(DB_ENTRY), b"the user's entire knowledge index").unwrap();
        std::fs::write(own.join("gcp-share-config.json"), b"{}").unwrap();
        own
    }

    /// **The test this task exists for.**
    ///
    /// An empty `assistant_id` has nothing to join onto
    /// `{root}/{user}/assistants/`, so an unguarded `delete_assistant` would
    /// `remove_dir_all` that folder — every imported assistant at once. The
    /// whitespace-only ids in the loop are the sharper half: they pass any bare
    /// `is_empty()` and sanitize to a perfectly valid-looking `_` segment.
    ///
    /// Asserted afterwards: the refusal deleted nothing at all — not the
    /// profile's own index (see the sibling traversal test for the id that
    /// reaches *that*), and not the assistant that was legitimately there.
    #[test]
    fn an_empty_assistant_id_is_refused_and_the_profile_index_survives() {
        let dir = scratch_dir("delete-empty-id");
        let root = dir.join("local-index");
        let own = make_own_index(&root);
        let (zip_path, _) = build_real_archive(&dir);
        let imported = import_from(&root, &zip_path).unwrap();

        for id in ["", " ", "\t", "\n  "] {
            let err = delete_assistant(&root, RECIPIENT, id).unwrap_err();
            assert!(
                err.contains("without knowing which one"),
                "id {id:?} gave: {err}"
            );
        }

        // The whole point: nothing of the profile's own index was touched.
        assert!(own.is_dir(), "the profile's directory was deleted");
        assert_eq!(
            std::fs::read(own.join(DB_ENTRY)).unwrap(),
            b"the user's entire knowledge index",
        );
        assert!(own.join("gcp-share-config.json").is_file());
        // And the real assistant is still there too — a refusal must not be a
        // partial deletion.
        assert!(assistants_root(&root)
            .join(&imported.assistant_id)
            .join(DB_ENTRY)
            .is_file());
    }

    /// Deleting takes the assistant's whole directory and nothing else: not the
    /// profile's index, not the other assistant.
    #[test]
    fn deleting_one_assistant_leaves_the_others_and_the_profile_alone() {
        let dir = scratch_dir("delete-one");
        let root = dir.join("local-index");
        let own = make_own_index(&root);
        let (zip_path, _) = build_real_archive(&dir);
        let a = import_from(&root, &zip_path).unwrap();
        let b = import_from(&root, &zip_path).unwrap();

        // Media beside the database must go too, not just `index.db`.
        let a_dir = assistants_root(&root).join(&a.assistant_id);
        std::fs::create_dir_all(a_dir.join(MEDIA_DIR)).unwrap();
        std::fs::write(a_dir.join(MEDIA_DIR).join("shot.png"), b"png").unwrap();

        delete_assistant(&root, RECIPIENT, &a.assistant_id).unwrap();

        assert!(!a_dir.exists(), "the assistant's directory survived");
        assert!(assistants_root(&root)
            .join(&b.assistant_id)
            .join(DB_ENTRY)
            .is_file());
        assert!(own.join(DB_ENTRY).is_file());
        // The `assistants` folder itself stays: it still holds `b`.
        assert!(assistants_root(&root).is_dir());
    }

    /// An id crafted to climb out. `..` lands on the profile's own directory,
    /// `../..` on the `local-index` root — every profile on the machine.
    ///
    /// A real assistant is imported first, on purpose: it makes
    /// `{profile}/assistants/` exist, so `{profile}/assistants/..` is a path the
    /// filesystem *can* resolve and `remove_dir_all` would really follow. Without
    /// that the test would pass for the empty reason that nothing was there, and
    /// would keep passing with every guard removed.
    #[test]
    fn a_traversing_assistant_id_deletes_nothing_outside_the_profile() {
        let dir = scratch_dir("delete-traversal");
        let root = dir.join("local-index");
        let own = make_own_index(&root);
        let other_profile = root.join("some-other-user");
        std::fs::create_dir_all(&other_profile).unwrap();
        std::fs::write(other_profile.join(DB_ENTRY), b"someone else's index").unwrap();
        let (zip_path, _) = build_real_archive(&dir);
        let innocent = import_from(&root, &zip_path).unwrap();
        assert!(assistants_root(&root).is_dir());

        for id in ["..", "../..", "../../..", "/", "../../../../../../etc"] {
            // Whatever it returns, it must not have deleted anything.
            let _ = delete_assistant(&root, RECIPIENT, id);
            assert!(own.join(DB_ENTRY).is_file(), "id {id:?} hit the profile index");
            assert!(
                other_profile.join(DB_ENTRY).is_file(),
                "id {id:?} hit another profile"
            );
            assert!(root.is_dir(), "id {id:?} hit the local-index root");
            assert!(
                assistants_root(&root)
                    .join(&innocent.assistant_id)
                    .join(DB_ENTRY)
                    .is_file(),
                "id {id:?} hit an unrelated assistant"
            );
        }
    }

    /// Deleting something that is not on disk is not an error. The registry
    /// entry and the folder are separate state: if refusing here were allowed,
    /// a user whose folder had already gone could never clear the entry that
    /// points at it.
    #[test]
    fn deleting_an_assistant_that_is_not_there_succeeds() {
        let dir = scratch_dir("delete-missing");
        let root = dir.join("local-index");
        make_own_index(&root);

        delete_assistant(&root, RECIPIENT, "never-imported").unwrap();
        // Twice in a row, too — the second call is the realistic one (a retry
        // after the registry write failed the first time round).
        delete_assistant(&root, RECIPIENT, "never-imported").unwrap();
    }

    /// "Not there" is forgiven; "we could not look" is not.
    ///
    /// `Path::exists()` answers `false` to both, and the caller drops the registry
    /// entry on `Ok(())` — so an unreadable ancestor or an unmounted volume would
    /// have the entry thrown away while the files sat there, invisible, waiting to
    /// reappear with the volume.
    ///
    /// A file where `assistants/` should be is how that is staged portably: the
    /// lookup fails with "not a directory", which is emphatically not
    /// `NotFound`, and no test needs to arrange a permission denial.
    #[test]
    fn a_delete_that_cannot_look_at_the_folder_does_not_report_success() {
        let dir = scratch_dir("delete-unreachable");
        let root = dir.join("local-index");
        let own = make_own_index(&root);
        // `{profile}/assistants` is a *file*, so `{profile}/assistants/x` cannot
        // be reached — and cannot be said to be absent either.
        std::fs::write(own.join("assistants"), b"not a directory").unwrap();

        let err = delete_assistant(&root, RECIPIENT, "some-assistant").unwrap_err();
        assert!(err.contains("could not reach"), "got: {err}");
        // Nothing was touched on the way to saying so.
        assert!(own.join(DB_ENTRY).is_file());
        assert!(own.join("assistants").is_file());
    }

    // ── Assistants nothing lists ──────────────────────────────────────────────

    /// The registry is the only thing that lists an imported assistant, so a lost
    /// entry used to mean a folder nothing could ever open, offer or remove. This
    /// is the floor under that: the folder is named, sized, and addressed by the
    /// id `delete_assistant` takes.
    #[test]
    fn an_assistant_the_registry_forgot_is_listed_and_can_then_be_deleted() {
        let dir = scratch_dir("orphans");
        let root = dir.join("local-index");
        make_own_index(&root);
        let (zip_path, _) = build_real_archive(&dir);
        let kept = import_from(&root, &zip_path).unwrap();
        let lost = import_from(&root, &zip_path).unwrap();

        // The registry remembers one of the two.
        let orphans = list_orphan_assistants(&root, RECIPIENT, &[kept.assistant_id.clone()]).unwrap();
        assert_eq!(orphans.len(), 1, "got: {orphans:?}");
        assert_eq!(orphans[0].assistant_id, lost.assistant_id);
        assert!(orphans[0].size_bytes > 0, "an index of no size at all: {orphans:?}");

        // Listing deletes nothing — an orphan may be one the user wants back.
        assert!(assistants_root(&root)
            .join(&lost.assistant_id)
            .join(DB_ENTRY)
            .is_file());

        // And the id it reports is the one that removes it.
        delete_assistant(&root, RECIPIENT, &orphans[0].assistant_id).unwrap();
        assert!(!assistants_root(&root).join(&lost.assistant_id).exists());
        assert!(assistants_root(&root)
            .join(&kept.assistant_id)
            .join(DB_ENTRY)
            .is_file());
        assert!(list_orphan_assistants(&root, RECIPIENT, &[kept.assistant_id]).unwrap().is_empty());
    }

    /// A registry that lists everything on disk has no orphans, and a profile
    /// that has never imported anything has nothing to look through.
    #[test]
    fn a_complete_registry_reports_no_orphans() {
        let dir = scratch_dir("orphans-none");
        let root = dir.join("local-index");
        make_own_index(&root);
        assert!(list_orphan_assistants(&root, RECIPIENT, &[]).unwrap().is_empty());

        let (zip_path, _) = build_real_archive(&dir);
        let a = import_from(&root, &zip_path).unwrap();
        let b = import_from(&root, &zip_path).unwrap();
        let known = vec![a.assistant_id.clone(), b.assistant_id.clone()];
        assert!(list_orphan_assistants(&root, RECIPIENT, &known).unwrap().is_empty());

        // The whole registry lost: everything on disk is then reported, and
        // nothing of it is removed by the reporting.
        let all = list_orphan_assistants(&root, RECIPIENT, &[]).unwrap();
        assert_eq!(all.len(), 2);
        assert!(assistants_root(&root).join(&a.assistant_id).join(DB_ENTRY).is_file());
        assert!(assistants_root(&root).join(&b.assistant_id).join(DB_ENTRY).is_file());
    }

    /// End to end: what is imported can be deleted, addressed by the very
    /// `assistant_id` the import handed back.
    #[test]
    fn an_imported_assistant_can_be_deleted_by_the_id_the_import_returned() {
        let dir = scratch_dir("delete-roundtrip");
        let root = dir.join("local-index");
        let (zip_path, _) = build_real_archive(&dir);
        let imported = import_from(&root, &zip_path).unwrap();
        let db = assistants_root(&root)
            .join(&imported.assistant_id)
            .join(DB_ENTRY);
        assert!(db.is_file());

        delete_assistant(&root, RECIPIENT, &imported.assistant_id).unwrap();
        assert!(!db.exists());
    }

    /// An empty `user_id` must not resolve to the `local-index` root and take
    /// every profile with it. `local_index_dir_in` refuses it; this asserts the
    /// refusal reaches this function rather than being swallowed.
    #[test]
    fn an_empty_user_id_is_refused_too() {
        let dir = scratch_dir("delete-empty-user");
        let root = dir.join("local-index");
        make_own_index(&root);

        assert!(delete_assistant(&root, "", "some-assistant").is_err());
        assert!(root.join(RECIPIENT).join(DB_ENTRY).is_file());
    }
}
