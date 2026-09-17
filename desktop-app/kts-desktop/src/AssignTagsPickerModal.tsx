import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { CaptureTag, OffSessionNote, OffSessionImage, OffSessionVideo } from "./appTypes";

export type AssignTagsPickerModalProps = {
  open: boolean;
  onClose: () => void;
  selectedItemIds: Set<string>;
  captureTags: CaptureTag[];
  assignTagAiPoolIds: string[];
  setAssignTagAiPoolIds: Dispatch<SetStateAction<string[]>>;
  assignTagAiBusy: boolean;
  assignTagAiProgress: { done: number; total: number } | null;
  assignTagAiError: string | null;
  setAssignTagAiError: Dispatch<SetStateAction<string | null>>;
  /** Same model as Settings → AI tasks → Tags & sensitive. */
  sensitiveScanModel: string;
  onAssignTagsWithAi: () => void | Promise<void>;
  offSessionNotes: OffSessionNote[];
  offSessionImages: OffSessionImage[];
  offSessionVideos: OffSessionVideo[];
  setOffSessionNotes: Dispatch<SetStateAction<OffSessionNote[]>>;
  setOffSessionImages: Dispatch<SetStateAction<OffSessionImage[]>>;
  setOffSessionVideos: Dispatch<SetStateAction<OffSessionVideo[]>>;
  onCaptureTagChange: (key: string, newTagIds: string[]) => void;
};

export function AssignTagsPickerModal({
  open,
  onClose,
  selectedItemIds,
  captureTags,
  assignTagAiPoolIds,
  setAssignTagAiPoolIds,
  assignTagAiBusy,
  assignTagAiProgress,
  assignTagAiError,
  setAssignTagAiError,
  sensitiveScanModel,
  onAssignTagsWithAi,
  offSessionNotes,
  offSessionImages,
  offSessionVideos,
  setOffSessionNotes,
  setOffSessionImages,
  setOffSessionVideos,
  onCaptureTagChange,
}: AssignTagsPickerModalProps) {
  /**
   * Tri-state per tag, over the current selection:
   *   "all"     - every selected capture has it
   *   "partial" - some do
   *   "none"    - none do
   * Only tags the user actually clicks end up in `overrides`, and only those are
   * applied. A tag left at "partial" keeps its exact per-capture distribution —
   * a plain checkbox would show it unchecked and silently strip it.
   */
  const selectedEntries = useMemo(() => {
    const out: { key: string; tagIds: string[] }[] = [];
    for (const n of offSessionNotes) {
      const key = `offNote|${n.id}`;
      if (selectedItemIds.has(key)) out.push({ key, tagIds: n.tagIds ?? [] });
    }
    for (const i of offSessionImages) {
      const key = `offImage|${i.id}`;
      if (selectedItemIds.has(key)) out.push({ key, tagIds: i.tagIds ?? [] });
    }
    for (const v of offSessionVideos) {
      const key = `offVideo|${v.id}`;
      if (selectedItemIds.has(key)) out.push({ key, tagIds: v.tagIds ?? [] });
    }
    return out;
  }, [offSessionNotes, offSessionImages, offSessionVideos, selectedItemIds]);

  const initialStates = useMemo(() => {
    const m: Record<string, "all" | "partial" | "none"> = {};
    const total = selectedEntries.length;
    for (const tag of captureTags) {
      const n = selectedEntries.filter((e) => e.tagIds.includes(tag.id)).length;
      m[tag.id] = n === 0 ? "none" : n === total && total > 0 ? "all" : "partial";
    }
    return m;
  }, [captureTags, selectedEntries]);

  const [overrides, setOverrides] = useState<Record<string, "all" | "none">>({});

  // Reset the pending changes each time the modal opens on a new selection.
  useEffect(() => {
    if (open) setOverrides({});
  }, [open]);

  if (!open) return null;

  const stateOf = (tagId: string): "all" | "partial" | "none" =>
    overrides[tagId] ?? initialStates[tagId] ?? "none";

  const cycleTag = (tagId: string) => {
    setOverrides((prev) => ({
      ...prev,
      [tagId]: stateOf(tagId) === "all" ? "none" : "all",
    }));
  };

  const applyTriState = () => {
    const changes = Object.entries(overrides) as ["all" | "none" extends never ? never : string, "all" | "none"][];
    if (changes.length === 0) {
      handleClose();
      return;
    }
    const nextFor = (current: string[] | undefined): string[] => {
      let next = [...(current ?? [])];
      for (const [tagId, mode] of changes) {
        if (mode === "all") {
          if (!next.includes(tagId)) next.push(tagId);
        } else {
          next = next.filter((t) => t !== tagId);
        }
      }
      return next;
    };
    const sameSet = (a: string[], b: string[]) =>
      a.length === b.length && a.every((x) => b.includes(x));

    setOffSessionNotes((prev) =>
      prev.map((n) => {
        const key = `offNote|${n.id}`;
        if (!selectedItemIds.has(key)) return n;
        const next = nextFor(n.tagIds);
        if (sameSet(next, n.tagIds ?? [])) return n;
        onCaptureTagChange(key, next);
        return { ...n, tagIds: next };
      }),
    );
    setOffSessionImages((prev) =>
      prev.map((i) => {
        const key = `offImage|${i.id}`;
        if (!selectedItemIds.has(key)) return i;
        const next = nextFor(i.tagIds);
        if (sameSet(next, i.tagIds ?? [])) return i;
        onCaptureTagChange(key, next);
        return { ...i, tagIds: next };
      }),
    );
    setOffSessionVideos((prev) =>
      prev.map((v) => {
        const key = `offVideo|${v.id}`;
        if (!selectedItemIds.has(key)) return v;
        const next = nextFor(v.tagIds);
        if (sameSet(next, v.tagIds ?? [])) return v;
        onCaptureTagChange(key, next);
        return { ...v, tagIds: next };
      }),
    );
    handleClose();
  };

  const hasAiAssignableSelection = [...selectedItemIds].some(
    (k) =>
      k.startsWith("offNote|") ||
      k.startsWith("offImage|") ||
      k.startsWith("offVideo|"),
  );
  const useAiDisabled =
    assignTagAiBusy ||
    sensitiveScanModel === "disabled" ||
    assignTagAiPoolIds.length === 0 ||
    !hasAiAssignableSelection;

  const handleClose = () => {
    if (assignTagAiBusy) return;
    onClose();
    setAssignTagAiError(null);
  };

  return (
    <div
      className="history-error-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-tag-title"
      onClick={handleClose}
    >
      <div
        className="history-error-dialog glass-card assign-tag-dialog"
        style={{ minWidth: 340, maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="assign-tag-title" className="history-error-title">Assign tags</h3>
        <p className="settings-hint" style={{ marginBottom: 12 }}>
          Manual: a <strong>✓</strong> puts the tag on every selected capture, an empty box removes it from all of
          them, and a <strong>–</strong> means only some captures have it — left alone, those stay exactly as they
          are. Only tags you click are changed. AI: limit the pool, then <strong>Use AI &amp; assign</strong> (same
          model as Tags &amp; sensitive in Settings → AI tasks). AI only ever adds tags, never removes them, and runs
          one capture at a time with a progress bar.
        </p>
        <p className="settings-hint" style={{ marginBottom: 8 }}>
          {selectedItemIds.size} selected capture{selectedItemIds.size !== 1 ? "s" : ""}.
        </p>
        {captureTags.length === 0 ? (
          <p className="settings-hint" style={{ marginBottom: 16 }}>
            No tags yet. Create tags in Settings → AI tasks → Tags & sensitive → Advanced → Tags.
          </p>
        ) : (
          <>
            <p className="settings-hint" style={{ marginBottom: 6, fontWeight: 600 }}>Manual</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {captureTags.map((tag) => {
                const st = stateOf(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={`captures-tag-chip${st === "all" ? " captures-tag-chip--active" : ""}`}
                    style={{
                      "--tag-color": tag.color,
                      ...(st === "partial" ? { opacity: 0.7, borderStyle: "dashed" } : {}),
                    } as React.CSSProperties}
                    title={
                      st === "all"
                        ? "On every selected capture. Click to remove it from all of them."
                        : st === "partial"
                          ? "On some selected captures. Click to add it to all of them; leave it alone to keep it as it is."
                          : "On none of the selected captures. Click to add it to all of them."
                    }
                    onClick={() => cycleTag(tag.id)}
                  >
                    {st === "all" ? "✓ " : st === "partial" ? "– " : ""}
                    {tag.name}
                  </button>
                );
              })}
            </div>
            <div
              className="assign-tag-ai-section"
              style={{ marginBottom: 14, paddingTop: 12, borderTop: "1px solid var(--glass-border)" }}
            >
              <div
                className="controls-row"
                style={{
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <span className="settings-hint" style={{ fontWeight: 600, margin: 0 }}>Tags the AI may assign</span>
                <span className="settings-hint" style={{ display: "inline-flex", gap: 10 }}>
                  <button
                    type="button"
                    className="btn-link-like"
                    onClick={() => setAssignTagAiPoolIds(captureTags.map((t) => t.id))}
                  >
                    All
                  </button>
                  <button type="button" className="btn-link-like" onClick={() => setAssignTagAiPoolIds([])}>
                    None
                  </button>
                </span>
              </div>
              <div className="assign-tag-ai-pool-chips" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {captureTags.map((tag) => (
                  <button
                    key={`pool-${tag.id}`}
                    type="button"
                    className={`captures-tag-chip captures-tag-chip--pool${assignTagAiPoolIds.includes(tag.id) ? " captures-tag-chip--active" : ""}`}
                    style={{ "--tag-color": tag.color } as React.CSSProperties}
                    onClick={() =>
                      setAssignTagAiPoolIds((prev) =>
                        prev.includes(tag.id) ? prev.filter((id) => id !== tag.id) : [...prev, tag.id],
                      )
                    }
                  >
                    {assignTagAiPoolIds.includes(tag.id) ? "✓ " : ""}
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {assignTagAiError && (
          <p className="settings-hint" style={{ color: "#dc2626", marginBottom: 12 }} role="alert">
            {assignTagAiError}
          </p>
        )}
        {assignTagAiProgress !== null && assignTagAiBusy && (
          <div style={{ marginBottom: 14 }}>
            <p className="settings-hint" style={{ marginBottom: 6 }}>
              Assigning tags (one capture at a time)… {assignTagAiProgress.done} / {assignTagAiProgress.total}
            </p>
            <div className="assign-tag-ai-progress-track" aria-hidden>
              <div
                className="assign-tag-ai-progress-fill"
                style={{
                  width: `${assignTagAiProgress.total > 0 ? Math.min(100, (assignTagAiProgress.done / assignTagAiProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        )}
        <div className="controls-row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={assignTagAiBusy}
            onClick={() => {
              onClose();
              setAssignTagAiError(null);
            }}
          >
            Cancel
          </button>
          {captureTags.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={useAiDisabled}
              title={
                sensitiveScanModel === "disabled"
                  ? "Enable a Tags & sensitive model in Settings → AI tasks first."
                  : undefined
              }
              onClick={() => {
                void onAssignTagsWithAi();
              }}
            >
              {assignTagAiBusy ? "AI…" : "Use AI & assign"}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={Object.keys(overrides).length === 0 || assignTagAiBusy}
            onClick={applyTriState}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
