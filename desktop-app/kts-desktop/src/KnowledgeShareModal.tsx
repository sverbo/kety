import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  filterKnowledgeShareStemInput,
  sanitizeKnowledgeShareStem,
  type ShareExpiryUnit,
} from "./uploadService";
import { createShareLink } from "./gcpShareService";
import { copyLocalFileToDownloads } from "./localIndex";

type ShareDestination = "link" | "file";

function isTauriWebview(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (isTauriWebview()) {
    await invoke("copy_text_to_clipboard", { text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

const MAX_HOURS = 7 * 24;
const MAX_DAYS = 7;

export type KnowledgeShareModalProps = {
  open: boolean;
  onClose: () => void;
  /** Local file path to upload — the artifact or the temp ZIP being shared. */
  sourcePath: string;
  /** Local profile id — selects which bucket/service account to use. */
  profileId: string;
  /** Display only, e.g. `.zip` or `.png`; empty if unknown. */
  extensionWithDot: string;
  defaultStem: string;
  onCopied: (message: string) => void;
  /** When set, the quote icon opens Share link history (after closing this modal). */
  onOpenShareLinkHistory?: () => void;
  /** Whether a storage bucket is set up for this profile — gates the "Get a link" destination. */
  sharingConfigured: boolean;
};

export function KnowledgeShareModal({
  open,
  onClose,
  sourcePath,
  profileId,
  extensionWithDot,
  defaultStem,
  onCopied,
  onOpenShareLinkHistory,
  sharingConfigured,
}: KnowledgeShareModalProps) {
  const [destination, setDestination] = useState<ShareDestination>(
    sharingConfigured ? "link" : "file"
  );
  const [stem, setStem] = useState(defaultStem);
  const [expiryUnit, setExpiryUnit] = useState<ShareExpiryUnit>("days");
  const [expiryValue, setExpiryValue] = useState(7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDestination(sharingConfigured ? "link" : "file");
    setStem(filterKnowledgeShareStemInput(defaultStem));
    setExpiryUnit("days");
    setExpiryValue(7);
    setErr(null);
    setBusy(false);
  }, [open, defaultStem, sharingConfigured]);

  const onSubmit = useCallback(async () => {
    if (!sourcePath.trim()) return;

    if (destination === "file") {
      setBusy(true);
      setErr(null);
      try {
        const destPath = await copyLocalFileToDownloads(sourcePath);
        const filename = destPath.replace(/\\/g, "/").split("/").pop() ?? destPath;
        onCopied(`Saved to your Downloads folder as ${filename}.`);
        onClose();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!sharingConfigured) return;
    const maxVal = expiryUnit === "hours" ? MAX_HOURS : MAX_DAYS;
    const v = Math.floor(Number(expiryValue));
    if (!Number.isFinite(v) || v < 1 || v > maxVal) {
      setErr(
        expiryUnit === "hours"
          ? `Enter a number of hours between 1 and ${MAX_HOURS}.`
          : `Enter a number of days between 1 and ${MAX_DAYS}.`
      );
      return;
    }
    const cleanStem = sanitizeKnowledgeShareStem(stem);
    if (!cleanStem) {
      setErr("Enter a file name.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const expirySeconds = expiryUnit === "hours" ? v * 3600 : v * 86400;
      const downloadFilename = `${cleanStem}${extensionWithDot}`;
      const row = await createShareLink(profileId, sourcePath, downloadFilename, expirySeconds);
      await copyTextToClipboard(row.signedUrl);
      onCopied("Link copied to clipboard.");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    sourcePath,
    destination,
    sharingConfigured,
    profileId,
    stem,
    expiryUnit,
    expiryValue,
    extensionWithDot,
    onCopied,
    onClose,
  ]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card knowledge-share-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Share"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Share</h3>
        <div className="knowledge-share-modal__field">
          <span className="knowledge-share-modal__label" id="knowledge-share-destination-label">
            Share as
          </span>
          <div
            className="knowledge-share-modal__destination-row"
            role="radiogroup"
            aria-labelledby="knowledge-share-destination-label"
          >
            <label
              className={`knowledge-share-modal__destination-option${
                !sharingConfigured ? " knowledge-share-modal__destination-option--disabled" : ""
              }`}
            >
              <input
                type="radio"
                name="knowledge-share-destination"
                value="link"
                checked={destination === "link"}
                onChange={() => setDestination("link")}
                disabled={!sharingConfigured || busy}
              />
              Get a link
            </label>
            <label className="knowledge-share-modal__destination-option">
              <input
                type="radio"
                name="knowledge-share-destination"
                value="file"
                checked={destination === "file"}
                onChange={() => setDestination("file")}
                disabled={busy}
              />
              Save the file
            </label>
          </div>
          {!sharingConfigured ? (
            <p className="knowledge-share-modal__cap">
              Set up a storage bucket in Settings → Sharing to share by link.
            </p>
          ) : null}
        </div>
        {destination === "link" ? (
          <>
            <p className="modal-body knowledge-share-modal__hint">
              <strong>a-z</strong>, <strong>0-9</strong>, underscores and hyphens; space becomes a hyphen.
            </p>
            <div className="knowledge-share-modal__field">
              <label className="knowledge-share-modal__label" htmlFor="knowledge-share-stem">
                File name for recipient
              </label>
              <div className="knowledge-share-modal__name-row">
                <input
                  id="knowledge-share-stem"
                  type="text"
                  className="knowledge-share-modal__input"
                  value={stem}
                  onChange={(e) => setStem(filterKnowledgeShareStemInput(e.target.value))}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                />
                {extensionWithDot ? (
                  <span className="knowledge-share-modal__ext">{extensionWithDot}</span>
                ) : null}
              </div>
            </div>
            <div className="knowledge-share-modal__field">
              <label className="knowledge-share-modal__label" htmlFor="knowledge-share-expiry">
                Link expires after
              </label>
              <div className="knowledge-share-modal__expiry-row">
                <input
                  id="knowledge-share-expiry"
                  type="number"
                  min={1}
                  max={expiryUnit === "hours" ? MAX_HOURS : MAX_DAYS}
                  className="knowledge-share-modal__input knowledge-share-modal__input--narrow"
                  value={expiryValue}
                  onChange={(e) => setExpiryValue(Number(e.target.value))}
                  disabled={busy}
                />
                <select
                  className="knowledge-share-modal__select"
                  value={expiryUnit}
                  onChange={(e) =>
                    setExpiryUnit(e.target.value === "hours" ? "hours" : "days")
                  }
                  disabled={busy}
                  aria-label="Expiry unit"
                >
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
              <p className="knowledge-share-modal__cap">
                Maximum {MAX_DAYS} days ({MAX_HOURS} hours).
              </p>
              <blockquote className="knowledge-share-modal__history-quote" role="note">
                {onOpenShareLinkHistory ? (
                  <button
                    type="button"
                    className="knowledge-share-modal__history-quote-icon-btn"
                    aria-label="Open Share link history"
                    title="Open Share link history"
                    onClick={() => {
                      onClose();
                      onOpenShareLinkHistory();
                    }}
                  >
                    <svg
                      className="knowledge-share-modal__history-quote-svg"
                      width={14}
                      height={14}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 8h9M3 12h7M3 16h9" />
                      <circle cx="17" cy="12" r="4.5" />
                      <path d="M17 9.5V12l2 1.2" />
                    </svg>
                  </button>
                ) : (
                  <span className="knowledge-share-modal__history-quote-icon" aria-hidden>
                    <svg
                      className="knowledge-share-modal__history-quote-svg"
                      width={14}
                      height={14}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 8h9M3 12h7M3 16h9" />
                      <circle cx="17" cy="12" r="4.5" />
                      <path d="M17 9.5V12l2 1.2" />
                    </svg>
                  </span>
                )}
                <span>
                  {onOpenShareLinkHistory ? (
                    <>
                      Tap the icon to open <strong>Share link history</strong> and see your links, copy a URL
                      again, or revoke access.
                    </>
                  ) : (
                    <>
                      Open <strong>Share link history</strong> from the Captures tab to see your links, copy a
                      URL again, or revoke access.
                    </>
                  )}
                </span>
              </blockquote>
            </div>
          </>
        ) : (
          <p className="modal-body knowledge-share-modal__hint">
            The file will be copied to your Downloads folder and revealed in Finder.
          </p>
        )}
        {err ? (
          <p className="knowledge-share-modal__err" role="alert">
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
            onClick={() => void onSubmit()}
            disabled={busy}
          >
            {destination === "file"
              ? busy
                ? "Saving…"
                : "Save file"
              : busy
                ? "Creating…"
                : "Create link & copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
