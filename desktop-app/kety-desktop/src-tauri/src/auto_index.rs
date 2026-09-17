//! Background auto-indexing loop.
//!
//! Captures being indexed as soon as they arrive is the central feature of the app,
//! so it must not depend on a webview being awake. This is a tray app: the main
//! window starts hidden and closing it hides it rather than quitting, so "no visible
//! window" is the steady state, and a suspended renderer would silently stop the
//! polling that used to live in `App.tsx`.
//!
//! The loop owns nothing the frontend has to hand it: it re-reads the active profile
//! and that profile's settings from the same on-disk store the frontend writes to,
//! on every tick, so switching profiles or toggling auto-indexing off takes effect
//! without a restart. Indexing itself is `local_index_commands::index_pending_for_user`,
//! the same function the manual command calls — including the same embed lock, which
//! is what makes a manual index and a background tick serialise instead of race.

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use futures_util::FutureExt;
use serde_json::Value;
use tauri::Manager;
use tauri_plugin_store::StoreExt;

/// Frontend's local-profile session store (see `appStore.ts` / `profileContext.tsx`
/// in the React app). This loop runs outside any `invoke()` call, so like the MCP
/// server it reads the store the frontend already persists to.
const FRONTEND_SESSION_STORE_FILE: &str = "kts/kts-session-store.json";
const ACTIVE_PROFILE_STORE_KEY: &str = "kts:activeProfileId";
/// The list the active id is checked against — see [`resolve_profile`].
const PROFILES_STORE_KEY: &str = "kts:profiles";

/// Per-profile settings are stored under `u:<profileId>:<key>` (`sessionStoreUser.ts`).
const AUTO_INDEX_ENABLED_KEY: &str = "autoIndexEnabled";
const OPENAI_API_KEY_KEY: &str = "openAiApiKey";

/// Same cadence the frontend used before this loop replaced it.
const TICK_INTERVAL: Duration = Duration::from_secs(15);

/// Captures indexed per tick, matching what the frontend asked for.
const BATCH_LIMIT: usize = 10;

fn scoped_key(user_id: &str, base_key: &str) -> String {
    format!("u:{user_id}:{base_key}")
}

/// The stored active profile id, or `None` when no profile is active.
///
/// Never creates and never guesses one: a logged-out app simply does nothing.
fn active_profile_id(raw: Option<Value>) -> Option<String> {
    let id = raw?.as_str()?.trim().to_string();
    if id.is_empty() { None } else { Some(id) }
}

/// Whether auto-indexing is on for a profile.
///
/// Absent or null means on, which is how the Settings toggle reads it for a profile
/// that never touched it (`App.tsx`: `storedAutoIndex ?? true`). Only an explicit
/// `false` turns the loop off — a user who switched auto-indexing off must not have
/// it keep running out of sight.
fn auto_index_enabled(raw: Option<Value>) -> bool {
    match raw {
        Some(v) => v.as_bool().unwrap_or(true),
        None => true,
    }
}

/// Which profile the app is really on.
///
/// The frontend does not trust `kts:activeProfileId` on its own: `profileContext.tsx`
/// checks it against `kts:profiles` and, when it names nothing in that list, uses the
/// first profile instead — **without writing the correction back**. So the raw key can
/// legitimately disagree with the profile the person is looking at, and a loop reading
/// only the raw key would either index into a directory for a profile that does not
/// exist, or — id absent, profiles present — do nothing at all for the rest of the
/// session. Both silently. The loop therefore resolves it exactly the way the window
/// does, and says so when the two differ.
#[derive(Debug, PartialEq, Eq)]
enum ProfileChoice {
    /// The stored active id, and it names a real profile.
    Stored(String),
    /// The stored id named nothing; this is `profiles[0]`, the frontend's fallback.
    FellBack(String),
    /// No profiles at all — nothing to index for.
    None,
}

fn resolve_profile(profiles_raw: Option<Value>, active_raw: Option<Value>) -> ProfileChoice {
    let ids: Vec<String> = profiles_raw
        .as_ref()
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|p| p.get("id")?.as_str().map(str::trim).map(String::from))
                .filter(|id| !id.is_empty())
                .collect()
        })
        .unwrap_or_default();
    match active_profile_id(active_raw) {
        // `profiles` empty falls through here even for a valid-looking id, because the
        // frontend's `stored[0]?.id ?? null` does the same: no profile list, no profile.
        Some(id) if ids.iter().any(|known| *known == id) => ProfileChoice::Stored(id),
        _ => match ids.into_iter().next() {
            Some(first) => ProfileChoice::FellBack(first),
            None => ProfileChoice::None,
        },
    }
}

/// What a tick did, in the terms someone reading the log needs.
///
/// The point of the enum is the ones that are *not* errors. "Turned off", "no
/// profile", "settings unreadable", "nothing to do" and "the loop is dead" used to
/// be the same thing from outside — silence — for the component that is this app's
/// central feature and has no UI of its own.
#[derive(Clone, PartialEq, Eq, Debug)]
enum TickOutcome {
    /// Captures were indexed. Always logged: it is the loop doing its job.
    Indexed(usize),
    /// Everything is set up and nothing was waiting.
    Idle,
    /// The settings store would not open.
    NoStore,
    /// No profile to index for.
    NoProfile,
    /// The active profile has auto-indexing switched off.
    Disabled,
    /// The app's own state is not registered yet.
    NotReady,
    /// Indexing was attempted and failed.
    Failed(String),
    /// A tick panicked. The loop survives it; this says it happened.
    Panicked(String),
}

impl TickOutcome {
    /// One line for the log. English, and readable by someone who did not write
    /// this file — these go to a terminal during development, not to the user.
    fn describe(&self) -> String {
        match self {
            Self::Indexed(n) => format!("indexed {n} capture(s)"),
            Self::Idle => "up to date — nothing waiting to be indexed".to_string(),
            Self::NoStore => "cannot read the app's settings — not indexing".to_string(),
            Self::NoProfile => "no profile is set up — not indexing".to_string(),
            Self::Disabled => "auto-indexing is switched off for this profile".to_string(),
            Self::NotReady => "the app is still starting up — not indexing".to_string(),
            Self::Failed(e) => format!("could not index: {e}"),
            Self::Panicked(e) => {
                format!("a tick crashed ({e}) — the loop is still running and will try again")
            }
        }
    }
}

/// What one tick produced: its outcome, and — separately, because it is true of
/// working ticks too — whether the profile it used came from the frontend's
/// fallback rather than the stored active id.
struct TickReport {
    outcome: TickOutcome,
    fallback_profile: Option<String>,
}

/// Everything a tick needs from the on-disk store, read in one pass.
enum TickPlan {
    Run {
        user_id: String,
        openai_api_key: Option<String>,
        fallback_profile: Option<String>,
    },
    Skip(TickReport),
}

/// The decision a tick makes before doing any work, as a pure function of what the
/// store holds. Returns the profile to index for, and the fallback note that has to
/// travel with it whether or not indexing goes ahead.
///
/// `read_enabled` is only called once a profile is known, because the setting is
/// stored per profile and there is no key to read without one.
fn tick_decision<F>(
    profiles_raw: Option<Value>,
    active_raw: Option<Value>,
    read_enabled: F,
) -> (Option<String>, Result<String, TickOutcome>)
where
    F: FnOnce(&str) -> Option<Value>,
{
    let (user_id, fallback) = match resolve_profile(profiles_raw, active_raw) {
        ProfileChoice::Stored(id) => (id, None),
        ProfileChoice::FellBack(id) => (id.clone(), Some(id)),
        ProfileChoice::None => return (None, Err(TickOutcome::NoProfile)),
    };
    if !auto_index_enabled(read_enabled(&user_id)) {
        return (fallback, Err(TickOutcome::Disabled));
    }
    (fallback, Ok(user_id))
}

/// Read the store once and decide. The store handle is not held past this function:
/// nothing below it awaits with a handle on disk state that the frontend also writes.
fn resolve_tick(app: &tauri::AppHandle) -> TickPlan {
    let Ok(store) = app.store(FRONTEND_SESSION_STORE_FILE) else {
        return TickPlan::Skip(TickReport {
            outcome: TickOutcome::NoStore,
            fallback_profile: None,
        });
    };
    let (fallback_profile, decision) = tick_decision(
        store.get(PROFILES_STORE_KEY),
        store.get(ACTIVE_PROFILE_STORE_KEY),
        |uid| store.get(scoped_key(uid, AUTO_INDEX_ENABLED_KEY)),
    );
    let user_id = match decision {
        Ok(id) => id,
        Err(outcome) => {
            return TickPlan::Skip(TickReport {
                outcome,
                fallback_profile,
            })
        }
    };
    let openai_api_key = store
        .get(scoped_key(&user_id, OPENAI_API_KEY_KEY))
        .and_then(|v| v.as_str().map(str::trim).map(String::from))
        .filter(|k| !k.is_empty());
    TickPlan::Run {
        user_id,
        openai_api_key,
        fallback_profile,
    }
}

/// One pass. Anything that goes wrong is reported and swallowed: a profile whose DB
/// cannot be opened must not take the loop down with it, and a capture that fails
/// forever must not stop every later tick (`index_pending_captures` already marks
/// per-capture failures so they are not retried endlessly).
async fn run_tick(app: &tauri::AppHandle) -> TickReport {
    let (user_id, openai_api_key, fallback_profile) = match resolve_tick(app) {
        TickPlan::Skip(report) => return report,
        TickPlan::Run {
            user_id,
            openai_api_key,
            fallback_profile,
        } => (user_id, openai_api_key, fallback_profile),
    };
    let (Some(embed_lock), Some(index)) = (
        app.try_state::<crate::EmbedLockState>(),
        app.try_state::<crate::local_index::LocalIndexState>(),
    ) else {
        return TickReport {
            outcome: TickOutcome::NotReady,
            fallback_profile,
        };
    };
    let outcome = match crate::local_index_commands::index_pending_for_user(
        app,
        &user_id,
        openai_api_key,
        BATCH_LIMIT,
        &embed_lock,
        &index,
    )
    .await
    {
        Ok(0) => TickOutcome::Idle,
        Ok(n) => TickOutcome::Indexed(n),
        Err(e) => TickOutcome::Failed(e),
    };
    TickReport {
        outcome,
        fallback_profile,
    }
}

/// What a panic payload says, as far as it can be recovered.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".to_string())
}

/// Start the loop. Called once at setup; runs for the lifetime of the app.
///
/// The first tick waits a full interval so the frontend has had time to load the
/// store; captures added in the meantime are indexed on demand by
/// `local_index_pending_cmd` rather than waiting for this loop.
///
/// Two properties the `setInterval` this replaced had for free, and which had to be
/// rebuilt here:
///
/// - **It survives a panic.** `catch_unwind` per tick is the `try/catch` the
///   interval had. Without it one panic ends auto-indexing until the app is
///   restarted, with nothing printed — and the path is real: `Store::get` is a
///   `lock().unwrap()`, so a panic anywhere else in the app while that mutex is held
///   poisons it and every later tick dies on the first store read.
/// - **It says what it is doing.** But only when the answer changes: a heartbeat
///   every fifteen seconds is its own kind of silence. The memo below is why the log
///   reads as a list of transitions rather than a stream.
pub fn start_auto_index_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_outcome: Option<TickOutcome> = None;
        let mut last_fallback: Option<String> = None;
        loop {
            tokio::time::sleep(TICK_INTERVAL).await;
            let report = match AssertUnwindSafe(run_tick(&app)).catch_unwind().await {
                Ok(report) => report,
                Err(payload) => TickReport {
                    outcome: TickOutcome::Panicked(panic_text(payload.as_ref())),
                    // A panicked tick learnt nothing about the profile; keep what the
                    // last one knew so the transition log does not invent a change.
                    fallback_profile: last_fallback.clone(),
                },
            };

            if report.fallback_profile != last_fallback {
                if let Some(id) = &report.fallback_profile {
                    eprintln!(
                        "[auto-index] the saved active profile is not in the profile list; \
                         using the first profile ({id}) instead, like the app window does"
                    );
                }
                last_fallback = report.fallback_profile.clone();
            }

            // Real work is always worth a line. Everything else only when it changes.
            let worth_saying = matches!(report.outcome, TickOutcome::Indexed(_))
                || last_outcome.as_ref() != Some(&report.outcome);
            if worth_saying {
                eprintln!("[auto-index] {}", report.outcome.describe());
            }
            last_outcome = Some(report.outcome);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The loop's *timing* is not unit-testable: it needs a running app and a real
    // clock. What is testable is the decision a tick makes before doing any work.

    /// A profile list as `profileContext.tsx` persists it.
    fn profiles(ids: &[&str]) -> Option<Value> {
        Some(Value::Array(
            ids.iter()
                .map(|id| json!({ "id": id, "name": id, "createdAt": "2026-01-01T00:00:00Z" }))
                .collect(),
        ))
    }

    /// The profile a tick would index for, dropping the fallback note.
    fn chosen<F>(profiles_raw: Option<Value>, active_raw: Option<Value>, read_enabled: F) -> Option<String>
    where
        F: FnOnce(&str) -> Option<Value>,
    {
        tick_decision(profiles_raw, active_raw, read_enabled).1.ok()
    }

    #[test]
    fn no_active_profile_means_no_work() {
        for active in [None, Some(Value::Null), Some(json!("")), Some(json!("   "))] {
            assert_eq!(chosen(None, active.clone(), |_| Some(json!(true))), None);
            // And with profiles on disk the frontend's fallback applies instead of nothing.
            assert_eq!(
                chosen(profiles(&["u1"]), active, |_| Some(json!(true))),
                Some("u1".to_string())
            );
        }
    }

    #[test]
    fn auto_index_turned_off_means_no_work() {
        assert_eq!(
            tick_decision(profiles(&["u1"]), Some(json!("u1")), |_| Some(json!(false))).1,
            Err(TickOutcome::Disabled)
        );
    }

    #[test]
    fn active_profile_with_setting_on_is_indexed() {
        assert_eq!(
            chosen(profiles(&["u1"]), Some(json!("u1")), |_| Some(json!(true))),
            Some("u1".to_string())
        );
    }

    #[test]
    fn missing_setting_defaults_to_on_like_the_toggle() {
        assert_eq!(
            chosen(profiles(&["u1"]), Some(json!("u1")), |_| None),
            Some("u1".to_string())
        );
        assert_eq!(
            chosen(profiles(&["u1"]), Some(json!("u1")), |_| Some(Value::Null)),
            Some("u1".to_string())
        );
    }

    #[test]
    fn setting_is_read_for_the_active_profile() {
        let seen = std::cell::RefCell::new(String::new());
        let _ = tick_decision(profiles(&["u42"]), Some(json!("u42")), |uid| {
            *seen.borrow_mut() = uid.to_string();
            Some(json!(true))
        });
        assert_eq!(seen.into_inner(), "u42");
        assert_eq!(scoped_key("u42", AUTO_INDEX_ENABLED_KEY), "u:u42:autoIndexEnabled");
    }

    /// The loop must land on the same profile the window is showing. `profileContext`
    /// validates the stored id against the profile list and falls back to the first
    /// one without persisting the correction, so the raw key alone is not the answer.
    #[test]
    fn the_loop_resolves_the_profile_the_way_the_window_does() {
        assert_eq!(
            resolve_profile(profiles(&["u1", "u2"]), Some(json!("u2"))),
            ProfileChoice::Stored("u2".to_string())
        );
        // Stored id names no profile → the window's fallback, and so this loop's.
        assert_eq!(
            resolve_profile(profiles(&["u1", "u2"]), Some(json!("gone"))),
            ProfileChoice::FellBack("u1".to_string())
        );
        // Id absent, profiles present: reading the raw key alone would give up here
        // and auto-indexing would be dead for the session.
        assert_eq!(
            resolve_profile(profiles(&["u1"]), None),
            ProfileChoice::FellBack("u1".to_string())
        );
        // A valid-looking id with no profile list is still nothing — `stored[0]?.id
        // ?? null` in the frontend reaches the same conclusion.
        assert_eq!(resolve_profile(None, Some(json!("u1"))), ProfileChoice::None);
        assert_eq!(resolve_profile(profiles(&[]), Some(json!("u1"))), ProfileChoice::None);
    }

    /// Falling back is worth saying out loud, and the note has to survive a tick that
    /// decides not to index — otherwise the one case where the disagreement matters
    /// most, a profile that is both wrong and switched off, reports nothing.
    #[test]
    fn a_fallback_is_reported_even_when_the_tick_does_nothing() {
        let (fallback, decision) =
            tick_decision(profiles(&["u1"]), Some(json!("gone")), |_| Some(json!(false)));
        assert_eq!(fallback, Some("u1".to_string()));
        assert_eq!(decision, Err(TickOutcome::Disabled));

        let (fallback, _) = tick_decision(profiles(&["u1"]), Some(json!("u1")), |_| Some(json!(true)));
        assert_eq!(fallback, None, "a profile that matched was reported as a fallback");
    }

    /// Every reason a tick has for doing nothing must be distinguishable from every
    /// other, and from the loop being dead. They were all the same thing — silence.
    #[test]
    fn every_outcome_says_something_of_its_own() {
        let all = [
            TickOutcome::Indexed(3),
            TickOutcome::Idle,
            TickOutcome::NoStore,
            TickOutcome::NoProfile,
            TickOutcome::Disabled,
            TickOutcome::NotReady,
            TickOutcome::Failed("disk full".to_string()),
            TickOutcome::Panicked("poisoned lock".to_string()),
        ];
        let lines: Vec<String> = all.iter().map(TickOutcome::describe).collect();
        for line in &lines {
            assert!(!line.is_empty());
            assert_eq!(lines.iter().filter(|l| *l == line).count(), 1, "{line} is not unique");
        }
    }

    /// A panic payload has to come out as something, whichever shape it arrives in:
    /// the line it produces is the only trace of a tick that died.
    #[test]
    fn a_panic_is_described_whatever_it_carried() {
        assert_eq!(panic_text(&"poisoned lock"), "poisoned lock");
        assert_eq!(panic_text(&"poisoned lock".to_string()), "poisoned lock");
        assert_eq!(panic_text(&42u8), "no message");
    }
}
