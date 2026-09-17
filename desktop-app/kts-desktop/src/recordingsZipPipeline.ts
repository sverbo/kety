import { invoke } from "@tauri-apps/api/core";
import type {
  FocusSegment,
  OffSessionImage,
  OffSessionNote,
  OffSessionVideo,
  RecordingSelfIdentity,
  Session,
} from "./App";
import { isLinkNote } from "./contextNoteTypes";
import type { ContextTimelineItem } from "./contextTimeline";
import {
  getSegmentTimeline,
  timelineHasTextOrMedia,
} from "./contextTimeline";
import {
  buildRecordingsContextZipBundle,
  type RecordingsZipMediaEntry,
} from "./recordingsContextExport";
import type { PreparedUploadPayload } from "./uploadPrepareFilter";

type LiveFocusSnapshot = Omit<FocusSegment, "endedAt">;

function segmentDurationMs(seg: Pick<FocusSegment, "startedAt" | "endedAt">): number {
  const a = Date.parse(seg.startedAt);
  const b = Date.parse(seg.endedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return b - a;
}

/** Aligné sur l’UI Recording : masquer les segments courts vides sauf notes/captures. */
function shouldShowSegmentForZip(seg: FocusSegment, minDisplaySec: number): boolean {
  if (minDisplaySec <= 0) return true;
  if (timelineHasTextOrMedia(getSegmentTimeline(seg))) return true;
  return segmentDurationMs(seg) >= minDisplaySec * 1000;
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

function endedSessions(sessions: Session[]): Session[] {
  return sessions.filter((s) => Boolean(s.endedAt));
}

function filterSessionForFullExport(
  session: Session,
  minDisplaySec: number,
  self: RecordingSelfIdentity | null
): Session | null {
  const segs = session.segments.filter(
    (seg) => !isSelfKtsSegment(seg, self) && shouldShowSegmentForZip(seg, minDisplaySec)
  );
  if (segs.length === 0) return null;
  return { ...session, segments: segs };
}

export type RecordingZipBuildContextBase = {
  exportedAt: string;
  /** Optional batch title (upload UI or local export); stored in ZIP JSON and MD H1 when set. */
  title?: string | null;
  currentSessionId: string | null;
  recordingPaused: boolean;
  focusCaptureActive: boolean;
  selfIdentity: RecordingSelfIdentity | null;
  liveBySessionId: Record<string, LiveFocusSnapshot>;
  livePendingTimelineBySession: Record<string, ContextTimelineItem[]>;
  ocrTextByPath: Record<string, string>;
};

export type RecordingZipBuildContext =
  | ({
      mode: "full";
      settingsMinDisplaySec: number;
      allSessions: Session[];
      allOffNotes: OffSessionNote[];
      allOffImages: OffSessionImage[];
      allOffVideos: OffSessionVideo[];
    } & RecordingZipBuildContextBase)
  | ({
      mode: "clean";
      prepared: PreparedUploadPayload;
      prepareMinEmptySegmentSec: number;
    } & RecordingZipBuildContextBase);

export function buildZipExportBundle(ctx: RecordingZipBuildContext): {
  jsonString: string;
  markdown: string;
  mediaFiles: RecordingsZipMediaEntry[];
} {
  let sessions: Session[];
  let offNotes: OffSessionNote[];
  let offImages: OffSessionImage[];
  let offVideos: OffSessionVideo[];
  let minDisplayForMd: number;
  let variantDesc: string;
  let liveBy: Record<string, LiveFocusSnapshot>;
  let livePending: Record<string, ContextTimelineItem[]>;
  let currentSessionId: string | null;
  let recordingPaused: boolean;
  let focusCaptureActive: boolean;

  const titleForZip =
    ctx.title != null && String(ctx.title).trim() !== ""
      ? String(ctx.title).trim()
      : null;

  if (ctx.mode === "full") {
    minDisplayForMd = ctx.settingsMinDisplaySec;
    variantDesc = `Full export (Settings display threshold: ${minDisplayForMd}s)`;
    sessions = endedSessions(ctx.allSessions)
      .map((s) => filterSessionForFullExport(s, ctx.settingsMinDisplaySec, ctx.selfIdentity))
      .filter((s): s is Session => s != null);
    offNotes = ctx.allOffNotes;
    offImages = ctx.allOffImages;
    offVideos = ctx.allOffVideos;
    const allowed = new Set(sessions.map((s) => s.id));
    liveBy = {};
    for (const id of Object.keys(ctx.liveBySessionId)) {
      if (allowed.has(id)) liveBy[id] = ctx.liveBySessionId[id];
    }
    livePending = {};
    for (const id of Object.keys(ctx.livePendingTimelineBySession)) {
      if (allowed.has(id)) livePending[id] = ctx.livePendingTimelineBySession[id];
    }
    currentSessionId = ctx.currentSessionId;
    recordingPaused = ctx.recordingPaused;
    focusCaptureActive = ctx.focusCaptureActive;
  } else {
    minDisplayForMd = ctx.prepareMinEmptySegmentSec;
    variantDesc = `Prepare-aligned export (${minDisplayForMd}s empty threshold + Prepare exclusions)`;
    sessions = ctx.prepared.sessionsToUpload;
    offNotes = ctx.prepared.notesToUpload;
    offImages = ctx.prepared.imagesToUpload;
    offVideos = ctx.prepared.videosToUpload;
    liveBy = {};
    livePending = {};
    currentSessionId = null;
    recordingPaused = false;
    focusCaptureActive = false;
  }

  const exportArgs = {
    exportedAtIso: ctx.exportedAt,
    minDisplaySec: minDisplayForMd,
    currentSessionId,
    recordingPaused,
    focusCaptureActive,
    selfIdentity: ctx.selfIdentity,
    sessions,
    liveBySessionId: liveBy,
    livePendingTimelineBySession: livePending,
    offSessionNotes: offNotes,
    offSessionImages: offImages,
    offSessionVideos: offVideos,
    ocrTextByPath: ctx.ocrTextByPath,
    exportVariantDescription: variantDesc,
    title: titleForZip,
  };

  const { markdown, mediaFiles: bundleMediaFiles } = buildRecordingsContextZipBundle(exportArgs);

  // Document (`docSummary`) binaries are included via `buildRecordingsContextZipBundle` under
  // `artefacts/.../files/...` and `artefacts/off-session/files/...` (userOwned).

  const payload = {
    schemaVersion: 1 as const,
    title: titleForZip,
    exportedAt: ctx.exportedAt,
    exportVariant: ctx.mode,
    currentSessionId,
    recordingPaused,
    selfIdentity: ctx.selfIdentity,
    sessions,
    liveBySessionId: liveBy,
    livePendingTimelineBySession: livePending,
    offSessionNotes: offNotes,
    offSessionImages: offImages,
    offSessionVideos: offVideos,
    ocrTextByPath: ctx.ocrTextByPath,
  };
  const jsonString = JSON.stringify(payload, null, 2);

  return { jsonString, markdown, mediaFiles: bundleMediaFiles };
}

export async function saveRecordingZipToDownloads(
  ctx: RecordingZipBuildContext
): Promise<void> {
  const { jsonString, markdown, mediaFiles } = buildZipExportBundle(ctx);
  await invoke<string>("export_recordings_context_zip_cmd", {
    jsonContent: jsonString,
    markdownContent: markdown,
    mediaFiles,
    filename: "kety-captures.zip",
  });
}

// ── Captures-only ZIP export (no session segments) ────────────────────────────

export type CaptureExportEntry = {
  id: string;
  kind: "note" | "image" | "video";
  subKind: string | null;
  createdAt: string;
  rawText: string | null;
  explanation: string | null;
  appName: string | null;
  windowName: string | null;
  localPath: string | null;
  tagIds: string[] | null;
};

/**
 * Map in-memory captures (React state) onto the flat rows written into a captures ZIP.
 * Shared by every state-driven export path (Download a ZIP, Share a selection as a link) so
 * a shared archive always describes the captures exactly like a downloaded one.
 */
export function buildCaptureExportEntries(
  notes: OffSessionNote[],
  images: OffSessionImage[],
  videos: OffSessionVideo[],
): CaptureExportEntry[] {
  return [
    ...notes.map((n): CaptureExportEntry => ({
      id: n.id,
      kind: "note",
      subKind: (() => {
        if (n.source === "link" || isLinkNote(n.text)) return "url";
        if (n.kind === "document" && n.filePath) {
          const ext = n.filePath.split(".").pop()?.toLowerCase();
          if (ext === "pdf" || ext === "md" || ext === "txt") return ext;
        }
        return n.source ?? null;
      })(),
      createdAt: n.createdAt,
      rawText: n.kind === "document" ? (n.summary ?? null) : (n.text ?? null),
      explanation: n.explanation ?? null,
      appName: n.contextFocus?.appName ?? null,
      windowName: n.contextFocus?.windowName ?? null,
      localPath: n.filePath ?? null,
      tagIds: n.tagIds ?? null,
    })),
    ...images.map((i): CaptureExportEntry => ({
      id: i.id,
      kind: "image",
      subKind: "screenshot",
      createdAt: i.createdAt,
      rawText: i.ocr ?? null,
      explanation: i.explanation ?? null,
      appName: i.contextFocus?.appName ?? null,
      windowName: i.contextFocus?.windowName ?? null,
      localPath: i.path,
      tagIds: i.tagIds ?? null,
    })),
    ...videos.map((v): CaptureExportEntry => ({
      id: v.id,
      kind: "video",
      subKind: "screenRecording",
      createdAt: v.createdAt,
      rawText: v.transcription ?? null,
      explanation: v.explanation ?? null,
      appName: v.contextFocus?.appName ?? null,
      windowName: v.contextFocus?.windowName ?? null,
      localPath: v.path,
      tagIds: v.tagIds ?? null,
    })),
  ];
}

/**
 * Build a captures-only ZIP (no session segments) and save it to the Downloads folder.
 * Returns the path of the saved file.
 */
export async function saveCapturesZipToDownloads(
  entries: CaptureExportEntry[],
  exportedAt: string,
): Promise<string> {
  const mediaFiles: { diskPath: string; zipPath: string }[] = [];

  for (const entry of entries) {
    if (entry.localPath && (entry.kind === "image" || entry.kind === "video")) {
      const basename = entry.localPath.replace(/\\/g, "/").split("/").pop() ?? entry.id;
      const folder = entry.kind === "image" ? "images" : "videos";
      mediaFiles.push({ diskPath: entry.localPath, zipPath: `artefacts/${folder}/${basename}` });
    }
  }

  const payload = {
    schemaVersion: 1,
    exportedAt,
    captures: entries,
  };

  return invoke<string>("save_captures_zip_cmd", {
    jsonContent: JSON.stringify(payload, null, 2),
    mediaFiles,
  });
}

/**
 * Build a captures-only ZIP and write it to a temp file (not Downloads) — used to stage
 * a file for upload in the GCP share flow. Returns the temp file path.
 */
export async function buildCapturesZipToTemp(
  entries: CaptureExportEntry[],
  exportedAt: string,
): Promise<string> {
  const mediaFiles: { diskPath: string; zipPath: string }[] = [];

  for (const entry of entries) {
    if (entry.localPath && (entry.kind === "image" || entry.kind === "video")) {
      const basename = entry.localPath.replace(/\\/g, "/").split("/").pop() ?? entry.id;
      const folder = entry.kind === "image" ? "images" : "videos";
      mediaFiles.push({ diskPath: entry.localPath, zipPath: `artefacts/${folder}/${basename}` });
    }
  }

  const payload = {
    schemaVersion: 1,
    exportedAt,
    captures: entries,
  };

  return invoke<string>("build_captures_zip_to_temp_cmd", {
    jsonContent: JSON.stringify(payload, null, 2),
    mediaFiles,
  });
}

/**
 * Delete a temp ZIP previously created by {@link buildCapturesZipToTemp} once the share flow
 * is done with it (success, failure, or cancel) — the temp file is never cleaned up otherwise
 * and a batch with recordings can be multiple GB. Best-effort: errors are swallowed since this
 * is disk-space cleanup, not a user-facing operation.
 */
export async function deleteTempFile(path: string): Promise<void> {
  try {
    await invoke("delete_temp_file_cmd", { path });
  } catch (e) {
    console.warn("[recordingsZipPipeline] delete temp file failed:", e);
  }
}

/** Minimal context needed to build the cleaned-up capture ZIP. */
export type RecordingZipUploadContext = {
  selfIdentity: RecordingSelfIdentity | null;
  ocrTextByPath: Record<string, string>;
  prepareMinEmptySegmentSec: number;
};
