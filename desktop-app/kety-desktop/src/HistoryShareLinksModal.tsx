import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listShareLinks, revokeShareLink, type ShareLinkRow } from "./gcpShareService";

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

function IconCopy({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export type HistoryShareLinksModalProps = {
  open: boolean;
  onClose: () => void;
  profileId: string;
};

function isRowInactive(r: ShareLinkRow, now: Date): boolean {
  if (r.revokedAt) return true;
  if (r.expiresAt) {
    const ex = new Date(r.expiresAt);
    if (!Number.isNaN(ex.getTime()) && ex.getTime() <= now.getTime()) return true;
  }
  return false;
}

function expiryLabel(r: ShareLinkRow, now: Date): string {
  if (r.revokedAt) return "Revoked";
  if (r.expiresAt) {
    const ex = new Date(r.expiresAt);
    if (!Number.isNaN(ex.getTime()) && ex.getTime() <= now.getTime()) {
      return "Expired";
    }
    return ex.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  return "Never";
}

export function HistoryShareLinksModal({ open, onClose, profileId }: HistoryShareLinksModalProps) {
  const [rows, setRows] = useState<ShareLinkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** When false (default): only still-usable links. When true: include expired / revoked / maxed-out. */
  const [showExpired, setShowExpired] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => new Date());
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const copyFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [revokeConfirmRow, setRevokeConfirmRow] = useState<ShareLinkRow | null>(null);

  const load = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    setErr(null);
    try {
      const list = await listShareLinks(profileId);
      setRows(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    if (!open) {
      setRevokeConfirmRow(null);
      return;
    }
    setShowExpired(false);
    setCopiedRowId(null);
    setRevokeConfirmRow(null);
    setNowTick(new Date());
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setNowTick(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, [open]);

  useEffect(() => {
    return () => {
      if (copyFlashTimerRef.current) {
        clearTimeout(copyFlashTimerRef.current);
        copyFlashTimerRef.current = null;
      }
    };
  }, []);

  const handleCopyLink = useCallback(async (row: ShareLinkRow) => {
    if (isRowInactive(row, nowTick) || !row.signedUrl?.trim()) return;
    setErr(null);
    try {
      await copyTextToClipboard(row.signedUrl);
      setCopiedRowId(row.id);
      if (copyFlashTimerRef.current) clearTimeout(copyFlashTimerRef.current);
      copyFlashTimerRef.current = setTimeout(() => {
        setCopiedRowId(null);
        copyFlashTimerRef.current = null;
      }, 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [nowTick]);

  const visibleRows = useMemo(() => {
    if (showExpired) return rows;
    return rows.filter((r) => !isRowInactive(r, nowTick));
  }, [rows, showExpired, nowTick]);

  const handleRevoke = useCallback(
    async (id: string) => {
      setRevokingId(id);
      setErr(null);
      try {
        const updated = await revokeShareLink(profileId, id);
        setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setRevokingId(null);
      }
    },
    [profileId]
  );

  if (!open) return null;

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card history-share-links-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-share-links-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="history-share-links-title" className="modal-title">
          Share link history
        </h3>
        <label className="history-share-links-filter">
          <input
            type="checkbox"
            checked={showExpired}
            onChange={(e) => setShowExpired(e.target.checked)}
          />
          <span>Show expired</span>
        </label>
        {err ? (
          <p className="history-share-links-modal__err" role="alert">
            {err}
          </p>
        ) : null}
        {loading ? (
          <p className="modal-body">Loading…</p>
        ) : visibleRows.length === 0 ? (
          <p className="modal-body">
            {rows.length === 0
              ? "No share links yet."
              : showExpired
                ? "No links to display."
                : "No active share links."}
          </p>
        ) : (
          <div className="history-share-links-table-wrap">
            <table className="history-share-links-table">
              <thead>
                <tr>
                  <th scope="col">File name</th>
                  <th scope="col">Expires</th>
                  <th scope="col" className="history-share-links-th-icon">
                    <span className="history-share-links-sr-only">Copy link</span>
                  </th>
                  <th scope="col"> </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const isRevoked = Boolean(r.revokedAt);
                  const linkActive = !isRowInactive(r, nowTick) && Boolean(r.signedUrl?.trim());
                  return (
                    <tr key={r.id}>
                      <td className="history-share-links-td-name">
                        {r.downloadFilename?.trim() || "—"}
                      </td>
                      <td>{expiryLabel(r, nowTick)}</td>
                      <td className="history-share-links-td-copy">
                        <button
                          type="button"
                          className="history-share-links-copy-btn"
                          disabled={!linkActive}
                          title={
                            linkActive
                              ? "Copy share link"
                              : "Link is no longer active"
                          }
                          aria-label={linkActive ? "Copy share link" : "Copy unavailable"}
                          onClick={() => void handleCopyLink(r)}
                        >
                          {copiedRowId === r.id ? (
                            <IconCheck className="history-share-links-copy-icon" />
                          ) : (
                            <IconCopy className="history-share-links-copy-icon" />
                          )}
                        </button>
                      </td>
                      <td className="history-share-links-td-action">
                        <button
                          type="button"
                          className="modal-btn modal-btn--delete history-share-links-revoke"
                          disabled={isRevoked || revokingId === r.id}
                          title={
                            isRevoked
                              ? "This link is already revoked"
                              : "Stop sharing this link"
                          }
                          onClick={() => {
                            if (isRevoked || revokingId === r.id) return;
                            setRevokeConfirmRow(r);
                          }}
                        >
                          {revokingId === r.id ? "…" : "Revoke"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="modal-btn modal-btn--cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>

    {revokeConfirmRow ? (
      <div
        className="modal-overlay history-share-links-revoke-confirm-overlay"
        role="presentation"
        onClick={() => setRevokeConfirmRow(null)}
      >
        <div
          className="modal-card history-share-links-revoke-confirm-card"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="history-revoke-confirm-title"
          aria-describedby="history-revoke-confirm-desc"
          onClick={(e) => e.stopPropagation()}
        >
          <h4 id="history-revoke-confirm-title" className="modal-title">
            Revoke this link?
          </h4>
          <p id="history-revoke-confirm-desc" className="modal-body history-share-links-revoke-confirm-desc">
            Anyone who still has this link will lose access right away—the download will stop working
            for them. There is no way to turn this back on; you would need to create a new share link.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn modal-btn--cancel"
              onClick={() => setRevokeConfirmRow(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="modal-btn modal-btn--delete"
              disabled={Boolean(revokeConfirmRow.revokedAt) || revokingId === revokeConfirmRow.id}
              onClick={() => {
                const id = revokeConfirmRow.id;
                setRevokeConfirmRow(null);
                void handleRevoke(id);
              }}
            >
              Revoke link
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
