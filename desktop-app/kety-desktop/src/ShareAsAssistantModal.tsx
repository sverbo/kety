import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { localBuildIndexExport } from "./localIndex";
import { sanitizeKnowledgeShareStem } from "./uploadService";
import { localDateStr } from "./captureDisplayHelpers";
import type { CaptureTag } from "./appTypes";

/** The little a capture has to tell us for the curation rules to apply to it. */
export type ShareAsAssistantCapture = {
  id: string;
  tagIds?: string[];
  /** Absent means the capture was never scanned — not that it came back clean. */
  sensitiveVerdict?: "critical" | "potential" | "clean";
  /** `"excluded"` means the user took this out of their own assistant. */
  indexState?: string;
};

export type ShareAsAssistantModalProps = {
  open: boolean;
  onClose: () => void;
  /** Local profile id — whose index the captures are copied out of. */
  userId: string;
  /** The captures the user selected in the list, before any narrowing here. */
  selectedCaptures: ShareAsAssistantCapture[];
  captureTags: CaptureTag[];
  /**
   * Called the instant the archive exists on disk, before the user has been shown
   * anything about it. Ownership of the temp file starts here, not at `onBuilt`:
   * the modal can leave by a route it does not control (the tab unmounting under
   * it), and only the parent outlives that. The parent must keep the path until
   * it is sent or discarded.
   */
  onArchiveStaged: (zipPath: string) => void;
  /** Throws away the archive registered by `onArchiveStaged` — the user backed out. */
  onDiscardStagedArchive: () => void;
  /**
   * Handed the finished archive. The caller owns the file from this point on,
   * including deleting it — it sits in a temp folder nothing else revisits.
   */
  onBuilt: (zipPath: string, suggestedStem: string) => void;
};

/** Chip id standing for "this capture carries none of the tags below".
 *  Real tag ids are UUIDs, so it cannot collide with one. */
const NO_TAG = "__untagged__";

function defaultExportName(): string {
  return `Shared captures — ${localDateStr(new Date().toISOString())}`;
}

/**
 * Narrows the current selection down to what the user actually means to send,
 * then builds the archive.
 *
 * Nothing under this modal re-applies the sensitive rules: `build_index_export_cmd`
 * exports precisely the ids it is handed. So the opt-ins here are the whole of the
 * "nothing leaves by accident" guarantee, which is why every one of them starts
 * off — at-risk, critical, captures removed from the user's own assistant, media
 * files and window titles — and why the count below the options is computed from
 * the same array that is sent to the backend rather than from a parallel tally.
 */
export function ShareAsAssistantModal({
  open,
  onClose,
  userId,
  selectedCaptures,
  captureTags,
  onArchiveStaged,
  onDiscardStagedArchive,
  onBuilt,
}: ShareAsAssistantModalProps) {
  const [name, setName] = useState(defaultExportName);
  const [includedTagIds, setIncludedTagIds] = useState<string[]>([]);
  const [includeAtRisk, setIncludeAtRisk] = useState(false);
  const [includeCritical, setIncludeCritical] = useState(false);
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [includeMedia, setIncludeMedia] = useState(false);
  const [includeWindowTitles, setIncludeWindowTitles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Set once the archive exists but the user still has to be told something. */
  const [built, setBuilt] = useState<
    { path: string; stem: string; mediaWritten: number; mediaSkipped: number } | null
  >(null);

  /**
   * Each selected capture with its tags reduced to the ones that still exist.
   * A capture whose only tag has since been deleted counts as untagged, so it
   * lands under the "No tag" chip instead of matching no chip at all and
   * disappearing from the export with nothing on screen to explain why.
   */
  const captures = useMemo(() => {
    const known = new Set(captureTags.map((t) => t.id));
    return selectedCaptures.map((c) => ({
      id: c.id,
      sensitiveVerdict: c.sensitiveVerdict,
      indexState: c.indexState,
      tags: (c.tagIds ?? []).filter((id) => known.has(id)),
    }));
  }, [selectedCaptures, captureTags]);

  /** Only the tags someone in this selection actually carries — a chip that can
   *  never change the count is noise in a screen about being precise. */
  const tagsInSelection = useMemo(
    () => captureTags.filter((t) => captures.some((c) => c.tags.includes(t.id))),
    [captureTags, captures],
  );
  const hasUntagged = useMemo(() => captures.some((c) => c.tags.length === 0), [captures]);

  const chipIdsKey = useMemo(
    () => [...tagsInSelection.map((t) => t.id), ...(hasUntagged ? [NO_TAG] : [])].join("\n"),
    [tagsInSelection, hasUntagged],
  );

  // Every choice goes back to its default each time the modal opens: an opt-in
  // left over from a previous share is exactly the kind of thing that sends
  // something the user did not mean to send.
  // Opening is the only thing that resets the rest of the screen. It used to also
  // run whenever the chip set changed — a parent reload dropping a capture, a tag
  // renamed or deleted — which threw away the typed name, discarded an already
  // built archive along with the notice about it, and re-enabled Prepare in the
  // middle of a build so a second export could start on top of the first.
  useEffect(() => {
    if (!open) return;
    setName(defaultExportName());
    setIncludeAtRisk(false);
    setIncludeCritical(false);
    setIncludeRemoved(false);
    setIncludeMedia(false);
    setIncludeWindowTitles(false);
    setErr(null);
    setBusy(false);
    setBuilt(null);
  }, [open]);

  // The chips are the one thing that does have to follow the tag set: a chip that
  // no longer exists cannot be ticked, and a new one starts on. This touches the
  // selection and nothing else.
  useEffect(() => {
    if (!open) return;
    setIncludedTagIds(chipIdsKey ? chipIdsKey.split("\n") : []);
  }, [open, chipIdsKey]);

  const toggleChip = useCallback((id: string) => {
    setIncludedTagIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  /** The selection after the chips, before the sensitive opt-ins. */
  const tagFiltered = useMemo(
    () =>
      captures.filter((c) =>
        c.tags.length === 0
          ? includedTagIds.includes(NO_TAG)
          : c.tags.some((id) => includedTagIds.includes(id)),
      ),
    [captures, includedTagIds],
  );

  // Counted after the chips, so ticking an opt-in adds exactly the number shown.
  const atRiskCount = useMemo(
    () => tagFiltered.filter((c) => c.sensitiveVerdict === "potential").length,
    [tagFiltered],
  );
  const criticalCount = useMemo(
    () => tagFiltered.filter((c) => c.sensitiveVerdict === "critical").length,
    [tagFiltered],
  );
  // No verdict at all means nobody ever looked at this capture — not that it came
  // back clean. These still go out (that is what the user picked), but saying
  // nothing about them would read as "checked and fine".
  const unscannedCount = useMemo(
    () => tagFiltered.filter((c) => c.sensitiveVerdict == null).length,
    [tagFiltered],
  );
  const removedCount = useMemo(
    () => tagFiltered.filter((c) => c.indexState === "excluded").length,
    [tagFiltered],
  );

  // A count that drops to zero takes its checkbox off the screen with it. The
  // flag has to go back to false at the same moment, or the tick the user gave
  // for one set of captures silently applies to whichever set shows up next.
  useEffect(() => {
    if (atRiskCount === 0) setIncludeAtRisk(false);
  }, [atRiskCount]);
  useEffect(() => {
    if (criticalCount === 0) setIncludeCritical(false);
  }, [criticalCount]);
  useEffect(() => {
    if (removedCount === 0) setIncludeRemoved(false);
  }, [removedCount]);

  /**
   * The real tag ids behind the ticked chips, which is what the backend needs:
   * a capture travels carrying only these, and only these get a tag row in the
   * file. Derived from the very array the chips and the count read, so the tags
   * that are sent cannot disagree with the tags that are lit up on screen.
   *
   * `NO_TAG` is dropped: it is this screen's own stand-in for "carries no tags"
   * and has no id in the index. It decides which captures are in `tagFiltered`
   * and nothing else — an untagged capture has no tag to strip.
   */
  const selectedTagIds = useMemo(
    () => includedTagIds.filter((id) => id !== NO_TAG),
    [includedTagIds],
  );

  const includedIds = useMemo(
    () =>
      tagFiltered
        .filter((c) => {
          // Every opt-in that applies has to be ticked: a capture the user took
          // out of their assistant *and* flagged as critical needs both.
          if (c.indexState === "excluded" && !includeRemoved) return false;
          if (c.sensitiveVerdict === "potential") return includeAtRisk;
          if (c.sensitiveVerdict === "critical") return includeCritical;
          return true;
        })
        .map((c) => c.id),
    [tagFiltered, includeAtRisk, includeCritical, includeRemoved],
  );

  const onConfirm = useCallback(async () => {
    if (busy || includedIds.length === 0) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("Give this a name, so the person receiving it knows what it is.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const result = await localBuildIndexExport(
        userId,
        includedIds,
        selectedTagIds,
        trimmed,
        includeMedia,
        includeWindowTitles,
      );
      const stem = sanitizeKnowledgeShareStem(trimmed);
      // Hand the path up before anything else: from here on the file exists, and
      // every way out of this modal — sending it, cancelling, or the tab unmounting
      // under us — has to be able to find it. Only the parent survives all three.
      onArchiveStaged(result.path);
      if (result.mediaSkipped > 0) {
        // Hand nothing over yet: the user asked for files and did not get them
        // all, and the next screen is about sending. They see it first.
        setBuilt({
          path: result.path,
          stem,
          mediaWritten: result.mediaWritten,
          mediaSkipped: result.mediaSkipped,
        });
        return;
      }
      onBuilt(result.path, stem);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    includedIds,
    selectedTagIds,
    name,
    userId,
    includeMedia,
    includeWindowTitles,
    onArchiveStaged,
    onBuilt,
    onClose,
  ]);

  if (!open) return null;

  // The archive is already on disk here. The parent has been holding its path
  // since it was built, so backing out just tells the parent to throw it away —
  // the same call its own unmount makes, which is why closing, cancelling and
  // switching tabs now all delete it instead of only the first two.
  if (built) {
    const total = built.mediaWritten + built.mediaSkipped;
    return (
      <div className="modal-overlay">
        <div
          className="modal-card share-assistant-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Share as assistant"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="modal-title">Share as assistant</h3>
          <p className="modal-body share-assistant-modal__notice" role="alert">
            {/* The export skips a media file both when it is gone and when it is
                there but cannot be read, so the notice cannot claim it was moved
                or deleted — that is only one of the two reasons. */}
            {built.mediaWritten === 0
              ? "None of the screenshots and recordings could be included — those files are missing or could not be read. All the text is in the file."
              : `${built.mediaSkipped} of ${total} screenshots and recordings could not be included — those files are missing or could not be read. Everything else is in the file.`}
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn modal-btn--cancel"
              onClick={() => {
                setBuilt(null);
                onDiscardStagedArchive();
                onClose();
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="modal-btn modal-btn--primary"
              onClick={() => {
                const { path, stem } = built;
                setBuilt(null);
                onBuilt(path, stem);
                onClose();
              }}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="modal-card share-assistant-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Share as assistant"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Share as assistant</h3>
        <p className="modal-body share-assistant-modal__intro">
          Whoever you send this to can ask their assistant about everything you include here. Once
          it is sent, you cannot take it back.
        </p>

        <div className="share-assistant-modal__field">
          <label className="share-assistant-modal__label" htmlFor="share-assistant-name">
            Name
          </label>
          <input
            id="share-assistant-name"
            type="text"
            className="share-assistant-modal__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {(tagsInSelection.length > 0 || hasUntagged) && (
          <div className="share-assistant-modal__field">
            <span className="share-assistant-modal__label">Tags to include</span>
            <div className="captures-filter-chips-row share-assistant-modal__chips">
              {tagsInSelection.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className={`captures-tag-chip${includedTagIds.includes(tag.id) ? " captures-tag-chip--active" : ""}`}
                  style={{ "--tag-color": tag.color } as CSSProperties}
                  aria-pressed={includedTagIds.includes(tag.id)}
                  disabled={busy}
                  onClick={() => toggleChip(tag.id)}
                >
                  {tag.name}
                </button>
              ))}
              {hasUntagged && (
                <button
                  type="button"
                  className={`captures-tag-chip${includedTagIds.includes(NO_TAG) ? " captures-tag-chip--active" : ""}`}
                  style={{ "--tag-color": "#9ca3af" } as CSSProperties}
                  aria-pressed={includedTagIds.includes(NO_TAG)}
                  disabled={busy}
                  onClick={() => toggleChip(NO_TAG)}
                >
                  No tag
                </button>
              )}
            </div>
          </div>
        )}

        {(atRiskCount > 0 || criticalCount > 0 || unscannedCount > 0) && (
          <div className="share-assistant-modal__field">
            <span className="share-assistant-modal__label">Sensitive captures</span>
            {(atRiskCount > 0 || criticalCount > 0) && (
              <p className="share-assistant-modal__hint">
                Captures flagged as sensitive are left out unless you tick them here.
              </p>
            )}
            {unscannedCount > 0 && (
              <p className="share-assistant-modal__hint">
                {unscannedCount} of these have not been checked for sensitive data yet.
              </p>
            )}
            {atRiskCount > 0 && (
              <label className="share-assistant-modal__check">
                <input
                  type="checkbox"
                  checked={includeAtRisk}
                  onChange={(e) => setIncludeAtRisk(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  Include {atRiskCount} at-risk {atRiskCount === 1 ? "capture" : "captures"}
                </span>
              </label>
            )}
            {criticalCount > 0 && (
              <label className="share-assistant-modal__check">
                <input
                  type="checkbox"
                  checked={includeCritical}
                  onChange={(e) => setIncludeCritical(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  Include {criticalCount} critical {criticalCount === 1 ? "capture" : "captures"}
                </span>
              </label>
            )}
          </div>
        )}

        {removedCount > 0 && (
          <div className="share-assistant-modal__field">
            <span className="share-assistant-modal__label">Removed from your assistant</span>
            <label className="share-assistant-modal__check">
              <input
                type="checkbox"
                checked={includeRemoved}
                onChange={(e) => setIncludeRemoved(e.target.checked)}
                disabled={busy}
              />
              <span>
                Include {removedCount}{" "}
                {removedCount === 1 ? "capture" : "captures"} you removed from your assistant
              </span>
            </label>
            {/* Taking a capture out of your assistant deletes its indexed text
                (`clear_capture_chunks`), so it exports with nothing to search:
                no keyword match either, not just no match by meaning. */}
            <p className="share-assistant-modal__check-hint">
              You took these out of your own assistant, so they are left out here too unless you
              tick this. They travel as plain text: the person you send them to can open and read
              them, but their assistant will not find them in any search until they add them to it.
            </p>
          </div>
        )}

        <div className="share-assistant-modal__field">
          <span className="share-assistant-modal__label">What travels with the text</span>
          <label className="share-assistant-modal__check">
            <input
              type="checkbox"
              checked={includeMedia}
              onChange={(e) => setIncludeMedia(e.target.checked)}
              disabled={busy}
            />
            <span>Include screenshots and recordings</span>
          </label>
          <p className="share-assistant-modal__check-hint">
            Makes the file much larger. The assistant works either way — it reads text, not images.
          </p>
          <label className="share-assistant-modal__check">
            <input
              type="checkbox"
              checked={includeWindowTitles}
              onChange={(e) => setIncludeWindowTitles(e.target.checked)}
              disabled={busy}
            />
            <span>Include window titles</span>
          </label>
          <p className="share-assistant-modal__check-hint">
            Left out unless you tick this. The title of the window each capture came from often
            shows your name, your computer name and your folders.
          </p>
        </div>

        <p className="share-assistant-modal__count">
          {includedIds.length === 0
            ? "Nothing left to share with these filters."
            : `${includedIds.length} ${includedIds.length === 1 ? "capture" : "captures"} will be shared.`}
        </p>

        {err ? (
          <p className="share-assistant-modal__err" role="alert">
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
            onClick={() => void onConfirm()}
            disabled={busy || includedIds.length === 0}
          >
            {busy ? "Preparing…" : "Prepare the file"}
          </button>
        </div>
      </div>
    </div>
  );
}
