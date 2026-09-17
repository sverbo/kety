import { useEffect } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

/**
 * Full-size viewer for a capture's screenshot or screen recording.
 * Opens over the app instead of handing the file to the operating system.
 */
export function MediaViewerModal({
  open,
  onClose,
  kind,
  path,
  caption,
}: {
  open: boolean;
  onClose: () => void;
  kind: "image" | "video";
  path: string;
  caption?: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !path) return null;

  const src = convertFileSrc(path);
  const fileName = path.replace(/\\/g, "/").split("/").pop() || path;
  const captionText = caption?.trim() ?? "";

  return createPortal(
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={kind === "image" ? "Screenshot" : "Screen recording"}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "min(1100px, calc(100vw - 48px))",
          width: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: "18px 18px 14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={fileName}
          >
            {fileName}
          </span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void openPath(path).catch(console.error)}
          >
            Open in default app
          </button>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </div>

        {kind === "image" ? (
          <img
            src={src}
            alt={fileName}
            style={{
              display: "block",
              maxWidth: "100%",
              maxHeight: "calc(100vh - 220px)",
              borderRadius: 8,
              objectFit: "contain",
            }}
          />
        ) : (
          <video
            src={src}
            controls
            autoPlay
            style={{
              display: "block",
              maxWidth: "100%",
              maxHeight: "calc(100vh - 220px)",
              borderRadius: 8,
            }}
          />
        )}

        {captionText ? (
          <p
            style={{
              margin: 0,
              fontSize: 12,
              lineHeight: 1.5,
              opacity: 0.85,
              maxHeight: 120,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {captionText}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
