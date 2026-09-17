import type { ContextTimelineItem } from "./contextTimeline";
import {
  getSegmentTimeline,
  timelineHasTextOrMedia,
} from "./contextTimeline";
import type {
  FocusSegment,
  OffSessionImage,
  OffSessionNote,
  OffSessionVideo,
  RecordingSelfIdentity,
  Session,
} from "./App";
import { offSessionVideoTranscription } from "./offSessionFocusUi";

function offSessionNoteBody(n: OffSessionNote): string {
  if (n.kind === "document") return n.summary ?? "";
  return n.text ?? "";
}

function offSessionNoteHasAttachedBinary(n: OffSessionNote): boolean {
  const fp = n.filePath?.trim();
  if (!fp) return false;
  return n.kind === "document";
}

export type RecordingsZipMediaEntry = { diskPath: string; zipPath: string; userOwned?: boolean };

export type BuildRecordingsExportArgs = {
  exportedAtIso: string;
  minDisplaySec: number;
  currentSessionId: string | null;
  recordingPaused: boolean;
  focusCaptureActive: boolean;
  selfIdentity: RecordingSelfIdentity | null;
  sessions: Session[];
  liveBySessionId: Record<string, LiveFocusSnapshot>;
  livePendingTimelineBySession: Record<string, ContextTimelineItem[]>;
  offSessionNotes: OffSessionNote[];
  offSessionImages: OffSessionImage[];
  offSessionVideos: OffSessionVideo[];
  ocrTextByPath: Record<string, string>;
  /** Optional line in the MD preamble (Full vs Prepare-aligned). */
  exportVariantDescription?: string;
  /** Batch title (e.g. Process “Batch title”); H1 in MD and root `title` in JSON when non-empty. */
  title?: string | null;
};

type LiveFocusSnapshot = Omit<FocusSegment, "endedAt">;

/**
 * After a successful process/upload, `uploadService` replaces local filesystem paths
 * in `contextTimeline` and off-session media with `https://…` GCS URLs. Those are
 * not readable as local paths for the ZIP step.
 */
function isRemoteMediaRef(p: string): boolean {
  return /^https?:\/\//i.test(p.trim());
}

function fileBasename(p: string): string {
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

function safePathToken(s: string): string {
  const t = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return t.slice(0, 80) || "file";
}

function segmentDurationMs(seg: Pick<FocusSegment, "startedAt" | "endedAt">): number {
  const a = Date.parse(seg.startedAt);
  const b = Date.parse(seg.endedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return b - a;
}

function fmtDurationMs(ms: number): string {
  if (ms <= 0) return "0s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function isSelfKtsSegment(
  seg: Pick<FocusSegment, "processId" | "bundleId">,
  self: RecordingSelfIdentity | null
): boolean {
  if (!self) return false;
  if (seg.processId === self.processId) return true;
  const bid = seg.bundleId?.trim();
  if (!bid) return false;
  const b = bid.toLowerCase();
  if (self.bundleId?.trim()) {
    if (b === self.bundleId.trim().toLowerCase()) return true;
  }
  if (self.configIdentifier?.trim()) {
    if (b === self.configIdentifier.trim().toLowerCase()) return true;
  }
  return false;
}

function sortSegmentsChrono(segments: FocusSegment[]): FocusSegment[] {
  return [...segments].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)
  );
}

function fencedText(s: string): string {
  let fence = "```";
  while (s.includes(fence)) fence += "`";
  return `${fence}\n${s}\n${fence}`;
}

function fmtDateOnly(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return iso;
  return new Date(d).toLocaleDateString(undefined, { dateStyle: "long" });
}

/** Single-line safe heading text (no newlines). */
function headingText(s: string): string {
  return s.replace(/\s+/g, " ").trim() || "-";
}

function segmentAppTitle(
  seg: Pick<FocusSegment, "appName" | "bundleId" | "processId">
): string {
  return (
    (seg.appName && seg.appName.trim()) ||
    (seg.bundleId && seg.bundleId.trim()) ||
    `Process ${seg.processId}`
  );
}

function segmentWindowSubtitle(seg: Pick<FocusSegment, "windowName">): string | null {
  const w = seg.windowName?.trim();
  return w && w.length > 0 ? w : null;
}

type OffSessionFocus = NonNullable<OffSessionNote["contextFocus"]>;

function offSessionAppWindow(
  cf: OffSessionFocus | null | undefined
): { app: string; win: string | null } {
  if (!cf) {
    return { app: "Other", win: null };
  }
  const app =
    (cf.appName && cf.appName.trim()) ||
    (cf.bundleId && cf.bundleId.trim()) ||
    (cf.processId ? `Process ${cf.processId}` : "Other");
  const win =
    (cf.windowName && cf.windowName.trim()) ||
    (cf.windowOwnerName && cf.windowOwnerName.trim()) ||
    null;
  return { app, win };
}

function offSessionFocusKey(cf: OffSessionNote["contextFocus"]): string {
  const { app, win } = offSessionAppWindow(cf);
  return `${app}\n${win ?? ""}`;
}

function segmentVisibleForExport(
  seg: FocusSegment,
  minDisplaySec: number,
  self: RecordingSelfIdentity | null,
  mergeForThreshold?: ContextTimelineItem[]
): boolean {
  if (isSelfKtsSegment(seg, self)) return false;
  const tl = getSegmentTimeline(seg);
  const merged =
    mergeForThreshold && mergeForThreshold.length > 0
      ? [...tl, ...mergeForThreshold]
      : tl;
  if (minDisplaySec <= 0) return true;
  if (timelineHasTextOrMedia(merged)) return true;
  return segmentDurationMs(seg) >= minDisplaySec * 1000;
}

function formatNoteBody(text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (t.includes("```") || /^#{1,6}\s/m.test(t)) {
    return `${fencedText(t)}\n\n`;
  }
  return `${t}\n\n`;
}

function emitReadableTimeline(
  items: ContextTimelineItem[],
  paths: PathResolver,
  zipTailPrefix: string
): string {
  if (items.length === 0) return "";
  const parts: string[] = [];
  let mediaIdx = 0;
  for (const it of items) {
    if (it.kind === "text") {
      parts.push(formatNoteBody(it.text));
      if (it.explanation) {
        const exp = it.explanation.trim();
        if (exp) parts.push(`> ${exp.replace(/\n/g, "\n> ")}\n\n`);
      }
      if (it.source === "dictation") {
        parts.push("*Transcribed from dictation.*\n\n");
      }
    } else if (it.kind === "document") {
      mediaIdx++;
      const fp = it.filePath.trim();
      if (isRemoteMediaRef(fp)) {
        parts.push(`[Attached file](${fp})\n\n`);
      } else {
        const base = safePathToken(fileBasename(fp));
        const rel = paths.forDisk(
          fp,
          `${zipTailPrefix}/files/summary-${mediaIdx}_${base}`,
          { userOwned: true }
        );
        parts.push(`[Attached file](${rel})\n\n`);
      }
      parts.push(formatNoteBody(it.summary));
      if (it.explanation) {
        const exp = it.explanation.trim();
        if (exp) parts.push(`> ${exp.replace(/\n/g, "\n> ")}\n\n`);
      }
    } else if (it.kind === "screenshot") {
      mediaIdx++;
      if (isRemoteMediaRef(it.path)) {
        const url = it.path.trim();
        const label = safePathToken(fileBasename(url)) || "screenshot";
        parts.push(`![${label}](${url})\n\n`);
      } else {
        const base = safePathToken(fileBasename(it.path));
        const rel = paths.forDisk(
          it.path,
          `${zipTailPrefix}/screenshot-${mediaIdx}_${base}`
        );
        parts.push(`![Screenshot](${rel})\n\n`);
      }
    } else if (it.kind === "screenRecording") {
      mediaIdx++;
      const trans = it.transcription?.trim();
      if (isRemoteMediaRef(it.path)) {
        const url = it.path.trim();
        parts.push(`[Screen recording](${url})\n\n`);
        if (trans) parts.push(`${formatNoteBody(trans)}`);
      } else {
        const base = safePathToken(fileBasename(it.path));
        const rel = paths.forDisk(
          it.path,
          `${zipTailPrefix}/screen-recording-${mediaIdx}_${base}`
        );
        parts.push(`[Screen recording](${rel})\n\n`);
        if (trans) parts.push(`${formatNoteBody(trans)}`);
      }
    }
  }
  return parts.join("");
}

type PathResolver = {
  forDisk: (
    diskPath: string,
    suggestedZipTail: string,
    opts?: { userOwned?: boolean }
  ) => string;
  mediaEntries: () => RecordingsZipMediaEntry[];
};

function createPathResolver(): PathResolver {
  const diskToZip = new Map<string, string>();
  const diskUserOwned = new Map<string, boolean>();
  const used = new Set<string>();

  function allocate(fullRel: string): string {
    let p = fullRel;
    let i = 1;
    while (used.has(p)) {
      const slash = p.lastIndexOf("/");
      const dir = slash >= 0 ? p.slice(0, slash) : "";
      const file = slash >= 0 ? p.slice(slash + 1) : p;
      const dot = file.lastIndexOf(".");
      const stem = dot >= 0 ? file.slice(0, dot) : file;
      const ext = dot >= 0 ? file.slice(dot) : "";
      const next = `${stem}~${i}${ext}`;
      p = dir ? `${dir}/${next}` : next;
      i++;
    }
    used.add(p);
    return p;
  }

  return {
    forDisk(diskPath: string, suggestedZipTail: string, opts?: { userOwned?: boolean }) {
      const hit = diskToZip.get(diskPath);
      if (hit) return hit;
      const tail = suggestedZipTail.replace(/^\/+/, "");
      const z = allocate(`artefacts/${tail}`);
      diskToZip.set(diskPath, z);
      if (opts?.userOwned) diskUserOwned.set(diskPath, true);
      return z;
    },
    mediaEntries() {
      return [...diskToZip.entries()].map(([diskPath, zipPath]) => ({
        diskPath,
        zipPath,
        ...(diskUserOwned.get(diskPath) ? { userOwned: true as const } : {}),
      }));
    },
  };
}

function sessionShortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

type OffSessionEvent =
  | { kind: "note"; t: number; note: OffSessionNote }
  | { kind: "img"; t: number; img: OffSessionImage }
  | { kind: "vid"; t: number; vid: OffSessionVideo };

function parseCreatedMs(iso: string): number {
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Builds human-readable Markdown and the list of files to pack under `artefacts/`.
 * Technical detail lives in `recordings-context.json`; this file is meant to be read as notes.
 */
export function buildRecordingsContextZipBundle(
  a: BuildRecordingsExportArgs
): { markdown: string; mediaFiles: RecordingsZipMediaEntry[] } {
  const paths = createPathResolver();
  const lines: string[] = [];

  const mdH1 =
    a.title != null && String(a.title).trim() !== ""
      ? headingText(String(a.title).trim())
      : "Recording notes";
  lines.push(`# ${mdH1}\n`);
  lines.push(`**Exported:** ${fmtDateOnly(a.exportedAtIso)}\n`);
  lines.push(
    "\n_Full technical data (sources, timestamps, OCR, IDs, thresholds) is in `recordings-context.json`._\n"
  );

  const offEvents: OffSessionEvent[] = [];
  for (const note of a.offSessionNotes) {
    if (note.source === "screenRecording") continue;
    offEvents.push({
      kind: "note",
      t: parseCreatedMs(note.createdAt),
      note,
    });
  }
  for (const img of a.offSessionImages) {
    offEvents.push({
      kind: "img",
      t: parseCreatedMs(img.createdAt),
      img,
    });
  }
  for (const vid of a.offSessionVideos) {
    offEvents.push({
      kind: "vid",
      t: parseCreatedMs(vid.createdAt),
      vid,
    });
  }
  offEvents.sort((x, y) => x.t - y.t);

  if (offEvents.length > 0) {
    lines.push("\n## Outside recording sessions\n");
    let lastFocusKey = "";
    for (const ev of offEvents) {
      const cf =
        ev.kind === "note"
          ? ev.note.contextFocus
          : ev.kind === "img"
            ? ev.img.contextFocus
            : ev.vid.contextFocus;
      const key = offSessionFocusKey(cf);
      if (key !== lastFocusKey) {
        lastFocusKey = key;
        const { app, win } = offSessionAppWindow(cf);
        lines.push(`\n### ${headingText(app)}\n`);
        if (win) lines.push(`#### ${headingText(win)}\n`);
        lines.push("");
      }
      if (ev.kind === "note") {
        const n = ev.note;
        if (offSessionNoteHasAttachedBinary(n)) {
          const fp = n.filePath!.trim();
          if (isRemoteMediaRef(fp)) {
            lines.push(`[Attached file](${fp})\n\n`);
          } else {
            const base = safePathToken(fileBasename(fp));
            const rel = paths.forDisk(
              fp,
              `off-session/files/${sessionShortId(n.id)}_${base}`,
              { userOwned: true }
            );
            lines.push(`[Attached file](${rel})\n\n`);
          }
        }
        lines.push(formatNoteBody(offSessionNoteBody(n)));
        if (n.explanation) {
          const exp = n.explanation.trim();
          if (exp) lines.push(`> ${exp.replace(/\n/g, "\n> ")}\n\n`);
        }
        if (n.source === "dictation") {
          lines.push("*Transcribed from dictation.*\n\n");
        }
      } else if (ev.kind === "img") {
        const { img } = ev;
        if (isRemoteMediaRef(img.path)) {
          const url = img.path.trim();
          const label = safePathToken(fileBasename(url)) || "screenshot";
          lines.push(`![${label}](${url})\n\n`);
        } else {
          const base = safePathToken(fileBasename(img.path));
          const rel = paths.forDisk(
            img.path,
            `off-session/images/${sessionShortId(img.id)}_${base}`
          );
          lines.push(`![Screenshot](${rel})\n\n`);
        }
      } else {
        const { vid } = ev;
        if (isRemoteMediaRef(vid.path)) {
          const url = vid.path.trim();
          lines.push(`[Screen recording](${url})\n\n`);
        } else {
          const base = safePathToken(fileBasename(vid.path));
          const rel = paths.forDisk(
            vid.path,
            `off-session/videos/${sessionShortId(vid.id)}_${base}`
          );
          lines.push(`[Screen recording](${rel})\n\n`);
        }
        const vTrans = offSessionVideoTranscription(vid);
        if (vTrans) lines.push(formatNoteBody(vTrans));
      }
    }
  }

  for (const session of a.sessions) {
    const sid = sessionShortId(session.id);
    const sessionTitle =
      session.name?.trim() || fmtDateOnly(session.startedAt);
    lines.push(`\n## Session: ${headingText(sessionTitle)}\n`);

    const sessionOpen =
      a.currentSessionId === session.id && !session.endedAt;
    const liveSnap =
      !session.endedAt && a.liveBySessionId[session.id]
        ? a.liveBySessionId[session.id]
        : undefined;
    const pendingOnly =
      sessionOpen &&
      liveSnap == null &&
      (a.livePendingTimelineBySession[session.id]?.length ?? 0) > 0;
    const pendingItems =
      a.livePendingTimelineBySession[session.id] ?? [];

    if (pendingOnly && !liveSnap && pendingItems.length > 0) {
      lines.push("\n### Before first focus\n\n");
      lines.push(
        emitReadableTimeline(
          pendingItems,
          paths,
          `sessions/${sid}/pending`
        )
      );
    }

    if (liveSnap) {
      const endedIso = a.exportedAtIso;
      const liveSeg = { ...liveSnap, endedAt: endedIso };
      if (
        segmentVisibleForExport(
          liveSeg,
          a.minDisplaySec,
          a.selfIdentity,
          pendingItems
        )
      ) {
        const app = headingText(segmentAppTitle(liveSnap));
        const win = segmentWindowSubtitle(liveSnap);
        const dur = fmtDurationMs(
          segmentDurationMs({ ...liveSnap, endedAt: endedIso })
        );
        lines.push(`\n### ${app}\n`);
        if (win) lines.push(`#### ${headingText(win)}\n`);
        lines.push(`*Time on this app:* ${dur}\n\n`);
        lines.push(
          emitReadableTimeline(
            pendingItems,
            paths,
            `sessions/${sid}/live`
          )
        );
      }
    }

    const closedChrono = sortSegmentsChrono(session.segments);
    for (const seg of closedChrono) {
      if (!seg.endedAt) continue;
      if (!segmentVisibleForExport(seg, a.minDisplaySec, a.selfIdentity)) {
        continue;
      }
      const app = headingText(segmentAppTitle(seg));
      const win = segmentWindowSubtitle(seg);
      const dur = fmtDurationMs(segmentDurationMs(seg));
      lines.push(`\n### ${app}\n`);
      if (win) lines.push(`#### ${headingText(win)}\n`);
      lines.push(`*Time on this app:* ${dur}\n\n`);
      lines.push(
        emitReadableTimeline(
          getSegmentTimeline(seg),
          paths,
          `sessions/${sid}/closed-${safePathToken(seg.startedAt)}`
        )
      );
    }
  }

  const markdown = lines.join("\n");
  return { markdown, mediaFiles: paths.mediaEntries() };
}
