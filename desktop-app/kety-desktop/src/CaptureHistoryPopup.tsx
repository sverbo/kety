import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DictationHistoryInject, OffSessionNote, AppMainTab } from "./appTypes";

/** Max height of the whole history list in the modal. */
const CAPTURE_HISTORY_LIST_MAX_PX = 280;
/** When a row’s text is expanded, scroll inside this box if content is very long. */
const CAPTURE_HISTORY_ROW_TEXT_EXPANDED_MAX_PX = 220;

type HistoryRow = { id: string; text: string; source: "dictation" | "copy"; createdAt: string };

export type CaptureHistoryPopupProps = {
  open: boolean;
  onClose: () => void;
  dictationFieldInjects: DictationHistoryInject[];
  setDictationFieldInjects: Dispatch<SetStateAction<DictationHistoryInject[]>>;
  copyHistoryNotes: OffSessionNote[];
  setCopyHistoryNotes: Dispatch<SetStateAction<OffSessionNote[]>>;
  historyFilter: "all" | "dictation" | "copy";
  setHistoryFilter: Dispatch<SetStateAction<"all" | "dictation" | "copy">>;
  historyDeletePending: string | null;
  setHistoryDeletePending: Dispatch<SetStateAction<string | null>>;
  historyFlushAllPending: boolean;
  setHistoryFlushAllPending: Dispatch<SetStateAction<boolean>>;
  onAddCapture: (note: OffSessionNote) => void;
  setActiveTab: Dispatch<SetStateAction<AppMainTab>>;
};

export function CaptureHistoryPopup({
  open,
  onClose,
  dictationFieldInjects,
  setDictationFieldInjects,
  copyHistoryNotes,
  setCopyHistoryNotes,
  historyFilter,
  setHistoryFilter,
  historyDeletePending,
  setHistoryDeletePending,
  historyFlushAllPending,
  setHistoryFlushAllPending,
  onAddCapture,
  setActiveTab,
}: CaptureHistoryPopupProps) {
  const [expandedTextRowIds, setExpandedTextRowIds] = useState<Set<string>>(() => new Set());

  const dictRows: HistoryRow[] = dictationFieldInjects.map((d) => ({
    id: d.id,
    text: d.text,
    source: "dictation",
    createdAt: d.createdAt,
  }));
  const copyRows: HistoryRow[] = copyHistoryNotes.map((n) => ({
    id: n.id,
    text: n.text ?? "",
    source: "copy",
    createdAt: n.createdAt,
  }));

  let allItems: HistoryRow[] = [
    ...dictRows.filter(() => historyFilter === "all" || historyFilter === "dictation"),
    ...copyRows.filter(() => historyFilter === "all" || historyFilter === "copy"),
  ];
  if (historyFilter === "all") {
    allItems = [...allItems].sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      const na = Number.isNaN(ta) ? 0 : ta;
      const nb = Number.isNaN(tb) ? 0 : tb;
      return nb - na;
    });
  }
  const totalHistoryCount = dictationFieldInjects.length + copyHistoryNotes.length;

  useEffect(() => {
    if (open) setExpandedTextRowIds(new Set());
  }, [open]);

  const toggleTextExpand = useCallback((id: string) => {
    setExpandedTextRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!open) return null;

  const handleClose = () => {
    onClose();
    setHistoryDeletePending(null);
    setHistoryFlushAllPending(false);
  };

  return (
    <div
      className="history-error-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-popup-title"
      onClick={handleClose}
    >
      <div className="history-popup-solid" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 id="history-popup-title" className="history-error-title" style={{ margin: 0 }}>
            Capture history
          </h3>
          <button type="button" className="btn btn-ghost btn-small" onClick={handleClose}>
            ✕
          </button>
        </div>
        <p className="settings-hint" style={{ marginBottom: 10, lineHeight: 1.45, fontSize: 13 }}>
          Voice dictations injected into focused fields and copy history items appear here. They are{" "}
          <strong>not</strong> saved as captures unless you send an individual item. Options live in{" "}
          <button
            type="button"
            className="link-inline"
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              font: "inherit",
              color: "var(--accent)",
            }}
            onClick={() => {
              handleClose();
              setActiveTab("settings");
              setTimeout(
                () => document.getElementById("settings-capture-history")?.scrollIntoView({ behavior: "smooth", block: "start" }),
                100
              );
            }}
          >
            Settings → Capture history
          </button>
          .
        </p>
        <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          {(["all", "dictation", "copy"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn btn-small${historyFilter === f ? " btn-primary" : " btn-secondary"}`}
              onClick={() => {
                setHistoryFilter(f);
                setHistoryDeletePending(null);
                setHistoryFlushAllPending(false);
                setExpandedTextRowIds(new Set());
              }}
            >
              {f === "all" ? "All" : f === "dictation" ? "Dictation" : "Copy"}
            </button>
          ))}
          <div style={{ flex: 1, minWidth: 8 }} />
          {historyFlushAllPending ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="settings-hint" style={{ fontSize: 12, fontWeight: 600 }}>Delete all items?</span>
              <button
                type="button"
                className="dictation-inject-confirm-btn dictation-inject-confirm-btn--yes"
                onClick={() => {
                  setDictationFieldInjects([]);
                  setCopyHistoryNotes([]);
                  setHistoryDeletePending(null);
                  setHistoryFlushAllPending(false);
                }}
              >
                Oui
              </button>
              <button
                type="button"
                className="dictation-inject-confirm-btn dictation-inject-confirm-btn--no"
                onClick={() => setHistoryFlushAllPending(false)}
              >
                Non
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-small btn-secondary"
              disabled={totalHistoryCount === 0}
              title="Remove every dictation and clipboard item from this list"
              onClick={() => {
                setHistoryFlushAllPending(true);
                setHistoryDeletePending(null);
              }}
            >
              Delete all
            </button>
          )}
        </div>
        {allItems.length === 0 ? (
          <p className="settings-hint" style={{ margin: "16px 0" }}>No history items.</p>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: CAPTURE_HISTORY_LIST_MAX_PX,
              overflowY: "auto",
            }}
          >
            {allItems.map((item) => {
              const textExpanded = expandedTextRowIds.has(item.id);
              return (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 6,
                    background: "var(--bg-secondary)",
                    minHeight: 32,
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      padding: "2px 5px",
                      borderRadius: 4,
                      marginTop: 2,
                      background:
                        item.source === "dictation"
                          ? "var(--color-blue-faint, rgba(59,130,246,0.15))"
                          : "var(--color-green-faint, rgba(34,197,94,0.15))",
                      color:
                        item.source === "dictation"
                          ? "var(--color-blue, #3b82f6)"
                          : "var(--color-green, #22c55e)",
                    }}
                  >
                    {item.source === "dictation" ? "dic" : "copy"}
                  </span>
                  <button
                    type="button"
                    className="capture-history-text-expand"
                    title={textExpanded ? "Show one line" : "Show full text"}
                    aria-expanded={textExpanded}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleTextExpand(item.id);
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      margin: 0,
                      padding: "2px 4px",
                      border: "none",
                      borderRadius: 4,
                      background: "transparent",
                      cursor: "pointer",
                      font: "inherit",
                      color: "inherit",
                      textAlign: "left",
                      ...(textExpanded
                        ? {
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            maxHeight: CAPTURE_HISTORY_ROW_TEXT_EXPANDED_MAX_PX,
                            overflowY: "auto",
                          }
                        : {
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }),
                    }}
                  >
                    {item.text}
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, flexWrap: "wrap" }}>
                    {historyDeletePending === item.id ? (
                      <>
                        <button
                          type="button"
                          className="dictation-inject-confirm-btn dictation-inject-confirm-btn--yes"
                          onClick={() => {
                            if (item.source === "dictation") {
                              setDictationFieldInjects((prev) => prev.filter((d) => d.id !== item.id));
                            } else {
                              setCopyHistoryNotes((prev) => prev.filter((n) => n.id !== item.id));
                            }
                            setHistoryDeletePending(null);
                          }}
                        >
                          Oui
                        </button>
                        <button
                          type="button"
                          className="dictation-inject-confirm-btn dictation-inject-confirm-btn--no"
                          onClick={() => setHistoryDeletePending(null)}
                        >
                          Non
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="dictation-inject-action-btn"
                          title="Copy text"
                          onClick={() => navigator.clipboard.writeText(item.text).catch(console.error)}
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                            <path
                              d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="dictation-inject-action-btn"
                          title="Delete"
                          onClick={() => {
                            setHistoryDeletePending(item.id);
                            setHistoryFlushAllPending(false);
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path
                              d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4l.5 8h5l.5-8"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="dictation-inject-send-btn"
                          title="Send to capture"
                          onClick={() => {
                            const note: OffSessionNote = {
                              id: `hist-${item.source}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                              text: item.text,
                              source: item.source === "dictation" ? "dictation" : "manual",
                              createdAt: new Date().toISOString(),
                            };
                            onAddCapture(note);
                            if (item.source === "dictation") {
                              setDictationFieldInjects((prev) => prev.filter((d) => d.id !== item.id));
                            } else {
                              setCopyHistoryNotes((prev) => prev.filter((n) => n.id !== item.id));
                            }
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path
                              d="M3 8h10M9 4l4 4-4 4"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
