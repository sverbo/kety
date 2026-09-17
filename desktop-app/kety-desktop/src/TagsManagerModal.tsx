import type { Dispatch, SetStateAction } from "react";
import { updateShareTagFilter, type ShareContactRow } from "./shareService";
import { CAPTURE_TAG_COLORS, pickTagColor } from "./appConstants";
import type { CaptureTag, OffSessionNote, OffSessionImage, OffSessionVideo } from "./appTypes";

export type TagsManagerModalProps = {
  open: boolean;
  onClose: () => void;
  editingTag: CaptureTag | null;
  setEditingTag: Dispatch<SetStateAction<CaptureTag | null>>;
  tagDeletePending: string | null;
  setTagDeletePending: Dispatch<SetStateAction<string | null>>;
  captureTags: CaptureTag[];
  setCaptureTags: Dispatch<SetStateAction<CaptureTag[]>>;
  offSessionNotes: OffSessionNote[];
  offSessionImages: OffSessionImage[];
  offSessionVideos: OffSessionVideo[];
  setOffSessionNotes: Dispatch<SetStateAction<OffSessionNote[]>>;
  setOffSessionImages: Dispatch<SetStateAction<OffSessionImage[]>>;
  setOffSessionVideos: Dispatch<SetStateAction<OffSessionVideo[]>>;
  shareContacts: ShareContactRow[] | null;
  onSaveTag: (tag: CaptureTag) => void;
  onDeleteTag: (tagId: string) => void;
};

export function TagsManagerModal({
  open,
  onClose,
  editingTag,
  setEditingTag,
  tagDeletePending,
  setTagDeletePending,
  captureTags,
  setCaptureTags,
  offSessionNotes,
  offSessionImages,
  offSessionVideos,
  setOffSessionNotes,
  setOffSessionImages,
  setOffSessionVideos,
  shareContacts,
  onSaveTag,
  onDeleteTag,
}: TagsManagerModalProps) {
  if (!open) return null;

  const handleClose = () => {
    onClose();
    setEditingTag(null);
    setTagDeletePending(null);
  };

  return (
    <div
      className="history-error-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tags-manager-title"
      onClick={handleClose}
    >
      <div
        className="history-error-dialog glass-card"
        style={{ minWidth: 380, maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="tags-manager-title" className="history-error-title">Tags</h3>
        {(() => {
          if (editingTag !== null) {
            const isNew = !captureTags.some((t) => t.id === editingTag.id);
            return (
              <div>
                <div className="settings-field" style={{ marginBottom: 12 }}>
                  <label className="settings-label">Name</label>
                  <input
                    className="settings-input"
                    type="text"
                    value={editingTag.name}
                    maxLength={60}
                    autoFocus
                    onChange={(e) => setEditingTag((t) => t ? { ...t, name: e.target.value } : t)}
                  />
                </div>
                <div className="settings-field" style={{ marginBottom: 12 }}>
                  <label className="settings-label">
                    Description{" "}
                    <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
                      ({editingTag.description.length}/200)
                    </span>
                  </label>
                  <textarea
                    className="settings-input"
                    rows={3}
                    maxLength={200}
                    value={editingTag.description}
                    onChange={(e) => setEditingTag((t) => t ? { ...t, description: e.target.value } : t)}
                  />
                </div>
                <div className="settings-field" style={{ marginBottom: 12 }}>
                  <label className="settings-label">Color</label>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {CAPTURE_TAG_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={c}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          background: c,
                          border: editingTag.color === c
                            ? "2px solid var(--text-primary)"
                            : "2px solid transparent",
                          cursor: "pointer",
                        }}
                        onClick={() => setEditingTag((t) => t ? { ...t, color: c } : t)}
                      />
                    ))}
                  </div>
                </div>
                <div className="settings-field" style={{ marginBottom: 16 }}>
                  <label className="settings-label">
                    Auto-assign to apps{" "}
                    <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
                      (case-insensitive, one per line)
                    </span>
                  </label>
                  <textarea
                    className="settings-input"
                    rows={3}
                    placeholder={"Xcode\nSafari\nSlack"}
                    value={editingTag.autoAssignApps.join("\n")}
                    onChange={(e) =>
                      setEditingTag((t) =>
                        t
                          ? { ...t, autoAssignApps: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }
                          : t
                      )
                    }
                  />
                </div>
                <div className="controls-row" style={{ gap: 8, justifyContent: "flex-end" }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setEditingTag(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!editingTag.name.trim()}
                    onClick={() => {
                      const saved = { ...editingTag, name: editingTag.name.trim() };
                      if (isNew) {
                        setCaptureTags((prev) => [...prev, saved]);
                      } else {
                        setCaptureTags((prev) =>
                          prev.map((t) => t.id === saved.id ? saved : t)
                        );
                      }
                      onSaveTag(saved);
                      setEditingTag(null);
                    }}
                  >
                    {isNew ? "Create" : "Save"}
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div>
              {captureTags.length === 0 && (
                <p className="settings-hint" style={{ marginBottom: 12 }}>No tags yet.</p>
              )}
              <ul style={{ listStyle: "none", margin: 0, padding: 0, marginBottom: 12 }}>
                {captureTags.map((tag) => {
                  const usageCount = [
                    ...offSessionNotes.filter((n) => n.tagIds?.includes(tag.id)),
                    ...offSessionImages.filter((i) => i.tagIds?.includes(tag.id)),
                    ...offSessionVideos.filter((v) => v.tagIds?.includes(tag.id)),
                  ].length;
                  return (
                    <li
                      key={tag.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <span
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: "50%",
                          background: tag.color,
                          flexShrink: 0,
                          display: "inline-block",
                        }}
                      />
                      <span style={{ flex: 1, fontWeight: 500 }}>{tag.name}</span>
                      <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                        {usageCount} capture{usageCount !== 1 ? "s" : ""}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-tiny"
                        onClick={() => setEditingTag({ ...tag })}
                      >
                        Edit
                      </button>
                      {tagDeletePending === tag.id ? (
                        <>
                          <span style={{ fontSize: 12, color: "var(--color-error)" }}>
                            Used by {usageCount} - unassign all?
                          </span>
                          {(() => {
                            const affectedShares = (shareContacts ?? []).filter(
                              (r) =>
                                r.assistant_outgoing_share_id &&
                                Array.isArray(r.segment_tag_ids) &&
                                r.segment_tag_ids.includes(tag.id)
                            );
                            if (affectedShares.length > 0) {
                              return (
                                <span style={{ fontSize: 12, color: "#ea580c" }}>
                                  ⚠ used in {affectedShares.length} sharing filter
                                  {affectedShares.length !== 1 ? "s" : ""}
                                </span>
                              );
                            }
                            return null;
                          })()}
                          <button
                            type="button"
                            className="btn btn-destructive btn-tiny"
                            onClick={() => {
                              const removeTag = (ids?: string[]) => ids?.filter((id) => id !== tag.id);
                              setCaptureTags((prev) => prev.filter((t) => t.id !== tag.id));
                              setOffSessionNotes((prev) => prev.map((n) => ({ ...n, tagIds: removeTag(n.tagIds) })));
                              setOffSessionImages((prev) => prev.map((i) => ({ ...i, tagIds: removeTag(i.tagIds) })));
                              setOffSessionVideos((prev) => prev.map((v) => ({ ...v, tagIds: removeTag(v.tagIds) })));
                              onDeleteTag(tag.id);
                              const affectedShares = (shareContacts ?? []).filter(
                                (r) =>
                                  r.assistant_outgoing_share_id &&
                                  Array.isArray(r.segment_tag_ids) &&
                                  r.segment_tag_ids.includes(tag.id)
                              );
                              for (const row of affectedShares) {
                                const shareId = row.assistant_outgoing_share_id!;
                                const next = (row.segment_tag_ids ?? []).filter((id) => id !== tag.id);
                                void updateShareTagFilter(shareId, next.length === 0 ? null : next).catch(
                                  console.error
                                );
                              }
                              setTagDeletePending(null);
                            }}
                          >
                            Unassign all
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-tiny"
                            onClick={() => setTagDeletePending(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-tiny"
                          onClick={() => setTagDeletePending(tag.id)}
                        >
                          Delete
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => {
                    const usedColors = captureTags.map((t) => t.color);
                    setEditingTag({
                      id: crypto.randomUUID(),
                      name: "",
                      description: "",
                      color: pickTagColor(usedColors),
                      autoAssignApps: [],
                      createdAt: new Date().toISOString(),
                    });
                  }}
                >
                  + New tag
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => onClose()}
                >
                  Close
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
