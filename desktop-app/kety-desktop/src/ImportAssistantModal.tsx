import { useCallback, useState } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import {
  addImportedAssistant,
  renameImportedAssistant,
  type ImportedAssistant,
} from "./importedAssistants";
import { friendlyMessage } from "./friendlyMessage";

export type ImportAssistantModalProps = {
  /** Local profile id — whose list of shared knowledge this is added to. */
  userId: string;
  /** Leave without adding anything, or after the name step is done. */
  onClose: () => void;
  /**
   * Called once the index is on disk **and** listed, with the id of what was
   * added. The parent re-reads the registry from this — nothing else does — so
   * it has to run even when the user leaves by the name step's back door.
   */
  onImported: (assistantId: string) => void | Promise<void>;
};

/** The last path segment, which is what the user recognises a file by. */
function fileLabel(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}


/**
 * Add a knowledge index somebody shared, as a read-only assistant of this profile.
 *
 * Two screens, and the split is not cosmetic. The first takes the link or the
 * file and does the slow part; the second names what came back. The name can
 * only be asked for afterwards because the suggestion comes out of the archive's
 * own manifest, which nothing on this machine has seen until the import has
 * downloaded, validated and adopted it.
 *
 * That ordering means the assistant is already listed by the time the name field
 * appears, so the second screen *renames* an entry rather than creating one. The
 * alternative — asking for a name first and passing it into the import — would
 * have made the field a blank box with nothing to suggest, which is precisely
 * the moment the user knows least about what they are naming.
 *
 * Failures on the first screen keep the modal open with what was typed still
 * there: the two routes in are interchangeable, and a link that will not download
 * is the most likely reason to reach for the file instead.
 */
export function ImportAssistantModal({ userId, onClose, onImported }: ImportAssistantModalProps) {
  const [url, setUrl] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Set once the import is on disk and listed — the modal is on its second screen. */
  const [added, setAdded] = useState<ImportedAssistant | null>(null);
  const [name, setName] = useState("");

  const chooseFile = useCallback(async () => {
    setErr(null);
    try {
      const result = await openFilePicker({
        multiple: false,
        filters: [{ name: "Shared knowledge", extensions: ["zip"] }],
      });
      if (!result) return;
      const path = typeof result === "string" ? result : (result as { path: string }).path;
      setFilePath(path);
      // One source at a time, so the button below never has to guess which of the
      // two the user meant.
      setUrl("");
    } catch (e) {
      setErr(friendlyMessage(e, "We could not open the file chooser. Please try again."));
    }
  }, []);

  const source = filePath ?? url.trim();
  const isUrl = filePath == null;

  const runImport = useCallback(async () => {
    if (busy || !source) return;
    setBusy(true);
    setErr(null);
    try {
      // `addImportedAssistant`, never `localImportSharedIndex`: the raw call
      // leaves an index on disk that nothing lists and nothing can remove.
      const imported = await addImportedAssistant(userId, source, isUrl, null);
      setAdded(imported);
      setName(imported.name);
    } catch (e) {
      // The sentence is shown as written — it names the guard that refused the
      // archive, and replacing it with something general would take away the
      // only thing telling the user whether to retry or ask for another file.
      // What `friendlyMessage` removes is the tail the Rust side appends after
      // the colon: a URL, an OS error number, a path on disk. None of that is
      // actionable by the person reading, and all of it goes to the console.
      setErr(
        friendlyMessage(
          e,
          "We could not add this shared knowledge. Check the link or the file and try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, source, isUrl, userId]);

  /** Leave the second screen. The import stands either way; only the name is at stake. */
  const finishNaming = useCallback(
    async (save: boolean) => {
      if (!added || busy) return;
      const trimmed = name.trim();
      if (save && trimmed && trimmed !== added.name) {
        setBusy(true);
        setErr(null);
        try {
          await renameImportedAssistant(userId, added.assistantId, trimmed);
        } catch (e) {
          setErr(friendlyMessage(e, "We could not save that name."));
          setBusy(false);
          return;
        }
        setBusy(false);
      }
      await onImported(added.assistantId);
      onClose();
    },
    [added, busy, name, userId, onImported, onClose],
  );

  if (added) {
    return (
      <div className="modal-overlay">
        <div
          className="modal-card import-assistant-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Name this knowledge"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="modal-title">Name this knowledge</h3>
          <p className="modal-body import-assistant-modal__intro">
            {added.captureCount === 1
              ? "Added, with 1 capture. This is the name it will show in your chat — change it if you like."
              : `Added, with ${added.captureCount} captures. This is the name it will show in your chat — change it if you like.`}
          </p>

          <div className="import-assistant-modal__field">
            <label className="import-assistant-modal__label" htmlFor="import-assistant-name">
              Name
            </label>
            <input
              id="import-assistant-name"
              type="text"
              className="import-assistant-modal__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>

          {err ? (
            <p className="import-assistant-modal__err" role="alert">
              {err} It was added as “{added.name}”, and you can keep using it under that name.
            </p>
          ) : null}

          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn modal-btn--cancel"
              onClick={() => void finishNaming(false)}
              disabled={busy}
            >
              Keep “{added.name}”
            </button>
            <button
              type="button"
              className="modal-btn modal-btn--primary"
              onClick={() => void finishNaming(true)}
              disabled={busy || !name.trim()}
            >
              {busy ? "Saving…" : "Done"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="modal-card import-assistant-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add shared knowledge"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Add shared knowledge</h3>
        <p className="modal-body import-assistant-modal__intro">
          When someone shares their knowledge with you, they send a link or a file. Add it here and
          you can ask it questions in its own chat. Your own knowledge is not touched, and you
          cannot add anything to theirs.
        </p>

        <div className="import-assistant-modal__field">
          <label className="import-assistant-modal__label" htmlFor="import-assistant-url">
            Paste the link they sent you
          </label>
          <input
            id="import-assistant-url"
            type="text"
            className="import-assistant-modal__input"
            value={url}
            placeholder="https://…"
            onChange={(e) => {
              setUrl(e.target.value);
              // Typing a link is a choice of route; drop the file so the two
              // cannot both be armed.
              if (e.target.value) setFilePath(null);
            }}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </div>

        <div className="import-assistant-modal__field">
          <span className="import-assistant-modal__label">Or choose the file they sent you</span>
          <div className="import-assistant-modal__file-row">
            <button
              type="button"
              className="modal-btn modal-btn--cancel import-assistant-modal__file-btn"
              onClick={() => void chooseFile()}
              disabled={busy}
            >
              {filePath ? "Choose another file…" : "Choose a file…"}
            </button>
            {filePath ? (
              <span className="import-assistant-modal__file-name" title={filePath}>
                {fileLabel(filePath)}
              </span>
            ) : null}
          </div>
        </div>

        {busy ? (
          <p className="import-assistant-modal__hint" role="status">
            Adding this knowledge. It is downloaded and checked before anything is kept, so it can
            take a minute — please leave this open.
          </p>
        ) : null}

        {err ? (
          <p className="import-assistant-modal__err" role="alert">
            {err}
          </p>
        ) : null}

        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn modal-btn--cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn modal-btn--primary"
            onClick={() => void runImport()}
            disabled={busy || !source}
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
