//! Local SQLite knowledge index — chunking, embeddings (BLOB), hybrid search (FTS5 + cosine).
//!
//! DB: `{app_local_data_dir}/kety/local-index/{user_id}/index.db` for a profile's own index,
//!     `.../{user_id}/assistants/{assistant_id}/index.db` for an index imported into it.
//!
//! Vectors are stored as raw little-endian f32 blobs — no extension required.
//! Search = FTS5 BM25 + cosine similarity computed in Rust, fused with RRF.
//!
//! Env vars (all optional):
//!   KTS_LOCAL_CHUNK_SIZE           chars per chunk         (default 2048 ≈ 512 tok)
//!   KTS_LOCAL_CHUNK_OVERLAP        char overlap            (default 256  ≈ 64 tok)
//!   KTS_LOCAL_RAG_TOP_K_LOCAL      top-k for local Qwen   (default 5)
//!   KTS_LOCAL_RAG_TOP_K_API        top-k for API mode     (default 12)
//!   KTS_LOCAL_RAG_TOKEN_BUDGET_LOCAL  max prompt chars     (default 6000)
//!   KTS_LOCAL_RAG_TOKEN_BUDGET_API    max prompt chars     (default 24000)

use std::sync::Mutex;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

// ── Env-configurable defaults ─────────────────────────────────────────────────

fn chunk_size() -> usize {
    std::env::var("KTS_LOCAL_CHUNK_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(2048)
}
fn chunk_overlap() -> usize {
    std::env::var("KTS_LOCAL_CHUNK_OVERLAP").ok().and_then(|v| v.parse().ok()).unwrap_or(256)
}
pub fn top_k_local() -> usize {
    std::env::var("KTS_LOCAL_RAG_TOP_K_LOCAL").ok().and_then(|v| v.parse().ok()).unwrap_or(5)
}
pub fn top_k_api() -> usize {
    std::env::var("KTS_LOCAL_RAG_TOP_K_API").ok().and_then(|v| v.parse().ok()).unwrap_or(12)
}
pub fn token_budget_local() -> usize {
    std::env::var("KTS_LOCAL_RAG_TOKEN_BUDGET_LOCAL").ok().and_then(|v| v.parse().ok()).unwrap_or(6000)
}
pub fn token_budget_api() -> usize {
    std::env::var("KTS_LOCAL_RAG_TOKEN_BUDGET_API").ok().and_then(|v| v.parse().ok()).unwrap_or(24000)
}

// ── Which index is being opened, and what that permits ────────────────────────

/// Whose knowledge a database holds — and therefore what may be done to it when
/// it will not open.
///
/// The two cases are not symmetric, and treating them as one is how a user loses
/// knowledge they cannot get back:
///
/// - [`IndexKind::Own`] is the profile's own index, a **derived** artefact. The
///   real captures live in `kety/captures/` and the media beside them, so a
///   database that will not open can be deleted and rebuilt. That is the
///   recovery policy `open_or_recreate_db` was written for, and it is sound here.
/// - [`IndexKind::Imported`] is an index somebody else shared. Its directory —
///   `{user}/assistants/{id}/`, holding `index.db` **and** `artefacts/` — is the
///   **only** copy of that knowledge and its media on this machine. Nothing can
///   rebuild it. Delete-and-rebuild here is not recovery, it is the loss.
///
/// So an imported index is never deleted on a failed open: it is left exactly as
/// it is and the failure is reported. A blank database in place of a stranger's
/// shared knowledge, under a tab still claiming N captures, is the outcome this
/// type exists to make impossible.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IndexKind {
    /// The profile's own index — rebuildable, so recoverable by recreation.
    Own,
    /// An index imported from someone else — the only copy, never recreated.
    Imported,
}

impl IndexKind {
    /// The kind an `assistant_id` implies: `None` is the profile's own index,
    /// `Some(_)` an imported one. Every caller derives the kind this way rather
    /// than choosing it, so the two can never disagree.
    pub fn of(assistant_id: Option<&str>) -> Self {
        if assistant_id.is_some() { Self::Imported } else { Self::Own }
    }

    fn is_imported(self) -> bool {
        matches!(self, Self::Imported)
    }
}

/// What the user is told when an imported index will not open.
///
/// It has to say two things, and the second is the one that matters: the files
/// are still there. The whole point of refusing to recreate is that nothing was
/// destroyed, and a message that only reported the failure would leave the user
/// assuming the worst and, quite reasonably, deleting the assistant to "start
/// clean" — finishing by hand the destruction we just declined to do.
pub(crate) fn unreadable_shared_index_message() -> String {
    "We could not open this shared knowledge. Nothing was removed — it is still on your computer. \
     Close the app, reopen it and try again."
        .to_string()
}

/// What the user is told when a read arrives with no profile behind it.
///
/// An empty `user_id` is a programming mistake, not something the reader did —
/// but the string still travels straight to the surface: these errors are
/// returned verbatim by the local index commands and rendered by whichever
/// banner asked. `"user_id is required for local index operations"` in front of
/// a person names an internal parameter and tells them nothing they can act on,
/// so the sentence they get says what happened and what to do instead. The
/// technical detail stays where it belongs, in the log line at the call site.
pub(crate) fn missing_profile_message() -> String {
    "We could not open your knowledge because no account is signed in. Sign in and try again."
        .to_string()
}

/// What the user is told when the index is locked by something else right now.
///
/// It has to promise the same thing the imported message promises — nothing was
/// touched — because that is the whole point of telling a lock apart from a
/// broken file. Being busy is a moment, not a state, so the sentence asks for a
/// moment rather than sending anyone to look for a problem.
pub(crate) fn index_busy_message() -> String {
    "We could not open your knowledge because it is in use right now. Nothing was changed — \
     please try again in a moment."
        .to_string()
}

// ── Per-(profile, assistant) connection manager ───────────────────────────────

/// Holds the currently-open DB connection + the identity it was opened for.
///
/// That identity is a pair: the profile (`user_id`) and, within it, which
/// knowledge source (`assistant_id`) — `None` being the profile's own index,
/// `Some(id)` an index imported into it. Both halves are part of the cache key:
/// keyed on `user_id` alone, a read meant for an imported assistant would hit the
/// connection already open on the profile's own database and silently answer from
/// the wrong knowledge. Transparently re-opens when a different pair is requested.
pub struct LocalIndexConn {
    user_id: String,
    assistant_id: Option<String>,
    conn: Option<Connection>,
}

/// Does the cached connection's identity match what the caller wants?
///
/// Both halves of the pair must match, or a cache hit answers from the wrong
/// index: keyed on `user_id` alone, a read meant for an imported assistant
/// would hit the connection already open on the profile's own database and
/// silently answer from the wrong knowledge.
///
/// Pure: no I/O, no lock — safe to unit test directly even though `get_for`
/// and `force_recreate_for` (its only callers) require an `AppHandle` and
/// cannot be.
fn cache_matches(
    cached_user: &str,
    cached_assistant: Option<&str>,
    want_user: &str,
    want_assistant: Option<&str>,
) -> bool {
    cached_user == want_user && cached_assistant == want_assistant
}

impl LocalIndexConn {
    pub fn new() -> Self { Self { user_id: String::new(), assistant_id: None, conn: None } }

    /// Return the DB path for a (profile, assistant) pair without opening a
    /// connection or holding any lock.
    pub fn db_path_for(
        &mut self,
        app: &tauri::AppHandle,
        user_id: &str,
        assistant_id: Option<&str>,
    ) -> Result<std::path::PathBuf, String> {
        if user_id.is_empty() {
            eprintln!("[db] db_path_for called with an empty user_id");
            return Err(missing_profile_message());
        }
        crate::kety_paths::local_index_db_path(app, user_id, assistant_id)
    }

    /// Force-delete the DB file and recreate it from scratch.
    /// Use when save_capture returns "malformed" — the file on disk is corrupted and cannot be
    /// salvaged; we must delete it so the next open_or_recreate_db gets a truly clean slate.
    ///
    /// **Refuses an imported index**, before touching anything. This is the same
    /// delete-and-rebuild `open_or_recreate_db` declines for [`IndexKind::Imported`],
    /// reachable by another door: its only caller today is the write path, which
    /// cannot name an assistant, but that is a fact about the caller and this is a
    /// `pub fn`. The refusal lives here so the invariant is enforced where the
    /// `remove_dir_all` is, not remembered at each call site.
    pub fn force_recreate_for(
        &mut self,
        app: &tauri::AppHandle,
        user_id: &str,
        assistant_id: Option<&str>,
    ) -> Result<&Connection, String> {
        if IndexKind::of(assistant_id).is_imported() {
            eprintln!("[db] force-recreate refused: imported indexes are never rebuilt");
            return Err(unreadable_shared_index_message());
        }
        self.conn = None; // closes the SQLite connection (sqlite3_close) before we touch files
        self.user_id = String::new();
        self.assistant_id = None;
        let db_path = crate::kety_paths::local_index_db_path(app, user_id, assistant_id)?;
        eprintln!("[db] force-recreating DB at {}", db_path.display());

        // Nuke the entire user index directory — individual remove_file can silently fail if
        // sqlite3_close's internal WAL flush still holds a lock, leaving the corrupted file in
        // place. remove_dir_all removes everything atomically and eliminates all stale SQLite
        // sidecar files (db-wal, db-shm) in one shot.
        let index_dir = db_path.parent()
            .ok_or_else(|| "force-recreate: could not get index dir".to_string())?;
        match std::fs::remove_dir_all(index_dir) {
            Ok(()) => eprintln!("[db] force-recreate: cleared index dir {}", index_dir.display()),
            Err(e) => eprintln!("[db] force-recreate: WARNING could not clear index dir: {e}"),
        }
        std::fs::create_dir_all(index_dir)
            .map_err(|e| { eprintln!("[db] force-recreate: mkdir failed: {e}"); format!("force-recreate: mkdir failed: {e}") })?;
        eprintln!("[db] force-recreate: dir ready");

        let conn = Connection::open(&db_path)
            .map_err(|e| { eprintln!("[db] force-recreate: open failed: {e}"); e.to_string() })?;
        eprintln!("[db] force-recreate: DB opened");

        // Derived from the id, never written as a literal. The refusal at the top of
        // this function means only `None` reaches here today, so `IndexKind::of` and
        // `IndexKind::Own` name the same value — but one of them stays true if that
        // guard is ever loosened, and the other silently starts telling a delete-and-
        // rebuild path that somebody else's shared index is ours to rebuild.
        init_db(&conn, IndexKind::of(assistant_id)).map_err(|e| { eprintln!("[db] force-recreate: init_db failed: {e}"); e.to_string() })?;
        eprintln!("[db] force-recreate done");
        self.conn = Some(conn);
        self.user_id = user_id.to_string();
        self.assistant_id = assistant_id.map(str::to_string);
        Ok(self.conn.as_ref().unwrap())
    }

    /// Close the cached connection if it is the one open on this
    /// (profile, assistant) pair. Returns whether it matched.
    ///
    /// Called before an assistant's files are deleted, for two reasons that are
    /// both failures without it:
    ///
    /// - the cache key is `(user_id, assistant_id)` and nothing invalidates it,
    ///   so a read arriving after the delete would still *hit* — answering from a
    ///   database whose directory entry is gone, showing content from a deleted
    ///   assistant and pinning its blocks on disk for as long as the app runs;
    /// - on Windows the open handle makes `remove_dir_all` fail outright.
    ///
    /// `force_recreate_for` above drops `self.conn` before touching files for
    /// exactly this reason; this is the same move, made from the delete path.
    pub fn drop_cached_for(&mut self, user_id: &str, assistant_id: Option<&str>) -> bool {
        if !cache_matches(&self.user_id, self.assistant_id.as_deref(), user_id, assistant_id) {
            return false;
        }
        self.conn = None; // sqlite3_close, before the files go
        self.user_id = String::new();
        self.assistant_id = None;
        true
    }

    pub fn get_for(
        &mut self,
        app: &tauri::AppHandle,
        user_id: &str,
        assistant_id: Option<&str>,
    ) -> Result<&Connection, String> {
        if user_id.is_empty() {
            eprintln!("[db] get_for called with an empty user_id");
            return Err(missing_profile_message());
        }
        let cached_matches = cache_matches(&self.user_id, self.assistant_id.as_deref(), user_id, assistant_id);
        if !cached_matches || self.conn.is_none() {
            let db_path = crate::kety_paths::local_index_db_path(app, user_id, assistant_id)?;
            let conn = open_or_recreate_db(&db_path, IndexKind::of(assistant_id))?;
            self.conn = Some(conn);
            self.user_id = user_id.to_string();
            self.assistant_id = assistant_id.map(str::to_string);
        }
        Ok(self.conn.as_ref().unwrap())
    }
}

pub struct LocalIndexState(pub Mutex<LocalIndexConn>);

// ── DB init ───────────────────────────────────────────────────────────────────

/// Open a DB, running schema creation and migrations.
/// Use this instead of a bare `Connection::open` from commands that work off the
/// pooled connection (e.g. inside `spawn_blocking`): `db_path_for` only
/// computes a path, so a profile that has never been opened through
/// `get_for` would otherwise be missing recently-added columns.
///
/// `kind` must be [`IndexKind::of`] the same `assistant_id` the path was computed
/// from — it decides whether a failed open may delete the directory. Getting it
/// wrong on an imported index destroys the only copy of somebody's shared
/// knowledge; see [`IndexKind`].
pub fn open_migrated_db(db_path: &std::path::Path, kind: IndexKind) -> Result<Connection, String> {
    open_or_recreate_db(db_path, kind)
}

/// How long an open waits for another connection to let go of the write lock.
///
/// rusqlite applies five seconds of its own; it is written out here because the
/// recovery policy below now turns on this timeout. "Busy" only means "still busy
/// after we waited", and how long we waited is part of that sentence — so it is
/// stated where the policy can be read, not left in a dependency's source.
#[cfg(not(test))]
const OPEN_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// Long enough to prove a writer was waited for, short enough that the test
/// holding the lock does not cost five seconds of the suite.
#[cfg(test)]
const OPEN_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

/// Why an open failed — and therefore what may be done to the files.
///
/// This distinction is the whole reason the type exists. Below, one branch calls
/// `remove_dir_all` on the index directory. That is sound recovery for a database
/// this app can rebuild from `kety/captures/`, and it is destruction for a
/// database that was merely locked for a moment by another connection. Before the
/// split, both arrived at that branch as the same `String`.
///
/// It matters more now than it did: the background loop opens this database every
/// fifteen seconds for the life of the process, while a pooled connection is open
/// on the same file. Anything with a per-open probability of hitting the
/// destructive branch is no longer a risk, it is a schedule.
enum OpenFailure {
    /// Another connection held the write lock for longer than [`OPEN_BUSY_TIMEOUT`].
    /// The database is intact; there is nothing to recover from and nothing to
    /// delete. Backing off is the fix, and for the loop backing off is free — the
    /// next tick is the retry.
    Busy(String),
    /// The file cannot be used as this app's index: not a database, corrupt pages,
    /// or a schema this binary no longer understands. For the profile's own index
    /// this is the case delete-and-rebuild exists for.
    Unusable(String),
}

impl OpenFailure {
    /// Sort a rusqlite error into the two cases.
    ///
    /// Transient is deliberately a short, closed list: `SQLITE_BUSY` and
    /// `SQLITE_LOCKED` are the codes that mean "the database is fine, someone else
    /// is holding it". Everything else keeps the pre-existing behaviour of
    /// recreating, which the stale-schema check depends on — that one fails with a
    /// plain `SQLITE_ERROR` and *must* still rebuild. Widening the transient list
    /// beyond lock contention would quietly turn off recovery for the failures it
    /// was written for.
    fn classify(context: &str, e: &rusqlite::Error) -> Self {
        let text = format!("{context}: {e}");
        let locked = matches!(
            e,
            rusqlite::Error::SqliteFailure(f, _)
                if matches!(
                    f.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                )
        );
        if locked { Self::Busy(text) } else { Self::Unusable(text) }
    }
}

/// Whether this database has a capture waiting to be indexed — asked without
/// paying for a full open.
///
/// "Waiting" is `'pending'` **or** `'indexing'`. A row is only left in `'indexing'`
/// when the app stopped mid-pass, and the reset that rescues it lives in `init_db`
/// — i.e. behind the full open this peek exists to skip. Counting only `'pending'`
/// here would mean a crashed pass whose last pending row was the one in flight
/// answers `Some(false)` forever, the full open never happens, the reset never
/// runs, and that capture is never indexed again.
///
/// `open_migrated_db` is not cheap: `init_db` drops `chunks_fts` and its shadow
/// tables and re-inserts every row of `chunks` one statement at a time, then
/// `stat`s every capture that has a local path. That is the right price for a real
/// open and the wrong price for finding out there is nothing to do, which is what
/// the background loop finds out every fifteen seconds for the life of the process.
///
/// `None` means "cannot tell from here" — no file yet, a schema older than the
/// `index_state` column, a read that failed. The caller must then take the full
/// path, which is the one that can answer properly. Never `Some(false)` on a
/// doubt: a false negative here is a capture that never gets indexed.
pub fn any_capture_pending(db_path: &std::path::Path) -> Option<bool> {
    // READ_WRITE without CREATE: a peek must never bring a database into
    // existence, and must never be the thing that decides the schema. Read-only
    // would be truer to the intent but is the wrong flag on a WAL database —
    // a reader still needs to create the `-shm` file when no other connection has,
    // so `SQLITE_OPEN_READ_ONLY` would fail on exactly the idle app this exists for.
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
        | rusqlite::OpenFlags::SQLITE_OPEN_URI
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(db_path, flags).ok()?;
    // A peek that blocks is worse than a peek that gives up: the caller's fallback
    // is the full open, which waits properly.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM captures WHERE index_state IN ('pending','indexing'))",
        [],
        |r| r.get::<_, i64>(0),
    )
    .ok()
    .map(|found| found != 0)
}

fn open_or_recreate_db(db_path: &std::path::Path, kind: IndexKind) -> Result<Connection, String> {
    eprintln!("[db] opening DB at {}", db_path.display());
    let try_open = || -> Result<Connection, OpenFailure> {
        let conn = Connection::open(db_path)
            .map_err(|e| OpenFailure::classify("open", &e))?;
        let _ = conn.busy_timeout(OPEN_BUSY_TIMEOUT);
        init_db(&conn, kind).map_err(|e| OpenFailure::classify("init", &e))?;
        // Verify critical columns exist (guards against stale schema from old binary).
        conn.execute_batch(
            "SELECT size_kb, size_media_kb, process_doc_index_doc, index_meet_raw_transcript \
             FROM captures WHERE 0;"
        ).map_err(|e| OpenFailure::classify("captures schema stale — will recreate DB", &e))?;
        // Write probe: INSERT+DELETE on meta (no FTS5 triggers — safe to roll back).
        // NOTE: SAVEPOINT+INSERT+ROLLBACK on captures corrupts FTS5 internal state and must
        //       NOT be used here. The FTS5 integrity-check catches index-level corruption.
        //       Corruption that slips past these two checks is handled by force_recreate_for
        //       in local_save_capture_cmd if the first real save fails.
        //
        // This is also the most likely place to meet a lock: it is the first write
        // of the open, and the pooled connection may be mid-save on the same file.
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('__probe__', '1')", [])
            .map_err(|e| OpenFailure::classify("write probe failed", &e))?;
        let _ = conn.execute("DELETE FROM meta WHERE key='__probe__'", []);
        Ok(conn)
    };
    match try_open() {
        Ok(conn) => {
            eprintln!("[db] DB opened OK at {}", db_path.display());
            Ok(conn)
        },
        Err(OpenFailure::Busy(e)) => {
            // Before the split this fell through to the branch below and deleted the
            // user's index because somebody else was writing to it. Nothing here is
            // broken, so nothing here gets recreated: report it and let the caller
            // come back. The auto-index loop's next tick is fifteen seconds away.
            eprintln!(
                "[db] index is in use ({e}) at {} — left untouched, will retry",
                db_path.display()
            );
            Err(index_busy_message())
        }
        Err(OpenFailure::Unusable(e)) if kind.is_imported() => {
            // The whole asymmetry, at the one line that would have done the damage.
            // Below this branch is `remove_dir_all` on the directory holding the
            // imported `index.db` and its `artefacts/` — the only copy of what
            // somebody shared. Recreating gives back a blank database under a tab
            // that still says N captures, with nothing on screen. Stop here, leave
            // every byte where it is, and say so.
            eprintln!(
                "[db] imported index will not open ({e}) at {} — left untouched, NOT recreated",
                db_path.display()
            );
            Err(unreadable_shared_index_message())
        }
        Err(OpenFailure::Unusable(e)) => {
            eprintln!("[db] DB corrupted/stale ({e}) at {}, recreating…", db_path.display());
            // Nuke the entire user index directory.
            // Deleting files individually is unreliable: remove_file on the WAL/SHM can silently
            // fail (OS lock still held during sqlite3_close's internal checkpoint), leaving a
            // stale WAL on disk. When the new empty DB is opened, SQLite finds the orphaned WAL
            // and replays its (corrupted) frames into the fresh DB — causing the same malformed
            // error on the very first write. remove_dir_all eliminates all sidecar files atomically.
            let index_dir = db_path.parent()
                .ok_or_else(|| "recovery: cannot get index dir".to_string())?;
            match std::fs::remove_dir_all(index_dir) {
                Ok(()) => eprintln!("[db] recovery: cleared index dir {}", index_dir.display()),
                Err(e) => eprintln!("[db] recovery: WARNING could not clear index dir: {e}"),
            }
            std::fs::create_dir_all(index_dir)
                .map_err(|e| format!("recovery: mkdir failed: {e}"))?;
            let conn = Connection::open(db_path)
                .map_err(|e| { eprintln!("[db] recovery open failed: {e}"); e.to_string() })?;
            init_db(&conn, kind)
                .map_err(|e| { eprintln!("[db] recovery init_db failed: {e}"); e.to_string() })?;
            // Write probe — same safe probes as try_open (no SAVEPOINT/captures INSERT).
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('__probe__', '1')", [])
                .map_err(|e| format!("recovery write probe failed ({e})"))?;
            let _ = conn.execute("DELETE FROM meta WHERE key='__probe__'", []);
            eprintln!("[db] recovery done");
            Ok(conn)
        }
    }
}

/// Create the base tables/indexes of a local index database.
///
/// Shared by `init_db` (the normal profile DB path) and by the export builder in
/// `index_export.rs`, so an exported index is byte-for-byte schema-compatible with
/// one the app creates itself. Never let the two drift apart: an exported file is
/// opened by the ordinary index-opening code on the recipient's machine.
///
/// Note: the `chunks_fts` virtual table is NOT created here — `init_db` drops and
/// rebuilds it on every open, so it has its own lifecycle.
pub fn create_schema(conn: &Connection) -> Result<(), String> {
    create_schema_inner(conn).map_err(|e| e.to_string())
}

fn create_schema_inner(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        -- Columns named, never positional. This statement also runs against
        -- databases this app did not create: an imported archive is validated on
        -- *presence* of the canonical schema, so its meta table may legitimately
        -- carry a column of its own -- and INSERT INTO meta VALUES (a, b) against
        -- a three-column table is a hard error (3 columns but 2 values supplied),
        -- failing the open of an index nothing can rebuild.
        INSERT OR IGNORE INTO meta (key, value) VALUES ('active_embed_model', '');
        INSERT OR IGNORE INTO meta (key, value) VALUES ('active_embed_dim',   '0');

        CREATE TABLE IF NOT EXISTS captures (
            id                        TEXT PRIMARY KEY,
            user_id                   TEXT,
            raw_text                  TEXT,
            explanation               TEXT,
            title                     TEXT,
            kind                      TEXT NOT NULL,
            sub_kind                  TEXT,
            local_path                TEXT,
            tag_ids                   TEXT,
            sensitive_state           TEXT NOT NULL DEFAULT 'normal',
            created_at                TEXT,
            indexed_at                TEXT,
            index_state               TEXT NOT NULL DEFAULT 'pending',
            index_error               TEXT,
            meta                      TEXT,
            raw_content               TEXT,
            app_name                  TEXT,
            window_name               TEXT,
            size_kb                   INTEGER,
            size_media_kb             INTEGER,
            process_doc_index_doc     INTEGER,
            index_meet_raw_transcript INTEGER,
            kety_server_path          TEXT
        );

        CREATE TABLE IF NOT EXISTS chunks (
            id          TEXT PRIMARY KEY,
            capture_id  TEXT    NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
            seq         INTEGER NOT NULL,
            chunk_text  TEXT    NOT NULL,
            chunk_type  TEXT,
            overlap_before TEXT,
            overlap_after  TEXT
        );

        -- One row per (chunk × embed_model). Vector stored as little-endian f32 blob.
        CREATE TABLE IF NOT EXISTS chunk_embeddings (
            id          TEXT    PRIMARY KEY,
            chunk_id    TEXT    NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
            embed_model TEXT    NOT NULL,
            embed_dim   INTEGER NOT NULL,
            embedding   BLOB    NOT NULL,
            created_at  TEXT    NOT NULL,
            status      TEXT    NOT NULL DEFAULT 'ok',
            error_msg   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cemb_model ON chunk_embeddings(embed_model);
        CREATE INDEX IF NOT EXISTS idx_cemb_chunk  ON chunk_embeddings(chunk_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cemb_chunk_model ON chunk_embeddings(chunk_id, embed_model);

        CREATE TABLE IF NOT EXISTS tags (
            id               TEXT PRIMARY KEY,
            user_id          TEXT,
            name             TEXT NOT NULL,
            description      TEXT NOT NULL DEFAULT '',
            color            TEXT NOT NULL DEFAULT '#6366f1',
            auto_assign_apps TEXT NOT NULL DEFAULT '[]',
            created_at       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS share_links (
            id                TEXT PRIMARY KEY,
            blob_key          TEXT NOT NULL,
            download_filename TEXT NOT NULL,
            signed_url        TEXT NOT NULL,
            expires_at        TEXT NOT NULL,
            revoked_at        TEXT,
            created_at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_share_links_created_at ON share_links(created_at);

        CREATE INDEX IF NOT EXISTS idx_captures_user_id ON captures(user_id);
        CREATE INDEX IF NOT EXISTS idx_captures_index_state ON captures(index_state);
        CREATE INDEX IF NOT EXISTS idx_tags_user_id     ON tags(user_id);

    ")?;
    Ok(())
}

/// Bring an open database up to the current schema, then run the startup backfills.
///
/// `kind` is not decoration. One of the backfills below reads the filesystem at
/// paths taken from the database, which is fine for a database only this app has
/// ever written and is not fine for one that arrived from somebody else — see the
/// backfill's own comment.
pub fn init_db(conn: &Connection, kind: IndexKind) -> Result<(), rusqlite::Error> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=100;")?;
    create_schema_inner(conn)?;

    // Migrate: add kety_server_path (GCS URL) column to captures.
    let _ = conn.execute_batch("ALTER TABLE captures ADD COLUMN kety_server_path TEXT;");
    // Migrate: per-capture indexing state (added 2026-09).
    let _ = conn.execute_batch(
        "ALTER TABLE captures ADD COLUMN index_state TEXT NOT NULL DEFAULT 'pending';",
    );
    let _ = conn.execute_batch("ALTER TABLE captures ADD COLUMN index_error TEXT;");
    let _ =
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_captures_index_state ON captures(index_state);");
    // Crash recovery, before the backfill below and for the same reason it is here:
    // this runs on every open, which is the only moment nothing can be mid-pass on
    // this connection. See `reset_stale_indexing`.
    let _ = reset_stale_indexing(conn);
    // Backfill: a capture that already has at least one embedding is already indexed.
    let _ = conn.execute_batch(
        "UPDATE captures SET index_state='indexed' \
         WHERE index_state='pending' AND EXISTS ( \
           SELECT 1 FROM chunks ch \
           JOIN chunk_embeddings ce ON ce.chunk_id=ch.id \
           WHERE ch.capture_id=captures.id AND ce.status='ok' \
         );",
    );
    // Drop any leftover size triggers — size_kb is now computed purely in Rust.
    let _ = conn.execute_batch("
        DROP TRIGGER IF EXISTS captures_size_after_insert;
        DROP TRIGGER IF EXISTS captures_size_after_update;
    ");
    // Drop legacy capture-level FTS table — superseded by chunks_fts.
    let _ = conn.execute_batch("DROP TABLE IF EXISTS captures_fts;");
    // Rebuild chunks_fts from scratch on every open (content is reconstructed from chunks table).
    // Correct order:
    //   1. DROP the virtual table (also drops shadow tables when vtable is healthy).
    //   2. Drop shadow tables individually (cleanup for the broken-vtable case where step 1 failed
    //      with "vtable constructor failed" and left the entry in sqlite_master).
    //   3. If the vtable entry is still in sqlite_master after both drops, use writable_schema to
    //      forcibly remove it — otherwise CREATE VIRTUAL TABLE would be a silent no-op.
    //   4. CREATE fresh (no IF NOT EXISTS — we know it is gone at this point).
    let _ = conn.execute_batch("DROP TABLE IF EXISTS chunks_fts;");
    let _ = conn.execute_batch("
        DROP TABLE IF EXISTS chunks_fts_data;
        DROP TABLE IF EXISTS chunks_fts_idx;
        DROP TABLE IF EXISTS chunks_fts_config;
        DROP TABLE IF EXISTS chunks_fts_content;
        DROP TABLE IF EXISTS chunks_fts_docsize;
    ");
    let still_in_schema: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chunks_fts'",
        [],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0;
    if still_in_schema {
        let _ = conn.execute_batch("
            PRAGMA writable_schema = ON;
            DELETE FROM sqlite_master WHERE type='table' AND name LIKE 'chunks_fts%';
            PRAGMA writable_schema = OFF;
        ");
    }
    // Chunk-level FTS5 — rebuilt on every open to stay in sync with chunks table.
    let _ = conn.execute_batch("
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
            chunk_text,
            chunk_type UNINDEXED,
            capture_id UNINDEXED,
            chunk_id UNINDEXED,
            tokenize = 'unicode61'
        );
    ");
    {
        let mut stmt = conn.prepare(
            "SELECT id, chunk_text, chunk_type, capture_id FROM chunks"
        ).unwrap_or_else(|_| conn.prepare("SELECT 0,0,0,0 WHERE 0").unwrap());
        let rows: Vec<(String, String, Option<String>, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .ok()
            .map(|mapped| mapped.filter_map(|r| r.ok()).collect())
            .unwrap_or_default();
        for (chunk_id, chunk_text, chunk_type, capture_id) in &rows {
            let _ = conn.execute(
                "INSERT INTO chunks_fts(chunk_text, chunk_type, capture_id, chunk_id) VALUES (?1,?2,?3,?4)",
                params![chunk_text, chunk_type, capture_id, chunk_id],
            );
        }
    }
    // ── Startup backfill ───────────────────────────────────────────────────────
    // 1. size_media_kb: read file metadata for captures that have a local_path but no size yet.
    //    Doing this from Rust since SQL cannot access the filesystem.
    //
    //    **Own index only.** `local_path` is a value out of the database, and in an
    //    imported one every value came from whoever built the archive. The import
    //    rewrites `user_id` and prunes `tag_ids` and touches nothing else, so a
    //    hostile archive can put `../../../../Users/victim/Documents/secret.pdf`
    //    here and have the app `stat` it on the first open. Today that is a lookup
    //    and not a read, and the size lands in a column no imported view shows — but
    //    it is the app walking the user's filesystem on a stranger's instructions,
    //    and it becomes a leak the day anyone displays a size or adds a re-export.
    //    It also has no purpose here: an imported capture's media lives in the
    //    assistant's own `artefacts/`, never at the path the sender wrote.
    if !kind.is_imported() {
        let rows_needing_media: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, local_path FROM captures
                 WHERE size_media_kb IS NULL AND local_path IS NOT NULL"
            ).unwrap_or_else(|_| conn.prepare("SELECT 0,0 WHERE 0").unwrap());
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
        };
        for (id, path) in &rows_needing_media {
            if let Ok(meta) = std::fs::metadata(path) {
                let size_bytes = meta.len();
                if size_bytes > 0 {
                    let kb = size_bytes.div_ceil(1024) as i64;
                    let _ = conn.execute(
                        "UPDATE captures SET size_media_kb = ?1 WHERE id = ?2",
                        params![kb, id],
                    );
                }
            }
        }
    }

    // 2. size_kb: text-only captures (no media file) still have null size_kb after step 1.
    //    Fill them directly — no trigger needed since there's no column to change.
    let _ = conn.execute_batch("
        UPDATE captures SET size_kb =
            NULLIF(
                COALESCE(size_media_kb, 0) +
                (COALESCE(LENGTH(raw_text), 0) + COALESCE(LENGTH(explanation), 0) + COALESCE(LENGTH(raw_content), 0) + 1023) / 1024,
                0
            )
        WHERE size_kb IS NULL;
    ");

    Ok(())
}

// ── Chunking ──────────────────────────────────────────────────────────────────

struct ChunkEntry {
    seq: usize,
    chunk_text: String,
    overlap_before: Option<String>,
    overlap_after: Option<String>,
}

/// Split `text` into non-overlapping chunks of `size` chars.
/// Store the `overlap` chars immediately before/after each chunk boundary as
/// `overlap_before` / `overlap_after` so re-embedding never needs to re-read
/// the full source text — just concatenate `overlap_before + chunk_text + overlap_after`.
fn chunk_with_context(text: &str, size: usize, overlap: usize) -> Vec<ChunkEntry> {
    if text.is_empty() { return vec![]; }
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let mut entries = Vec::new();
    let mut start = 0;
    let mut seq = 0usize;
    while start < total {
        let end = (start + size).min(total);
        let chunk_text: String = chars[start..end].iter().collect();
        let overlap_before = if start > 0 && overlap > 0 {
            let ob = start.saturating_sub(overlap);
            Some(chars[ob..start].iter().collect::<String>())
        } else { None };
        let overlap_after = if end < total && overlap > 0 {
            let oa = (end + overlap).min(total);
            Some(chars[end..oa].iter().collect::<String>())
        } else { None };
        entries.push(ChunkEntry { seq, chunk_text, overlap_before, overlap_after });
        seq += 1;
        if end == total { break; }
        start = end;
    }
    entries
}

/// Legacy helper kept for potential future use.
#[allow(dead_code)]
fn chunk_text(text: &str, size: usize, overlap: usize) -> Vec<(usize, String)> {
    chunk_with_context(text, size, overlap)
        .into_iter()
        .map(|e| (e.seq, e.chunk_text))
        .collect()
}

// ── Embedding generation ──────────────────────────────────────────────────────

pub fn embed_via_llama(
    app: &tauri::AppHandle,
    model_filename: &str,
    text: &str,
    threads: u8,
) -> Result<Vec<f32>, String> {
    let embed_bin = crate::local_llm::llama_embedding_path(app);
    if !embed_bin.is_file() {
        return Err(format!(
            "llama-embedding not found at {}. Re-run scripts/setup-llama-cli.sh",
            embed_bin.display()
        ));
    }
    let model_path = crate::kety_paths::embed_model_for(app, model_filename);
    if !model_path.is_file() {
        return Err(format!("Embed model not found: {}. Download in Settings.", model_path.display()));
    }
    let prompt_filename = format!("embed_prompt_{}.txt", uuid::Uuid::new_v4().simple());
    let prompt_path = crate::kety_paths::local_index_dir(app)
        .map(|d| d.join(&prompt_filename))
        .unwrap_or_else(|_| std::path::PathBuf::from(&prompt_filename));
    std::fs::write(&prompt_path, text.as_bytes()).map_err(|e| format!("write embed prompt: {e}"))?;

    let threads_str = threads.to_string();
    let output = std::process::Command::new(embed_bin.to_str().ok_or("embed bin path")?)
        .args([
            "-m", model_path.to_str().ok_or("model path")?,
            "-f", prompt_path.to_str().ok_or("prompt path")?,
            "-t", &threads_str,
            "--embd-output-format", "array",
        ])
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("llama-embedding: {e}"))?;

    let _ = std::fs::remove_file(&prompt_path);
    if !output.status.success() {
        return Err(format!("llama-embedding exited with status {}", output.status));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output is [[f32, f32, ...]] — one outer array, one inner array per input sequence.
    let outer: Vec<Vec<f32>> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("llama-embedding JSON parse: {e}. raw: {}", &stdout[..stdout.len().min(200)]))?;
    outer.into_iter().next().ok_or_else(|| "llama-embedding returned empty array".to_string())
}


pub fn embed_via_openai(api_key: &str, text: &str) -> Result<Vec<f32>, String> {
    let payload = serde_json::json!({ "model": "text-embedding-3-small", "input": text });
    let response = ureq::post("https://api.openai.com/v1/embeddings")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| format!("OpenAI embeddings: {e}"))?;
    let parsed: serde_json::Value = response.into_json().map_err(|e| format!("embed parse: {e}"))?;
    let values: Vec<f32> = parsed
        .get("data").and_then(|d| d.as_array()).and_then(|a| a.first())
        .and_then(|i| i.get("embedding")).and_then(|v| v.as_array())
        .ok_or("missing data[0].embedding")?
        .iter().filter_map(|v| v.as_f64().map(|f| f as f32)).collect();
    if values.is_empty() { return Err("Empty OpenAI embedding".to_string()); }
    Ok(values)
}

// ── Vector (de)serialization ──────────────────────────────────────────────────

fn floats_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn blob_to_floats(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() { return 0.0; }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 { return 0.0; }
    dot / (na * nb)
}

// ── Index a capture ───────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexCaptureRequest {
    pub id: String,
    pub raw_text: Option<String>,
    pub explanation: Option<String>,
    pub title: Option<String>,
    pub kind: String,
    pub local_path: Option<String>,
    pub tag_ids: Option<Vec<String>>,
    pub sensitive_state: Option<String>,
    pub created_at: Option<String>,
    /// "qwen3-embed-0.6b-q8" | "openai:text-embedding-3-small"
    pub embed_model_id: String,
    pub openai_api_key: Option<String>,
}

pub fn index_capture(
    app: &tauri::AppHandle,
    conn: &Connection,
    req: &IndexCaptureRequest,
) -> Result<(), String> {
    let text = req.raw_text.as_deref().unwrap_or("").trim().to_string();
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let dim = resolve_embed_dim(&req.embed_model_id)?;

    let tag_ids_json = req.tag_ids.as_ref()
        .map(|ids| serde_json::to_string(ids).unwrap_or_default())
        .unwrap_or_default();

    conn.execute(
        "INSERT INTO captures
         (id,raw_text,title,kind,local_path,tag_ids,sensitive_state,created_at,indexed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET
             raw_text       = excluded.raw_text,
             title          = excluded.title,
             kind           = excluded.kind,
             local_path     = excluded.local_path,
             tag_ids        = excluded.tag_ids,
             sensitive_state= excluded.sensitive_state,
             indexed_at     = excluded.indexed_at",
        params![
            req.id,
            if text.is_empty() { None } else { Some(&text) },
            req.title, req.kind, req.local_path,
            if tag_ids_json.is_empty() { None } else { Some(&tag_ids_json) },
            req.sensitive_state.as_deref().unwrap_or("normal"),
            req.created_at, now,
        ],
    ).map_err(|e| format!("insert capture: {e}"))?;

    if text.is_empty() { return Ok(()); }

    // Delete old chunks + FTS entries for this capture before re-indexing
    let _ = conn.execute("DELETE FROM chunks_fts WHERE capture_id = ?1", params![req.id]);
    conn.execute("DELETE FROM chunks WHERE capture_id = ?1", params![req.id])
        .map_err(|e| format!("delete old chunks: {e}"))?;

    let sources: &[(&str, &str)] = &[
        ("raw_text",    text.as_str()),
        ("explanation", req.explanation.as_deref().unwrap_or("")),
    ];
    for (chunk_type, src) in sources {
        if src.is_empty() { continue; }
        for entry in chunk_with_context(src, chunk_size(), chunk_overlap()) {
            let to_embed = {
                let ctx = format!(
                    "{}{}{}",
                    entry.overlap_before.as_deref().unwrap_or(""),
                    entry.chunk_text,
                    entry.overlap_after.as_deref().unwrap_or(""),
                );
                match &req.title {
                    Some(t) if !t.is_empty() => format!("title: {} | {}: {}", t, chunk_type, ctx),
                    _ => ctx,
                }
            };

            let chunk_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO chunks(id,capture_id,seq,chunk_text,chunk_type,overlap_before,overlap_after) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![chunk_id, req.id, entry.seq, entry.chunk_text, chunk_type,
                        entry.overlap_before, entry.overlap_after],
            ).map_err(|e| format!("insert chunk: {e}"))?;
            let _ = conn.execute(
                "INSERT INTO chunks_fts(chunk_text, chunk_type, capture_id, chunk_id) VALUES (?1,?2,?3,?4)",
                params![entry.chunk_text, chunk_type, req.id, chunk_id],
            );

            let embedding = if req.embed_model_id.starts_with("openai:") {
                let key = req.openai_api_key.as_deref().filter(|k| !k.is_empty())
                    .ok_or("OpenAI API key required for OpenAI embeddings")?;
                embed_via_openai(key, &to_embed)?
            } else {
                let info = crate::embed_setup::model_by_id(&req.embed_model_id)
                    .ok_or_else(|| format!("Unknown embed model: {}", req.embed_model_id))?;
                embed_via_llama(app, info.filename, &to_embed, 4)?
            };

            if embedding.len() as u32 != dim {
                return Err(format!("Dim mismatch: expected {dim}, got {}. Wrong model?", embedding.len()));
            }
            let blob = floats_to_blob(&embedding);
            conn.execute(
                "INSERT INTO chunk_embeddings(id,chunk_id,embed_model,embed_dim,embedding,status,created_at) \
                 VALUES (?1,?2,?3,?4,?5,'ok',?6) \
                 ON CONFLICT(chunk_id,embed_model) DO UPDATE SET embedding=excluded.embedding, status='ok', error_msg=NULL",
                params![uuid::Uuid::new_v4().to_string(), chunk_id, req.embed_model_id, dim, blob, now],
            ).map_err(|e| format!("insert chunk_embedding: {e}"))?;
        }
    }
    Ok(())
}

pub fn resolve_embed_dim(model_id: &str) -> Result<u32, String> {
    if model_id.starts_with("openai:") { return Ok(crate::embed_setup::OPENAI_EMBED_DIM); }
    crate::embed_setup::model_by_id(model_id)
        .map(|m| m.dim)
        .ok_or_else(|| format!("Unknown embed model: {model_id}"))
}

/// Outcome of one `embed_missing_for_model` sweep.
///
/// `attempted` is what the caller must loop on: it is 0 only when there is
/// genuinely nothing left to try. `succeeded` alone cannot distinguish "finished"
/// from "every single chunk failed", which is exactly the case that used to make
/// the UI go quiet while filling the index with error rows.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmbedMissingResult {
    /// Chunks picked up by this sweep (successes + failures).
    pub attempted: usize,
    /// Chunks that got a usable vector written.
    pub succeeded: usize,
    /// Message from the last failure in this sweep, if any.
    pub last_error: Option<String>,
}

/// Embed up to `limit` chunks that have no usable embedding for `embed_model`.
/// Purely additive: chunks are never deleted and other models' vectors are left
/// untouched, so switching a assistant back to a previous model costs nothing.
/// Re-running it is safe — it only ever fills in what is missing.
/// A per-chunk embedding failure is recorded on that row (status='error') and the
/// sweep continues; it does not abort the call or lose already-completed work, so
/// running it repeatedly makes steady progress even if some chunks keep failing.
/// Error-marked chunks are deliberately NOT retried by later sweeps — an automatic
/// retry would re-spend OpenAI credits on every pass. Retrying is an explicit user
/// action, served by `clear_error_embeddings_for_model`.
/// `Err` is reserved for whole-call preconditions (unknown model, missing key).
pub fn embed_missing_for_model(
    app: &tauri::AppHandle,
    conn: &Connection,
    embed_model: &str,
    openai_api_key: Option<&str>,
    limit: usize,
) -> Result<EmbedMissingResult, String> {
    if embed_model.is_empty() {
        return Ok(EmbedMissingResult::default());
    }
    let dim = resolve_embed_dim(embed_model)?;
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    // The OpenAI key requirement is a precondition for the whole call, not a
    // per-row concern, so check it once up front rather than inside the loop.
    if embed_model.starts_with("openai:") {
        openai_api_key.filter(|k| !k.is_empty())
            .ok_or("OpenAI API key required for OpenAI embeddings")?;
    }

    struct Pending { chunk_id: String, chunk_text: String, chunk_type: Option<String>,
                     overlap_before: Option<String>, overlap_after: Option<String>,
                     title: Option<String> }

    let rows: Vec<Pending> = {
        let mut stmt = conn.prepare(
            "SELECT ch.id, ch.chunk_text, ch.chunk_type, ch.overlap_before, ch.overlap_after, cap.title \
             FROM chunks ch \
             JOIN captures cap ON cap.id = ch.capture_id \
             WHERE NOT EXISTS ( \
               SELECT 1 FROM chunk_embeddings ce \
               WHERE ce.chunk_id = ch.id AND ce.embed_model = ?1 \
             ) \
             ORDER BY ch.id \
             LIMIT ?2",
        ).map_err(|e| format!("select missing: {e}"))?;
        let mapped = stmt.query_map(params![embed_model, limit as i64], |r| {
            Ok(Pending {
                chunk_id: r.get(0)?, chunk_text: r.get(1)?, chunk_type: r.get(2)?,
                overlap_before: r.get(3)?, overlap_after: r.get(4)?, title: r.get(5)?,
            })
        }).map_err(|e| format!("select missing: {e}"))?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    let mut out = EmbedMissingResult { attempted: rows.len(), succeeded: 0, last_error: None };
    for row in rows {
        // Rebuild the embedded text exactly as index_capture does, so vectors from
        // the two paths are comparable.
        let ctx = format!(
            "{}{}{}",
            row.overlap_before.as_deref().unwrap_or(""),
            row.chunk_text,
            row.overlap_after.as_deref().unwrap_or(""),
        );
        let chunk_type = row.chunk_type.as_deref().unwrap_or("raw_text");
        let to_embed = match row.title.as_deref() {
            Some(t) if !t.is_empty() => format!("title: {} | {}: {}", t, chunk_type, ctx),
            _ => ctx,
        };

        let embed_result = if embed_model.starts_with("openai:") {
            // Key presence was already validated before the loop.
            let key = openai_api_key.filter(|k| !k.is_empty()).unwrap_or_default();
            embed_via_openai(key, &to_embed)
        } else {
            match crate::embed_setup::model_by_id(embed_model) {
                Some(info) => embed_via_llama(app, info.filename, &to_embed, 4),
                None => Err(format!("Unknown embed model: {embed_model}")),
            }
        };
        let embed_result = embed_result.and_then(|e| {
            if e.len() as u32 == dim { Ok(e) }
            else { Err(format!("Dim mismatch: expected {dim}, got {}. Wrong model?", e.len())) }
        });

        let embedding = match embed_result {
            Ok(e) => e,
            Err(msg) => {
                // Record the failure on the row and move on: a single bad chunk
                // must never block the rest of the sweep or lose prior progress.
                eprintln!("[embed-worker] chunk={} failed: {msg}", row.chunk_id);
                conn.execute(
                    "INSERT INTO chunk_embeddings(id,chunk_id,embed_model,embed_dim,embedding,status,error_msg,created_at) \
                     VALUES (?1,?2,?3,?4,?5,'error',?6,?7) \
                     ON CONFLICT(chunk_id,embed_model) DO UPDATE SET status='error', error_msg=excluded.error_msg",
                    params![uuid::Uuid::new_v4().to_string(), row.chunk_id, embed_model, dim, Vec::<u8>::new(), &msg, now],
                ).map_err(|e| format!("insert chunk_embedding: {e}"))?;
                out.last_error = Some(msg);
                continue;
            }
        };
        conn.execute(
            "INSERT INTO chunk_embeddings(id,chunk_id,embed_model,embed_dim,embedding,status,created_at) \
             VALUES (?1,?2,?3,?4,?5,'ok',?6) \
             ON CONFLICT(chunk_id,embed_model) DO UPDATE SET embedding=excluded.embedding, status='ok', error_msg=NULL",
            params![uuid::Uuid::new_v4().to_string(), row.chunk_id, embed_model, dim, floats_to_blob(&embedding), now],
        ).map_err(|e| format!("insert chunk_embedding: {e}"))?;
        out.succeeded += 1;
    }
    Ok(out)
}

/// Drop the error-marked `chunk_embeddings` rows for one model so the next sweep
/// picks those chunks up again.
///
/// Additive with respect to everything that matters: it removes no chunk, no
/// 'ok' vector, and nothing belonging to another model — only this model's
/// failure markers. This is the single deletion path allowed alongside
/// `embed_missing_for_model`, and it exists so retrying stays an explicit user
/// choice rather than an automatic cost on every sweep.
pub fn clear_error_embeddings_for_model(conn: &Connection, embed_model: &str) -> Result<usize, String> {
    if embed_model.is_empty() {
        return Ok(0);
    }
    conn.execute(
        "DELETE FROM chunk_embeddings WHERE embed_model = ?1 AND status = 'error'",
        params![embed_model],
    )
    .map_err(|e| format!("clear_error_embeddings_for_model: {e}"))
}

// ── State management ──────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalCaptureRow {
    pub id: String,
    pub user_id: Option<String>,
    pub raw_text: Option<String>,
    pub explanation: Option<String>,
    pub title: Option<String>,
    pub kind: String,
    pub sub_kind: Option<String>,
    pub local_path: Option<String>,
    pub tag_ids: Option<String>,
    pub sensitive_state: String,
    pub created_at: Option<String>,
    pub meta: Option<String>,
    pub raw_content: Option<String>, // JSON array of strings
    pub app_name: Option<String>,
    pub window_name: Option<String>,
    pub size_kb: Option<i64>,
    pub size_media_kb: Option<i64>,
    pub process_doc_index_doc: Option<bool>,
    pub index_meet_raw_transcript: Option<bool>,
    pub kety_server_path: Option<String>,
    pub index_state: String,
    pub index_error: Option<String>,
}

pub fn save_capture(
    conn: &Connection,
    id: &str,
    user_id: Option<&str>,
    raw_text: Option<&str>,
    explanation: Option<&str>,
    title: Option<&str>,
    kind: &str,
    sub_kind: Option<&str>,
    local_path: Option<&str>,
    tag_ids_json: Option<&str>,
    sensitive_state: &str,
    created_at: Option<&str>,
    meta: Option<&str>,
    raw_content: Option<&str>,
    app_name: Option<&str>,
    window_name: Option<&str>,
    _frontend_size_kb: Option<i64>,
    process_doc_index_doc: Option<bool>,
    index_meet_raw_transcript: Option<bool>,
    kety_server_path: Option<&str>,
) -> Result<(), String> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let text_stored = raw_text.filter(|t| !t.trim().is_empty());
    // Prefer meta.fileSize; fall back to reading the file on disk (screenshot payload
    // doesn't always include fileSize when the event fires before the write completes).
    let size_media_kb: Option<i64> = meta
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .and_then(|v| v.get("fileSize").and_then(|f| f.as_f64()))
        .filter(|&b| b > 0.0)
        .map(|b| ((b as u64 + 1023) / 1024) as i64)
        .or_else(|| {
            local_path
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|m| ((m.len() + 1023) / 1024) as i64)
                .filter(|&kb| kb > 0)
        });
    let text_bytes = raw_text.map(|s| s.len()).unwrap_or(0)
        + explanation.map(|s| s.len()).unwrap_or(0)
        + raw_content.map(|s| s.len()).unwrap_or(0);
    let media_kb_val = size_media_kb.unwrap_or(0);
    let text_kb_val = ((text_bytes + 1023) / 1024) as i64;
    let size_kb: Option<i64> = if media_kb_val + text_kb_val > 0 { Some(media_kb_val + text_kb_val) } else { None };
    eprintln!("[db:save_capture] id={id} kind={kind} raw_text_len={} text_bytes={text_bytes} size_media_kb={size_media_kb:?} size_kb={size_kb:?}",
        raw_text.map(|s| s.len()).unwrap_or(0));
    // Detect a text change on an already-indexed capture so we can re-index it.
    // 'excluded' is deliberately left alone: the user removed this from the
    // assistant, and editing it must not silently bring it back.
    let prior: Option<(Option<String>, Option<String>, Option<String>, String)> = conn
        .query_row(
            "SELECT raw_text, explanation, raw_content, index_state FROM captures WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();
    let text_changed = match &prior {
        Some((p_raw, p_expl, p_content, _)) => {
            // Mirror the UPSERT below: raw_text and explanation are overwritten
            // unconditionally, but raw_content is COALESCEd, so passing None leaves
            // the stored value in place and must not count as a change.
            let effective_content = raw_content.or(p_content.as_deref());
            p_raw.as_deref() != text_stored
                || p_expl.as_deref() != explanation
                || p_content.as_deref() != effective_content
        }
        None => false,
    };
    let prior_state = prior.as_ref().map(|p| p.3.clone());
    let result = conn.execute(
        "INSERT INTO captures(id,user_id,raw_text,explanation,title,kind,sub_kind,local_path,tag_ids,sensitive_state,created_at,indexed_at,meta,raw_content,app_name,window_name,size_media_kb,size_kb,process_doc_index_doc,index_meet_raw_transcript,kety_server_path)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
         ON CONFLICT(id) DO UPDATE SET
           user_id                  = COALESCE(excluded.user_id, user_id),
           raw_text                 = excluded.raw_text,
           explanation              = excluded.explanation,
           title                    = excluded.title,
           kind                     = excluded.kind,
           sub_kind                 = excluded.sub_kind,
           local_path               = excluded.local_path,
           tag_ids                  = excluded.tag_ids,
           sensitive_state          = excluded.sensitive_state,
           meta                     = excluded.meta,
           raw_content              = COALESCE(excluded.raw_content, raw_content),
           app_name                 = COALESCE(excluded.app_name, app_name),
           window_name              = COALESCE(excluded.window_name, window_name),
           size_media_kb            = COALESCE(excluded.size_media_kb, captures.size_media_kb),
           size_kb                  = COALESCE(excluded.size_kb, captures.size_kb),
           process_doc_index_doc    = COALESCE(excluded.process_doc_index_doc, process_doc_index_doc),
           index_meet_raw_transcript = COALESCE(excluded.index_meet_raw_transcript, index_meet_raw_transcript),
           kety_server_path         = COALESCE(excluded.kety_server_path, kety_server_path)",
        params![id, user_id, text_stored, explanation, title, kind, sub_kind, local_path, tag_ids_json, sensitive_state, created_at, now, meta, raw_content, app_name, window_name, size_media_kb, size_kb, process_doc_index_doc, index_meet_raw_transcript, kety_server_path],
    ).map_err(|e| {
        if let rusqlite::Error::SqliteFailure(ref sf, _) = e {
            eprintln!("[db:save_capture] SQLite error code={} extended={}", sf.code as i32, sf.extended_code);
        }
        format!("save_capture: {e}")
    });
    match &result {
        Ok(rows) => {
            let stored: (Option<i64>, Option<i64>) = conn.query_row(
                "SELECT size_kb, size_media_kb FROM captures WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?))
            ).unwrap_or((None, None));
            eprintln!("[db:save_capture] OK id={id} rows={rows} | STORED size_kb={:?} size_media_kb={:?}", stored.0, stored.1);
        },
        Err(e) => eprintln!("[db:save_capture] FAIL id={id} err={e}"),
    }
    result?;
    // A new capture (no prior row) starts 'pending' via the column default and is
    // picked up by the worker. An edited, already-indexed capture goes back to
    // 'pending' so the worker re-embeds the new text. Editing one the worker is on
    // right now ('indexing') does the same and is not a race: `finish_index_state`
    // refuses to record an outcome over a state somebody else has since written, so
    // the in-flight pass ends without a trace and the next one re-reads the new text.
    if text_changed && prior_state.as_deref() != Some("excluded") {
        clear_capture_chunks(conn, id)?;
        set_index_state(conn, id, "pending", None)?;
    }
    Ok(())
}

pub fn list_captures_for_user(conn: &Connection, user_id: &str) -> Result<Vec<LocalCaptureRow>, String> {
    let mut stmt = conn.prepare(
        "SELECT id,user_id,raw_text,explanation,title,kind,sub_kind,local_path,tag_ids,sensitive_state,created_at,meta,raw_content,app_name,window_name,size_kb,process_doc_index_doc,index_meet_raw_transcript,size_media_kb,kety_server_path,index_state,index_error
         FROM captures
         WHERE (user_id IS NULL OR user_id = ?1)
         ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![user_id], |r| {
        Ok(LocalCaptureRow {
            id: r.get(0)?,
            user_id: r.get(1)?,
            raw_text: r.get(2)?,
            explanation: r.get(3)?,
            title: r.get(4)?,
            kind: r.get(5)?,
            sub_kind: r.get(6)?,
            local_path: r.get(7)?,
            tag_ids: r.get(8)?,
            sensitive_state: r.get::<_, Option<String>>(9)?.unwrap_or_else(|| "normal".to_string()),
            created_at: r.get(10)?,
            meta: r.get(11)?,
            raw_content: r.get(12)?,
            app_name: r.get(13)?,
            window_name: r.get(14)?,
            size_kb: r.get(15)?,
            process_doc_index_doc: r.get::<_, Option<i64>>(16)?.map(|v| v != 0),
            index_meet_raw_transcript: r.get::<_, Option<i64>>(17)?.map(|v| v != 0),
            size_media_kb: r.get(18)?,
            kety_server_path: r.get(19)?,
            index_state: r.get::<_, Option<String>>(20)?.unwrap_or_else(|| "pending".to_string()),
            index_error: r.get(21)?,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(rows)
}

/// Event carrying one capture's new indexing state to the window, so a row can show
/// "waiting" or "being indexed" without polling for it. See [`emit_index_state`].
pub const INDEX_STATE_EVENT: &str = "kts:index/capture-state";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStateChanged {
    pub capture_id: String,
    pub state: String,
}

/// Tell the window a capture changed indexing state.
///
/// Fired only on a real transition, so an app with nothing to index sends nothing.
/// Best-effort by construction: a window that is not there yet, or is asleep, must
/// never be able to hold up or fail an indexing pass.
fn emit_index_state(app: &tauri::AppHandle, capture_id: &str, state: &str) {
    crate::emit_payload_to_main(
        app,
        INDEX_STATE_EVENT,
        &IndexStateChanged { capture_id: capture_id.to_string(), state: state.to_string() },
    );
}

/// Put back in the queue every capture left mid-pass by an app that stopped.
///
/// `'indexing'` only ever means "a worker is on this one *now*", and a worker only
/// exists inside a running process. So on open, every such row is a leftover: the
/// pass that claimed it will never come back to finish it, and since the worker
/// selects `'pending'` only, leaving it as it is strands that capture — never
/// indexed, never failed, never retried, and with no sign of it anywhere.
///
/// Called from `init_db`, which is the one place that runs on every open. It has to
/// come *before* the "already has embeddings → indexed" backfill: a pass that died
/// after writing a capture's vectors but before recording the outcome lands back on
/// `'pending'` here and is then promoted to `'indexed'` there, without re-embedding.
pub fn reset_stale_indexing(conn: &Connection) -> Result<usize, String> {
    let n = conn
        .execute("UPDATE captures SET index_state='pending' WHERE index_state='indexing'", [])
        .map_err(|e| format!("reset_stale_indexing: {e}"))?;
    if n > 0 {
        eprintln!("[index-worker] {n} capture(s) were left mid-index by a previous run — queued again");
    }
    Ok(n)
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStateCounts {
    pub pending: i64,
    /// Claimed by a worker right now. Its own field rather than folded into
    /// `pending`: the row badges tell the two apart, so the pill's arithmetic must
    /// be able to as well. Every caller still has to add it in somewhere, or the
    /// captures in flight drop out of the total and rows silently stop being counted.
    pub indexing: i64,
    pub indexed: i64,
    pub failed: i64,
    pub excluded: i64,
}

/// Set a capture's indexing state. `error` is stored only for the 'failed' state.
pub fn set_index_state(
    conn: &Connection,
    capture_id: &str,
    state: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let indexed_at = if state == "indexed" { Some(now) } else { None };
    conn.execute(
        "UPDATE captures SET index_state=?1, index_error=?2, \
         indexed_at=COALESCE(?3, indexed_at) WHERE id=?4",
        params![state, error, indexed_at, capture_id],
    )
    .map_err(|e| format!("set_index_state: {e}"))?;
    Ok(())
}

/// Record the outcome of a pass on a capture — but only if that capture is still
/// the one this pass claimed.
///
/// Whoever wrote something else over `'indexing'` in the meantime meant it and said
/// it more recently: the user removed the capture from the assistant, or edited its
/// text and put it back in the queue. An unguarded write would undo both, quietly,
/// and the removal is the one that matters — it would come back into the assistant
/// the user took it out of.
///
/// Returns whether the outcome was recorded.
fn finish_index_state(
    conn: &Connection,
    capture_id: &str,
    state: &str,
    error: Option<&str>,
) -> Result<bool, String> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let indexed_at = if state == "indexed" { Some(now) } else { None };
    let rows = conn
        .execute(
            "UPDATE captures SET index_state=?1, index_error=?2, \
             indexed_at=COALESCE(?3, indexed_at) \
             WHERE id=?4 AND index_state='indexing'",
            params![state, error, indexed_at, capture_id],
        )
        .map_err(|e| format!("finish_index_state: {e}"))?;
    Ok(rows > 0)
}

/// Delete a capture's chunks; cascades to chunk_embeddings, and clears the FTS rows.
pub fn clear_capture_chunks(conn: &Connection, capture_id: &str) -> Result<(), String> {
    let _ = conn.execute("DELETE FROM chunks_fts WHERE capture_id = ?1", params![capture_id]);
    conn.execute("DELETE FROM chunks WHERE capture_id = ?1", params![capture_id])
        .map_err(|e| format!("clear_capture_chunks: {e}"))?;
    Ok(())
}

/// Aggregate counts for the global indexing status pill.
pub fn count_index_states(conn: &Connection) -> Result<IndexStateCounts, String> {
    let mut out = IndexStateCounts::default();
    let mut stmt = conn
        .prepare("SELECT index_state, COUNT(*) FROM captures GROUP BY index_state")
        .map_err(|e| format!("count_index_states: {e}"))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| format!("count_index_states: {e}"))?;
    for row in rows.flatten() {
        match row.0.as_str() {
            "pending" => out.pending = row.1,
            "indexing" => out.indexing = row.1,
            "indexed" => out.indexed = row.1,
            "failed" => out.failed = row.1,
            "excluded" => out.excluded = row.1,
            _ => {}
        }
    }
    Ok(out)
}

/// Remove captures from the assistant: drop their chunks and mark them excluded.
/// 'excluded' is sticky — the worker never picks these up again.
pub fn unindex_captures(conn: &Connection, capture_ids: &[String]) -> Result<(), String> {
    for id in capture_ids {
        clear_capture_chunks(conn, id)?;
        set_index_state(conn, id, "excluded", None)?;
    }
    Ok(())
}

/// Put captures back in the queue (undo an unindex, or retry a failure).
pub fn requeue_captures(conn: &Connection, capture_ids: &[String]) -> Result<(), String> {
    for id in capture_ids {
        set_index_state(conn, id, "pending", None)?;
    }
    Ok(())
}

/// The captures a pass may claim. Named so the test that pins it uses the same
/// string the worker does rather than a copy of it that can drift.
///
/// 'excluded' the user removed, 'failed' needs an explicit retry, 'indexed' is done
/// — and 'indexing' belongs to a pass already under way. Only one pass runs at a
/// time today (the embed lock), so that last one is insurance rather than a live
/// race; it is also what stops a pass from re-claiming a capture that a concurrent
/// `init_db` reset out from under it.
const PENDING_CAPTURE_FILTER: &str = "index_state='pending'";

/// Index up to `limit` captures in the 'pending' state. Returns how many succeeded.
/// Never touches 'excluded' (user removed it) or 'failed' (needs explicit retry),
/// and never 'indexing' — that one is claimed by a pass already under way.
///
/// Each capture is marked `'indexing'` for as long as it is being worked on, so the
/// row in the window can say so. The claim is written one capture at a time rather
/// than over the whole batch up front: the point of the state is "right now", and a
/// batch of ten all claiming to be in flight at once would be a lie in nine rows.
pub fn index_pending_captures(
    app: &tauri::AppHandle,
    conn: &Connection,
    embed_model_id: &str,
    openai_api_key: Option<&str>,
    limit: usize,
) -> Result<usize, String> {
    if embed_model_id.is_empty() {
        // No model configured yet: leave everything pending, this is not an error.
        return Ok(0);
    }
    struct Pending {
        id: String,
        raw_text: Option<String>,
        explanation: Option<String>,
        title: Option<String>,
        kind: String,
        local_path: Option<String>,
        tag_ids: Option<String>,
        sensitive_state: Option<String>,
        created_at: Option<String>,
    }
    let rows: Vec<Pending> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, raw_text, explanation, title, kind, local_path, \
                        tag_ids, sensitive_state, created_at \
                 FROM captures WHERE {PENDING_CAPTURE_FILTER} ORDER BY created_at ASC LIMIT ?1",
            ))
            .map_err(|e| format!("select pending: {e}"))?;
        let mapped = stmt
            .query_map(params![limit as i64], |r| {
                Ok(Pending {
                    id: r.get(0)?,
                    raw_text: r.get(1)?,
                    explanation: r.get(2)?,
                    title: r.get(3)?,
                    kind: r.get(4)?,
                    local_path: r.get(5)?,
                    tag_ids: r.get(6)?,
                    sensitive_state: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })
            .map_err(|e| format!("select pending: {e}"))?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    let mut done = 0usize;
    for row in rows {
        // Claim it before the slow part: embedding one capture can take seconds, and
        // this write is what the row's spinner is reading.
        set_index_state(conn, &row.id, "indexing", None)?;
        emit_index_state(app, &row.id, "indexing");
        // index_capture UPSERTs the capture row from the request, so every field it
        // writes must be carried over from the existing row or it would be wiped.
        let tag_ids = row
            .tag_ids
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok());
        let req = IndexCaptureRequest {
            id: row.id.clone(),
            raw_text: row.raw_text,
            explanation: row.explanation,
            title: row.title,
            kind: row.kind,
            local_path: row.local_path,
            tag_ids,
            sensitive_state: row.sensitive_state,
            created_at: row.created_at,
            embed_model_id: embed_model_id.to_string(),
            openai_api_key: openai_api_key.map(|s| s.to_string()),
        };
        let (state, error) = match index_capture(app, conn, &req) {
            Ok(()) => {
                done += 1;
                ("indexed", None)
            }
            Err(e) => {
                eprintln!("[index-worker] capture={} failed: {e}", row.id);
                ("failed", Some(e))
            }
        };
        if finish_index_state(conn, &row.id, state, error.as_deref())? {
            emit_index_state(app, &row.id, state);
        }
    }
    Ok(done)
}

pub fn hard_delete_capture(conn: &Connection, capture_id: &str) -> Result<Option<String>, String> {
    let path: Option<String> = conn.query_row(
        "SELECT local_path FROM captures WHERE id=?1", params![capture_id], |r| r.get(0),
    ).ok().flatten();
    conn.execute("DELETE FROM captures WHERE id=?1", params![capture_id])
        .map_err(|e| format!("delete capture: {e}"))?;
    Ok(path)
}

// ── Stats & reindex detection ─────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalIndexStats {
    pub total_captures: i64,
    pub total_chunks: i64,
    pub captures_missing_embed: i64,
    pub active_embed_model: String,
    pub active_embed_dim: u32,
}

pub fn get_stats(conn: &Connection) -> Result<LocalIndexStats, String> {
    let active_model: String = conn
        .query_row("SELECT value FROM meta WHERE key='active_embed_model'", [], |r| r.get(0))
        .unwrap_or_default();
    let active_dim: u32 = conn
        .query_row("SELECT value FROM meta WHERE key='active_embed_dim'", [], |r| {
            r.get::<_, String>(0).map(|s| s.parse::<u32>().unwrap_or(0))
        })
        .unwrap_or(0);

    let total_captures = conn.query_row("SELECT COUNT(*) FROM captures", [], |r| r.get(0)).unwrap_or(0i64);
    let total_chunks   = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap_or(0i64);

    let captures_missing: i64 = if active_model.is_empty() {
        0
    } else {
        conn.query_row(
            "SELECT COUNT(DISTINCT cap.id) FROM chunks ch
             JOIN captures cap ON cap.id=ch.capture_id
             WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings ce
                               WHERE ce.chunk_id=ch.id AND ce.embed_model=?1 AND ce.status='ok')",
            params![active_model], |r| r.get(0),
        ).unwrap_or(0)
    };

    Ok(LocalIndexStats { total_captures, total_chunks, captures_missing_embed: captures_missing, active_embed_model: active_model, active_embed_dim: active_dim })
}

pub fn get_distinct_tag_ids(conn: &Connection) -> Vec<String> {
    let mut stmt = match conn.prepare(
        "SELECT tag_ids FROM captures \
         WHERE tag_ids IS NOT NULL AND tag_ids != 'null' AND tag_ids != '[]'",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(rows) = stmt.query_map([], |row| row.get::<_, Option<String>>(0)) {
        for row in rows.flatten().flatten() {
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(&row) {
                for id in arr {
                    if !id.is_empty() {
                        ids.insert(id);
                    }
                }
            }
        }
    }
    ids.into_iter().collect()
}

/// Returns tag IDs that have at least one chunk embedding with the given model (status='ok').
pub fn get_distinct_tag_ids_for_embed_model(conn: &Connection, embed_model: &str) -> Vec<String> {
    let mut stmt = match conn.prepare(
        "SELECT DISTINCT cap.tag_ids \
         FROM captures cap \
         INNER JOIN chunks ch ON ch.capture_id = cap.id \
         INNER JOIN chunk_embeddings ce ON ce.chunk_id = ch.id \
         WHERE ce.embed_model = ?1 AND ce.status = 'ok' \
           AND cap.tag_ids IS NOT NULL AND cap.tag_ids != 'null' AND cap.tag_ids != '[]'",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(rows) = stmt.query_map(rusqlite::params![embed_model], |row| {
        row.get::<_, Option<String>>(0)
    }) {
        for row in rows.flatten().flatten() {
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(&row) {
                for id in arr {
                    if !id.is_empty() {
                        ids.insert(id);
                    }
                }
            }
        }
    }
    ids.into_iter().collect()
}

// ── Index diagnostics ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiag {
    /// Value of meta.active_embed_model
    pub meta_embed_model: String,
    /// Value of meta.active_embed_dim
    pub meta_embed_dim: u32,
    /// (embed_model, count) for all rows in chunk_embeddings, grouped
    pub stored_models: Vec<(String, i64)>,
    /// Total rows in chunk_embeddings (may include orphans)
    pub total_chunk_embeddings: i64,
    /// Total rows in chunks (may include orphans)
    pub total_chunks: i64,
    /// chunk_embeddings rows that successfully JOIN to a live, visible capture (what vector_search sees)
    pub valid_chunk_embeddings: i64,
    /// Current visible captures that have ≥1 chunk_embedding for the active model (searchable)
    pub captures_with_embeddings: i64,
    /// Current visible captures with NO chunk_embedding for the active model (not yet indexed)
    pub captures_missing_embeddings: i64,
    /// Captures with non-null/non-empty tag_ids (not deleted, not hidden)
    pub captures_with_tags: i64,
    /// Captures with null or empty tag_ids (not deleted, not hidden)
    pub captures_without_tags: i64,
    /// Sample of distinct tag_ids values stored in captures (up to 5)
    pub sample_tag_ids: Vec<String>,
}

pub fn get_index_diag(conn: &Connection) -> IndexDiag {
    let meta_embed_model: String = conn
        .query_row("SELECT value FROM meta WHERE key='active_embed_model'", [], |r| r.get(0))
        .unwrap_or_default();
    let meta_embed_dim: u32 = conn
        .query_row("SELECT value FROM meta WHERE key='active_embed_dim'", [], |r| {
            r.get::<_, String>(0).map(|s| s.parse::<u32>().unwrap_or(0))
        })
        .unwrap_or(0);
    let total_chunk_embeddings: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunk_embeddings", [], |r| r.get(0))
        .unwrap_or(0);
    let total_chunks: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap_or(0);
    let stored_models: Vec<(String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT embed_model, COUNT(*) FROM chunk_embeddings GROUP BY embed_model ORDER BY COUNT(*) DESC")
            .unwrap_or_else(|_| conn.prepare("SELECT '' WHERE 0").unwrap());
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    };
    // What vector_search actually sees: chunk_embeddings that JOIN to a live, visible capture
    let valid_chunk_embeddings: i64 = conn
        .query_row(
            "SELECT COUNT(ce.id)
             FROM chunk_embeddings ce
             JOIN chunks ch ON ch.id = ce.chunk_id
             JOIN captures cap ON cap.id = ch.capture_id
             WHERE ce.embed_model = ?1 AND ce.status = 'ok'",
            rusqlite::params![&meta_embed_model],
            |r| r.get(0),
        )
        .unwrap_or(0);
    // Current visible captures that are searchable vs missing embeddings
    let captures_with_embeddings: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT cap.id)
             FROM captures cap
             JOIN chunks ch ON ch.capture_id = cap.id
             JOIN chunk_embeddings ce ON ce.chunk_id = ch.id
             WHERE ce.embed_model = ?1 AND ce.status = 'ok'",
            rusqlite::params![&meta_embed_model],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let captures_missing_embeddings: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT cap.id)
             FROM captures cap
             WHERE NOT EXISTS (
                 SELECT 1 FROM chunks ch
                 JOIN chunk_embeddings ce ON ce.chunk_id = ch.id
                 WHERE ch.capture_id = cap.id AND ce.embed_model = ?1 AND ce.status = 'ok'
               )",
            rusqlite::params![&meta_embed_model],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let captures_with_tags: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM captures WHERE tag_ids IS NOT NULL AND tag_ids != 'null' AND tag_ids != '[]'",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let captures_without_tags: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM captures WHERE (tag_ids IS NULL OR tag_ids = 'null' OR tag_ids = '[]')",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let sample_tag_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT tag_ids FROM captures WHERE tag_ids IS NOT NULL AND tag_ids != 'null' AND tag_ids != '[]' LIMIT 5")
            .unwrap_or_else(|_| conn.prepare("SELECT '' WHERE 0").unwrap());
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    };
    IndexDiag { meta_embed_model, meta_embed_dim, stored_models, total_chunk_embeddings, total_chunks, valid_chunk_embeddings, captures_with_embeddings, captures_missing_embeddings, captures_with_tags, captures_without_tags, sample_tag_ids }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelCoverage {
    pub embed_model: String,
    /// Captures with at least one usable embedding for this model.
    pub covered: i64,
    /// Captures that have chunks at all — the only ones coverage can apply to.
    pub total: i64,
}

/// Captures reachable by `embed_model`, out of the captures that have chunks.
/// A capture with no chunks (empty text, or still pending) is not a coverage
/// gap — the Captures status pill already reports that case.
pub fn model_coverage(conn: &Connection, embed_model: &str) -> Result<ModelCoverage, String> {
    let total: i64 = conn
        .query_row("SELECT COUNT(DISTINCT capture_id) FROM chunks", [], |r| r.get(0))
        .map_err(|e| format!("coverage total: {e}"))?;
    let covered: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT ch.capture_id) \
             FROM chunks ch \
             JOIN chunk_embeddings ce ON ce.chunk_id = ch.id \
             WHERE ce.embed_model = ?1 AND ce.status = 'ok'",
            params![embed_model],
            |r| r.get(0),
        )
        .map_err(|e| format!("coverage covered: {e}"))?;
    Ok(ModelCoverage { embed_model: embed_model.to_string(), covered, total })
}

/// Coverage for every model that has at least one stored embedding, best first.
/// Drives the "use a different model" picker so the choice is informed.
pub fn coverage_by_model(conn: &Connection) -> Result<Vec<ModelCoverage>, String> {
    let models: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT embed_model FROM chunk_embeddings WHERE status = 'ok'")
            .map_err(|e| format!("coverage models: {e}"))?;
        let mapped = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("coverage models: {e}"))?;
        mapped.filter_map(|r| r.ok()).collect()
    };
    let mut out = Vec::new();
    for m in models {
        out.push(model_coverage(conn, &m)?);
    }
    out.sort_by(|a, b| b.covered.cmp(&a.covered));
    Ok(out)
}

// ── Share links (for GCP artifact sharing) ────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkRow {
    pub id: String,
    pub blob_key: String,
    pub download_filename: String,
    pub signed_url: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub created_at: String,
}

pub fn insert_share_link(conn: &Connection, row: &ShareLinkRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO share_links(id, blob_key, download_filename, signed_url, expires_at, revoked_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            row.id,
            row.blob_key,
            row.download_filename,
            row.signed_url,
            row.expires_at,
            row.revoked_at,
            row.created_at,
        ],
    )
    .map_err(|e| format!("insert_share_link: {e}"))?;
    Ok(())
}

pub fn list_share_links(conn: &Connection) -> Result<Vec<ShareLinkRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, blob_key, download_filename, signed_url, expires_at, revoked_at, created_at
             FROM share_links ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ShareLinkRow {
                id: r.get(0)?,
                blob_key: r.get(1)?,
                download_filename: r.get(2)?,
                signed_url: r.get(3)?,
                expires_at: r.get(4)?,
                revoked_at: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get_share_link(conn: &Connection, id: &str) -> Result<ShareLinkRow, String> {
    conn.query_row(
        "SELECT id, blob_key, download_filename, signed_url, expires_at, revoked_at, created_at
         FROM share_links WHERE id=?1",
        params![id],
        |r| {
            Ok(ShareLinkRow {
                id: r.get(0)?,
                blob_key: r.get(1)?,
                download_filename: r.get(2)?,
                signed_url: r.get(3)?,
                expires_at: r.get(4)?,
                revoked_at: r.get(5)?,
                created_at: r.get(6)?,
            })
        },
    )
    .map_err(|e| format!("get_share_link: {e}"))
}

pub fn mark_share_link_revoked(conn: &Connection, id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    conn.execute("UPDATE share_links SET revoked_at=?1 WHERE id=?2", params![now, id])
        .map_err(|e| format!("mark_share_link_revoked: {e}"))?;
    Ok(())
}

pub fn set_active_embed_model(conn: &Connection, model_id: &str, dim: u32) -> Result<(), String> {
    conn.execute("UPDATE meta SET value=?1 WHERE key='active_embed_model'", params![model_id])
        .map_err(|e| format!("set active model: {e}"))?;
    conn.execute("UPDATE meta SET value=?1 WHERE key='active_embed_dim'", params![dim.to_string()])
        .map_err(|e| format!("set active dim: {e}"))?;
    Ok(())
}

// ── Chat router (gpt-4o-mini) ─────────────────────────────────────────────────

/// Subset of the router JSON we actually use locally.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ChatRouterResult {
    pub need_more_context: bool,
    pub reformulated_for_embedding: Option<String>,
    pub keyword_terms_for_search: Option<Vec<String>>,
}

const ROUTER_SYSTEM: &str = r#"You are a routing step for the KTS knowledge assistant. You never answer the user's question here — you only decide whether retrieval from the local knowledge base is needed.

## Output format (strict)
Return ONLY a JSON object — no markdown fences, no text before or after.
Required keys:
1. "need_more_context" — boolean. True only when new facts from the local knowledge base are needed that are NOT already in the conversation.
2. "reformulated_for_embedding" — string or null. A tight retrieval query in the user's language. Null when need_more_context is false.
3. "keyword_terms_for_search" — array of 0-5 strings or null. Only proper nouns, identifiers, product names, codes. Null or [] for generic questions. Null when need_more_context is false.

## Rules for need_more_context
Set FALSE when:
- The answer can be given from the conversation history already.
- The task is rephrase, translate, summarize, or edit text already in the thread.
- The user asks follow-up on something already answered above.

Set TRUE only when a good answer requires fetching new concrete facts from the local knowledge base.

Return only the JSON object."#;

pub fn call_chat_router(
    api_key: &str,
    query: &str,
    history: &[(String, String)], // (role, content)
) -> Result<ChatRouterResult, String> {
    let mut messages: Vec<serde_json::Value> = vec![
        serde_json::json!({"role": "system", "content": ROUTER_SYSTEM}),
    ];
    // Include last few history turns for context
    let history_window = history.iter().rev().take(6).collect::<Vec<_>>();
    for (role, content) in history_window.into_iter().rev() {
        messages.push(serde_json::json!({"role": role, "content": content}));
    }
    let user_msg = format!(
        "Below is the current question. Decide if retrieval is needed.\n\n--- CURRENT QUESTION ---\n{query}\n\nReturn only the JSON object."
    );
    messages.push(serde_json::json!({"role": "user", "content": user_msg}));

    let raw = crate::local_llm::run_openai_chat_completion_messages(
        api_key,
        "gpt-4o-mini",
        &messages,
        256,
        0.0,
    )?;

    // Strip optional markdown fences
    let json_str = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    serde_json::from_str::<ChatRouterResult>(json_str)
        .map_err(|e| format!("Router JSON parse error: {e} — raw: {json_str}"))
}

// ── Hybrid search ─────────────────────────────────────────────────────────────

/// Context expansion config — mirrors backend neighbor + cross-type expansion.
/// Scale params down for local models (small context window).
#[derive(Clone, Debug)]
pub struct ExpandConfig {
    /// Adjacent same-type chunks before the matched chunk to include.
    pub prev_neighbors: usize,
    /// Adjacent same-type chunks after the matched chunk to include.
    pub next_neighbors: usize,
    /// Top-N cross-type chunks to add from the same capture (raw↔explanation).
    pub cross_type_top_n: usize,
}

impl ExpandConfig {
    /// Large context window — OpenAI model or MCP (Claude Code).
    pub fn api() -> Self { Self { prev_neighbors: 1, next_neighbors: 1, cross_type_top_n: 3 } }
    /// Small context window — local Qwen model.
    pub fn local() -> Self { Self { prev_neighbors: 0, next_neighbors: 1, cross_type_top_n: 2 } }
    /// Derive from embedding model: openai:* → api(), else → local().
    pub fn for_model(embed_model: &str) -> Self {
        if embed_model.starts_with("openai:") { Self::api() } else { Self::local() }
    }
}

pub struct SearchRequest {
    pub query: String,
    pub query_embedding: Vec<f32>,
    pub top_k: usize,
    pub embed_model: String,
    /// Keyword terms from router (proper nouns, identifiers). Overrides BM25 query when set.
    pub keyword_terms: Option<Vec<String>>,
    /// None = no filter; Some(ids) = keep captures that have any of these tag IDs.
    /// Use "00000000-0000-0000-0000-000000000000" to match untagged captures.
    pub tag_ids: Option<Vec<String>>,
    /// Neighbor + cross-type expansion config.
    pub expand: ExpandConfig,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub capture_id: String,
    pub chunk_text: String,
    pub raw_text: Option<String>,
    pub title: Option<String>,
    pub local_path: Option<String>,
    pub kind: String,
    pub score: f32,
    pub tag_ids: Vec<String>,
}

pub fn search_hybrid(conn: &Connection, req: &SearchRequest) -> Result<Vec<SearchHit>, String> {
    let k = req.top_k;
    eprintln!("[search] query={:?} top_k={} embed_model={} query_vec_dim={} tag_ids={:?} keyword_terms={:?}",
        &req.query[..req.query.len().min(60)], k, req.embed_model, req.query_embedding.len(), req.tag_ids, req.keyword_terms);

    let vec_hits = vector_search(conn, &req.query_embedding, k * 2, &req.embed_model)
        .map_err(|e| format!("vector search: {e}"))?; // Vec<(capture_id, chunk_id)>

    // BM25: use router keyword terms (quoted, OR-joined) when available; else raw query
    let bm25_query = match &req.keyword_terms {
        Some(terms) if !terms.is_empty() => {
            terms.iter()
                .map(|t| {
                    let clean = t.replace('"', "");
                    if clean.contains(' ') { format!("\"{clean}\"") } else { clean }
                })
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join(" OR ")
        }
        _ => req.query.clone(),
    };
    let bm25_hits = bm25_search_chunks(conn, &bm25_query, k * 2)
        .map_err(|e| format!("bm25 search: {e}"))?; // Vec<(capture_id, chunk_id)>
    eprintln!("[search] vec_hits={} bm25_hits={}", vec_hits.len(), bm25_hits.len());

    // RRF fusion — track best chunk_id per capture_id (first seen = best-ranked)
    let mut scores: std::collections::HashMap<String, f32> = std::collections::HashMap::new();
    let mut best_chunk: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    const K: f32 = 60.0;
    for (rank, (capture_id, chunk_id)) in vec_hits.iter().enumerate() {
        *scores.entry(capture_id.clone()).or_insert(0.0) += 1.0 / (K + rank as f32 + 1.0);
        best_chunk.entry(capture_id.clone()).or_insert_with(|| chunk_id.clone());
    }
    for (rank, (capture_id, chunk_id)) in bm25_hits.iter().enumerate() {
        *scores.entry(capture_id.clone()).or_insert(0.0) += 1.0 / (K + rank as f32 + 1.0);
        best_chunk.entry(capture_id.clone()).or_insert_with(|| chunk_id.clone());
    }

    let mut sorted: Vec<(String, f32)> = scores.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    sorted.truncate(k);
    eprintln!("[search] after RRF+truncate: {} candidates", sorted.len());

    let mut hits = Vec::new();
    for (capture_id, score) in &sorted {
        let hint = best_chunk.get(capture_id).map(|s| s.as_str());
        match fetch_capture_hit(conn, capture_id, hint, *score, &req.expand) {
            Ok(Some(h)) => { hits.push(h); }
            Ok(None) => { eprintln!("[search] fetch_capture_hit returned None for capture_id={capture_id}"); }
            Err(e) => { eprintln!("[search] fetch_capture_hit error for capture_id={capture_id}: {e}"); return Err(e); }
        }
    }

    // Apply tag filter if requested. An empty list means "no filter" (show all).
    let before_tag_filter = hits.len();
    if let Some(filter_ids) = &req.tag_ids {
        if !filter_ids.is_empty() {
            const UNTAGGED_ID: &str = "00000000-0000-0000-0000-000000000000";
            let want_untagged = filter_ids.iter().any(|id| id == UNTAGGED_ID);
            let specific_ids: Vec<&str> = filter_ids.iter()
                .filter(|id| id.as_str() != UNTAGGED_ID)
                .map(|id| id.as_str())
                .collect();
            eprintln!("[search] tag filter: want_untagged={want_untagged} specific_ids={specific_ids:?}");
            hits.retain(|h| {
                let pass = if h.tag_ids.is_empty() { want_untagged } else { specific_ids.iter().any(|fid| h.tag_ids.iter().any(|tid| tid == *fid)) };
                eprintln!("[search]   capture={} tag_ids={:?} -> pass={pass}", &h.capture_id[..h.capture_id.len().min(8)], h.tag_ids);
                pass
            });
        }
    }
    eprintln!("[search] after tag filter: {} hits (was {})", hits.len(), before_tag_filter);

    Ok(hits)
}

fn vector_search(
    conn: &Connection,
    query_vec: &[f32],
    limit: usize,
    embed_model: &str,
) -> Result<Vec<(String, String)>, rusqlite::Error> {
    // Fetch all embeddings for this model; compute cosine in Rust.
    // Returns (capture_id, chunk_id) so callers can use the best-matching chunk for context.
    type Row = (String, String, Vec<u8>); // (capture_id, chunk_id, embedding blob)
    let rows: Vec<Row> = {
        let mut stmt = conn.prepare(
            "SELECT cap.id, ch.id, ce.embedding
             FROM chunk_embeddings ce
             JOIN chunks ch ON ch.id=ce.chunk_id
             JOIN captures cap ON cap.id=ch.capture_id
             WHERE ce.embed_model=?1 AND ce.status = 'ok'"
        )?;
        stmt.query_map(params![embed_model], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,Vec<u8>>(2)?)))
            .map(|mapped| mapped.filter_map(|r| r.ok()).collect())?
    };
    eprintln!("[vector_search] loaded {} chunk rows for model={} query_dim={}", rows.len(), embed_model, query_vec.len());

    let mut scored: Vec<(String, String, f32)> = rows.iter()
        .map(|(capture_id, chunk_id, blob)| {
            let v = blob_to_floats(blob);
            let sim = cosine_similarity(query_vec, &v);
            if v.is_empty() { eprintln!("[vector_search] empty blob for capture={capture_id}"); }
            else if query_vec.len() != v.len() { eprintln!("[vector_search] dim mismatch: query={} stored={} capture={capture_id}", query_vec.len(), v.len()); }
            (capture_id.clone(), chunk_id.clone(), sim)
        })
        .collect();

    scored.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    // Dedup: for each capture keep only the best-scoring chunk
    let mut seen_captures = std::collections::HashSet::new();
    scored.retain(|(cap_id, _, _)| seen_captures.insert(cap_id.clone()));
    scored.truncate(limit);
    eprintln!("[vector_search] after dedup+truncate: {} unique captures, top_score={:.4}",
        scored.len(), scored.first().map(|s| s.2).unwrap_or(0.0));

    Ok(scored.into_iter().map(|(cap_id, chunk_id, _)| (cap_id, chunk_id)).collect())
}

fn bm25_search_chunks(conn: &Connection, query: &str, limit: usize) -> Result<Vec<(String, String)>, rusqlite::Error> {
    let fts_query = sanitize_fts_query(query);
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT fts.capture_id, fts.chunk_id \
             FROM chunks_fts fts \
             JOIN captures cap ON cap.id = fts.capture_id \
             WHERE chunks_fts MATCH ?1 \
             ORDER BY rank LIMIT ?2"
        )?;
        stmt.query_map(params![fts_query, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|mapped| mapped.filter_map(|r| r.ok()).collect())?
    };
    Ok(rows)
}

fn sanitize_fts_query(query: &str) -> String {
    // Strip FTS5 special chars that cause parse errors; keep alphanumeric + basic punctuation.
    let terms: Vec<String> = query.split_whitespace()
        .filter_map(|t| {
            let clean: String = t.chars()
                .filter(|c| c.is_alphanumeric() || matches!(*c, '-' | '_' | '\''))
                .collect();
            if clean.len() >= 2 { Some(clean) } else { None }
        })
        .collect();
    if terms.is_empty() { query.to_string() } else { terms.join(" ") }
}

fn fetch_capture_hit(conn: &Connection, capture_id: &str, hint_chunk_id: Option<&str>, score: f32, expand: &ExpandConfig) -> Result<Option<SearchHit>, String> {
    let row = conn.query_row(
        "SELECT raw_text, title, local_path, kind, tag_ids FROM captures WHERE id=?1",
        params![capture_id],
        |r| Ok((
            r.get::<_,Option<String>>(0)?,
            r.get::<_,Option<String>>(1)?,
            r.get::<_,Option<String>>(2)?,
            r.get::<_,String>(3)?,
            r.get::<_,Option<String>>(4)?,
        )),
    );
    let (raw_text, title, local_path, kind, tag_ids_json) = match row {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let tag_ids: Vec<String> = tag_ids_json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let mut context_parts: Vec<String> = Vec::new();

    // 1. [Summary]: all explanation chunks (cross-type counterpart for raw_text hits,
    //    always useful as high-level context — mirrors backend chunk_explanation expansion)
    let explanation_chunks: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT chunk_text FROM chunks WHERE capture_id=?1 AND chunk_type='explanation' ORDER BY seq"
        ).unwrap_or_else(|_| conn.prepare("SELECT ''").unwrap());
        stmt.query_map(params![capture_id], |r| r.get::<_,String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    };
    if !explanation_chunks.is_empty() {
        context_parts.push(format!("[Summary]\n{}", explanation_chunks.join(" ")));
    }

    // 2. [Content]: matched chunk + prev/next neighbors + cross-type
    if let Some(chunk_id) = hint_chunk_id {
        // Get matched chunk metadata
        let matched = conn.query_row(
            "SELECT chunk_type, seq, chunk_text, overlap_before, overlap_after FROM chunks WHERE id=?1",
            params![chunk_id],
            |r| Ok((
                r.get::<_,Option<String>>(0)?,
                r.get::<_,i64>(1)?,
                r.get::<_,String>(2)?,
                r.get::<_,Option<String>>(3)?,
                r.get::<_,Option<String>>(4)?,
            )),
        ).ok();

        if let Some((matched_type, matched_seq, matched_text, overlap_before, overlap_after)) = matched {
            let chunk_type = matched_type.as_deref().unwrap_or("raw_text");
            let mut content_parts: Vec<String> = Vec::new();

            // Prev neighbors (same chunk_type, fetched in reverse → reversed back to forward order)
            if expand.prev_neighbors > 0 {
                let prev: Vec<String> = conn.prepare(
                    "SELECT chunk_text FROM chunks WHERE capture_id=?1 AND chunk_type=?2 AND seq<?3 ORDER BY seq DESC LIMIT ?4"
                ).ok().and_then(|mut s| {
                    s.query_map(params![capture_id, chunk_type, matched_seq, expand.prev_neighbors as i64], |r| r.get::<_,String>(0))
                     .ok().map(|rows| rows.filter_map(|r| r.ok()).collect())
                }).unwrap_or_default();
                content_parts.extend(prev.into_iter().rev());
            }

            // Matched chunk with overlap context
            content_parts.push(format!("{}{}{}",
                overlap_before.as_deref().unwrap_or(""),
                matched_text,
                overlap_after.as_deref().unwrap_or(""),
            ));

            // Next neighbors (same chunk_type)
            if expand.next_neighbors > 0 {
                let next: Vec<String> = conn.prepare(
                    "SELECT chunk_text FROM chunks WHERE capture_id=?1 AND chunk_type=?2 AND seq>?3 ORDER BY seq ASC LIMIT ?4"
                ).ok().and_then(|mut s| {
                    s.query_map(params![capture_id, chunk_type, matched_seq, expand.next_neighbors as i64], |r| r.get::<_,String>(0))
                     .ok().map(|rows| rows.filter_map(|r| r.ok()).collect())
                }).unwrap_or_default();
                content_parts.extend(next);
            }

            // Cross-type: if matched is explanation, add top-N raw_text chunks
            // (raw_text→explanation already covered by the [Summary] block above)
            if chunk_type == "explanation" && expand.cross_type_top_n > 0 {
                let cross: Vec<String> = conn.prepare(
                    "SELECT chunk_text FROM chunks WHERE capture_id=?1 AND chunk_type='raw_text' ORDER BY seq LIMIT ?2"
                ).ok().and_then(|mut s| {
                    s.query_map(params![capture_id, expand.cross_type_top_n as i64], |r| r.get::<_,String>(0))
                     .ok().map(|rows| rows.filter_map(|r| r.ok()).collect())
                }).unwrap_or_default();
                content_parts.extend(cross);
            }

            if !content_parts.is_empty() {
                context_parts.push(format!("[Content]\n{}", content_parts.join("\n\n")));
            }
        }
    } else {
        // No hint chunk — fallback to first raw_text chunk
        let fallback = conn.query_row(
            "SELECT chunk_text FROM chunks WHERE capture_id=?1 AND chunk_type='raw_text' ORDER BY seq LIMIT 1",
            params![capture_id], |r| r.get::<_,String>(0),
        ).ok().or_else(|| conn.query_row(
            "SELECT chunk_text FROM chunks WHERE capture_id=?1 ORDER BY seq LIMIT 1",
            params![capture_id], |r| r.get::<_,String>(0),
        ).ok());
        if let Some(fb) = fallback {
            context_parts.push(format!("[Content]\n{}", fb));
        }
    }

    let chunk_text = if context_parts.is_empty() {
        raw_text.as_deref().unwrap_or("").to_string()
    } else {
        context_parts.join("\n\n")
    };

    Ok(Some(SearchHit { capture_id: capture_id.to_string(), chunk_text, raw_text, title, local_path, kind, score, tag_ids }))
}

// ── Context packing ───────────────────────────────────────────────────────────

pub fn pack_context(hits: &[SearchHit], char_budget: usize) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut seen = std::collections::HashSet::new();
    for hit in hits {
        if !seen.insert(&hit.capture_id) { continue; }
        let media_line = hit.local_path.as_deref()
            .filter(|p| !p.is_empty())
            .map(|p| format!("[media: file://{}]\n", p))
            .unwrap_or_default();
        let entry = format!(
            "--- {} ({}) ---\n{}{}",
            hit.title.as_deref().unwrap_or("Untitled"),
            hit.kind,
            media_line,
            &hit.chunk_text,
        );
        if used + entry.len() > char_budget { break; }
        used += entry.len();
        parts.push(entry);
    }
    parts.join("\n\n")
}

// ── Tags ──────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagRow {
    pub id: String,
    pub user_id: Option<String>,
    pub name: String,
    pub description: String,
    pub color: String,
    pub auto_assign_apps: String, // JSON array string
    pub created_at: String,
}

pub fn save_tag(
    conn: &Connection,
    user_id: &str,
    id: &str,
    name: &str,
    description: &str,
    color: &str,
    auto_assign_apps_json: &str,
    created_at: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO tags(id, user_id, name, description, color, auto_assign_apps, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           user_id           = excluded.user_id,
           name              = excluded.name,
           description       = excluded.description,
           color             = excluded.color,
           auto_assign_apps  = excluded.auto_assign_apps",
        rusqlite::params![id, user_id, name, description, color, auto_assign_apps_json, created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_tags_for_user(conn: &Connection, user_id: &str) -> Result<Vec<TagRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, user_id, name, description, color, auto_assign_apps, created_at
             FROM tags WHERE user_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![user_id], |row| {
            Ok(TagRow {
                id: row.get(0)?,
                user_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                color: row.get(4)?,
                auto_assign_apps: row
                    .get::<_, Option<String>>(5)?
                    .unwrap_or_else(|| "[]".to_string()),
                created_at: row
                    .get::<_, Option<String>>(6)?
                    .unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn delete_tag(conn: &Connection, user_id: &str, tag_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM tags WHERE id = ?1 AND user_id = ?2",
        rusqlite::params![tag_id, user_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod cache_matches_tests {
    use super::{cache_matches, Connection, LocalIndexConn};

    /// A profile's own index, reused for the same profile.
    #[test]
    fn same_profile_own_index_reuses() {
        assert!(cache_matches("user-42", None, "user-42", None));
    }

    /// An imported assistant's index, reused for the same profile + assistant.
    #[test]
    fn same_profile_same_assistant_reuses() {
        assert!(cache_matches("user-42", Some("alice-index"), "user-42", Some("alice-index")));
    }

    /// The failure this guards: a cache holding the profile's own index must
    /// NOT be reused for a request targeting an imported assistant of that
    /// same profile (and vice versa) — that would silently answer a request
    /// for imported knowledge from the profile's own captures.
    #[test]
    fn own_index_vs_assistant_of_same_profile_does_not_reuse() {
        assert!(!cache_matches("user-42", None, "user-42", Some("alice-index")));
        assert!(!cache_matches("user-42", Some("alice-index"), "user-42", None));
    }

    /// Two different assistants imported into the same profile must not share
    /// a cached connection.
    #[test]
    fn two_different_assistants_of_same_profile_do_not_reuse() {
        assert!(!cache_matches("user-42", Some("alice-index"), "user-42", Some("bob-index")));
    }

    /// The same assistant id imported into two different profiles must not
    /// share a cached connection — the user_id half of the key matters too.
    #[test]
    fn same_assistant_id_under_two_profiles_does_not_reuse() {
        assert!(!cache_matches("user-1", Some("alice-index"), "user-2", Some("alice-index")));
    }

    /// The fresh-construction state (`LocalIndexConn::new()`) has an empty
    /// cached user_id. It must never look like a match for any real request,
    /// or the first call after construction could read stale/uninitialized
    /// state instead of opening a real connection.
    #[test]
    fn empty_cached_user_never_matches() {
        assert!(!cache_matches("", None, "user-42", None));
        assert!(!cache_matches("", None, "user-42", Some("alice-index")));
        assert!(!cache_matches("", Some("alice-index"), "user-42", Some("alice-index")));
    }

    /// A connection cached on an assistant that is being deleted must be closed
    /// *and* forgotten. Left in place it is still a cache **hit**: the next read
    /// answers from a database whose directory entry is gone — content from a
    /// deleted assistant, and its blocks pinned for as long as the app runs.
    #[test]
    fn deleting_an_assistant_drops_its_cached_connection() {
        let mut c = LocalIndexConn::new();
        c.user_id = "user-42".to_string();
        c.assistant_id = Some("alice-index".to_string());
        c.conn = Some(Connection::open_in_memory().unwrap());

        assert!(c.drop_cached_for("user-42", Some("alice-index")));
        assert!(c.conn.is_none(), "the connection stayed open on deleted files");
        // Forgotten, not merely closed: an identity left behind would match the
        // next read, which would then reopen the deleted path.
        assert!(!cache_matches(
            &c.user_id,
            c.assistant_id.as_deref(),
            "user-42",
            Some("alice-index")
        ));
    }

    /// And it drops only that one. Deleting one assistant must not close the
    /// connection the profile's own index — or another assistant — is using.
    #[test]
    fn deleting_an_assistant_leaves_another_cached_connection_alone() {
        for (cached_user, cached_assistant) in [
            ("user-42", None),
            ("user-42", Some("bob-index")),
            ("user-1", Some("alice-index")),
        ] {
            let mut c = LocalIndexConn::new();
            c.user_id = cached_user.to_string();
            c.assistant_id = cached_assistant.map(str::to_string);
            c.conn = Some(Connection::open_in_memory().unwrap());

            assert!(!c.drop_cached_for("user-42", Some("alice-index")));
            assert!(
                c.conn.is_some(),
                "deleting an assistant closed the connection of {cached_user:?}/{cached_assistant:?}"
            );
        }
    }
}

#[cfg(test)]
mod open_policy_tests {
    use super::*;

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kts-open-policy-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An assistant directory as the importer leaves it: the database, and the
    /// media that exists nowhere else. `index.db` is deliberately not a database,
    /// so the open fails — which failure does not matter, only what happens next.
    fn unopenable_assistant_dir(name: &str) -> std::path::PathBuf {
        let dir = test_dir(name).join("assistants").join("alice");
        std::fs::create_dir_all(dir.join("artefacts")).unwrap();
        std::fs::write(dir.join("index.db"), b"this is not a SQLite file").unwrap();
        std::fs::write(dir.join("artefacts").join("photo.png"), b"the only copy").unwrap();
        dir
    }

    /// **The regression this whole policy exists for.**
    ///
    /// An imported assistant's directory is the only copy of what somebody shared.
    /// A failed open must leave every byte of it alone — database, media, all of
    /// it — and report the failure. The old behaviour was `remove_dir_all` on this
    /// directory, silently, on the first read after the import.
    #[test]
    fn a_failed_open_of_an_imported_index_deletes_nothing() {
        let dir = unopenable_assistant_dir("imported-survives");
        let db = dir.join("index.db");

        let err = open_migrated_db(&db, IndexKind::Imported).unwrap_err();

        assert_eq!(err, unreadable_shared_index_message());
        assert!(dir.is_dir(), "the assistant directory was removed");
        assert!(dir.join("artefacts").join("photo.png").is_file(), "the media was removed");
        assert_eq!(
            std::fs::read(&db).unwrap(),
            b"this is not a SQLite file",
            "the database was replaced by a blank one",
        );
    }

    /// The user-facing half: whatever went wrong, the person is told the files are
    /// still there. A message that only reported the failure would have them delete
    /// the assistant to start clean, finishing by hand the loss we just refused.
    #[test]
    fn the_refusal_tells_the_user_nothing_was_removed() {
        let dir = unopenable_assistant_dir("imported-message");
        let err = open_migrated_db(&dir.join("index.db"), IndexKind::Imported).unwrap_err();

        assert!(err.contains("still on your computer"), "{err}");
        // And nothing technical: no path, no SQLite text, no error code.
        assert!(!err.contains('/'), "{err}");
        assert!(!err.to_lowercase().contains("sqlite"), "{err}");
    }

    /// **The regression the background loop makes into a schedule.**
    ///
    /// A lock is not corruption. `try_open`'s write probe is the first write of the
    /// open, so it meets whatever the pooled connection is doing on the same file;
    /// when that takes longer than the busy timeout it comes back `SQLITE_BUSY`.
    /// Every such failure used to land in the branch that `remove_dir_all`s the
    /// index directory — and the auto-index loop now opens this database every
    /// fifteen seconds, forever, buying a ticket each time.
    #[test]
    fn a_busy_index_is_not_mistaken_for_a_corrupt_one() {
        let dir = test_dir("own-busy").join("user-42");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("index.db");

        // A healthy index, with something in it that recovery would have destroyed.
        {
            let conn = open_migrated_db(&db, IndexKind::Own).unwrap();
            conn.execute(
                "INSERT INTO captures(id,kind,raw_text) VALUES ('c1','note','the only copy')",
                [],
            )
            .unwrap();
        }

        // Another connection is mid-write and still holding the write lock — the
        // pooled connection saving a capture, as far as the opener can tell.
        let holder = Connection::open(&db).unwrap();
        holder
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO meta(key,value) VALUES ('held','1');")
            .unwrap();

        let err = open_migrated_db(&db, IndexKind::Own).unwrap_err();

        assert_eq!(err, index_busy_message());
        assert!(dir.is_dir(), "the index directory was removed for a lock");
        assert!(db.is_file(), "the index file was removed for a lock");

        // And once the writer is done, the index is still the one we started with.
        drop(holder);
        let conn = open_migrated_db(&db, IndexKind::Own).expect("index should reopen");
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM captures WHERE id='c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "a transient lock cost the user their captures");
    }

    /// The sorting itself, on the codes SQLite actually returns. `SQLITE_BUSY` and
    /// `SQLITE_LOCKED` mean somebody else is holding an intact database; everything
    /// else — including the plain `SQLITE_ERROR` the stale-schema check fails with —
    /// keeps the recreate behaviour that recovery depends on.
    #[test]
    fn lock_contention_and_a_broken_file_are_told_apart() {
        let failure = |extended_code: std::os::raw::c_int| {
            OpenFailure::classify(
                "probe",
                &rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(extended_code), None),
            )
        };
        for code in [5 /* BUSY */, 6 /* LOCKED */, 517 /* BUSY_SNAPSHOT */] {
            assert!(
                matches!(failure(code), OpenFailure::Busy(_)),
                "SQLite code {code} was not treated as lock contention",
            );
        }
        for code in [11 /* CORRUPT */, 26 /* NOTADB */, 1 /* ERROR */, 14 /* CANTOPEN */] {
            assert!(
                matches!(failure(code), OpenFailure::Unusable(_)),
                "SQLite code {code} was treated as a transient lock",
            );
        }
    }

    /// The other side of the asymmetry, on a directory laid out identically. The
    /// profile's own index is derived from `kety/captures/`, so delete-and-rebuild
    /// is sound recovery and must keep working — that is what makes a corrupted
    /// own index self-healing rather than a dead app.
    #[test]
    fn a_failed_open_of_the_profiles_own_index_still_recreates_it() {
        let root = test_dir("own-recreates").join("user-42");
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("index.db");
        std::fs::write(&db, b"this is not a SQLite file").unwrap();

        let conn = open_migrated_db(&db, IndexKind::Own).expect("own index should recover");
        let captures: i64 = conn
            .query_row("SELECT COUNT(*) FROM captures", [], |r| r.get(0))
            .unwrap();
        assert_eq!(captures, 0, "recovery did not produce a usable empty index");
    }

    /// The peek the background loop uses to avoid a full open every fifteen seconds.
    /// It has to be right in both directions: a wrong "nothing waiting" is a capture
    /// that never gets indexed.
    #[test]
    fn the_peek_answers_only_when_it_knows() {
        let dir = test_dir("peek");
        let db = dir.join("index.db");

        assert_eq!(
            any_capture_pending(&db),
            None,
            "the peek answered for a database that does not exist yet",
        );
        assert!(!db.exists(), "the peek created the database file");

        {
            let conn = open_migrated_db(&db, IndexKind::Own).unwrap();
            assert_eq!(any_capture_pending(&db), Some(false), "an empty index looked busy");
            conn.execute("INSERT INTO captures(id,kind) VALUES ('c1','note')", []).unwrap();
        }
        assert_eq!(any_capture_pending(&db), Some(true), "a pending capture was missed");

        {
            let conn = open_migrated_db(&db, IndexKind::Own).unwrap();
            conn.execute("UPDATE captures SET index_state='indexed'", []).unwrap();
        }
        assert_eq!(any_capture_pending(&db), Some(false), "an indexed capture still looked pending");

        // A capture left mid-index by an app that stopped is still waiting, and the
        // only thing that rescues it — the reset in `init_db` — is behind the full
        // open this peek decides whether to take. Answering "nothing waiting" here
        // strands it for good.
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute("UPDATE captures SET index_state='indexing'", []).unwrap();
        }
        assert_eq!(
            any_capture_pending(&db),
            Some(true),
            "a capture left mid-index was skipped, so the reset that saves it never runs",
        );
    }

    /// A database older than the `index_state` column cannot answer the peek, and
    /// must not be read as "nothing waiting" — it is exactly the database that has
    /// everything waiting. `None` sends it down the full open, which migrates it.
    #[test]
    fn a_schema_too_old_to_answer_the_peek_is_not_skipped() {
        let dir = test_dir("peek-old-schema");
        let db = dir.join("index.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE captures (id TEXT PRIMARY KEY, kind TEXT);")
                .unwrap();
            conn.execute("INSERT INTO captures(id,kind) VALUES ('c1','note')", []).unwrap();
        }

        assert_eq!(any_capture_pending(&db), None);
    }

    /// `IndexKind` is derived from the `assistant_id`, never chosen, so the policy
    /// and the path cannot disagree about which index is being opened.
    #[test]
    fn the_kind_follows_the_assistant_id() {
        assert_eq!(IndexKind::of(None), IndexKind::Own);
        assert_eq!(IndexKind::of(Some("alice-index")), IndexKind::Imported);
    }

    /// The proximate trigger of the data loss: `meta` seeded positionally.
    ///
    /// An archive is validated on *presence* of the canonical schema, so it may
    /// legitimately carry a `meta` column of its own. `INSERT INTO meta VALUES
    /// (a, b)` against three columns is a hard error, which failed the open, which
    /// reached the recovery branch, which deleted the assistant. Naming the columns
    /// removes the first domino; the refusal above removes the last.
    #[test]
    fn an_extra_meta_column_does_not_fail_the_open() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, extra TEXT);",
        )
        .unwrap();

        init_db(&conn, IndexKind::Imported).expect("an extra meta column must not fail the open");

        let seeded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM meta WHERE key IN ('active_embed_model','active_embed_dim')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(seeded, 2);
    }

    /// An imported index must not have the app `stat` paths it chose. `local_path`
    /// arrives verbatim from whoever built the archive, and the media that matters
    /// is in the assistant's own `artefacts/`, never at the sender's path.
    #[test]
    fn opening_an_imported_index_does_not_stat_paths_the_archive_chose() {
        let dir = test_dir("no-stat");
        let bait = dir.join("secret.pdf");
        std::fs::write(&bait, b"0123456789").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO captures(id,kind,local_path) VALUES ('c1','image',?1)",
            params![bait.to_str().unwrap()],
        )
        .unwrap();

        init_db(&conn, IndexKind::Imported).unwrap();
        let size: Option<i64> = conn
            .query_row("SELECT size_media_kb FROM captures WHERE id='c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(size, None, "the backfill read a file the archive named");

        // And the same backfill still runs for the profile's own index, where the
        // paths are ones this app wrote.
        init_db(&conn, IndexKind::Own).unwrap();
        let size: Option<i64> = conn
            .query_row("SELECT size_media_kb FROM captures WHERE id='c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(size, Some(1), "the backfill stopped working for the own index");
    }
}

/// The `'indexing'` state: what has to be true of it beyond being displayed.
#[cfg(test)]
mod index_state_tests {
    use super::*;

    fn conn_with(states: &[(&str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn, IndexKind::Own).unwrap();
        for (id, state) in states {
            conn.execute(
                "INSERT INTO captures(id,kind,index_state) VALUES (?1,'note',?2)",
                params![id, state],
            )
            .unwrap();
        }
        conn
    }

    /// Give a capture a chunk with a usable vector, the way a finished pass would.
    fn embed(conn: &Connection, capture_id: &str) {
        conn.execute(
            "INSERT INTO chunks(id,capture_id,seq,chunk_text) VALUES (?1,?2,0,'text')",
            params![format!("chunk-{capture_id}"), capture_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunk_embeddings(id,chunk_id,embed_model,embed_dim,embedding,created_at,status) \
             VALUES (?1,?2,'m',1,X'00000000','2026-01-01T00:00:00Z','ok')",
            params![format!("emb-{capture_id}"), format!("chunk-{capture_id}")],
        )
        .unwrap();
    }

    fn state_of(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT index_state FROM captures WHERE id=?1", params![id], |r| r.get(0))
            .unwrap()
    }

    /// The whole reason `'indexing'` is allowed to exist. A worker only lives inside
    /// a running process, so a row still claiming one on open belongs to a pass that
    /// ended — and the worker selects `'pending'`, so leaving it there means that
    /// capture is never indexed and never says anything about it.
    #[test]
    fn a_capture_left_mid_index_is_queued_again_on_the_next_open() {
        let conn = conn_with(&[("stranded", "indexing")]);
        assert_eq!(state_of(&conn, "stranded"), "indexing", "the fixture did not take");

        init_db(&conn, IndexKind::Own).unwrap();

        assert_eq!(state_of(&conn, "stranded"), "pending");
    }

    /// And the reset has to run before the "already has embeddings" backfill, or a
    /// pass that died between writing the vectors and recording the outcome pays to
    /// embed the same capture twice.
    #[test]
    fn a_capture_that_finished_embedding_before_the_crash_is_not_embedded_again() {
        let conn = conn_with(&[("done", "indexing")]);
        embed(&conn, "done");

        init_db(&conn, IndexKind::Own).unwrap();

        assert_eq!(
            state_of(&conn, "done"),
            "indexed",
            "a capture whose vectors already landed was queued for another pass",
        );
    }

    /// Nothing else is touched: the reset is for rows a pass abandoned, and every
    /// other state is somebody's decision — the user's, or a finished pass's.
    #[test]
    fn the_reset_leaves_every_other_state_alone() {
        let conn = conn_with(&[
            ("a", "pending"),
            ("b", "indexed"),
            ("c", "failed"),
            ("d", "excluded"),
        ]);
        assert_eq!(reset_stale_indexing(&conn).unwrap(), 0);
        for (id, state) in [("a", "pending"), ("b", "indexed"), ("c", "failed"), ("d", "excluded")] {
            assert_eq!(state_of(&conn, id), state, "{id} was moved by the reset");
        }
    }

    /// The status pill totals the counts, so a state no field accounts for does not
    /// show as a wrong number — the captures in it silently leave the total.
    #[test]
    fn every_capture_is_in_exactly_one_count() {
        let conn = conn_with(&[
            ("a", "pending"),
            ("b", "indexing"),
            ("c", "indexing"),
            ("d", "indexed"),
            ("e", "failed"),
            ("f", "excluded"),
        ]);

        let counts = count_index_states(&conn).unwrap();
        assert_eq!(counts.indexing, 2, "captures in flight were not counted anywhere");

        let total: i64 = conn.query_row("SELECT COUNT(*) FROM captures", [], |r| r.get(0)).unwrap();
        assert_eq!(
            counts.pending + counts.indexing + counts.indexed + counts.failed + counts.excluded,
            total,
            "the counts no longer add up to the number of captures",
        );
    }

    /// A pass records its outcome only over its own claim. The removal is the case
    /// that matters: the user took a capture out of their assistant while a pass was
    /// on it, and an unguarded write would put it back.
    #[test]
    fn an_outcome_is_not_recorded_over_something_the_user_did_since() {
        let conn = conn_with(&[("claimed", "indexing")]);
        assert!(finish_index_state(&conn, "claimed", "indexed", None).unwrap());
        assert_eq!(state_of(&conn, "claimed"), "indexed");

        // The user removes it from the assistant mid-pass; the pass then finishes.
        unindex_captures(&conn, &["claimed".to_string()]).unwrap();
        assert!(!finish_index_state(&conn, "claimed", "indexed", None).unwrap());
        assert_eq!(state_of(&conn, "claimed"), "excluded", "a removal was undone by a pass");

        // Same for an edit, which queues the capture again for its new text.
        let conn = conn_with(&[("edited", "indexing")]);
        requeue_captures(&conn, &["edited".to_string()]).unwrap();
        assert!(!finish_index_state(&conn, "edited", "indexed", None).unwrap());
        assert_eq!(state_of(&conn, "edited"), "pending");
    }

    /// The worker's own selection. `'indexing'` is claimed by a pass under way and
    /// must not be picked up by a second one, the same way `'excluded'` and
    /// `'failed'` are left alone.
    #[test]
    fn only_pending_captures_are_picked_up() {
        let conn = conn_with(&[
            ("a", "pending"),
            ("b", "indexing"),
            ("c", "indexed"),
            ("d", "failed"),
            ("e", "excluded"),
        ]);
        let picked: Vec<String> = conn
            .prepare(&format!(
                "SELECT id FROM captures WHERE {PENDING_CAPTURE_FILTER} ORDER BY id"
            ))
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(picked, vec!["a".to_string()]);
    }
}

#[cfg(test)]
mod share_links_tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn, IndexKind::Own).unwrap();
        conn
    }

    fn sample_row(id: &str) -> ShareLinkRow {
        ShareLinkRow {
            id: id.to_string(),
            blob_key: format!("profile-1/{id}.png"),
            download_filename: "photo.png".to_string(),
            signed_url: "https://storage.googleapis.com/bucket/profile-1/x.png?sig=abc".to_string(),
            expires_at: "2026-01-22T10:30:00.000Z".to_string(),
            revoked_at: None,
            created_at: "2026-01-15T10:30:00.000Z".to_string(),
        }
    }

    #[test]
    fn insert_then_list_returns_the_row() {
        let conn = test_conn();
        insert_share_link(&conn, &sample_row("share-1")).unwrap();

        let rows = list_share_links(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "share-1");
        assert_eq!(rows[0].revoked_at, None);
    }

    #[test]
    fn mark_revoked_sets_revoked_at() {
        let conn = test_conn();
        insert_share_link(&conn, &sample_row("share-2")).unwrap();

        mark_share_link_revoked(&conn, "share-2").unwrap();

        let row = get_share_link(&conn, "share-2").unwrap();
        assert!(row.revoked_at.is_some());
    }

    #[test]
    fn list_orders_newest_first() {
        let conn = test_conn();
        let mut older = sample_row("share-old");
        older.created_at = "2026-01-01T00:00:00.000Z".to_string();
        let mut newer = sample_row("share-new");
        newer.created_at = "2026-01-20T00:00:00.000Z".to_string();
        insert_share_link(&conn, &older).unwrap();
        insert_share_link(&conn, &newer).unwrap();

        let rows = list_share_links(&conn).unwrap();
        assert_eq!(rows[0].id, "share-new");
        assert_eq!(rows[1].id, "share-old");
    }
}

