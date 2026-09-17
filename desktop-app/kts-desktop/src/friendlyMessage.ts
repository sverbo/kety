/**
 * Turning a message thrown by the Rust side into one a person can be shown.
 *
 * The local commands write their failures as a plain sentence followed by the
 * underlying error — `format!("We could not download the shared index: {e}")`.
 * The sentence is the part written for the reader; the tail is `io::Error`,
 * `ureq::Error` or `rusqlite::Error` rendering itself, and it carries OS error
 * numbers, filesystem paths and full URLs. Rendering the whole string puts all
 * of that in front of someone who cannot act on any of it.
 *
 * So the split is made here, once, rather than in forty Rust strings: everything
 * up to the first `": "` is kept, everything after it goes to the console. A
 * message with no such separator is a sentence on its own and survives
 * untouched — which is why the guards that refuse an archive ("This archive is
 * not a valid shared knowledge index…") read exactly as written.
 *
 * `": "` and not `":"` on purpose: `"…from an http:// or https:// link."` is a
 * real user-facing message and must not be cut at its scheme.
 */

/** The message inside whatever was thrown, or `""` if there is none. */
function rawMessage(e: unknown): string {
  if (typeof e === "string") return e.trim();
  if (e instanceof Error) return e.message.trim();
  if (e != null && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m.trim();
  }
  return "";
}

/**
 * Residue that means the split did not find a written sentence — either the
 * error never had one (a Tauri-level rejection, a bug reaching the surface) or
 * the sentence itself is technical. In both cases the caller's `fallback` is
 * the better thing to show.
 *
 * The lower-case test is the widest of the three, and the one that catches the
 * common shape: a Rust error written for a log rather than a reader — `format!
 * ("coverage models: {e}")`, `format!("write probe failed ({e})")` — puts a
 * fragment before the colon that this function would otherwise hand over
 * capitalised-by-nobody and full-stopped by us, as in "coverage models.". Every
 * message on the other side written *for* a reader is a sentence and starts
 * with a capital, so the two are told apart by the convention they already
 * follow. Getting it wrong in this direction costs the caller's `fallback`,
 * which its own contract requires to be a complete, actionable sentence.
 */
function stillTechnical(s: string): boolean {
  return s.includes("os error") || s.includes("\n") || /^[a-z_]+::/.test(s) || /^[a-z]/.test(s);
}

/**
 * A sentence to show the user, with the full error kept in the console.
 *
 * `fallback` is what is shown when nothing usable can be recovered — write it
 * as a complete, actionable sentence, because it is the whole message when it
 * is used.
 */
export function friendlyMessage(e: unknown, fallback: string): string {
  const raw = rawMessage(e);
  // Never lost, only moved: this is the line that keeps the URL, the errno and
  // the path available to whoever is debugging.
  console.error("[kety]", raw || e);
  if (!raw) return fallback;

  const cut = raw.indexOf(": ");
  let head = cut > 0 ? raw.slice(0, cut).trim() : raw;
  if (!head || stillTechnical(head)) return fallback;
  // Cutting at the colon takes the sentence's punctuation with it.
  if (!/[.!?…]$/.test(head)) head = `${head}.`;
  return head;
}
