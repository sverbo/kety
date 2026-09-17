import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterLinesBySensitiveVerdict, type SensitiveLineRollup } from "./uploadPrepareFilter";

export type SensitiveReviewDraft = {
  excludedContentIds: Set<string>;
  excludedWindowKeys: Set<string>;
  excludedAppKeys: Set<string>;
};

function mergeDraft(base: SensitiveReviewDraft, patch: SensitiveReviewDraft): SensitiveReviewDraft {
  const excludedContentIds = new Set(base.excludedContentIds);
  const excludedWindowKeys = new Set(base.excludedWindowKeys);
  const excludedAppKeys = new Set(base.excludedAppKeys);
  patch.excludedContentIds.forEach((id) => excludedContentIds.add(id));
  patch.excludedWindowKeys.forEach((k) => excludedWindowKeys.add(k));
  patch.excludedAppKeys.forEach((k) => excludedAppKeys.add(k));
  return { excludedContentIds, excludedWindowKeys, excludedAppKeys };
}

type Props = {
  open: boolean;
  lines: SensitiveLineRollup[];
  includeUncertain: boolean;
  onIncludeUncertainChange: (v: boolean) => void;
  onDiscard: () => void;
  /** Current text for a persist key (session / note / OCR), before edits in this modal. */
  getInitialTextForPersistKey: (persistTextKey: string) => string;
  onFinalSave: (draft: SensitiveReviewDraft, textEdits: Map<string, string>) => void;
};

/**
 * Phase D: stack Do not upload + optional text edits; Final save applies all at once.
 */
export function SensitiveReviewModal({
  open,
  lines,
  includeUncertain,
  onIncludeUncertainChange,
  onDiscard,
  getInitialTextForPersistKey,
  onFinalSave,
}: Props) {
  const [draft, setDraft] = useState<SensitiveReviewDraft>(() => ({
    excludedContentIds: new Set(),
    excludedWindowKeys: new Set(),
    excludedAppKeys: new Set(),
  }));

  /** lineId → edited text (full value for that row). */
  const [textByLineId, setTextByLineId] = useState<Record<string, string>>({});
  const baselineRef = useRef<Record<string, string>>({});

  const queue = useMemo(() => {
    return lines.filter((L) => {
      if (L.verdict === -1) return true;
      if (includeUncertain && L.verdict === 0) return true;
      return false;
    });
  }, [lines, includeUncertain]);

  useEffect(() => {
    if (!open) return;
    setDraft({
      excludedContentIds: new Set(),
      excludedWindowKeys: new Set(),
      excludedAppKeys: new Set(),
    });
    const q = filterLinesBySensitiveVerdict(
      lines,
      includeUncertain ? "sensitive_and_uncertain" : "sensitive_only"
    );
    const baseline: Record<string, string> = {};
    const init: Record<string, string> = {};
    for (const row of q) {
      const t = getInitialTextForPersistKey(row.persistTextKey);
      baseline[row.lineId] = t;
      init[row.lineId] = t;
    }
    baselineRef.current = baseline;
    setTextByLineId(init);
  }, [open, lines, includeUncertain, getInitialTextForPersistKey]);

  const addPatch = useCallback((patch: SensitiveReviewDraft) => {
    setDraft((d) => mergeDraft(d, patch));
  }, []);

  const handleDiscard = useCallback(() => {
    setDraft({
      excludedContentIds: new Set(),
      excludedWindowKeys: new Set(),
      excludedAppKeys: new Set(),
    });
    setTextByLineId({});
    onDiscard();
  }, [onDiscard]);

  const handleFinal = useCallback(() => {
    const textEdits = new Map<string, string>();
    for (const row of queue) {
      const next = textByLineId[row.lineId];
      if (next === undefined) continue;
      const base = baselineRef.current[row.lineId] ?? "";
      if (next !== base) {
        textEdits.set(row.persistTextKey, next);
      }
    }
    onFinalSave(draft, textEdits);
    setDraft({
      excludedContentIds: new Set(),
      excludedWindowKeys: new Set(),
      excludedAppKeys: new Set(),
    });
    setTextByLineId({});
  }, [draft, onFinalSave, queue, textByLineId]);

  if (!open) return null;

  const draftCounts =
    draft.excludedContentIds.size +
    draft.excludedWindowKeys.size +
    draft.excludedAppKeys.size;

  let textDirty = false;
  for (const row of queue) {
    const next = textByLineId[row.lineId];
    const base = baselineRef.current[row.lineId] ?? "";
    if (next !== undefined && next !== base) {
      textDirty = true;
      break;
    }
  }

  const canSave = draftCounts > 0 || textDirty;

  return (
    <div
      className="history-error-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sensitive-review-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleDiscard();
      }}
    >
      <div
        className="history-error-dialog glass-card"
        style={{
          maxWidth: 640,
          maxHeight: "90vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="sensitive-review-title" className="history-error-title">
          Review sensitive items
        </h3>
        <p className="settings-hint" style={{ marginBottom: 10 }}>
          Stack <strong>Do not upload</strong> actions and/or edit text below.{" "}
          <strong>Final save</strong> writes text to your local recordings and applies exclusions to
          Prepare. <strong>Discard</strong> closes without changes.
        </p>
        <label
          className="settings-label"
          style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}
        >
          <input
            type="checkbox"
            checked={includeUncertain}
            onChange={(e) => onIncludeUncertainChange(e.target.checked)}
          />
          Include uncertain (0) rows in addition to sensitive (-1)
        </label>

        <div style={{ overflow: "auto", flex: 1, marginBottom: 12 }}>
          {queue.length === 0 ? (
            <p className="settings-hint">No rows match the current filter.</p>
          ) : (
            queue.map((row) => (
              <div
                key={row.lineId}
                style={{
                  border: "1px solid var(--color-border, rgba(255,255,255,0.12))",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 8,
                }}
              >
                <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600 }}>
                  {row.displayApp} · {row.windowTitle} · {row.lineKind}
                  {row.verdict === -1 ? (
                    <span style={{ color: "var(--color-error, #f87171)", marginLeft: 8 }}>(sensitive)</span>
                  ) : (
                    <span style={{ color: "var(--color-warning, #fbbf24)", marginLeft: 8 }}>
                      (uncertain)
                    </span>
                  )}
                </p>
                <label className="settings-label" style={{ display: "block", marginBottom: 4 }}>
                  Text (editable)
                </label>
                <textarea
                  className="upload-focus-text-edit"
                  style={{ width: "100%", minHeight: 72, marginBottom: 8 }}
                  value={textByLineId[row.lineId] ?? ""}
                  onChange={(e) =>
                    setTextByLineId((prev) => ({ ...prev, [row.lineId]: e.target.value }))
                  }
                  spellCheck
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 11, padding: "4px 8px" }}
                    onClick={() =>
                      addPatch({
                        excludedContentIds: new Set([row.lineId]),
                        excludedWindowKeys: new Set(),
                        excludedAppKeys: new Set(),
                      })
                    }
                  >
                    Do not upload (chunk)
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 11, padding: "4px 8px" }}
                    onClick={() =>
                      addPatch({
                        excludedContentIds: new Set(),
                        excludedWindowKeys: new Set([row.windowKey]),
                        excludedAppKeys: new Set(),
                      })
                    }
                  >
                    Do not upload (window)
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 11, padding: "4px 8px" }}
                    onClick={() =>
                      addPatch({
                        excludedContentIds: new Set(),
                        excludedWindowKeys: new Set(),
                        excludedAppKeys: new Set([row.appKey]),
                      })
                    }
                  >
                    Do not upload (app)
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <p className="settings-hint" style={{ marginBottom: 8 }}>
          Pending DNU selections: {draftCounts} · Text modified: {textDirty ? "yes" : "no"}
        </p>

        <div className="controls-row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={handleDiscard}>
            Discard
          </button>
          <button type="button" className="btn btn-primary" onClick={handleFinal} disabled={!canSave}>
            Final save
          </button>
        </div>
      </div>
    </div>
  );
}
