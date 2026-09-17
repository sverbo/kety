/**
 * The registry of knowledge indexes this profile has imported from someone else.
 *
 * The files live under `local-index/{userId}/assistants/{assistantId}/`, and this
 * list is the only thing that *names* them: an index missing from it is an index
 * the app does not open and does not offer, while still occupying disk. The one
 * way back from that is `listOrphanImportedAssistants` below, which asks the Rust
 * side to enumerate the folder and report what this list does not account for —
 * a floor under the damage, not a substitute for the list. That asymmetry is what
 * decides the order of operations in the functions below:
 *
 * - importing writes the files first, then the entry — and if the entry cannot be
 *   written, it takes the files back off disk rather than leave an invisible one;
 * - deleting removes the files first, then the entry — so a failure leaves a
 *   *visible* entry pointing at nothing, which the user can simply delete again
 *   (deleting a missing assistant succeeds), instead of an invisible folder that
 *   nothing can reach.
 *
 * In both cases the recoverable failure is preferred over the unrecoverable one.
 */

import { load } from "@tauri-apps/plugin-store";
import {
  IMPORTED_ASSISTANTS_KEY,
  SESSION_STORE_FILE,
  sessionStoreKeyForUser,
} from "./sessionStoreUser";
import {
  localDeleteAssistant,
  localImportSharedIndex,
  localListOrphanAssistants,
  type ImportedAssistant,
  type OrphanAssistant,
} from "./localIndex";

export type { ImportedAssistant, OrphanAssistant };

/**
 * What the user is told when the stored list is there but cannot be read.
 *
 * Its own message because the situation is its own: not "you have no imported
 * knowledge" (which is what an empty list means and would make the app say), but
 * "we cannot tell what you have", which is the one case where writing is the
 * worst thing we could do.
 *
 * Exported because throwing is only half the fix. The list is read to *draw the
 * tab strip*, and a caller that catches the throw and draws an empty strip has
 * put the app back exactly where it started — every imported tab gone, nothing
 * said. Whoever catches this needs the sentence, so it lives here rather than
 * being reconstructed at the catch site. It also covers a `load()` that fails
 * outright: from the user's side "the file would not open" and "the value in it
 * is not a list" are the same fact, and neither is theirs to act on beyond
 * restarting.
 */
export const UNREADABLE_IMPORTED_ASSISTANTS_MESSAGE =
  "We could not read your list of shared knowledge, so we left it untouched. Restart the app and try again — your imported knowledge is still on this computer.";

/**
 * Thrown when a delete got through the files but not through the list.
 *
 * Its own type because it is the one delete failure where the answer is *not*
 * "nothing happened". The files are gone; only the entry naming them survives,
 * and deleting again clears it (`delete_assistant` treats a missing directory as
 * success). A caller that catches this must say so and must not leave the user
 * on an assistant that no longer has anything behind it.
 */
export class FilesDeletedButStillListedError extends Error {
  /**
   * What actually failed, for the log. Kept as an own field rather than the
   * standard `cause` option, which this project's ES2020 target does not have.
   */
  readonly reason: unknown;

  constructor(reason: unknown) {
    super(
      "This shared knowledge has been deleted, but we could not update your list, so it is still shown. Delete it again to clear it — nothing else will be removed.",
    );
    this.name = "FilesDeletedButStillListedError";
    this.reason = reason;
  }
}

function storeKey(userId: string): string {
  return sessionStoreKeyForUser(userId, IMPORTED_ASSISTANTS_KEY);
}

/**
 * Keep only entries we can actually act on.
 *
 * An entry whose `assistantId` is missing, blank or not a string is dropped
 * rather than repaired: it cannot address an index, and the one thing that must
 * never happen is such a value reaching `localDeleteAssistant`. Everything else
 * is cosmetic and gets a safe default, so one truncated field does not hide an
 * assistant whose files are perfectly fine.
 *
 * **A value that is present but not a list throws.** Absent is a fact — this
 * profile has imported nothing — and an empty list says it correctly. Anything
 * else is a registry we failed to read, and returning `[]` for it would be a
 * read failure quietly promoted into a write: the caller edits that empty list
 * and saves it back, and every imported assistant's files become unreachable in
 * one store write. Throwing here is what makes that impossible; `undefined` and
 * `null` are the only values allowed to mean "nothing yet".
 */
function parseImportedAssistants(raw: unknown): ImportedAssistant[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(UNREADABLE_IMPORTED_ASSISTANTS_MESSAGE);
  const out: ImportedAssistant[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const assistantId = typeof r.assistantId === "string" ? r.assistantId.trim() : "";
    if (!assistantId) continue;
    if (seen.has(assistantId)) continue;
    seen.add(assistantId);
    out.push({
      assistantId,
      name: typeof r.name === "string" && r.name.trim() ? r.name : "Shared knowledge",
      exportId: typeof r.exportId === "string" ? r.exportId : "",
      captureCount: typeof r.captureCount === "number" && Number.isFinite(r.captureCount) ? r.captureCount : 0,
      embedModel: typeof r.embedModel === "string" ? r.embedModel : "",
      importedAt: typeof r.importedAt === "string" ? r.importedAt : "",
    });
  }
  return out;
}

/**
 * Imported assistants of this profile, newest last.
 *
 * Individual bad *entries* are dropped silently; a stored value that is not a
 * list at all throws, because that is the difference between "one entry is
 * damaged" and "we cannot tell what is registered". Callers that only display
 * the list should catch and show nothing; callers that are about to write must
 * not.
 */
export async function loadImportedAssistants(userId: string): Promise<ImportedAssistant[]> {
  const st = await load(SESSION_STORE_FILE);
  return parseImportedAssistants(await st.get<unknown>(storeKey(userId)));
}

/**
 * Replace the list wholesale. Callers pass the result of editing what they loaded.
 *
 * The stored value is read once more first, and an unreadable one stops the
 * write here rather than being overwritten by it. Every caller does load-edit-
 * save and would already have thrown at the load, so this costs one `get` and
 * closes the door for the next caller who does not.
 *
 * **A failed `save()` puts the in-memory value back.** `set` and `save` are two
 * steps against one shared store: `set` lands in memory immediately and `save`
 * is the half that fails on a full or read-only disk. Leaving the `set` standing
 * after that would publish the new list anyway — `loadImportedAssistants` reads
 * through `get`, so it would see it; every other subsystem writing to this same
 * store calls `save()` on it, so the first of those to succeed would commit it;
 * and the store plugin's own autosave can commit it with no explicit save at
 * all. The caller that rolls an import back off disk on this error would then be
 * leaving an entry for files it just deleted, under a message saying nothing was
 * imported. Restoring the previous value is what makes that message true.
 */
export async function saveImportedAssistants(
  userId: string,
  list: ImportedAssistant[],
): Promise<void> {
  const st = await load(SESSION_STORE_FILE);
  const key = storeKey(userId);
  const previous = await st.get<unknown>(key);
  // Throws on a value that is present but unreadable — see parseImportedAssistants.
  parseImportedAssistants(previous);
  await st.set(key, list);
  try {
    await st.save();
  } catch (e) {
    try {
      // `undefined` is not a value the store holds — the key was simply absent,
      // and putting `undefined` back would leave it present and empty.
      if (previous === undefined) await st.delete(key);
      else await st.set(key, previous);
    } catch (restoreErr) {
      // Nothing left to try. The caller is about to report a failed write, which
      // is still the truthful half of what happened.
      console.error("[imported-assistants] restore after failed save:", restoreErr);
    }
    throw e;
  }
}

/**
 * Imported-knowledge folders on disk that this profile's list does not account
 * for — sorted by id, each with the space it takes.
 *
 * Nothing here deletes: an orphan may be an index the user would rather see
 * registered again than lose. Removing one is `removeImportedAssistant`, called
 * deliberately, with the `assistantId` this reports.
 *
 * Throws if the list itself cannot be read — with no idea what is registered,
 * every folder would look abandoned, and a user acting on that would delete
 * assistants that are perfectly fine.
 */
export async function listOrphanImportedAssistants(userId: string): Promise<OrphanAssistant[]> {
  const known = await loadImportedAssistants(userId);
  return localListOrphanAssistants(userId, known.map((a) => a.assistantId));
}

/**
 * Import a shared index and register it, as one operation.
 *
 * This is what UI should call — `localImportSharedIndex` on its own creates an
 * assistant nothing can find.
 *
 * The store is read once *before* the import as well, so a registry that cannot
 * be **read** is discovered while there is still nothing on disk to undo. That
 * is all a `load()` proves: it says nothing about whether the store can be
 * written. A read-only volume, a full disk or a locked file still fails at the
 * `set`/`save` below — after the files exist — which is why the failure there is
 * caught and the import taken back off disk rather than assumed impossible.
 *
 * It is read again afterwards rather than reusing that first result, so an entry
 * added meanwhile is not dropped.
 */
export async function addImportedAssistant(
  userId: string,
  source: string,
  isUrl: boolean,
  name?: string | null,
): Promise<ImportedAssistant> {
  // Cheapest possible proof that the registry is usable, before anything exists.
  await loadImportedAssistants(userId);

  const imported = await localImportSharedIndex(userId, source, isUrl, name);

  try {
    const current = await loadImportedAssistants(userId);
    await saveImportedAssistants(userId, [
      ...current.filter((a) => a.assistantId !== imported.assistantId),
      imported,
    ]);
  } catch {
    // The index is on disk and nothing lists it. Leaving it there would be a
    // folder the user can never see, use or remove, so undo the import.
    try {
      await localDeleteAssistant(userId, imported.assistantId);
    } catch {
      // Both halves failed: the entry was never written and the files could not
      // be removed. The old advice here — "if it appears twice, remove the one
      // you do not want" — could not happen: an import that never reached the
      // list cannot appear in it at all, so the user was being asked to clean up
      // something they had no way to reach. What is true is that the copy is on
      // disk, unlisted, and that `listOrphanImportedAssistants` is what finds it.
      throw new Error(
        "We could not add this shared knowledge to your list, and could not remove the copy we had already made. Its files are still on this computer and the app cannot show them — importing again will make a second copy rather than replace it.",
      );
    }
    throw new Error("We could not add this shared knowledge to your list, so nothing was imported.");
  }

  return imported;
}

/**
 * Change the name an imported assistant is listed under. Touches nothing else.
 *
 * The name is the one field of an entry that is purely for the person reading
 * it: the assistant is addressed by `assistantId` everywhere, and the files on
 * disk carry the sender's own name in their manifest regardless. So this is a
 * store write and nothing more — there is no matching call on the Rust side and
 * a failure here loses a label, not an index.
 *
 * An assistant that is not listed is not an error. The entry can have been
 * dropped between the read and this call (another window deleting it), and the
 * name of something that is gone is not worth failing over.
 */
export async function renameImportedAssistant(
  userId: string,
  assistantId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!assistantId.trim() || !trimmed) return;
  const current = await loadImportedAssistants(userId);
  if (!current.some((a) => a.assistantId === assistantId)) return;
  await saveImportedAssistants(
    userId,
    current.map((a) => (a.assistantId === assistantId ? { ...a, name: trimmed } : a)),
  );
}

/**
 * Remove an imported assistant: its files, then its entry.
 *
 * Files first on purpose. The other order would, on a failed delete, leave a
 * folder with no entry pointing at it — unreachable and unremovable. This order
 * leaves at worst an entry with no folder, which deleting again clears.
 *
 * That choice is only defensible if the caller can tell the two halves apart, so
 * the second half throws its own type. A failure *before* `localDeleteAssistant`
 * returns means nothing was touched; a failure after it means the captures and
 * media are gone and only the entry is left. Reporting the second as the first
 * would tell the user their knowledge is safe at the moment it stopped being.
 */
export async function removeImportedAssistant(userId: string, assistantId: string): Promise<void> {
  if (!assistantId.trim()) {
    throw new Error("We cannot remove an assistant without knowing which one, so nothing was deleted.");
  }
  await localDeleteAssistant(userId, assistantId);
  try {
    const current = await loadImportedAssistants(userId);
    await saveImportedAssistants(
      userId,
      current.filter((a) => a.assistantId !== assistantId),
    );
  } catch (e) {
    // Includes the unreadable-registry case, whose own message ("we left it
    // untouched") is true of the list and false of the files by this point.
    throw new FilesDeletedButStillListedError(e);
  }
}
