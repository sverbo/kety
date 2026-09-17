import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isLinkNote } from "./contextNoteTypes";
import { formatOffSessionContextFocus } from "./offSessionFocusUi";
// SegmentContextBlock removed (session recording feature deleted)
import { PdfDropZone, type PdfDropZoneHandle } from "./PdfDropZone";
import { IconCaptureHistoryClock } from "./appConstants";
import { useCloseOnOutsidePress } from "./useCloseOnOutsidePress";
import { AuthRequiredGate } from "./AuthModal";
import { MediaViewerModal } from "./MediaViewerModal";
import { HistoryShareLinksModal } from "./HistoryShareLinksModal";
import { KnowledgeShareModal } from "./KnowledgeShareModal";
import {
  ShareAsAssistantModal,
  type ShareAsAssistantCapture,
} from "./ShareAsAssistantModal";
import { getGcpShareConfig } from "./gcpShareService";
import {
  buildCaptureExportEntries,
  buildCapturesZipToTemp,
  deleteTempFile,
} from "./recordingsZipPipeline";
import {
  localUnindexCaptures,
  localReindexCaptures,
  localIndexStateCounts,
  INDEX_STATE_EVENT,
  type IndexStateChanged,
  type IndexStateCounts,
} from "./localIndex";
import {
  type OffSessionNote,
  type OffSessionImage,
  type OffSessionVideo,
  type CaptureTag,
  type SelectableItemSnapshot,
  type ConfirmKind,
  offSessionNoteBody,
  formatSessionDateTime,
  localDateStr,
  fmtBytes,
  IconDownload,
  ContextNoteChipRow,
  ContextImageThumbs,
  ContextVideoThumbs,
  MiniCalendar,
} from "./App";

// ── Types ──────────────────────────────────────────────────────────────────────

type SensitivePreviewResponse = { rawOutput: string; parsed: number | null; label: string };

const OPENAI_MODEL_PREFIX = "openai:";

export type CaptureEntry =
  | { kind: "note"; id: string; appName: string; windowName: string; createdAt: string; data: OffSessionNote; selKey: string }
  | { kind: "image"; id: string; appName: string; windowName: string; createdAt: string; data: OffSessionImage; selKey: string }
  | { kind: "video"; id: string; appName: string; windowName: string; createdAt: string; data: OffSessionVideo; selKey: string };

type TextSubKey = "link" | "highlight" | "dictation" | "clipboard" | "manual" | "googleMeet";

/** List + clock: the log of download links already created (toolbar button). */
function IconShareLinkHistory() {
  return (
    <svg
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
      <path d="M3 8h9M3 12h7M3 16h9" />
      <circle cx="17" cy="12" r="4.5" />
      <path d="M17 9.5V12l2 1.2" />
    </svg>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface CapturesTabProps {
  // auth
  authReady: boolean;
  session: { user?: { id?: string } } | null;

  // sort / filter
  capturesSort: "date" | "app" | "type";
  setCapturesSort: (v: "date" | "app" | "type") => void;
  showFilters: boolean;
  setShowFilters: React.Dispatch<React.SetStateAction<boolean>>;
  filterTagIds: string[];
  setFilterTagIds: React.Dispatch<React.SetStateAction<string[]>>;
  filterSensitiveVerdicts: ("critical" | "potential")[];
  setFilterSensitiveVerdicts: React.Dispatch<React.SetStateAction<("critical" | "potential")[]>>;
  filterTagSensitiveCombine: "and" | "or";
  setFilterTagSensitiveCombine: React.Dispatch<React.SetStateAction<"and" | "or">>;
  filterDateFrom: string;
  setFilterDateFrom: React.Dispatch<React.SetStateAction<string>>;
  filterDateTo: string;
  setFilterDateTo: React.Dispatch<React.SetStateAction<string>>;
  capturesSearch: string;
  setCapturesSearch: React.Dispatch<React.SetStateAction<string>>;
  searchMatchIndex: number;
  setSearchMatchIndex: React.Dispatch<React.SetStateAction<number>>;
  searchTermAtCollapse: string | null;
  setSearchTermAtCollapse: React.Dispatch<React.SetStateAction<string | null>>;
  showDateRange: boolean;
  setShowDateRange: React.Dispatch<React.SetStateAction<boolean>>;
  dateFromBtnRef: React.RefObject<HTMLButtonElement | null>;
  dateFromRect: DOMRect | null;
  setDateFromRect: React.Dispatch<React.SetStateAction<DOMRect | null>>;
  showDateFromPicker: boolean;
  setShowDateFromPicker: React.Dispatch<React.SetStateAction<boolean>>;
  dateToBtnRef: React.RefObject<HTMLButtonElement | null>;
  dateToRect: DOMRect | null;
  setDateToRect: React.Dispatch<React.SetStateAction<DOMRect | null>>;
  showDateToPicker: boolean;
  setShowDateToPicker: React.Dispatch<React.SetStateAction<boolean>>;

  // tags
  captureTags: CaptureTag[];
  setShowTagsManager: React.Dispatch<React.SetStateAction<boolean>>;

  // history
  setShowHistoryPopup: React.Dispatch<React.SetStateAction<boolean>>;
  setHistoryFilter: React.Dispatch<React.SetStateAction<"all" | "dictation" | "copy">>;
  setHistoryDeletePending: React.Dispatch<React.SetStateAction<string | null>>;
  setHistoryFlushAllPending: React.Dispatch<React.SetStateAction<boolean>>;
  historyFlash: boolean;

  // group expand/collapse
  expandedAppGroups: Record<string, boolean>;
  setExpandedAppGroups: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  currentGroupNamesRef: React.MutableRefObject<string[]>;

  // data
  offSessionNotes: OffSessionNote[];
  offSessionImages: OffSessionImage[];
  offSessionVideos: OffSessionVideo[];

  // setters for data
  setOffSessionNotes: React.Dispatch<React.SetStateAction<OffSessionNote[]>>;
  setOffSessionImages: React.Dispatch<React.SetStateAction<OffSessionImage[]>>;
  setOffSessionVideos: React.Dispatch<React.SetStateAction<OffSessionVideo[]>>;

  // selection
  selectedItemIds: Set<string>;
  setSelectedItemIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleItemSelected: (key: string) => void;
  selectAllPending: boolean;
  setSelectAllPending: React.Dispatch<React.SetStateAction<boolean>>;

  // confirm / assign tag
  setConfirmKind: React.Dispatch<React.SetStateAction<ConfirmKind | null>>;
  setShowAssignTagPicker: React.Dispatch<React.SetStateAction<boolean>>;

  // scan
  processingIds: Set<string>;
  scanCancelRef: React.MutableRefObject<boolean>;
  scanResultCountsRef: React.MutableRefObject<{ critical: number; atRisk: number }>;
  sensitiveScanModel: string;
  openAiApiKey: string;
  setScanRescanDialog: React.Dispatch<React.SetStateAction<boolean>>;
  setShowScanPopup: React.Dispatch<React.SetStateAction<boolean>>;
  setScanBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setScanError: React.Dispatch<React.SetStateAction<string | null>>;
  setScanProgress: React.Dispatch<React.SetStateAction<{ done: number; total: number } | null>>;
  setScanResultCounts: React.Dispatch<React.SetStateAction<{ critical: number; atRisk: number } | null>>;
  setScanCancelPending: React.Dispatch<React.SetStateAction<boolean>>;

  onRequestCaptureReload: () => void;

  // download
  zipDownloadBusy: boolean;
  downloadRecordingsContextArchive: () => Promise<void>;

  // media metadata
  fileSizeByPath: Record<string, number>;
  ocrTextByPath: Record<string, string>;
  updateOcrText: (path: string, newText: string) => void;

  // PDF drop zone
  pdfDropZoneRef: React.RefObject<PdfDropZoneHandle | null>;
  pdfPagesMode: "count" | "percent";
  pdfPagesCount: number;
  pdfPagesPercent: number;
  pdfWarnThreshold: number;
  pdfSummaryLang: string;
  pdfModelFilename: string;
  pdfParallelism: number;
  setPdfIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  handlePdfSummaryReady: (combined: string, docName: string, filePath: string, fileSize: number, rawContent?: string[]) => void;

  // filter: text sub-types
  filterTextSubTypes: string[];
  setFilterTextSubTypes: React.Dispatch<React.SetStateAction<string[]>>;

  onCaptureTagChange: (key: string, newTagIds: string[]) => void;
  onSensitiveStateChange: (key: string, state: string) => void;
  onCaptureDataSave: (key: string, fields: { text?: string | null; explanation?: string | null; transcription?: string | null; processDocIndexDoc?: boolean | null }) => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function CapturesTab({
  authReady,
  session,
  capturesSort,
  setCapturesSort,
  showFilters,
  setShowFilters,
  filterTagIds,
  setFilterTagIds,
  filterSensitiveVerdicts,
  setFilterSensitiveVerdicts,
  filterTagSensitiveCombine,
  setFilterTagSensitiveCombine,
  filterDateFrom,
  setFilterDateFrom,
  filterDateTo,
  setFilterDateTo,
  capturesSearch,
  setCapturesSearch,
  searchMatchIndex,
  setSearchMatchIndex,
  searchTermAtCollapse,
  setSearchTermAtCollapse,
  showDateRange,
  setShowDateRange,
  dateFromBtnRef,
  dateFromRect,
  setDateFromRect,
  showDateFromPicker,
  setShowDateFromPicker,
  dateToBtnRef,
  dateToRect,
  setDateToRect,
  showDateToPicker,
  setShowDateToPicker,
  captureTags,
  setShowTagsManager,
  setShowHistoryPopup,
  setHistoryFilter,
  setHistoryDeletePending,
  setHistoryFlushAllPending,
  historyFlash,
  expandedAppGroups,
  setExpandedAppGroups,
  currentGroupNamesRef,
  offSessionNotes,
  offSessionImages,
  offSessionVideos,
  setOffSessionNotes,
  setOffSessionImages,
  setOffSessionVideos,
  selectedItemIds,
  setSelectedItemIds,
  toggleItemSelected,
  selectAllPending,
  setSelectAllPending,
  setConfirmKind,
  setShowAssignTagPicker,
  processingIds,
  scanCancelRef,
  scanResultCountsRef,
  sensitiveScanModel,
  openAiApiKey,
  setScanRescanDialog,
  setShowScanPopup,
  setScanBusy,
  setScanError,
  setScanProgress,
  setScanResultCounts,
  setScanCancelPending,
  onRequestCaptureReload,
  zipDownloadBusy,
  downloadRecordingsContextArchive,
  fileSizeByPath,
  ocrTextByPath,
  updateOcrText,
  pdfDropZoneRef,
  pdfPagesMode,
  pdfPagesCount,
  pdfPagesPercent,
  pdfWarnThreshold,
  pdfSummaryLang,
  pdfModelFilename,
  pdfParallelism,
  setPdfIsProcessing,
  handlePdfSummaryReady,
  filterTextSubTypes,
  setFilterTextSubTypes,
  onCaptureTagChange,
  onSensitiveStateChange,
  onCaptureDataSave,
}: CapturesTabProps) {

  const [quickTagPopover, setQuickTagPopover] = useState<{ selKey: string; rect: DOMRect } | null>(null);
  const quickTagPopoverRef = useRef<HTMLDivElement | null>(null);
  /** Screenshot or recording currently shown in the in-app viewer. */
  const [viewerState, setViewerState] = useState<{ path: string; kind: "image" | "video" } | null>(null);
  const openMediaViewer = useCallback(
    (path: string, kind: "image" | "video") => setViewerState({ path, kind }),
    [],
  );
  /** Number of captures currently matching the search, kept in sync by the counter block below. */
  const searchMatchCountRef = useRef(0);
  useCloseOnOutsidePress(quickTagPopoverRef, quickTagPopover !== null, () => setQuickTagPopover(null));

  // ── Share a selection of captures as a download link ─────────────────────────
  /** Local profile id — selects which bucket / service account the share flow uses. */
  const storeUserId = session?.user?.id ?? "";
  const [shareLinkHistoryOpen, setShareLinkHistoryOpen] = useState(false);
  const [shareModalState, setShareModalState] = useState<{
    sourcePath: string;
    defaultStem: string;
    extensionWithDot: string;
  } | null>(null);
  const [shareZipBusy, setShareZipBusy] = useState(false);
  const [sharingConfigured, setSharingConfigured] = useState(false);
  /** Curation modal for "Share as assistant" — narrows the selection, then builds the archive. */
  const [shareAssistantOpen, setShareAssistantOpen] = useState(false);
  // Transient confirmation shown after a link is created — KnowledgeShareModal closes itself
  // immediately on success, so without this the modal just vanishes with no feedback that the
  // (possibly minutes-long) upload actually finished and the link was copied.
  const [shareToast, setShareToast] = useState<string | null>(null);
  const shareToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Path of the temp ZIP staged for the currently-open share modal. The ZIP is written to a temp
  // file that nothing else ever deletes, so it must be removed once the modal closes or the link
  // is copied — whichever happens first — or every share leaks a (possibly multi-GB) file.
  const pendingZipTempPathRef = useRef<string | null>(null);

  // Whether GCP-backed sharing is configured for this profile. Sharing itself never needs this —
  // KnowledgeShareModal always offers "Save the file" — but it disables the "Get a link" choice
  // there and hides the share-link-history button, both meaningless with no bucket.
  // getGcpShareConfig resolves to `null` when sharing genuinely isn't configured (handled by
  // .then) and rejects when the config exists but is broken, e.g. a corrupted service account file
  // (safe default, handled by .catch); either way `sharingConfigured` ends up false.
  useEffect(() => {
    if (!storeUserId) return;
    getGcpShareConfig(storeUserId)
      .then((c) => setSharingConfigured(c != null))
      .catch(() => setSharingConfigured(false));
  }, [storeUserId]);

  useEffect(() => {
    return () => {
      if (shareToastTimerRef.current != null) {
        window.clearTimeout(shareToastTimerRef.current);
      }
    };
  }, []);

  const showShareToast = useCallback((message: string) => {
    setShareToast(message);
    if (shareToastTimerRef.current != null) window.clearTimeout(shareToastTimerRef.current);
    shareToastTimerRef.current = window.setTimeout(() => {
      setShareToast(null);
      shareToastTimerRef.current = null;
    }, 3000);
  }, []);

  /** Deletes the staged temp ZIP (if any) exactly once. */
  const cleanupPendingZipTempFile = useCallback(() => {
    const path = pendingZipTempPathRef.current;
    if (!path) return;
    pendingZipTempPathRef.current = null;
    void deleteTempFile(path);
  }, []);

  // Switching tabs unmounts this component without firing the modal's onClose or
  // onCopied, so the staged ZIP would otherwise be left behind in the temp folder.
  useEffect(() => {
    return () => {
      const path = pendingZipTempPathRef.current;
      if (!path) return;
      pendingZipTempPathRef.current = null;
      void deleteTempFile(path);
    };
  }, []);

  const [indexActionBusy, setIndexActionBusy] = useState(false);
  const [indexCounts, setIndexCounts] = useState<IndexStateCounts | null>(null);

  // Keep the status pill roughly in step with the 15s auto-index loop in Rust.
  // This one stays in the frontend: it only refreshes what is on screen.
  //
  // It is also the safety net under the per-row badges. Those follow the events
  // below, which is instant but only reaches a window that was awake to hear them —
  // this is a tray app whose window is hidden most of the time. So a tick that finds
  // the counts different from what the last refresh left behind has caught a change
  // the rows may have missed, and re-reads them. On an app with everything indexed
  // nothing moves, the comparison never trips, and nothing extra is asked for.
  const lastCountsRef = useRef<string | null>(null);
  // `pending` and `indexing` deliberately added together: which of the two a capture
  // sits in changes constantly during a pass and says nothing about whether the rows
  // are behind. Everything that does — a capture arriving, finishing, failing, being
  // removed — moves one of these numbers.
  const countsKey = (c: IndexStateCounts) =>
    `${c.pending + c.indexing}|${c.indexed}|${c.failed}|${c.excluded}`;
  const refreshIndexCounts = useCallback(async (): Promise<string | null> => {
    if (!storeUserId) return null;
    try {
      const counts = await localIndexStateCounts(storeUserId);
      setIndexCounts(counts);
      return countsKey(counts);
    } catch {
      return null;
    }
  }, [storeUserId]);

  useEffect(() => {
    if (!storeUserId) return;
    let cancelled = false;
    const tick = () => {
      void refreshIndexCounts().then((key) => {
        if (cancelled || key === null) return;
        const missed = lastCountsRef.current !== null && lastCountsRef.current !== key;
        lastCountsRef.current = key;
        if (missed) onRequestCaptureReload();
      });
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [storeUserId, refreshIndexCounts, onRequestCaptureReload]);

  /**
   * Follow a background indexing pass capture by capture.
   *
   * The pass sends one event per capture as it claims it and again when it is done,
   * so a row can turn its spinner on and off at the moment it happens instead of up
   * to fifteen seconds later — which would show a capture still "waiting" long after
   * it was searchable, or a spinner that keeps turning on something already
   * finished. Only the one row is touched: re-reading every capture for a state
   * change on one of them is what the polling above is careful to avoid.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const promise = listen<IndexStateChanged>(INDEX_STATE_EVENT, (event) => {
      const { captureId, state } = event.payload;
      if (!captureId || !state) return;
      const patch = <T extends { id: string; indexState?: string; indexError?: string | null }>(
        prev: T[],
      ): T[] => {
        let changed = false;
        const next = prev.map((row) => {
          if (row.id !== captureId || row.indexState === state) return row;
          changed = true;
          // A capture that is no longer failed has no failure left to explain. The
          // event does not carry the new reason when it is, so the old one stands
          // until the next full read, which is the right way round: a stale reason
          // beats no reason, and "why" is only ever read from the badge's tooltip.
          return {
            ...row,
            indexState: state,
            indexError: state === "failed" ? row.indexError ?? null : null,
          };
        });
        return changed ? next : prev;
      };
      setOffSessionNotes(patch);
      setOffSessionImages(patch);
      setOffSessionVideos(patch);
      // Keep the pill in step, and keep the poll above from reading this as a change
      // the rows missed and re-reading all of them for nothing. Only on a terminal
      // state: a capture moving from waiting to in-flight changes which two counts
      // hold it but not the total left to do, so the pill would read the same.
      if (state !== "indexing") {
        void refreshIndexCounts().then((key) => {
          if (key !== null) lastCountsRef.current = key;
        });
      }
    });
    void promise.then((fn) => {
      if (cancelled) { fn(); return; }
      unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [refreshIndexCounts, setOffSessionNotes, setOffSessionImages, setOffSessionVideos]);

  /** Selection keys look like "offNote|<id>"; the backend wants bare capture ids. */
  const selectedCaptureIds = useCallback(
    () => [...selectedItemIds].map((k) => k.slice(k.indexOf("|") + 1)),
    [selectedItemIds],
  );

  /**
   * The selection in the shape the curation modal narrows: its id, what it is
   * tagged with, whether a sensitive scan flagged it, and whether the user took it
   * out of their own assistant. Nothing below the modal re-applies those rules, so
   * this is the input the guarantee rests on.
   */
  const selectedCapturesForShare = useMemo<ShareAsAssistantCapture[]>(() => {
    const out: ShareAsAssistantCapture[] = [];
    for (const n of offSessionNotes) {
      if (selectedItemIds.has(`offNote|${n.id}`)) {
        out.push({
          id: n.id,
          tagIds: n.tagIds,
          sensitiveVerdict: n.sensitiveVerdict,
          indexState: n.indexState,
        });
      }
    }
    for (const i of offSessionImages) {
      if (selectedItemIds.has(`offImage|${i.id}`)) {
        out.push({
          id: i.id,
          tagIds: i.tagIds,
          sensitiveVerdict: i.sensitiveVerdict,
          indexState: i.indexState,
        });
      }
    }
    for (const v of offSessionVideos) {
      if (selectedItemIds.has(`offVideo|${v.id}`)) {
        out.push({
          id: v.id,
          tagIds: v.tagIds,
          sensitiveVerdict: v.sensitiveVerdict,
          indexState: v.indexState,
        });
      }
    }
    return out;
  }, [selectedItemIds, offSessionNotes, offSessionImages, offSessionVideos]);

  /**
   * Which index-state actions actually apply to the current selection, so we only
   * offer the one that would do something. Offering both always meant "Add back to
   * assistant" showed up on selections where nothing had been removed.
   */
  const selectionIndexActions = useMemo(() => {
    let removable = false;
    let restorable = false;
    const check = (state: string | undefined) => {
      if (state === "excluded" || state === "failed") restorable = true;
      else removable = true;
    };
    for (const n of offSessionNotes) {
      if (selectedItemIds.has(`offNote|${n.id}`)) check(n.indexState);
    }
    for (const i of offSessionImages) {
      if (selectedItemIds.has(`offImage|${i.id}`)) check(i.indexState);
    }
    for (const v of offSessionVideos) {
      if (selectedItemIds.has(`offVideo|${v.id}`)) check(v.indexState);
    }
    return { removable, restorable };
  }, [selectedItemIds, offSessionNotes, offSessionImages, offSessionVideos]);

  const runIndexAction = useCallback(
    async (action: "unindex" | "reindex", ids: string[]) => {
      if (!storeUserId || ids.length === 0 || indexActionBusy) return;
      setIndexActionBusy(true);
      try {
        if (action === "unindex") await localUnindexCaptures(storeUserId, ids);
        else await localReindexCaptures(storeUserId, ids);
        onRequestCaptureReload();
        localIndexStateCounts(storeUserId).then(setIndexCounts).catch(() => {});
      } catch (e) {
        window.alert(`Could not update the assistant index: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setIndexActionBusy(false);
      }
    },
    [storeUserId, indexActionBusy, onRequestCaptureReload],
  );

  const shareSelectedCaptures = useCallback(async () => {
    if (shareZipBusy) return;
    setShareZipBusy(true);
    try {
      const entries = buildCaptureExportEntries(
        offSessionNotes.filter((n) => selectedItemIds.has(`offNote|${n.id}`)),
        offSessionImages.filter((i) => selectedItemIds.has(`offImage|${i.id}`)),
        offSessionVideos.filter((v) => selectedItemIds.has(`offVideo|${v.id}`)),
      );
      const now = new Date().toISOString();
      const tempZipPath = await buildCapturesZipToTemp(entries, now);
      // Safety net: if a previous temp ZIP is somehow still pending cleanup, delete it before
      // tracking the new one so the old one is never leaked.
      cleanupPendingZipTempFile();
      pendingZipTempPathRef.current = tempZipPath;
      setShareModalState({
        sourcePath: tempZipPath,
        defaultStem: `captures-${localDateStr(now)}`,
        extensionWithDot: ".zip",
      });
    } catch (e) {
      console.error("build share ZIP:", e);
      window.alert(
        `Could not prepare the selected captures for sharing: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setShareZipBusy(false);
    }
  }, [
    shareZipBusy,
    offSessionNotes,
    offSessionImages,
    offSessionVideos,
    selectedItemIds,
    cleanupPendingZipTempFile,
  ]);

  useEffect(() => {
    if (!quickTagPopover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQuickTagPopover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quickTagPopover]);

  useEffect(() => {
    if (!quickTagPopover) return;
    const onScroll = () => setQuickTagPopover(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [quickTagPopover]);

  const getTagIdsForSelKey = (selKey: string): string[] => {
    if (selKey.startsWith("offNote|")) {
      const id = selKey.slice(8);
      return offSessionNotes.find((n) => n.id === id)?.tagIds ?? [];
    }
    if (selKey.startsWith("offImage|")) {
      const id = selKey.slice(9);
      return offSessionImages.find((i) => i.id === id)?.tagIds ?? [];
    }
    if (selKey.startsWith("offVideo|")) {
      const id = selKey.slice(9);
      return offSessionVideos.find((v) => v.id === id)?.tagIds ?? [];
    }
    return [];
  };

  /** Quick + popover: add a tag only (removal stays on the inline badges). */
  const addTagOnSelKey = useCallback((selKey: string, tagId: string) => {
    if (selKey.startsWith("offNote|")) {
      const id = selKey.slice(8);
      const note = offSessionNotes.find((n) => n.id === id);
      if (!note) return;
      const cur = note.tagIds ?? [];
      if (cur.includes(tagId)) return;
      const newTagIds = [...cur, tagId];
      setOffSessionNotes((prev) => prev.map((n) => n.id !== id ? n : { ...n, tagIds: newTagIds }));
      onCaptureTagChange(selKey, newTagIds);
    } else if (selKey.startsWith("offImage|")) {
      const id = selKey.slice(9);
      const img = offSessionImages.find((i) => i.id === id);
      if (!img) return;
      const cur = img.tagIds ?? [];
      if (cur.includes(tagId)) return;
      const newTagIds = [...cur, tagId];
      setOffSessionImages((prev) => prev.map((i) => i.id !== id ? i : { ...i, tagIds: newTagIds }));
      onCaptureTagChange(selKey, newTagIds);
    } else if (selKey.startsWith("offVideo|")) {
      const id = selKey.slice(9);
      const vid = offSessionVideos.find((v) => v.id === id);
      if (!vid) return;
      const cur = vid.tagIds ?? [];
      if (cur.includes(tagId)) return;
      const newTagIds = [...cur, tagId];
      setOffSessionVideos((prev) => prev.map((v) => v.id !== id ? v : { ...v, tagIds: newTagIds }));
      onCaptureTagChange(selKey, newTagIds);
    }
  }, [offSessionNotes, offSessionImages, offSessionVideos, setOffSessionImages, setOffSessionNotes, setOffSessionVideos, onCaptureTagChange]);

  const selectionIncludesBusyProcessing = [...selectedItemIds].some((k) => {
    if (processingIds.has(k)) return true;
    const id = k.startsWith("offNote|") ? k.slice(8) : k.startsWith("offImage|") ? k.slice(9) : k.startsWith("offVideo|") ? k.slice(9) : null;
    return id !== null && processingIds.has(id);
  });

  return (
    <>
      {!authReady ? (
        <div className="glass-card">
          <p className="settings-hint">Loading…</p>
        </div>
      ) : session ? (
        <>
          {/* Captures toolbar */}
          <div className="glass-card captures-toolbar-card">
            <div className="controls-row">
              <div className="controls-row-buttons" style={{ flex: 1 }}>
                <div className="captures-sort-tabs">
                  <button type="button" className={`captures-sort-tab${capturesSort === "date" ? " active" : ""}`} onClick={() => setCapturesSort("date")}>
                    <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><path d="M8 2v12M4 10l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Date
                  </button>
                  <button type="button" className={`captures-sort-tab${capturesSort === "app" ? " active" : ""}`} onClick={() => setCapturesSort("app")}>
                    <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5"/><rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5"/><rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5"/></svg>
                    App
                  </button>
                  <button type="button" className={`captures-sort-tab${capturesSort === "type" ? " active" : ""}`} onClick={() => setCapturesSort("type")}>
                    <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    Type
                  </button>
                </div>
                <button
                  type="button"
                  className={`btn btn-secondary btn-small captures-filter-btn${showFilters ? " btn-active" : ""}${filterTagIds.length > 0 || filterSensitiveVerdicts.length > 0 || filterDateFrom || filterDateTo || capturesSearch ? " has-active-filters" : ""}`}
                  onClick={() => setShowFilters((v) => !v)}
                  title="Toggle filters"
                >
                  <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5 8h6M7 12h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
                  {(() => { const n = filterTagIds.length + filterSensitiveVerdicts.length + (filterDateFrom ? 1 : 0) + (filterDateTo ? 1 : 0) + (capturesSearch ? 1 : 0); return `Filter${n > 0 ? ` (${n})` : ""}`; })()}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small captures-tags-btn"
                  onClick={() => setShowTagsManager(true)}
                  title="Manage tags"
                >
                  <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><path d="M2.5 9.5L9.5 2.5a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4L6.5 13.5a1 1 0 0 1-.7.3H3a.5.5 0 0 1-.5-.5v-2.8a1 1 0 0 1 .3-.7Z" stroke="currentColor" strokeWidth="1.5"/><circle cx="5.5" cy="10.5" r="1" fill="currentColor"/></svg>
                  Tags
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => { setShowHistoryPopup(true); setHistoryFilter("all"); setHistoryDeletePending(null); setHistoryFlushAllPending(false); }}
                  title="Capture history"
                  style={
                    historyFlash
                      ? {
                          color: "var(--color-green, #22c55e)",
                          borderColor: "var(--color-green, #22c55e)",
                          transition: "color 120ms ease, border-color 120ms ease",
                        }
                      : { transition: "color 300ms ease, border-color 300ms ease" }
                  }
                >
                  <IconCaptureHistoryClock />
                </button>
                {(capturesSort === "app" || capturesSort === "type") && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => {
                      const next: Record<string, boolean> = {};
                      for (const k of currentGroupNamesRef.current) next[k] = false;
                      setExpandedAppGroups(next);
                      setSearchTermAtCollapse(capturesSearch);
                    }}
                  >
                    Collapse
                  </button>
                )}
                {indexCounts && (() => {
                  // `indexing` is counted with `pending`: both mean "not searchable
                  // yet", and the pill is about how much is left, not about which of
                  // the two a given capture is in \u2014 that is what the row badges are
                  // for. Leaving it out of the total would take every capture being
                  // worked on out of the count with nothing to show it had gone.
                  const { indexed, failed } = indexCounts;
                  const pending = indexCounts.pending + indexCounts.indexing;
                  const total = pending + indexed + failed;
                  if (total === 0) return null;
                  const label = failed > 0
                    ? `${indexed} of ${total} indexed, ${failed} failed`
                    : pending > 0
                      ? `Indexing \u2014 ${indexed} of ${total} done`
                      : "All captures indexed";
                  return (
                    <span
                      className="captures-index-pill"
                      title={
                        failed > 0
                          ? "Some captures could not be indexed. Select them and choose Add back to assistant to retry."
                          : pending > 0
                            ? "Captures become searchable by the assistant as they finish indexing."
                            : "Every capture is searchable by the assistant."
                      }
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: "1px solid var(--glass-border)",
                        opacity: 0.85,
                        color: failed > 0 ? "#dc2626" : undefined,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {label}
                    </span>
                  );
                })()}
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-secondary btn-tiny btn-export-download"
                  onClick={() => void downloadRecordingsContextArchive()}
                  disabled={zipDownloadBusy}
                  title="Save a ZIP to Downloads"
                  aria-label="Download"
                >
                  <span className="recording-export-inner">
                    {zipDownloadBusy ? (
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="history-icon-spinner" aria-hidden>
                        <circle cx="12" cy="12" r="9" strokeDasharray="36 28" />
                      </svg>
                    ) : (
                      <IconDownload />
                    )}
                  </span>
                </button>
                {sharingConfigured && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-tiny"
                    onClick={() => setShareLinkHistoryOpen(true)}
                    title="Download links you shared"
                    aria-label="Download links you shared"
                  >
                    <IconShareLinkHistory />
                  </button>
                )}
              </div>
            </div>
            {showFilters && (
              <div className="captures-filters-row">
                {/* Row 1: date toggle · search · reset */}
                <div className="captures-filters-main-row">
                  <button
                    type="button"
                    className={`captures-date-toggle-btn${(filterDateFrom || filterDateTo) ? " has-value" : ""}${showDateRange ? " is-open" : ""}`}
                    title="Date range filter"
                    onClick={() => setShowDateRange((v) => !v)}
                  >
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="12" r="9"/>
                      <polyline points="12 7 12 12 16 14"/>
                    </svg>
                  </button>

                  <div className="captures-search-row captures-search-row--inline">
                    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" className="captures-search-icon">
                      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <input
                      type="text"
                      className="captures-search-input"
                      placeholder="Search captures…"
                      value={capturesSearch}
                      onChange={(e) => { setCapturesSearch(e.target.value); setSearchMatchIndex(0); if (searchTermAtCollapse !== null && e.target.value !== searchTermAtCollapse) setSearchTermAtCollapse(null); }}
                    />
                    {capturesSearch && (
                      <>
                        <span className="captures-search-nav-count" id="captures-search-count-label" />
                        <button type="button" className="captures-search-nav-btn" title="Previous match"
                          onClick={() => setSearchMatchIndex((i) => Math.max(0, i - 1))}
                        >
                          <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><path d="M10 13L5 8l5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        <button type="button" className="captures-search-nav-btn" title="Next match"
                          onClick={() =>
                            setSearchMatchIndex((i) =>
                              Math.min(i + 1, Math.max(0, searchMatchCountRef.current - 1))
                            )
                          }
                        >
                          <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        <button type="button" className="captures-search-clear" onClick={() => { setCapturesSearch(""); setSearchMatchIndex(0); setSearchTermAtCollapse(null); }}>×</button>
                      </>
                    )}
                  </div>

                  {(filterTagIds.length > 0 || filterSensitiveVerdicts.length > 0 || filterDateFrom || filterDateTo || capturesSearch) && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small captures-reset-btn"
                      onClick={() => {
                        setFilterTagIds([]);
                        setFilterSensitiveVerdicts([]);
                        setFilterTagSensitiveCombine("and");
                        setFilterDateFrom("");
                        setFilterDateTo("");
                        setCapturesSearch("");
                        setSearchMatchIndex(0);
                        setSearchTermAtCollapse(null);
                        setShowDateRange(false);
                      }}
                    >
                      Reset
                    </button>
                  )}
                </div>

                {/* Date range row */}
                {showDateRange && (
                  <div className="captures-filters-date-row">
                    <div className="captures-filter-group captures-filter-group--inline">
                      <label className="captures-filter-label">From</label>
                      <button
                        ref={dateFromBtnRef}
                        type="button"
                        className={`captures-date-btn${filterDateFrom ? " has-value" : ""}`}
                        onClick={() => {
                          const r = dateFromBtnRef.current?.getBoundingClientRect() ?? null;
                          setDateFromRect(r);
                          setShowDateFromPicker((v) => !v);
                          setShowDateToPicker(false);
                        }}
                      >
                        {filterDateFrom || "Pick date"}
                        {filterDateFrom && (
                          <span className="captures-date-clear" onClick={(e) => { e.stopPropagation(); setFilterDateFrom(""); setShowDateFromPicker(false); }}>×</span>
                        )}
                      </button>
                    </div>
                    <div className="captures-filter-group captures-filter-group--inline">
                      <label className="captures-filter-label">To</label>
                      <button
                        ref={dateToBtnRef}
                        type="button"
                        className={`captures-date-btn${filterDateTo ? " has-value" : ""}`}
                        onClick={() => {
                          const r = dateToBtnRef.current?.getBoundingClientRect() ?? null;
                          setDateToRect(r);
                          setShowDateToPicker((v) => !v);
                          setShowDateFromPicker(false);
                        }}
                      >
                        {filterDateTo || "Pick date"}
                        {filterDateTo && (
                          <span className="captures-date-clear" onClick={(e) => { e.stopPropagation(); setFilterDateTo(""); setShowDateToPicker(false); }}>×</span>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {showDateFromPicker && dateFromRect && createPortal(
                  <div className="mini-calendar-portal" style={{ top: dateFromRect.bottom + 6, left: dateFromRect.left }}>
                    <MiniCalendar value={filterDateFrom} onChange={setFilterDateFrom} onClose={() => setShowDateFromPicker(false)} />
                  </div>,
                  document.body
                )}
                {showDateToPicker && dateToRect && createPortal(
                  <div className="mini-calendar-portal" style={{ top: dateToRect.bottom + 6, left: dateToRect.left }}>
                    <MiniCalendar value={filterDateTo} onChange={setFilterDateTo} onClose={() => setShowDateToPicker(false)} />
                  </div>,
                  document.body
                )}

                {/* Row: tag chips + sensitive verdict chips */}
                {(captureTags.length > 0 || offSessionNotes.some((n) => n.sensitiveVerdict)) && (
                  <div className="captures-filter-chips-row">
                    <span
                      className="captures-filter-and-or-group"
                      title="When both tag and sensitive (Critical / At risk) filters are active, match ALL (AND) or ANY (OR). Date and search still apply to every result."
                    >
                      <div className="captures-filter-and-or-toggle" role="group" aria-label="Combine tag and sensitive filters">
                        <button
                          type="button"
                          className={`captures-filter-and-or-btn${filterTagSensitiveCombine === "and" ? " captures-filter-and-or-btn--active" : ""}`}
                          onClick={() => setFilterTagSensitiveCombine("and")}
                        >
                          AND
                        </button>
                        <button
                          type="button"
                          className={`captures-filter-and-or-btn${filterTagSensitiveCombine === "or" ? " captures-filter-and-or-btn--active" : ""}`}
                          onClick={() => setFilterTagSensitiveCombine("or")}
                        >
                          OR
                        </button>
                      </div>
                    </span>
                    {captureTags.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        className={`captures-tag-chip${filterTagIds.includes(tag.id) ? " captures-tag-chip--active" : ""}`}
                        style={{ "--tag-color": tag.color } as CSSProperties}
                        onClick={() => setFilterTagIds((prev) => prev.includes(tag.id) ? prev.filter((id) => id !== tag.id) : [...prev, tag.id])}
                      >
                        {tag.name}
                      </button>
                    ))}
                    {offSessionNotes.some((n) => n.sensitiveVerdict) && (
                      (["potential", "critical"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          className={`captures-tag-chip captures-sensitive-chip--${v}${filterSensitiveVerdicts.includes(v) ? " captures-tag-chip--active" : ""}`}
                          onClick={() => setFilterSensitiveVerdicts((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
                        >
                          {v === "critical" ? "⚠ Critical" : "● At risk"}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>


          <div className="selection-action-bar">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setSelectAllPending(true)}
            >
              Select all
            </button>
            {selectedItemIds.size > 0 && (
              <>
                <button
                  type="button"
                  className="btn btn-destructive btn-small"
                  onClick={() => {
                    const items: SelectableItemSnapshot[] = [];
                    for (const key of selectedItemIds) {
                      if (key.startsWith("offNote|")) {
                        items.push({ kind: "offNote", id: key.slice(8) });
                      } else if (key.startsWith("offImage|")) {
                        const id = key.slice(9);
                        const img = offSessionImages.find((i) => i.id === id);
                        if (img) items.push({ kind: "offImage", id, path: img.path });
                      } else if (key.startsWith("offVideo|")) {
                        const id = key.slice(9);
                        const vid = offSessionVideos.find((v) => v.id === id);
                        if (vid) items.push({ kind: "offVideo", id, path: vid.path });
                      }
                    }
                    if (items.length > 0) setConfirmKind({ type: "deleteSelected", items });
                  }}
                >
                  Delete ({selectedItemIds.size})
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={selectionIncludesBusyProcessing}
                  title={selectionIncludesBusyProcessing ? "Waiting for analysis or AI tag assignment to finish…" : undefined}
                  onClick={() => setShowAssignTagPicker(true)}
                >
                  Assign tag
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={selectionIncludesBusyProcessing}
                  title={selectionIncludesBusyProcessing ? "Waiting for analysis or AI tag assignment to finish…" : undefined}
                  onClick={() => {
                    const hasScanned = [...selectedItemIds].some((key) => {
                      if (key.startsWith("offNote|")) {
                        const note = offSessionNotes.find((n) => n.id === key.slice(8));
                        return !!note?.sensitiveVerdict;
                      }
                      return false;
                    });
                    if (hasScanned) {
                      setScanRescanDialog(true);
                    } else {
                      void (async () => {
                        setScanRescanDialog(false);
                        setShowScanPopup(true);
                        setScanBusy(true);
                        setScanError(null);
                        scanCancelRef.current = false;
                        type ScanItem = { text: string; appName: string; windowTitle: string; kind: "note"; noteId?: string };
                        const items: ScanItem[] = [];
                        for (const key of selectedItemIds) {
                          if (key.startsWith("offNote|")) {
                            const note = offSessionNotes.find((n) => n.id === key.slice(8));
                            if (!note) continue;
                            const text = offSessionNoteBody(note);
                            if (!text.trim()) continue;
                            items.push({ text, appName: note.contextFocus?.appName ?? "", windowTitle: note.contextFocus?.windowName ?? "", kind: "note", noteId: note.id });
                          }
                        }
                        setScanProgress({ done: 0, total: items.length });
                        const scanUsesRemote = sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX);
                        for (let i = 0; i < items.length; i++) {
                          if (scanCancelRef.current) break;
                          const item = items[i]!;
                          try {
                            let r = await invoke<SensitivePreviewResponse>("sensitive_preview_run_cmd", {
                              req: { text: item.text, displayApp: item.appName, windowTitle: item.windowTitle },
                              sensitiveScanModel: scanUsesRemote ? sensitiveScanModel : null,
                              openaiApiKey: sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX)
                                ? openAiApiKey.trim()
                                : null,
                            });
                            if (r.parsed === null && !scanCancelRef.current) {
                              r = await invoke<SensitivePreviewResponse>("sensitive_preview_run_cmd", {
                                req: { text: item.text, displayApp: item.appName, windowTitle: item.windowTitle },
                                sensitiveScanModel: scanUsesRemote ? sensitiveScanModel : null,
                                openaiApiKey: sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX)
                                  ? openAiApiKey.trim()
                                  : null,
                              });
                            }
                            if (r.parsed !== null) {
                              const verdict: "critical" | "potential" | "clean" = r.parsed === -1 ? "critical" : r.parsed === 0 ? "potential" : "clean";
                              if (verdict === "critical") scanResultCountsRef.current.critical += 1;
                              else if (verdict === "potential") scanResultCountsRef.current.atRisk += 1;
                              setOffSessionNotes((prev) => prev.map((n) => n.id === item.noteId ? { ...n, sensitiveVerdict: verdict } : n));
                              onSensitiveStateChange(`offNote|${item.noteId}`, verdict);
                            }
                          } catch { /* skip */ }
                          setScanProgress({ done: i + 1, total: items.length });
                        }
                        setScanResultCounts({ ...scanResultCountsRef.current }); setScanBusy(false); setScanCancelPending(false);
                      })();
                    }
                  }}
                >
                  Scan sensitive
                </button>
                {selectionIndexActions.removable && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={indexActionBusy}
                    title="Keep these captures but stop the assistant from using them."
                    onClick={() => void runIndexAction("unindex", selectedCaptureIds())}
                  >
                    Remove from assistant
                  </button>
                )}
                {selectionIndexActions.restorable && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={indexActionBusy}
                    title="Queue these captures to be indexed again."
                    onClick={() => void runIndexAction("reindex", selectedCaptureIds())}
                  >
                    Add back to assistant
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={shareZipBusy}
                  title="Share the selected captures as a link or a saved file"
                  onClick={() => void shareSelectedCaptures()}
                >
                  {shareZipBusy ? "Preparing…" : "Share"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={shareZipBusy || !storeUserId}
                  title="Send the selected captures as a file someone else's assistant can answer questions from"
                  onClick={() => setShareAssistantOpen(true)}
                >
                  Share as assistant
                </button>
              </>
            )}
            {selectedItemIds.size > 0 && (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => setSelectedItemIds(new Set())}
              >
                Deselect all
              </button>
            )}
            {selectedItemIds.size === 0 && (
              <span className="selection-count-hint">No selection</span>
            )}
          </div>

          <PdfDropZone
            ref={pdfDropZoneRef}
            pagesMode={pdfPagesMode}
            pagesCount={pdfPagesCount}
            pagesPercent={pdfPagesPercent}
            warnThreshold={pdfWarnThreshold}
            summaryLang={pdfSummaryLang}
            modelFilename={pdfModelFilename}
            openaiApiKey={openAiApiKey}
            parallelism={pdfParallelism}
            onBusyChange={setPdfIsProcessing}
            onSummaryReady={handlePdfSummaryReady}
          />


          <div className="captures-scroll-area">
          <p className="section-label" style={{ paddingTop: 6, marginBottom: 6 }}>Captures</p>

          {(() => {
            // Every capture lives here now: no uploadedAt filter, so captures that
            // used to be visible only in Knowledge are listed (and editable) too.
            const allEntries: CaptureEntry[] = [
              ...offSessionNotes.map((n) => ({
                kind: "note" as const, id: n.id,
                appName: n.contextFocus?.appName || "Unknown", windowName: n.contextFocus?.windowName || "",
                createdAt: n.createdAt, data: n, selKey: `offNote|${n.id}`,
              })),
              ...offSessionImages.map((i) => ({
                kind: "image" as const, id: i.id,
                appName: i.contextFocus?.appName || "Unknown", windowName: i.contextFocus?.windowName || "",
                createdAt: i.createdAt, data: i, selKey: `offImage|${i.id}`,
              })),
              ...offSessionVideos.map((v) => ({
                kind: "video" as const, id: v.id,
                appName: v.contextFocus?.appName || "Unknown", windowName: v.contextFocus?.windowName || "",
                createdAt: v.createdAt, data: v, selKey: `offVideo|${v.id}`,
              })),
            ];

            const filtered = allEntries
              .filter((e) => {
                if (filterDateFrom && localDateStr(e.createdAt) < filterDateFrom) return false;
                if (filterDateTo && localDateStr(e.createdAt) > filterDateTo) return false;
                const tagFilterActive = filterTagIds.length > 0;
                const sensFilterActive = filterSensitiveVerdicts.length > 0;
                const tagPasses =
                  !tagFilterActive ||
                  filterTagIds.some((t) => ((e.data as { tagIds?: string[] }).tagIds ?? []).includes(t));
                const sv = (e.data as { sensitiveVerdict?: string }).sensitiveVerdict;
                const sensPasses =
                  !sensFilterActive ||
                  (!!sv && filterSensitiveVerdicts.includes(sv as "critical" | "potential"));
                if (tagFilterActive && sensFilterActive) {
                  if (filterTagSensitiveCombine === "or") {
                    if (!tagPasses && !sensPasses) return false;
                  } else {
                    if (!tagPasses || !sensPasses) return false;
                  }
                } else {
                  if (!tagPasses || !sensPasses) return false;
                }
                if (capturesSearch.trim()) {
                  const q = capturesSearch.trim().toLowerCase();
                  const d = e.data as {
                    ocr?: string;
                    transcription?: string;
                    explanation?: string;
                    filePath?: string;
                    path?: string;
                  };
                  const matchesApp = e.appName.toLowerCase().includes(q);
                  const matchesWindow = e.windowName.toLowerCase().includes(q);
                  const matchesNote = e.kind === "note" ? offSessionNoteBody(e.data).toLowerCase().includes(q) : false;
                  const matchesTags = captureTags.filter((t) => (e.data as { tagIds?: string[] }).tagIds?.includes(t.id)).some((t) => t.name.toLowerCase().includes(q));
                  // Screenshot text: the edited OCR lives in ocrTextByPath, the stored one in `ocr`.
                  const ocrText = e.kind === "image" && d.path ? (ocrTextByPath[d.path] ?? d.ocr ?? "") : "";
                  const matchesOcr = ocrText.toLowerCase().includes(q);
                  const matchesTranscription = (d.transcription ?? "").toLowerCase().includes(q);
                  const matchesExplanation = (d.explanation ?? "").toLowerCase().includes(q);
                  const matchesPath = (d.filePath ?? d.path ?? "").toLowerCase().includes(q);
                  if (
                    !matchesApp &&
                    !matchesWindow &&
                    !matchesNote &&
                    !matchesTags &&
                    !matchesOcr &&
                    !matchesTranscription &&
                    !matchesExplanation &&
                    !matchesPath
                  ) {
                    return false;
                  }
                }
                return true;
              })
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

            if (selectAllPending) {
              setTimeout(() => {
                setSelectedItemIds(new Set(filtered.map((e) => e.selKey)));
                setSelectAllPending(false);
              }, 0);
            }

            // Update search nav counter label
            searchMatchCountRef.current = capturesSearch.trim() ? filtered.length : 0;
            if (capturesSearch.trim()) {
              const total = filtered.length;
              const idx = Math.max(0, Math.min(searchMatchIndex, total - 1));
              setTimeout(() => {
                const el = document.getElementById("captures-search-count-label");
                if (el) el.textContent = total > 0 ? `${idx + 1} / ${total}` : "0";
                const target = document.getElementById(`capture-item-${idx}`);
                target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
              }, 0);
            }

            if (allEntries.length === 0) {
              return <div className="empty-state">No captures yet</div>;
            }

            const searchTerm = capturesSearch.trim() || undefined;
            const renderItem = (entry: CaptureEntry, idx?: number) => {
              const isActiveMatch = searchTerm !== undefined && idx === Math.max(0, Math.min(searchMatchIndex, filtered.length - 1));
              const focusLabel = formatOffSessionContextFocus(entry.data.contextFocus);
              const tags = captureTags.filter((t) => (entry.data as { tagIds?: string[] }).tagIds?.includes(t.id));
              const sv = (entry.data as { sensitiveVerdict?: string }).sensitiveVerdict;
              // Every row says where it stands with the assistant. The status pill
              // counts the same thing, but a count does not answer "is *this* one
              // searchable yet?", which is what someone looking at a capture they
              // just took wants to know — and the honest answer for the first few
              // seconds is "not yet". So the two normal states get a badge too:
              // a quiet "Waiting", and a spinner for the one being worked on.
              // Exactly one index badge per row, and none at all while the capture
              // is still being analyzed — that badge already says it is not ready.
              const idxState = (entry.data as { indexState?: string }).indexState;
              const idxError = (entry.data as { indexError?: string | null }).indexError;
              const isProcessing =
                processingIds.has(entry.selKey) ||
                processingIds.has((entry.data as { id: string }).id);

              // File size badge for media / document captures
              let fileInfoSize: number | undefined;
              if (entry.kind === "video") {
                fileInfoSize = entry.data.fileSize ?? fileSizeByPath[entry.data.path];
              } else if (entry.kind === "image") {
                fileInfoSize = entry.data.fileSize ?? fileSizeByPath[entry.data.path];
              } else if (entry.kind === "note" && entry.data.kind === "document") {
                fileInfoSize = entry.data.fileSize;
              }

              return (
              <div key={entry.selKey} id={idx !== undefined ? `capture-item-${idx}` : undefined}
                className={`off-session-note-entry${isActiveMatch ? " capture-item--search-active" : ""}`}
              >
                <div className="off-session-entry-header">
                  <time className="off-session-note-time" dateTime={entry.createdAt}>
                    {formatSessionDateTime(entry.createdAt)}
                  </time>
                  {fileInfoSize != null && fileInfoSize > 0 && (
                    <>
                      <span className="off-session-header-sep">·</span>
                      <span className="off-session-header-filesize-badge">{fmtBytes(fileInfoSize)}</span>
                    </>
                  )}
                  {focusLabel && (
                    <>
                      <span className="off-session-header-sep">·</span>
                      <span className="off-session-header-focus">{focusLabel}</span>
                    </>
                  )}
                  <span style={{ flex: 1 }} />
                  {(tags.length > 0 || isProcessing || captureTags.length > 0) && (
                    <span className="capture-tags-inline">
                      {tags.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className="capture-tag-badge capture-tag-badge--removable"
                          style={{ "--tag-color": t.color } as CSSProperties}
                          title={`Remove tag "${t.name}"`}
                          onClick={() => {
                            if (entry.kind === "note") {
                              const newTagIds = (entry.data as { tagIds?: string[] }).tagIds?.filter((id) => id !== t.id) ?? [];
                              setOffSessionNotes((prev) => prev.map((n) => n.id === entry.data.id ? { ...n, tagIds: newTagIds } : n));
                              onCaptureTagChange(entry.selKey, newTagIds);
                            } else if (entry.kind === "image") {
                              const newTagIds = (entry.data as { tagIds?: string[] }).tagIds?.filter((id) => id !== t.id) ?? [];
                              setOffSessionImages((prev) => prev.map((i) => i.id === entry.data.id ? { ...i, tagIds: newTagIds } : i));
                              onCaptureTagChange(entry.selKey, newTagIds);
                            } else if (entry.kind === "video") {
                              const newTagIds = (entry.data as { tagIds?: string[] }).tagIds?.filter((id) => id !== t.id) ?? [];
                              setOffSessionVideos((prev) => prev.map((v) => v.id === entry.data.id ? { ...v, tagIds: newTagIds } : v));
                              onCaptureTagChange(entry.selKey, newTagIds);
                            }
                          }}
                        >
                          {t.name}
                        </button>
                      ))}
                      {captureTags.length > 0 && (
                        <button
                          type="button"
                          className="capture-inline-icon-btn"
                          title="Add tags (popover)"
                          aria-label="Add tags"
                          disabled={isProcessing}
                          aria-expanded={quickTagPopover?.selKey === entry.selKey}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isProcessing) return;
                            const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                            setQuickTagPopover((prev) =>
                              prev?.selKey === entry.selKey ? null : { selKey: entry.selKey, rect: r },
                            );
                          }}
                        >
                          +
                        </button>
                      )}
                      {isProcessing && (
                        <span className="capture-processing-badge" title="Analyzing...">
                          <svg className="capture-processing-spinner" width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2.5" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round"/></svg>
                          Analyzing…
                        </span>
                      )}
                    </span>
                  )}
                  {idxState === "failed" ? (
                    <button
                      type="button"
                      className="capture-index-badge capture-index-badge--failed"
                      title={idxError ? `Indexing failed: ${idxError}` : "Indexing failed."}
                      style={{ fontSize: 10, color: "#dc2626", background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}
                      onClick={() => void runIndexAction("reindex", [(entry.data as { id: string }).id])}
                    >
                      ⚠ Not indexed
                    </button>
                  ) : idxState === "excluded" ? (
                    <button
                      type="button"
                      className="capture-index-badge capture-index-badge--excluded"
                      title="Not used by the assistant. Click to index it again."
                      style={{ fontSize: 10, opacity: 0.55, background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}
                      onClick={() => void runIndexAction("reindex", [(entry.data as { id: string }).id])}
                    >
                      Hidden from assistant
                    </button>
                  ) : isProcessing ? null : idxState === "indexing" ? (
                    <span
                      className="capture-processing-badge capture-index-badge capture-index-badge--indexing"
                      title="Being added to the assistant right now."
                    >
                      <svg className="capture-processing-spinner" width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2.5" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round"/></svg>
                      Indexing…
                    </span>
                  ) : idxState === "pending" ? (
                    <span
                      className="capture-index-badge capture-index-badge--waiting"
                      title="Not indexed yet. The assistant will be able to find this capture once it is."
                    >
                      Waiting
                    </span>
                  ) : null}
                  {sv && sv !== "clean" ? (
                    <button
                      type="button"
                      className={`sensitive-verdict-badge sensitive-verdict-badge--${sv} sensitive-verdict-badge--clickable`}
                      title="Click to mark as scanned (no warning)"
                      onClick={() => {
                        if (entry.kind === "note") {
                          setOffSessionNotes((prev) => prev.map((n) => n.id === entry.data.id ? { ...n, sensitiveVerdict: "clean" } : n));
                          onSensitiveStateChange(entry.selKey, "clean");
                        } else if (entry.kind === "image") {
                          setOffSessionImages((prev) => prev.map((i) => i.id === entry.data.id ? { ...i, sensitiveVerdict: "clean" } : i));
                          onSensitiveStateChange(entry.selKey, "clean");
                        } else if (entry.kind === "video") {
                          setOffSessionVideos((prev) => prev.map((v) => v.id === entry.data.id ? { ...v, sensitiveVerdict: "clean" } : v));
                          onSensitiveStateChange(entry.selKey, "clean");
                        }
                      }}
                    >
                      {sv === "critical" ? "⚠ Critical" : "● At risk"}
                    </button>
                  ) : sv === "clean" ? (
                    <span className="sensitive-scanned-icon" title="Scanned - no sensitive data detected">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 2L3 5v4c0 3 2.5 5 5 5s5-2 5-5V5L8 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M5.5 8l1.8 1.8L10.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </span>
                  ) : null}
                </div>
                {entry.kind === "image" && (
                  <ContextImageThumbs
                    paths={[entry.data.path]}
                    reverseOrder={false}
                    ocrTexts={ocrTextByPath}
                    explanationByPath={entry.data.explanation ? { [entry.data.path]: entry.data.explanation } : undefined}
                    highlightTerm={searchTerm}
                    onOpenViewer={openMediaViewer}
                    onSave={(path, text, exp) => {
                      updateOcrText(path, text);
                      setOffSessionImages((prev) =>
                        prev.map((img) => img.id === entry.data.id ? { ...img, explanation: exp || undefined, sensitiveVerdict: undefined } : img)
                      );
                      onCaptureDataSave(entry.selKey, { text: text || null, explanation: exp || null });
                    }}
                    onRequestDelete={() => setConfirmKind({ type: "deleteOffImage", id: entry.data.id, path: entry.data.path })}
                    itemKey={entry.selKey}
                    selectedIds={selectedItemIds}
                    onToggleSelect={toggleItemSelected}
                  />
                )}
                {entry.kind === "video" && (
                  <ContextVideoThumbs
                    videos={[entry.data]}
                    highlightTerm={searchTerm}
                    onOpenViewer={openMediaViewer}
                    onSave={(videoId, transcription, exp) => {
                      setOffSessionVideos((prev) =>
                        prev.map((v) => v.id === videoId ? { ...v, transcription, explanation: exp || undefined, sensitiveVerdict: undefined } : v)
                      );
                      onCaptureDataSave(entry.selKey, { transcription: transcription || null, explanation: exp || null });
                    }}
                    onRequestDelete={(vid) => setConfirmKind({ type: "deleteOffVideo", id: vid.id, path: vid.path })}
                    itemKey={entry.selKey}
                    selectedIds={selectedItemIds}
                    onToggleSelect={toggleItemSelected}
                  />
                )}
                {entry.kind === "note" && (
                  <ContextNoteChipRow
                    note={{
                      text: offSessionNoteBody(entry.data),
                      explanation: entry.data.explanation,
                      source: entry.data.source ?? "manual",
                      filePath: entry.data.filePath,
                    }}
                    useDocumentIcon={entry.data.kind === "document"}
                    highlightTerm={searchTerm}
                    onSave={(t, exp) => {
                      setOffSessionNotes((prev) =>
                        prev.map((x) => {
                          if (x.id !== entry.data.id) return x;
                          const nextExp = exp || undefined;
                          if (x.kind === "document") return { ...x, summary: t, explanation: nextExp, sensitiveVerdict: undefined };
                          return { ...x, text: t, explanation: nextExp, sensitiveVerdict: undefined };
                        })
                      );
                      onCaptureDataSave(entry.selKey, { text: t || null, explanation: exp || null });
                    }}
                    onDelete={() => setConfirmKind({ type: "deleteOffNote", id: entry.data.id })}
                    onOpenFile={entry.data.filePath?.trim() ? () => void openPath(entry.data.filePath!).catch(console.error) : undefined}
                    downloadPath={
                      entry.data.filePath?.trim() && !/^https?:\/\//i.test(entry.data.filePath.trim())
                        ? entry.data.filePath.trim()
                        : undefined
                    }
                    processEnabled={entry.data.kind === "document" ? entry.data.process_doc_index_doc !== false : undefined}
                    onToggleProcess={entry.data.kind === "document" ? () => {
                      const newVal = entry.data.process_doc_index_doc !== false ? false : true;
                      onCaptureDataSave(entry.selKey, { processDocIndexDoc: newVal });
                    } : undefined}
                    meetRawIndexEnabled={
                      entry.data.source === "googleMeet" && entry.data.kind !== "document"
                        ? entry.data.indexMeetRawTranscript === true
                        : undefined
                    }
                    onToggleMeetRawIndex={
                      entry.data.source === "googleMeet" && entry.data.kind !== "document"
                        ? () =>
                            setOffSessionNotes((prev) =>
                              prev.map((x) => {
                                if (x.id !== entry.data.id) return x;
                                const on = x.indexMeetRawTranscript === true;
                                return { ...x, indexMeetRawTranscript: on ? undefined : true };
                              })
                            )
                        : undefined
                    }
                    itemKey={entry.selKey}
                    selectedIds={selectedItemIds}
                    onToggleSelect={toggleItemSelected}
                  />
                )}
                {/* segment rendering removed - session recording feature deleted */}
              </div>
              );
            };

            const TEXT_SUBTYPE_ICONS: Record<TextSubKey, React.ReactElement> = {
              "link":      <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><path d="M6.5 9.5a4 4 0 0 0 5.657 0l1.414-1.414a4 4 0 0 0-5.657-5.657L7.5 3.843" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><path d="M9.5 6.5a4 4 0 0 0-5.657 0L2.43 7.914a4 4 0 0 0 5.657 5.657l.414-.414" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
              "highlight": <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="14" width="14" height="6" rx="2"/><path d="M8 14V8a4 4 0 0 1 8 0v6"/></svg>,
              "dictation": <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><rect x="5" y="1" width="6" height="9" rx="3" stroke="currentColor" strokeWidth="1.5"/><path d="M2 8a6 6 0 0 0 12 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><line x1="8" y1="14" x2="8" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
              "clipboard": <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><rect x="3" y="3" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><path d="M6 3V2a2 2 0 0 1 4 0v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
              "manual":    <svg width={12} height={12} viewBox="0 0 16 16" fill="none"><path d="M3 13L11 5l2 2-8 8H3v-2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M10 4l2-2 2 2-2 2-2-2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>,
              "googleMeet": <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4" width="9" height="8" rx="1.5"/><circle cx="7" cy="8" r="1.6"/><path d="M11.5 7.5 14 6v4l-2.5-1.5V7.5z"/></svg>,
            };

            const renderGroupCard = (
              groupKey: string,
              label: string,
              sublabel: string,
              items: CaptureEntry[],
              flatIndexStart: number,
              sortWindowsAlphabetically: boolean = false
            ) => {
              const searchActive = capturesSearch.trim() !== "" && capturesSearch !== searchTermAtCollapse;
              const expanded = searchActive ? true : (expandedAppGroups[groupKey] ?? false);
              const isTextGroup = groupKey === "text";

              const byWindow = new Map<string, CaptureEntry[]>();
              for (const item of items) {
                const win = item.windowName || "-";
                if (!byWindow.has(win)) byWindow.set(win, []);
                byWindow.get(win)!.push(item);
              }
              let sortedWindows = [...byWindow.entries()].sort((a, b) =>
                sortWindowsAlphabetically
                  ? a[0].localeCompare(b[0], undefined, { sensitivity: "base" })
                  : new Date(b[1][0].createdAt).getTime() - new Date(a[1][0].createdAt).getTime()
              );

              // Filter sub-groups for the text card based on active text sub-type chips
              if (isTextGroup && filterTextSubTypes.length > 0) {
                const activeLabels = filterTextSubTypes.map((k) => TEXT_SUB_LABELS[k as TextSubKey]);
                sortedWindows = sortedWindows.filter(([winName]) => activeLabels.includes(winName));
              }

              const visibleCount = sortedWindows.reduce((s, [, v]) => s + v.length, 0);
              const visibleKeys = sortedWindows.flatMap(([, its]) => its.map((e) => e.selKey));
              const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selectedItemIds.has(k));
              const someSelected = !allSelected && visibleKeys.some((k) => selectedItemIds.has(k));

              const groupMediaBytes = items.reduce((sum, e) => {
                if (e.kind === "video") return sum + (e.data.fileSize ?? fileSizeByPath[e.data.path] ?? 0);
                if (e.kind === "image") return sum + (e.data.fileSize ?? fileSizeByPath[e.data.path] ?? 0);
                if (e.kind === "note" && e.data.kind === "document") return sum + (e.data.fileSize ?? 0);
                return sum;
              }, 0);

              return (
                <div
                  key={groupKey}
                  className={`glass-card captures-app-group-card${groupKey === "google-meet" ? " captures-app-group-card--meet" : ""}`}
                >
                  <div className="captures-app-group-header-row">
                    <button
                      type="button"
                      className="captures-app-group-header"
                      onClick={() => setExpandedAppGroups((p) => ({ ...p, [groupKey]: !expanded }))}
                    >
                      <svg
                        className={`captures-app-chevron${expanded ? " open" : ""}`}
                        width={12} height={12} viewBox="0 0 12 12" fill="none"
                      >
                        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span className="captures-app-name">{label}</span>
                      {sublabel && <span className="captures-app-sublabel">{sublabel}</span>}
                    </button>
                    {isTextGroup && (
                      <span className="captures-text-subtype-chips">
                        {(["link", "highlight", "dictation", "clipboard", "manual"] as TextSubKey[]).map((sub) => {
                          const active = filterTextSubTypes.includes(sub);
                          return (
                            <button
                              key={sub}
                              type="button"
                              className={`captures-text-subtype-chip${active ? " active" : ""}`}
                              title={TEXT_SUB_LABELS[sub]}
                              onClick={() => setFilterTextSubTypes((p) => p.includes(sub) ? p.filter((x) => x !== sub) : [...p, sub])}
                            >
                              {TEXT_SUBTYPE_ICONS[sub]}
                            </button>
                          );
                        })}
                      </span>
                    )}
                    <span className="captures-app-count">
                      {visibleCount} capture{visibleCount !== 1 ? "s" : ""}
                      {groupMediaBytes > 0 && <span className="captures-app-count-size">{fmtBytes(groupMediaBytes)}</span>}
                    </span>
                    <button
                      type="button"
                      className={`captures-group-select-btn${allSelected ? " all" : someSelected ? " some" : ""}`}
                      title={allSelected ? "Deselect all in group" : someSelected ? "Deselect all in group" : "Select all in group"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedItemIds((prev) => {
                          const next = new Set(prev);
                          if (allSelected || someSelected) {
                            visibleKeys.forEach((k) => next.delete(k));
                          } else {
                            visibleKeys.forEach((k) => next.add(k));
                          }
                          return next;
                        });
                      }}
                    >
                      {allSelected ? (
                        <svg width={15} height={15} viewBox="0 0 15 15" fill="none" aria-hidden>
                          <rect x={1} y={1} width={13} height={13} rx={3} stroke="currentColor" strokeWidth={1.5} fill="var(--accent-bg)"/>
                          <path d="M4 7.5L6.5 10L11 5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      ) : someSelected ? (
                        <svg width={15} height={15} viewBox="0 0 15 15" fill="none" aria-hidden>
                          <rect x={1} y={1} width={13} height={13} rx={3} stroke="currentColor" strokeWidth={1.5} fill="var(--accent-bg)"/>
                          <path d="M4.5 7.5H10.5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"/>
                        </svg>
                      ) : (
                        <svg width={15} height={15} viewBox="0 0 15 15" fill="none" aria-hidden>
                          <rect x={1} y={1} width={13} height={13} rx={3} stroke="currentColor" strokeWidth={1.5}/>
                        </svg>
                      )}
                    </button>
                  </div>
                  {expanded && (
                    <div className="captures-app-group-body">
                      {sortedWindows.map(([winName, winItems], wi) => {
                        const showDivider = (capturesSort === "app" || capturesSort === "type") && sortedWindows.length > 1;
                        let localFlatIdx = flatIndexStart;
                        for (let i = 0; i < wi; i++) localFlatIdx += sortedWindows[i][1].length;
                        return (
                          <div key={winName}>
                            {showDivider && (
                              <div className="captures-window-divider">
                                <span className="captures-window-divider-name">{winName}</span>
                                <span className="captures-window-divider-count">{winItems.length}</span>
                              </div>
                            )}
                            <div className="off-session-notes-list">
                              {winItems.map((e, i) => renderItem(e, localFlatIdx + i))}
                            </div>
                          </div>
                        );
                      })}
                      {sortedWindows.length === 0 && (
                        <p className="captures-empty-filtered" style={{ padding: "16px 18px" }}>No captures match the selected types.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            };

            if (capturesSort === "date") {
              return (
                <div className="glass-card captures-flat-card">
                  <div className="off-session-notes-list">
                    {filtered.length === 0
                      ? <p className="captures-empty-filtered">No captures match the current filters.</p>
                      : filtered.map((e, i) => renderItem(e, i))
                    }
                  </div>
                </div>
              );
            }

            if (capturesSort === "app") {
              const byApp = new Map<string, CaptureEntry[]>();
              for (const entry of filtered) {
                const app = entry.appName || "Unknown";
                if (!byApp.has(app)) byApp.set(app, []);
                byApp.get(app)!.push(entry);
              }
              const sortedApps = [...byApp.entries()].sort((a, b) =>
                a[0].localeCompare(b[0], undefined, { sensitivity: "base" })
              );
              currentGroupNamesRef.current = sortedApps.map(([k]) => k);
              if (sortedApps.length === 0) {
                return <p className="captures-empty-filtered">No captures match the current filters.</p>;
              }
              let flatIdx = 0;
              return (
                <>
                  {sortedApps.map(([appName, items]) => {
                    const card = renderGroupCard(appName, appName, "", items, flatIdx, true);
                    flatIdx += items.length;
                    return card;
                  })}
                </>
              );
            }

            // By type (source type)
            type SourceTypeKey = "file" | "screenshot" | "screen-recording" | "text" | "google-meet";
            const TYPE_ORDER: SourceTypeKey[] = [
              "file",
              "screenshot",
              "screen-recording",
              "text",
              "google-meet",
            ];
            const TYPE_LABELS: Record<SourceTypeKey, string> = {
              "file": "File",
              "screenshot": "Screenshot",
              "screen-recording": "Screen Recording",
              "text": "Text",
              "google-meet": "Google Meet",
            };
            const TEXT_SUB_LABELS: Record<TextSubKey, string> = {
              "link": "Link",
              "highlight": "Highlight",
              "dictation": "Dictation",
              "clipboard": "Clipboard",
              "manual": "Manual",
              "googleMeet": "Google Meet",
            };

            const getTypeKey = (entry: CaptureEntry): SourceTypeKey => {
              if (entry.kind === "image") return "screenshot";
              if (entry.kind === "video") return "screen-recording";
              // note
              if (entry.data.kind === "document") return "file";
              if (entry.data.source === "screenRecording") return "screen-recording";
              if (entry.data.source === "googleMeet") return "google-meet";
              return "text";
            };

            const getTextSubKey = (entry: CaptureEntry): TextSubKey => {
              if (entry.kind !== "note") return "manual";
              const src = entry.data.source;
              if (src === "link" || isLinkNote(entry.data.text)) return "link";
              if (src === "highlight") return "highlight";
              if (src === "dictation") return "dictation";
              if (src === "googleMeet") return "googleMeet";
              if (src === "clipboard") return "clipboard";
              return "manual";
            };

            const byType = new Map<SourceTypeKey, CaptureEntry[]>();
            for (const entry of filtered) {
              const k = getTypeKey(entry);
              if (!byType.has(k)) byType.set(k, []);
              byType.get(k)!.push(entry);
            }
            const presentTypes = TYPE_ORDER.filter((k) => byType.has(k));
            currentGroupNamesRef.current = presentTypes;

            if (presentTypes.length === 0) {
              return <p className="captures-empty-filtered">No captures match the current filters.</p>;
            }

            // For "text" group we inject TextSubKey as the windowName so renderGroupCard
            // shows sub-dividers naturally via its byWindow grouping logic.
            const buildTypeItems = (typeKey: SourceTypeKey): CaptureEntry[] => {
              const items = byType.get(typeKey) ?? [];
              if (typeKey !== "text") return items;
              // Override windowName with sub-type label for dividers
              return items.map((e) => ({ ...e, windowName: TEXT_SUB_LABELS[getTextSubKey(e)] }));
            };

            let flatIdxType = 0;
            return (
              <>
                {presentTypes.map((typeKey) => {
                  const rawItems = byType.get(typeKey)!;
                  const displayItems = buildTypeItems(typeKey);
                  const card = renderGroupCard(typeKey, TYPE_LABELS[typeKey], "", displayItems, flatIdxType);
                  flatIdxType += rawItems.length;
                  return card;
                })}
              </>
            );
          })()}
          </div>{/* end captures-scroll-area */}
        </>
      ) : (
        <AuthRequiredGate message="Sign in to record sessions and capture context. Saved data is stored only for your account." />
      )}
      {quickTagPopover !== null &&
        captureTags.length > 0 &&
        createPortal(
          <div
            ref={quickTagPopoverRef}
            className="capture-quick-tag-popover glass-card"
            role="region"
            aria-label="Tags to add"
            style={(() => {
              const vw = typeof window !== "undefined" ? window.innerWidth : 800;
              const margin = 8;
              const maxPopover = 280;
              const maxW = Math.min(
                maxPopover,
                Math.max(0, quickTagPopover.rect.right - margin),
                vw - 2 * margin,
              );
              return {
                position: "fixed" as const,
                top: quickTagPopover.rect.bottom + 6,
                right: vw - quickTagPopover.rect.right,
                width: "max-content" as const,
                maxWidth: maxW > 0 ? maxW : maxPopover,
                zIndex: 10000,
              };
            })()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(() => {
              const assignedIds = new Set(getTagIdsForSelKey(quickTagPopover.selKey));
              const unassigned = captureTags.filter((t) => !assignedIds.has(t.id));
              if (unassigned.length === 0) {
                return (
                  <p className="settings-hint capture-quick-tag-popover--empty" style={{ margin: 0 }}>
                    All tags are already assigned to this capture.
                  </p>
                );
              }
              return (
                <>
                  {unassigned.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      className="captures-tag-chip"
                      style={{ "--tag-color": tag.color } as CSSProperties}
                      onClick={() => addTagOnSelKey(quickTagPopover.selKey, tag.id)}
                    >
                      {tag.name}
                    </button>
                  ))}
                </>
              );
            })()}
          </div>,
          document.body,
        )}
      {viewerState && (
        <MediaViewerModal
          open
          kind={viewerState.kind}
          path={viewerState.path}
          caption={
            viewerState.kind === "image"
              ? ocrTextByPath[viewerState.path]
              : offSessionVideos
                  .find((v) => v.path === viewerState.path)
                  ?.transcription?.replace(/^\[Screen recording - \d+:\d{2}\]\s*/, "")
          }
          onClose={() => setViewerState(null)}
        />
      )}
      <HistoryShareLinksModal
        open={shareLinkHistoryOpen}
        onClose={() => setShareLinkHistoryOpen(false)}
        profileId={storeUserId}
      />
      <ShareAsAssistantModal
        open={shareAssistantOpen}
        onClose={() => setShareAssistantOpen(false)}
        userId={storeUserId}
        selectedCaptures={selectedCapturesForShare}
        captureTags={captureTags}
        onArchiveStaged={(zipPath) => {
          // Taken over the moment the archive exists, not when it is sent: the modal
          // may sit on a notice screen for a while, and this tab unmounting during it
          // would otherwise strand a (possibly multi-GB) file nothing else deletes.
          cleanupPendingZipTempFile();
          pendingZipTempPathRef.current = zipPath;
        }}
        onDiscardStagedArchive={cleanupPendingZipTempFile}
        onBuilt={(zipPath, suggestedStem) => {
          // Already staged above, in the same build; re-registering is only a guard
          // for a path arriving here without having gone through onArchiveStaged.
          if (pendingZipTempPathRef.current !== zipPath) {
            cleanupPendingZipTempFile();
            pendingZipTempPathRef.current = zipPath;
          }
          setShareAssistantOpen(false);
          setShareModalState({
            sourcePath: zipPath,
            defaultStem: suggestedStem,
            extensionWithDot: ".zip",
          });
        }}
      />
      <KnowledgeShareModal
        open={shareModalState != null}
        onClose={() => {
          setShareModalState(null);
          cleanupPendingZipTempFile();
        }}
        sourcePath={shareModalState?.sourcePath ?? ""}
        profileId={storeUserId}
        defaultStem={shareModalState?.defaultStem ?? ""}
        extensionWithDot={shareModalState?.extensionWithDot ?? ""}
        sharingConfigured={sharingConfigured}
        onCopied={(message) => {
          showShareToast(message);
          cleanupPendingZipTempFile();
        }}
        onOpenShareLinkHistory={() => setShareLinkHistoryOpen(true)}
      />
      {shareToast ? (
        <div className="history-toast" role="status" aria-live="polite">
          {shareToast}
        </div>
      ) : null}
    </>
  );
}
