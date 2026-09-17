/**
 * Prepare-upload: focus analysis, segment/session filtering, app/window exclusions.
 */

import type {
  FocusSegment,
  OffSessionContextFocus,
  OffSessionImage,
  OffSessionNote,
  OffSessionVideo,
  Session,
} from "./App";
import type { ContextTimelineItem } from "./contextTimeline";
import { collectMediaPathsFromSegment, getSegmentTimeline } from "./contextTimeline";

/** Strip the `[Screen recording - M:SS]` duration prefix from a transcription string. */
export function stripTranscriptionPrefix(t: string): string {
  return t.replace(/^\[Screen recording - \d+:\d{2}\]\s*/, "");
}

// ── Keys (stable for Set / UI state) ─────────────────────────────────────────

export type FocusLike = Pick<
  FocusSegment,
  "bundleId" | "appName" | "processId" | "windowName"
>;

export function focusAppKey(f: FocusLike): string {
  // Key by app name first so that entries with a bundle ID and entries with only
  // an app name (e.g. off-session recording fallback) collapse into the same row.
  const a = f.appName?.trim();
  if (a) return `app:${a}`;
  const b = f.bundleId?.trim();
  if (b) return `bundle:${b}`;
  return `pid:${f.processId}`;
}

/** Per-window row id (unique avec le titre de fenêtre). */
export function focusWindowKey(f: FocusLike): string {
  const ak = focusAppKey(f);
  const w = f.windowName?.trim() ?? "";
  return `${ak}\n${w}`;
}

export function displayAppName(f: FocusLike): string {
  return f.appName?.trim() || f.bundleId?.trim() || `pid ${f.processId}`;
}

export function segmentDurationMs(seg: Pick<FocusSegment, "startedAt" | "endedAt">): number {
  const a = Date.parse(seg.startedAt);
  const b = Date.parse(seg.endedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return b - a;
}

// ── Filter options (Prepare Upload UI) ───────────────────────────────────────

export type PrepareUploadFilterOptions = {
  discardShortEmptySegments: boolean;
  /** Secondes : segments in-session plus courts que ce seuil sont exclus si discard activé (durée segment). */
  minEmptySegmentSec: number;
  excludedAppKeys: ReadonlySet<string>;
  excludedWindowKeys: ReadonlySet<string>;
  /** Exclusions par élément de timeline / note / image / vidéo (Prepare upload). */
  excludedContentIds?: ReadonlySet<string>;
  /** Texte ou transcription édité(s) avant upload, clé = id stable (voir helpers ci-dessous). */
  editedTextByContentId?: ReadonlyMap<string, string>;
  /**
   * Exclure le binaire document du ZIP : id de note hors session, ou `sessionTimelineItemId`
   * pour une entrée pdfSummary dans la timeline d’un segment.
   */
  excludedDocNoteIds?: ReadonlySet<string>;
  /**
   * `pdfSummary` row ids (off-session note id or `sessionTimelineItemId`) for which the export JSON
   * sets `process_doc_index_doc: false`: file may still upload, server skips full-document indexing.
   */
  docProcessIndexFalseIds?: ReadonlySet<string>;
};

/** Id stable pour un item de timeline en session (index = position dans getSegmentTimeline). */
export function sessionTimelineItemId(
  sessionId: string,
  segStartedAt: string,
  timelineIndex: number
): string {
  return `st|${sessionId}|${segStartedAt}|${timelineIndex}`;
}

export function offNoteContentId(noteId: string): string {
  return `on|${noteId}`;
}

export function offImageContentId(imageId: string): string {
  return `oi|${imageId}`;
}

export function offVideoContentId(videoId: string): string {
  return `ov|${videoId}`;
}

/** Lignes document (pdfSummary) avec binaire local - même case à cocher Prepare que les notes hors session. */
export type PendingDocPrepareRow = {
  /** Clé dans `excludedDocNoteIds` : id note hors session ou `sessionTimelineItemId` in-session. */
  excludeToggleId: string;
  filePath: string;
  fileSize?: number;
  text: string;
  explanation?: string;
  /** Libellé court dans la liste Prepare. */
  label: string;
};

export function listPendingDocAttachmentsForPrepare(
  pendingSessions: Session[],
  pendingNotes: OffSessionNote[]
): PendingDocPrepareRow[] {
  const rows: PendingDocPrepareRow[] = [];
  for (const n of pendingNotes) {
    if (n.kind !== "document" || !n.filePath?.trim()) continue;
    const nfp = n.filePath.trim();
    if (/^https?:\/\//i.test(nfp)) continue;
    const body = n.summary ?? "";
    rows.push({
      excludeToggleId: n.id,
      filePath: nfp,
      fileSize: n.fileSize,
      text: body,
      explanation: n.explanation,
      label: `Off-session · ${fileBasename(n.filePath)}`,
    });
  }
  for (const s of pendingSessions) {
    const title = (s.name?.trim() || s.startedAt).slice(0, 48);
    for (const seg of s.segments) {
      const tl = getSegmentTimeline(seg);
      tl.forEach((it, idx) => {
        if (it.kind !== "document" || !it.filePath?.trim()) return;
        const pfp = it.filePath.trim();
        if (/^https?:\/\//i.test(pfp)) return;
        rows.push({
          excludeToggleId: sessionTimelineItemId(s.id, seg.startedAt, idx),
          filePath: pfp,
          fileSize: it.fileSize,
          text: it.summary,
          explanation: it.explanation,
          label: `Session · ${title} · ${fileBasename(it.filePath)}`,
        });
      });
    }
  }
  return rows;
}

function segmentExcludedByFocus(seg: FocusLike, opts: PrepareUploadFilterOptions): boolean {
  const ak = focusAppKey(seg);
  if (opts.excludedAppKeys.has(ak)) return true;
  if (opts.excludedWindowKeys.has(focusWindowKey(seg))) return true;
  return false;
}

function offFocusLike(cf: OffSessionContextFocus | undefined): FocusLike | null {
  if (!cf) return null;
  return {
    bundleId: cf.bundleId,
    appName: cf.appName,
    processId: cf.processId,
    windowName: cf.windowName,
  };
}

function offItemExcluded(
  cf: OffSessionContextFocus | undefined,
  opts: PrepareUploadFilterOptions
): boolean {
  const fl = offFocusLike(cf);
  if (!fl) return false;
  return segmentExcludedByFocus(fl, opts);
}

/**
 * In-session segment strictly shorter than `minEmptySegmentSec` (when discard is on) → excluded from
 * upload and from Apps & windows counts. Uses wall-clock segment duration only (`startedAt` → `endedAt`).
 */
function segmentDroppedAsShorterThanThreshold(
  seg: FocusSegment,
  opts: PrepareUploadFilterOptions
): boolean {
  if (!opts.discardShortEmptySegments) return false;
  const minMs = Math.max(0, opts.minEmptySegmentSec) * 1000;
  if (minMs <= 0) return false;
  return segmentDurationMs(seg) < minMs;
}

export function segmentIncludedForUpload(seg: FocusSegment, opts: PrepareUploadFilterOptions): boolean {
  if (segmentExcludedByFocus(seg, opts)) return false;
  if (segmentDroppedAsShorterThanThreshold(seg, opts)) return false;
  return true;
}

export function offNoteIncludedForUpload(n: OffSessionNote, opts: PrepareUploadFilterOptions): boolean {
  return !offItemExcluded(n.contextFocus, opts);
}

export function offImageIncludedForUpload(i: OffSessionImage, opts: PrepareUploadFilterOptions): boolean {
  return !offItemExcluded(i.contextFocus, opts);
}

export function offVideoIncludedForUpload(v: OffSessionVideo, opts: PrepareUploadFilterOptions): boolean {
  return !offItemExcluded(v.contextFocus, opts);
}

// ── Analysis (segments en session filtrés comme le payload ; exclusions app/fenêtre séparées) ─

export type UploadFocusWindowRow = {
  windowKey: string;
  appKey: string;
  displayApp: string;
  windowTitle: string;
  /** Segments de focus (in session) rattachés à cette app / fenêtre. */
  sessionSegmentCount: number;
  /** Éléments dans les timelines des segments (session). */
  sessionText: number;
  sessionScreenshot: number;
  sessionScreenRecording: number;
  /** Temps in-session uniquement (ms) ; 0 si seulement hors-session. */
  sessionDurationMs: number;
  /** Hors session : notes texte / captures / enregistrements. */
  offText: number;
  offScreenshot: number;
  offScreenRecording: number;
  /** Pour tri : segments session + items hors session. */
  citationCount: number;
};

export type UploadFocusAppGroup = {
  appKey: string;
  displayApp: string;
  sessionSegmentCount: number;
  sessionText: number;
  sessionScreenshot: number;
  sessionScreenRecording: number;
  sessionDurationMs: number;
  offText: number;
  offScreenshot: number;
  offScreenRecording: number;
  citationCount: number;
  windows: UploadFocusWindowRow[];
};

const UNKNOWN_APP_KEY = "__nofocus__";

/** Même règle « segment plus court que X s » que le payload, sans exclusions app/fenêtre (pour l’analyse UI). */
function segmentOptsShortOnly(
  discardShortEmptySegments: boolean,
  minEmptySegmentSec: number
): PrepareUploadFilterOptions {
  return {
    discardShortEmptySegments,
    minEmptySegmentSec,
    excludedAppKeys: new Set(),
    excludedWindowKeys: new Set(),
  };
}

function countTimelineKinds(seg: FocusSegment): {
  text: number;
  screenshot: number;
  screenRecording: number;
} {
  let text = 0;
  let screenshot = 0;
  let screenRecording = 0;
  for (const it of getSegmentTimeline(seg)) {
    if (it.kind === "text" || it.kind === "document") text++;
    else if (it.kind === "screenshot") screenshot++;
    else if (it.kind === "screenRecording") screenRecording++;
  }
  return { text, screenshot, screenRecording };
}

type AggWindow = {
  windowTitle: string;
  citationCount: number;
  sessionSegmentCount: number;
  sessionDurationMs: number;
  sessionText: number;
  sessionScreenshot: number;
  sessionScreenRecording: number;
  offText: number;
  offScreenshot: number;
  offScreenRecording: number;
};

type AggApp = {
  displayApp: string;
  citationCount: number;
  sessionSegmentCount: number;
  sessionDurationMs: number;
  sessionText: number;
  sessionScreenshot: number;
  sessionScreenRecording: number;
  offText: number;
  offScreenshot: number;
  offScreenRecording: number;
  windows: Map<string, AggWindow>;
};

/**
 * Stats sur le lot pending : apps → fenêtres, comptages et durées segment.
 * `segmentFilter` aligne les segments **en session** sur la règle « plus court que X s » (comme l’upload).
 * Les éléments hors session ne sont pas concernés par cette durée.
 */
export function computeUploadFocusAnalysis(
  pendingSessions: Session[],
  pendingNotes: OffSessionNote[],
  pendingImages: OffSessionImage[],
  pendingVideos: OffSessionVideo[],
  segmentFilter: { discardShortEmptySegments: boolean; minEmptySegmentSec: number }
): UploadFocusAppGroup[] {
  const segOpts = segmentOptsShortOnly(
    segmentFilter.discardShortEmptySegments,
    segmentFilter.minEmptySegmentSec
  );
  const byApp = new Map<string, AggApp>();

  function bumpApp(ak: string, displayApp: string): AggApp {
    let g = byApp.get(ak);
    if (!g) {
      g = {
        displayApp,
        citationCount: 0,
        sessionSegmentCount: 0,
        sessionDurationMs: 0,
        sessionText: 0,
        sessionScreenshot: 0,
        sessionScreenRecording: 0,
        offText: 0,
        offScreenshot: 0,
        offScreenRecording: 0,
        windows: new Map(),
      };
      byApp.set(ak, g);
    }
    return g;
  }

  function bumpWindow(g: AggApp, wk: string, windowTitle: string): AggWindow {
    let w = g.windows.get(wk);
    if (!w) {
      w = {
        windowTitle,
        citationCount: 0,
        sessionSegmentCount: 0,
        sessionDurationMs: 0,
        sessionText: 0,
        sessionScreenshot: 0,
        sessionScreenRecording: 0,
        offText: 0,
        offScreenshot: 0,
        offScreenRecording: 0,
      };
      g.windows.set(wk, w);
    }
    return w;
  }

  for (const session of pendingSessions) {
    for (const seg of session.segments) {
      if (!segmentIncludedForUpload(seg, segOpts)) continue;
      const ak = focusAppKey(seg);
      const display = displayAppName(seg);
      const g = bumpApp(ak, display);
      const dur = segmentDurationMs(seg);
      const tc = countTimelineKinds(seg);
      g.citationCount += 1;
      g.sessionSegmentCount += 1;
      g.sessionDurationMs += dur;
      g.sessionText += tc.text;
      g.sessionScreenshot += tc.screenshot;
      g.sessionScreenRecording += tc.screenRecording;
      const wk = focusWindowKey(seg);
      const wt = seg.windowName?.trim() || "No window title";
      const wr = bumpWindow(g, wk, wt);
      wr.citationCount += 1;
      wr.sessionSegmentCount += 1;
      wr.sessionDurationMs += dur;
      wr.sessionText += tc.text;
      wr.sessionScreenshot += tc.screenshot;
      wr.sessionScreenRecording += tc.screenRecording;
    }
  }

  function bumpOffNote(cf: OffSessionContextFocus | undefined) {
    const fl = offFocusLike(cf);
    const ak = fl ? focusAppKey(fl) : UNKNOWN_APP_KEY;
    const display = fl ? displayAppName(fl) : "No focus captured";
    const g = bumpApp(ak, display);
    g.citationCount += 1;
    g.offText += 1;
    if (fl) {
      const wk = focusWindowKey(fl);
      const wt = fl.windowName?.trim() || "No window title";
      const wr = bumpWindow(g, wk, wt);
      wr.citationCount += 1;
      wr.offText += 1;
    } else {
      const ufk = `${UNKNOWN_APP_KEY}\n`;
      const wr = bumpWindow(g, ufk, "-");
      wr.citationCount += 1;
      wr.offText += 1;
    }
  }

  function bumpOffImage(cf: OffSessionContextFocus | undefined) {
    const fl = offFocusLike(cf);
    const ak = fl ? focusAppKey(fl) : UNKNOWN_APP_KEY;
    const display = fl ? displayAppName(fl) : "No focus captured";
    const g = bumpApp(ak, display);
    g.citationCount += 1;
    g.offScreenshot += 1;
    if (fl) {
      const wk = focusWindowKey(fl);
      const wt = fl.windowName?.trim() || "No window title";
      const wr = bumpWindow(g, wk, wt);
      wr.citationCount += 1;
      wr.offScreenshot += 1;
    } else {
      const ufk = `${UNKNOWN_APP_KEY}\n`;
      const wr = bumpWindow(g, ufk, "-");
      wr.citationCount += 1;
      wr.offScreenshot += 1;
    }
  }

  function bumpOffVideo(cf: OffSessionContextFocus | undefined) {
    const fl = offFocusLike(cf);
    const ak = fl ? focusAppKey(fl) : UNKNOWN_APP_KEY;
    const display = fl ? displayAppName(fl) : "No focus captured";
    const g = bumpApp(ak, display);
    g.citationCount += 1;
    g.offScreenRecording += 1;
    if (fl) {
      const wk = focusWindowKey(fl);
      const wt = fl.windowName?.trim() || "No window title";
      const wr = bumpWindow(g, wk, wt);
      wr.citationCount += 1;
      wr.offScreenRecording += 1;
    } else {
      const ufk = `${UNKNOWN_APP_KEY}\n`;
      const wr = bumpWindow(g, ufk, "-");
      wr.citationCount += 1;
      wr.offScreenRecording += 1;
    }
  }

  for (const n of pendingNotes) bumpOffNote(n.contextFocus);
  for (const i of pendingImages) bumpOffImage(i.contextFocus);
  for (const v of pendingVideos) bumpOffVideo(v.contextFocus);

  const apps: UploadFocusAppGroup[] = [];
  for (const [appKey, g] of byApp) {
    const windows: UploadFocusWindowRow[] = [...g.windows.entries()].map(([windowKey, w]) => ({
      windowKey,
      appKey,
      displayApp: g.displayApp,
      windowTitle: w.windowTitle,
      sessionSegmentCount: w.sessionSegmentCount,
      sessionText: w.sessionText,
      sessionScreenshot: w.sessionScreenshot,
      sessionScreenRecording: w.sessionScreenRecording,
      sessionDurationMs: w.sessionDurationMs,
      offText: w.offText,
      offScreenshot: w.offScreenshot,
      offScreenRecording: w.offScreenRecording,
      citationCount: w.citationCount,
    }));
    windows.sort((a, b) => b.citationCount - a.citationCount);
    apps.push({
      appKey,
      displayApp: g.displayApp,
      sessionSegmentCount: g.sessionSegmentCount,
      sessionText: g.sessionText,
      sessionScreenshot: g.sessionScreenshot,
      sessionScreenRecording: g.sessionScreenRecording,
      sessionDurationMs: g.sessionDurationMs,
      offText: g.offText,
      offScreenshot: g.offScreenshot,
      offScreenRecording: g.offScreenRecording,
      citationCount: g.citationCount,
      windows,
    });
  }
  apps.sort((a, b) => b.citationCount - a.citationCount);
  return apps;
}

export function isWindowEffectivelyExcluded(
  row: Pick<UploadFocusWindowRow, "appKey" | "windowKey">,
  opts: Pick<PrepareUploadFilterOptions, "excludedAppKeys" | "excludedWindowKeys">
): boolean {
  if (opts.excludedAppKeys.has(row.appKey)) return true;
  if (opts.excludedWindowKeys.has(row.windowKey)) return true;
  return false;
}

// ── Prepared upload payload ──────────────────────────────────────────────────

export type PreparedUploadPayload = {
  dumpId: string;
  sessionsToUpload: Session[];
  notesToUpload: OffSessionNote[];
  imagesToUpload: OffSessionImage[];
  videosToUpload: OffSessionVideo[];
  /** Fichiers locaux à supprimer après succès (segments / items non uploadés). */
  discardedLocalMediaPaths: string[];
  deleteSessionIds: string[];
  deleteOffNoteIds: string[];
  deleteOffImageIds: string[];
  deleteOffVideoIds: string[];
};

function uniqPaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

/** Notes dictée liées à une vidéo (même heuristique que l’export). */
function pairedTranscriptionNote(
  video: OffSessionVideo,
  srNotes: OffSessionNote[]
): OffSessionNote | undefined {
  if (srNotes.length === 0) return undefined;
  const videoTs = Date.parse(video.createdAt);
  let best: OffSessionNote | undefined;
  let bestDelta = Infinity;
  for (const n of srNotes) {
    const delta = Math.abs(Date.parse(n.createdAt) - videoTs);
    if (delta < bestDelta && delta < 60_000) {
      best = n;
      bestDelta = delta;
    }
  }
  return best;
}

// ── Contenu exact par fenêtre (Prepare upload, 3e niveau d’expansion) ─────

const CONTENT_PREVIEW_MAX = 500;

function truncateContentPreview(s: string, max = CONTENT_PREVIEW_MAX): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t.length) return "(empty)";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function fileBasename(p: string): string {
  const x = p.trim();
  const i = Math.max(x.lastIndexOf("/"), x.lastIndexOf("\\"));
  return i >= 0 ? x.slice(i + 1) : x || "(file)";
}

function sessionSegmentDetail(session: Session, seg: FocusSegment): string {
  const title = session.name?.trim() || session.id;
  return `${title} · ${seg.startedAt.slice(0, 19)} → ${seg.endedAt.slice(0, 19)}`;
}

export type UploadFocusContentLine = {
  /** Id d’exclusion / clé d’édition (stable). */
  id: string;
  /** Clé pour `editedTextByContentId` (texte / transcription) ; absent si non éditable. */
  editTextId?: string;
  scope: "session" | "off-session";
  kind: "text" | "screenshot" | "screenRecording";
  preview: string;
  /** Texte complet pour champs éditables. */
  fullText?: string;
  fullTranscription?: string;
  /** Optional explanation for text notes (two-field structured note). */
  explanation?: string;
  /** Chemin fichier local pour aperçu image / vidéo. */
  mediaPath?: string;
  detail?: string;
};

/**
 * Pour chaque `windowKey` (comme dans l’analyse focus), liste ordonnée du contenu affiché
 * (timelines de segments inclus + hors session), avec les mêmes filtres segment que l’analyse.
 */
function screenshotDetailWithOcr(
  base: string,
  path: string,
  ocrByPath?: Record<string, string>,
  inlineOcr?: string
): string {
  const t = (ocrByPath?.[path] ?? inlineOcr)?.trim();
  if (!t) return base;
  return `${base}\nOCR: ${truncateContentPreview(t, 900)}`;
}

export function buildUploadFocusWindowContentMap(
  pendingSessions: Session[],
  pendingNotes: OffSessionNote[],
  pendingImages: OffSessionImage[],
  pendingVideos: OffSessionVideo[],
  segmentFilter: { discardShortEmptySegments: boolean; minEmptySegmentSec: number },
  ocrByPath?: Record<string, string>
): Map<string, UploadFocusContentLine[]> {
  const segOpts = segmentOptsShortOnly(
    segmentFilter.discardShortEmptySegments,
    segmentFilter.minEmptySegmentSec
  );
  const map = new Map<string, UploadFocusContentLine[]>();

  const push = (wk: string, line: UploadFocusContentLine) => {
    const arr = map.get(wk) ?? [];
    arr.push(line);
    map.set(wk, arr);
  };

  for (const session of pendingSessions) {
    for (const seg of session.segments) {
      if (!segmentIncludedForUpload(seg, segOpts)) continue;
      const wk = focusWindowKey(seg);
      const tl = getSegmentTimeline(seg);
      const detailBase = sessionSegmentDetail(session, seg);
      tl.forEach((it, idx) => {
        const tid = sessionTimelineItemId(session.id, seg.startedAt, idx);
        if (it.kind === "text") {
          push(wk, {
            id: tid,
            editTextId: tid,
            scope: "session",
            kind: "text",
            preview: truncateContentPreview(it.text),
            fullText: it.text,
            ...(it.explanation !== undefined ? { explanation: it.explanation } : {}),
            detail: detailBase,
          });
        } else if (it.kind === "document") {
          push(wk, {
            id: tid,
            editTextId: tid,
            scope: "session",
            kind: "text",
            preview: truncateContentPreview(it.summary),
            fullText: it.summary,
            ...(it.explanation !== undefined ? { explanation: it.explanation } : {}),
            detail: `${detailBase}\n${it.filePath}`,
          });
        } else if (it.kind === "screenshot") {
          push(wk, {
            id: tid,
            scope: "session",
            kind: "screenshot",
            preview: fileBasename(it.path),
            mediaPath: it.path,
            detail: screenshotDetailWithOcr(`${detailBase}\n${it.path}`, it.path, ocrByPath),
          });
        } else if (it.kind === "screenRecording") {
          const tr = stripTranscriptionPrefix(it.transcription?.trim() ?? "");
          push(wk, {
            id: tid,
            editTextId: tid,
            scope: "session",
            kind: "screenRecording",
            preview: tr ? truncateContentPreview(tr) : fileBasename(it.path),
            fullTranscription: tr,
            mediaPath: it.path,
            detail: `${detailBase}\n${it.path}`,
          });
        }
      });
    }
  }

  const srPool = pendingNotes.filter((n) => n.source === "screenRecording");

  for (const n of [...pendingNotes].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  )) {
    const fl = offFocusLike(n.contextFocus);
    const wk = fl ? focusWindowKey(fl) : `${UNKNOWN_APP_KEY}\n`;
    const nid = offNoteContentId(n.id);
    const noteBody = n.kind === "document" ? n.summary ?? "" : n.text ?? "";
    push(wk, {
      id: nid,
      editTextId: nid,
      scope: "off-session",
      kind: "text",
      preview: truncateContentPreview(noteBody),
      fullText: noteBody,
      ...(n.explanation !== undefined ? { explanation: n.explanation } : {}),
      detail: `Off-session note · ${n.createdAt}`,
    });
  }

  for (const i of [...pendingImages].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  )) {
    const fl = offFocusLike(i.contextFocus);
    const wk = fl ? focusWindowKey(fl) : `${UNKNOWN_APP_KEY}\n`;
    const iid = offImageContentId(i.id);
    push(wk, {
      id: iid,
      scope: "off-session",
      kind: "screenshot",
      preview: fileBasename(i.path),
      mediaPath: i.path,
      detail: screenshotDetailWithOcr(
        `Off-session screenshot · ${i.createdAt}\n${i.path}`,
        i.path,
        ocrByPath,
        i.ocr
      ),
    });
  }

  for (const v of [...pendingVideos].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  )) {
    const fl = offFocusLike(v.contextFocus);
    const wk = fl ? focusWindowKey(fl) : `${UNKNOWN_APP_KEY}\n`;
    // Prefer v.transcription (new format); fall back to paired note (legacy).
    const paired = pairedTranscriptionNote(v, srPool);
    const rawTr = v.transcription?.trim() || paired?.text?.trim() || "";
    const tr = stripTranscriptionPrefix(rawTr);
    const vid = offVideoContentId(v.id);
    // Edit key: video id for new format, note id for legacy paired note.
    const editTransId = tr
      ? (v.transcription?.trim() ? vid : (paired ? offNoteContentId(paired.id) : vid))
      : undefined;
    push(wk, {
      id: vid,
      editTextId: editTransId,
      scope: "off-session",
      kind: "screenRecording",
      preview: tr ? truncateContentPreview(tr) : fileBasename(v.path),
      fullTranscription: tr,
      mediaPath: v.path,
      detail: `Off-session recording · ${v.createdAt}\n${v.path}`,
    });
  }

  return map;
}

function filterSegmentTimelineForUpload(
  session: Session,
  seg: FocusSegment,
  opts: PrepareUploadFilterOptions,
  discardedMedia: string[],
  docExcl: ReadonlySet<string>,
  docIndexFalse: ReadonlySet<string>
): ContextTimelineItem[] {
  const excl = opts.excludedContentIds ?? new Set<string>();
  const editMap = opts.editedTextByContentId ?? new Map<string, string>();
  const tl = getSegmentTimeline(seg);
  const out: ContextTimelineItem[] = [];
  tl.forEach((it, idx) => {
    const id = sessionTimelineItemId(session.id, seg.startedAt, idx);
    if (excl.has(id)) {
      if (it.kind === "screenshot" || it.kind === "screenRecording") discardedMedia.push(it.path);
      if (it.kind === "document" && it.filePath) discardedMedia.push(it.filePath);
      return;
    }
    if (it.kind === "text") {
      const text = editMap.get(id) ?? it.text;
      out.push({ ...it, text });
    } else if (it.kind === "document") {
      const summary = editMap.get(id) ?? it.summary;
      if (docExcl.has(id)) {
        out.push({
          kind: "text",
          text: summary,
          source: "manual",
          ...(it.explanation !== undefined ? { explanation: it.explanation } : {}),
          ...(it.lang !== undefined ? { lang: it.lang } : {}),
        });
      } else if (docIndexFalse.has(id)) {
        out.push({ ...it, summary, process_doc_index_doc: false });
      } else {
        out.push({ ...it, summary });
      }
    } else if (it.kind === "screenRecording") {
      const transcription = editMap.get(id) ?? it.transcription;
      out.push({ ...it, transcription });
    } else {
      out.push({ ...it });
    }
  });
  return out;
}

export function prepareUploadPayload(
  dumpId: string,
  pendingSessions: Session[],
  pendingNotes: OffSessionNote[],
  pendingImages: OffSessionImage[],
  pendingVideos: OffSessionVideo[],
  opts: PrepareUploadFilterOptions
): PreparedUploadPayload {
  const discardedMedia: string[] = [];
  const deleteSessionIds: string[] = [];
  const removeNoteIds = new Set<string>();
  const removeImageIds = new Set<string>();
  const removeVideoIds = new Set<string>();

  const excl = opts.excludedContentIds ?? new Set<string>();
  const editMap = opts.editedTextByContentId ?? new Map<string, string>();
  const docExcl = opts.excludedDocNoteIds ?? new Set<string>();
  const docIndexFalse = opts.docProcessIndexFalseIds ?? new Set<string>();
  const srPool = pendingNotes.filter((n) => n.source === "screenRecording");

  const sessionsToUpload: Session[] = [];

  for (const session of pendingSessions) {
    const newSegs: FocusSegment[] = [];
    for (const seg of session.segments) {
      if (!segmentIncludedForUpload(seg, opts)) {
        discardedMedia.push(...collectMediaPathsFromSegment(seg));
        continue;
      }
      const ft = filterSegmentTimelineForUpload(
        session,
        seg,
        opts,
        discardedMedia,
        docExcl,
        docIndexFalse
      );
      if (ft.length === 0) {
        continue;
      }
      newSegs.push({
        ...seg,
        contextTimeline: ft,
        contextNotes: undefined,
        contextImagePaths: undefined,
        contextImages: undefined,
      });
    }
    if (newSegs.length === 0) {
      deleteSessionIds.push(session.id);
    } else {
      sessionsToUpload.push({ ...session, segments: newSegs });
    }
  }

  for (const n of pendingNotes) {
    if (!offNoteIncludedForUpload(n, opts)) removeNoteIds.add(n.id);
    else if (excl.has(offNoteContentId(n.id))) removeNoteIds.add(n.id);
  }

  for (const i of pendingImages) {
    if (!offImageIncludedForUpload(i, opts)) {
      removeImageIds.add(i.id);
      discardedMedia.push(i.path);
    } else if (excl.has(offImageContentId(i.id))) {
      removeImageIds.add(i.id);
      discardedMedia.push(i.path);
    }
  }

  for (const v of pendingVideos) {
    if (!offVideoIncludedForUpload(v, opts)) {
      removeVideoIds.add(v.id);
      discardedMedia.push(v.path);
      const paired = pairedTranscriptionNote(v, srPool);
      if (paired) removeNoteIds.add(paired.id);
    } else if (excl.has(offVideoContentId(v.id))) {
      removeVideoIds.add(v.id);
      discardedMedia.push(v.path);
      const paired = pairedTranscriptionNote(v, srPool);
      if (paired) removeNoteIds.add(paired.id);
    }
  }

  const notesToUpload = pendingNotes
    .filter((n) => !removeNoteIds.has(n.id))
    .map((n) => {
      let result = n;
      const cid = offNoteContentId(n.id);
      const edited = editMap.get(cid);
      if (edited != null) {
        if (n.kind === "document") {
          if (edited !== (n.summary ?? "")) result = { ...result, summary: edited };
        } else if (edited !== (n.text ?? "")) {
          result = { ...result, text: edited };
        }
      }
      const docLike = n.kind === "document";
      if (docLike && n.filePath && docExcl.has(n.id)) {
        const body = n.kind === "document" ? n.summary ?? "" : n.text ?? "";
        result = {
          ...n,
          kind: undefined,
          summary: undefined,
          text: body,
          filePath: undefined,
          fileSize: undefined,
          process_doc_index_doc: undefined,
        };
      } else if (
        docLike &&
        n.filePath &&
        !docExcl.has(n.id) &&
        docIndexFalse.has(n.id)
      ) {
        result = { ...result, process_doc_index_doc: false };
      }
      return result;
    });

  const imagesToUpload = pendingImages.filter((i) => !removeImageIds.has(i.id));
  const videosToUpload = pendingVideos
    .filter((v) => !removeVideoIds.has(v.id))
    .map((v) => {
      const editedText = editMap.get(offVideoContentId(v.id));
      if (editedText == null) return v;
      return { ...v, transcription: editedText };
    });

  return {
    dumpId,
    sessionsToUpload,
    notesToUpload,
    imagesToUpload,
    videosToUpload,
    discardedLocalMediaPaths: uniqPaths(discardedMedia),
    deleteSessionIds,
    deleteOffNoteIds: [...removeNoteIds],
    deleteOffImageIds: [...removeImageIds],
    deleteOffVideoIds: [...removeVideoIds],
  };
}

/** Compte les éléments de contenu (texte / capture / enregistrement / fichiers PDF) alignés sur le payload préparé. */
export type PreparedUploadContentCounts = {
  textCount: number;
  screenshotCount: number;
  recordingCount: number;
  /** pdfSummary items (in-session or off-session) with a local filePath (binary in ZIP). */
  fileCount: number;
};

function countPdfSummaryWithLocalFileInSessions(sessions: Session[]): number {
  let n = 0;
  for (const s of sessions) {
    for (const seg of s.segments) {
      for (const it of getSegmentTimeline(seg)) {
        if (
          it.kind === "document" &&
          it.filePath &&
          !/^https?:\/\//i.test(it.filePath.trim())
        ) {
          n++;
        }
      }
    }
  }
  return n;
}

export function countPreparedUploadContentKinds(
  p: PreparedUploadPayload
): PreparedUploadContentCounts {
  let textCount = 0;
  let screenshotCount = 0;
  let recordingCount = 0;
  for (const s of p.sessionsToUpload) {
    for (const seg of s.segments) {
      for (const it of getSegmentTimeline(seg)) {
        if (it.kind === "text" || it.kind === "document") textCount++;
        else if (it.kind === "screenshot") screenshotCount++;
        else if (it.kind === "screenRecording") recordingCount++;
      }
    }
  }
  textCount += p.notesToUpload.length;
  screenshotCount += p.imagesToUpload.length;
  recordingCount += p.videosToUpload.length;
  const fileCount =
    p.notesToUpload.filter(
      (n) =>
        n.kind === "document" &&
        n.filePath &&
        !/^https?:\/\//i.test(n.filePath.trim())
    ).length + countPdfSummaryWithLocalFileInSessions(p.sessionsToUpload);
  return { textCount, screenshotCount, recordingCount, fileCount };
}

/**
 * Breaks the "files" count down the same way the export does:
 * chaque screenshot/recording = 1 fichier binaire, chaque session = 1 JSON, bloc hors session = 1 JSON.
 * Les textes / notes sont sérialisés dans ces JSON, pas en fichiers séparés.
 */
export type PreparedUploadFileBreakdown = {
  mediaFileCount: number;
  sessionJsonCount: number;
  offSessionJsonCount: 0 | 1;
  /** Document binaries included in the ZIP (pdfSummary notes with a non-cleared filePath). */
  docFileCount: number;
  totalFiles: number;
};

export function getPreparedUploadFileBreakdown(
  p: PreparedUploadPayload
): PreparedUploadFileBreakdown {
  let mediaFileCount = 0;
  for (const s of p.sessionsToUpload) {
    for (const seg of s.segments) {
      for (const it of getSegmentTimeline(seg)) {
        if (it.kind === "screenshot" || it.kind === "screenRecording") mediaFileCount++;
      }
    }
  }
  mediaFileCount += p.imagesToUpload.length;
  mediaFileCount += p.videosToUpload.length;

  const sessionJsonCount = p.sessionsToUpload.length;
  const hasOffPayload =
    p.notesToUpload.length + p.imagesToUpload.length + p.videosToUpload.length > 0;
  const offSessionJsonCount: 0 | 1 = hasOffPayload ? 1 : 0;
  const docFileCount =
    p.notesToUpload.filter(
      (n) =>
        n.kind === "document" &&
        n.filePath &&
        !/^https?:\/\//i.test(n.filePath.trim())
    ).length + countPdfSummaryWithLocalFileInSessions(p.sessionsToUpload);
  const totalFiles = mediaFileCount + sessionJsonCount + offSessionJsonCount + docFileCount;

  return { mediaFileCount, sessionJsonCount, offSessionJsonCount, docFileCount, totalFiles };
}

export function countPreparedUploadFiles(p: PreparedUploadPayload): number {
  return getPreparedUploadFileBreakdown(p).totalFiles;
}

// ── Phase B: local sensitive preview / full batch scan (same traversal as Prepare UI) ──

/** Default max characters per LLM call (whitespace-split; long lines split into several chunks). */
/** Max characters per text chunk sent to the local model (UTF-16 code units / `String.length`). Not a word count. */
export const SENSITIVE_MODEL_CHUNK_MAX_CHARS = 4000;

/**
 * Splits long text into segments ≤ `maxChars` by words; oversized single tokens are hard-sliced.
 */
export function splitTextForSensitiveChunks(text: string, maxChars: number): string[] {
  const t = text.trim();
  if (!t) return [];
  const cap = Math.max(256, maxChars);
  if (t.length <= cap) return [t];
  const words = t.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= cap) {
      cur = next;
    } else {
      if (cur) out.push(cur);
      if (w.length > cap) {
        for (let i = 0; i < w.length; i += cap) {
          out.push(w.slice(i, i + cap));
        }
        cur = "";
      } else {
        cur = w;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** One model call: a logical content line optionally split when text exceeds `maxCharsPerChunk`. */
export type SensitivePreviewChunk = {
  textForModel: string;
  displayApp: string;
  windowTitle: string;
  /** Same keys as Prepare exclusions (`focusAppKey` / `focusWindowKey`). */
  appKey: string;
  windowKey: string;
  lineKind: "text" | "screenshot" | "screenRecording";
  lineId: string;
  /** Sub-chunk index when `splitTextForSensitiveChunks` produced several parts (0-based). */
  chunkIndex: number;
  /** Stable id for this model invocation: `${lineId}#${chunkIndex}`. */
  chunkKey: string;
  /** Clé pour édition / persistance (`editTextId` ?? `lineId`). */
  persistTextKey: string;
};

/**
 * Stable ordering aligned with `ProcessTab`: `focusApps` order, each app's `windows` array,
 * then each window's lines from `buildUploadFocusWindowContentMap` (insertion order).
 * Skips excluded apps / windows / content ids. Skips empty text / empty OCR for screenshots.
 * Long text is split with `splitTextForSensitiveChunks` (several chunks share the same `lineId`).
 */
export function getAllSensitivePreviewChunks(
  focusApps: UploadFocusAppGroup[],
  windowContentMap: Map<string, UploadFocusContentLine[]>,
  opts: PrepareUploadFilterOptions,
  ocrByPath: Record<string, string>,
  maxCharsPerChunk: number = SENSITIVE_MODEL_CHUNK_MAX_CHARS
): SensitivePreviewChunk[] {
  const exclContent = opts.excludedContentIds ?? new Set<string>();
  const editMap = opts.editedTextByContentId ?? new Map<string, string>();
  const out: SensitivePreviewChunk[] = [];

  const pushLine = (
    raw: string,
    displayApp: string,
    windowTitle: string,
    appKey: string,
    windowKey: string,
    lineKind: SensitivePreviewChunk["lineKind"],
    lineId: string,
    persistTextKey: string
  ) => {
    const parts = splitTextForSensitiveChunks(raw, maxCharsPerChunk);
    parts.forEach((textForModel, chunkIndex) => {
      out.push({
        textForModel,
        displayApp,
        windowTitle,
        appKey,
        windowKey,
        lineKind,
        lineId,
        chunkIndex,
        chunkKey: `${lineId}#${chunkIndex}`,
        persistTextKey,
      });
    });
  };

  for (const app of focusApps) {
    for (const w of app.windows) {
      const winExcl = isWindowEffectivelyExcluded(w, opts);
      const lines = windowContentMap.get(w.windowKey) ?? [];
      /* Align with expandable list: no lines for this window after segment filters → no chunks. */
      if (lines.length === 0) continue;
      for (const line of lines) {
        const segmentExcluded = winExcl || exclContent.has(line.id);
        if (segmentExcluded) continue;
        const pk = line.editTextId ?? line.id;
        if (line.kind === "text") {
          const t = (editMap.get(pk) ?? line.fullText ?? "").trim();
          if (!t) continue;
          pushLine(t, app.displayApp, w.windowTitle, app.appKey, w.windowKey, "text", line.id, pk);
        } else if (line.kind === "screenRecording") {
          const t = (editMap.get(pk) ?? line.fullTranscription ?? "").trim();
          if (!t) continue;
          pushLine(
            t,
            app.displayApp,
            w.windowTitle,
            app.appKey,
            w.windowKey,
            "screenRecording",
            line.id,
            pk
          );
        } else if (line.kind === "screenshot") {
          const p = line.mediaPath?.trim() ?? "";
          const ocr = (ocrByPath[p] ?? "").trim();
          if (!ocr) continue;
          pushLine(ocr, app.displayApp, w.windowTitle, app.appKey, w.windowKey, "screenshot", line.id, pk);
        }
      }
    }
  }
  return out;
}

// ── Aggregate full-scan results (worst chunk wins per line) ─────────────────

export type SensitiveLineRollup = {
  lineId: string;
  displayApp: string;
  windowTitle: string;
  appKey: string;
  windowKey: string;
  /** Short text for UI / review (first chunk, truncated). */
  textPreview: string;
  /** Clé alignée avec `editedTextByContentId` / persistance disque. */
  persistTextKey: string;
  lineKind: SensitivePreviewChunk["lineKind"];
  /** Worst case across sub-chunks (-1 most sensitive); `null` if every chunk failed to parse. */
  verdict: number | null;
  chunks: {
    chunkKey: string;
    chunkIndex: number;
    parsed: number | null;
    label: string;
  }[];
};

export type SensitiveScanCounts = {
  sensitive: number;
  uncertain: number;
  ok: number;
  failedLines: number;
};

/**
 * Single verdict for one content line after all its model sub-parts are scanned.
 * A long text split into N internal calls still yields **one** value for UI (one warning icon per line):
 * worst case wins - any Sensitive (-1) beats any Maybe (0); any Maybe beats OK (1).
 */
function aggregateLineVerdict(parseds: (number | null)[]): number | null {
  if (parseds.some((x) => x === -1)) return -1;
  if (parseds.some((x) => x === 0)) return 0;
  if (parseds.some((x) => x === null)) return null;
  if (parseds.length === 0) return null;
  if (parseds.every((x) => x === 1)) return 1;
  return 0;
}

/** Stored result for one `chunkKey` after a Local LM call. */
export type ChunkScanResult = { parsed: number | null; label: string };

/**
 * Builds one rollup row per content `lineId` from stored per-model-part results.
 * Omits a line until **every** sub-chunk for that line has a result; then merges them into a
 * single `verdict` and a single set of UI badges (no duplicate icons per split text).
 */
export function buildSensitiveRollupFromChunkResultMap(
  allChunks: SensitivePreviewChunk[],
  resultsByChunkKey: ReadonlyMap<string, ChunkScanResult>
): { lines: SensitiveLineRollup[]; counts: SensitiveScanCounts } {
  const byLine = new Map<string, SensitivePreviewChunk[]>();
  for (const c of allChunks) {
    if (!byLine.has(c.lineId)) byLine.set(c.lineId, []);
    byLine.get(c.lineId)!.push(c);
  }
  for (const arr of byLine.values()) {
    arr.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  const lines: SensitiveLineRollup[] = [];
  for (const [, lineChunks] of byLine) {
    const chunkMetas: SensitiveLineRollup["chunks"] = [];
    const parseds: (number | null)[] = [];
    let complete = true;
    for (const c of lineChunks) {
      const r = resultsByChunkKey.get(c.chunkKey);
      if (!r) {
        complete = false;
        break;
      }
      parseds.push(r.parsed);
      chunkMetas.push({
        chunkKey: c.chunkKey,
        chunkIndex: c.chunkIndex,
        parsed: r.parsed,
        label: r.label,
      });
    }
    if (!complete) continue;

    const first = lineChunks[0]!;
    const verdict = aggregateLineVerdict(parseds);
    const prev = first.textForModel.slice(0, 900);
    lines.push({
      lineId: first.lineId,
      displayApp: first.displayApp,
      windowTitle: first.windowTitle,
      appKey: first.appKey,
      windowKey: first.windowKey,
      textPreview: prev.length < first.textForModel.length ? `${prev}…` : prev,
      persistTextKey: first.persistTextKey,
      lineKind: first.lineKind,
      verdict,
      chunks: chunkMetas,
    });
  }

  lines.sort((a, b) => a.lineId.localeCompare(b.lineId));

  const counts: SensitiveScanCounts = {
    sensitive: 0,
    uncertain: 0,
    ok: 0,
    failedLines: 0,
  };
  for (const L of lines) {
    if (L.verdict === -1) counts.sensitive += 1;
    else if (L.verdict === 0) counts.uncertain += 1;
    else if (L.verdict === 1) counts.ok += 1;
    else counts.failedLines += 1;
  }
  return { lines, counts };
}

/** Groups chunk-level LLM outputs by `lineId` (pire cas entre sous-chunks). */
export function rollUpSensitiveScan(
  pairs: {
    chunk: SensitivePreviewChunk;
    parsed: number | null;
    label: string;
  }[]
): { lines: SensitiveLineRollup[]; counts: SensitiveScanCounts } {
  const byLine = new Map<string, SensitiveLineRollup>();

  for (const { chunk, parsed, label } of pairs) {
    let row = byLine.get(chunk.lineId);
    if (!row) {
      const prev = chunk.textForModel.slice(0, 900);
      row = {
        lineId: chunk.lineId,
        displayApp: chunk.displayApp,
        windowTitle: chunk.windowTitle,
        appKey: chunk.appKey,
        windowKey: chunk.windowKey,
        textPreview: prev.length < chunk.textForModel.length ? `${prev}…` : prev,
        persistTextKey: chunk.persistTextKey,
        lineKind: chunk.lineKind,
        verdict: null,
        chunks: [],
      };
      byLine.set(chunk.lineId, row);
    }
    row.chunks.push({
      chunkKey: chunk.chunkKey,
      chunkIndex: chunk.chunkIndex,
      parsed,
      label,
    });
  }

  const lines: SensitiveLineRollup[] = [...byLine.values()].map((row) => {
    const parseds = row.chunks.map((c) => c.parsed);
    row.chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
    return {
      ...row,
      verdict: aggregateLineVerdict(parseds),
    };
  });

  lines.sort((a, b) => a.lineId.localeCompare(b.lineId));

  const counts: SensitiveScanCounts = {
    sensitive: 0,
    uncertain: 0,
    ok: 0,
    failedLines: 0,
  };
  for (const L of lines) {
    if (L.verdict === -1) counts.sensitive += 1;
    else if (L.verdict === 0) counts.uncertain += 1;
    else if (L.verdict === 1) counts.ok += 1;
    else counts.failedLines += 1;
  }

  return { lines, counts };
}

/** Lines that should be reviewed or auto-marked DNU depending on product mode. */
export function filterLinesBySensitiveVerdict(
  lines: SensitiveLineRollup[],
  mode: "sensitive_only" | "sensitive_and_uncertain"
): SensitiveLineRollup[] {
  return lines.filter((L) => {
    if (mode === "sensitive_only") return L.verdict === -1;
    return L.verdict === -1 || L.verdict === 0;
  });
}

/** First text-bearing chunk (same as first entry of `getAllSensitivePreviewChunks`). */
export function getFirstSensitivePreviewChunk(
  focusApps: UploadFocusAppGroup[],
  windowContentMap: Map<string, UploadFocusContentLine[]>,
  opts: PrepareUploadFilterOptions,
  ocrByPath: Record<string, string>
): SensitivePreviewChunk | null {
  const all = getAllSensitivePreviewChunks(
    focusApps,
    windowContentMap,
    opts,
    ocrByPath,
    SENSITIVE_MODEL_CHUNK_MAX_CHARS
  );
  return all[0] ?? null;
}
