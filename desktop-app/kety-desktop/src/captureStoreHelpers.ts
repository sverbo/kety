import { parseContextNoteSource, isLinkNote } from "./contextNoteTypes";
import type { LocalSaveCaptureReq, LocalCaptureRow } from "./localIndex";
import type {
  OffSessionNote,
  OffSessionImage,
  OffSessionVideo,
  DictationHistoryInject,
  WindowBounds,
  OffSessionContextFocus,
} from "./appTypes";
import { OPENAI_MODEL_PREFIX } from "./openaiTextModelOptions";

export function noteToSaveReq(note: OffSessionNote, userId: string): LocalSaveCaptureReq {
  const meta = JSON.stringify({
    contextFocus: note.contextFocus,
    lang: note.lang,
    summary: note.summary,
    fileSize: note.fileSize,
  });
  return {
    id: note.id,
    userId,
    rawText: note.kind === "document" ? (note.summary ?? null) : (note.text ?? null),
    explanation: note.explanation ?? null,
    title: null,
    kind: note.kind === "document" ? "document" : "note",
    subKind: (() => {
      if (note.source === "link" || isLinkNote(note.text)) return "url";
      if (note.kind === "document" && note.filePath) {
        const ext = note.filePath.split(".").pop()?.toLowerCase();
        if (ext === "pdf" || ext === "md" || ext === "txt") return ext;
      }
      return note.source ?? null;
    })(),
    localPath: note.filePath ?? null,
    tagIds: note.tagIds ?? null,
    sensitiveState: note.sensitiveVerdict ?? "normal",
    createdAt: note.createdAt,
    meta,
    appName: note.contextFocus?.appName ?? null,
    windowName: note.contextFocus?.windowName ?? null,
    sizeKb: note.fileSize != null ? Math.ceil(note.fileSize / 1024) : null,
    processDocIndexDoc: note.process_doc_index_doc ?? null,
    indexMeetRawTranscript: note.indexMeetRawTranscript ?? null,
  };
}

export function imageToSaveReq(img: OffSessionImage, userId: string): LocalSaveCaptureReq {
  const meta = JSON.stringify({ contextFocus: img.contextFocus, fileSize: img.fileSize });
  return {
    id: img.id,
    userId,
    rawText: img.ocr ?? null,
    explanation: img.explanation ?? null,
    title: null,
    kind: "image",
    subKind: "screenshot",
    localPath: img.path,
    tagIds: img.tagIds ?? null,
    sensitiveState: img.sensitiveVerdict ?? "normal",
    createdAt: img.createdAt,
    meta,
    appName: img.contextFocus?.appName ?? null,
    windowName: img.contextFocus?.windowName ?? null,
    sizeKb: img.fileSize != null ? Math.ceil(img.fileSize / 1024) : null,
    ketyServerPath: img.gcsPath ?? null,
  };
}

export function videoToSaveReq(vid: OffSessionVideo, userId: string): LocalSaveCaptureReq {
  const meta = JSON.stringify({ contextFocus: vid.contextFocus, lang: vid.lang, thumbnailPath: vid.thumbnailPath, fileSize: vid.fileSize });
  return {
    id: vid.id,
    userId,
    rawText: vid.transcription ?? null,
    explanation: vid.explanation ?? null,
    title: null,
    kind: "video",
    subKind: "screenRecording",
    localPath: vid.path,
    tagIds: vid.tagIds ?? null,
    sensitiveState: vid.sensitiveVerdict ?? "normal",
    createdAt: vid.createdAt,
    meta,
    appName: vid.contextFocus?.appName ?? null,
    windowName: vid.contextFocus?.windowName ?? null,
    sizeKb: vid.fileSize != null ? Math.ceil(vid.fileSize / 1024) : null,
    ketyServerPath: vid.gcsPath ?? null,
  };
}

export function captureRowsToOffSession(rows: LocalCaptureRow[]): {
  notes: OffSessionNote[];
  images: OffSessionImage[];
  videos: OffSessionVideo[];
  ocrMap: Record<string, string>;
} {
  const notes: OffSessionNote[] = [];
  const images: OffSessionImage[] = [];
  const videos: OffSessionVideo[] = [];
  const ocrMap: Record<string, string> = {};

  for (const row of rows) {
    const tagIds = row.tagIds ? (() => { try { return JSON.parse(row.tagIds!) as string[]; } catch { return undefined; } })() : undefined;
    const sv = row.sensitiveState !== "normal" ? row.sensitiveState as OffSessionNote["sensitiveVerdict"] : undefined;
    let meta: Record<string, unknown> = {};
    if (row.meta) { try { meta = JSON.parse(row.meta) as Record<string, unknown>; } catch { /* ignore */ } }
    let contextFocus = meta.contextFocus as OffSessionNote["contextFocus"] | undefined;
    // Enrich contextFocus with explicit columns (populated for rows saved after this migration)
    if (row.appName || row.windowName) {
      contextFocus = {
        appName: row.appName ?? contextFocus?.appName ?? null,
        windowName: row.windowName ?? contextFocus?.windowName ?? null,
        bundleId: contextFocus?.bundleId ?? null,
        processId: contextFocus?.processId ?? 0,
        appHidden: contextFocus?.appHidden ?? false,
        activationPolicy: contextFocus?.activationPolicy ?? 0,
        bundlePath: contextFocus?.bundlePath ?? null,
        executablePath: contextFocus?.executablePath ?? null,
        windowNumber: contextFocus?.windowNumber ?? null,
        windowOwnerName: contextFocus?.windowOwnerName ?? null,
        windowLayer: contextFocus?.windowLayer ?? null,
        windowBounds: contextFocus?.windowBounds ?? null,
        windowAlpha: contextFocus?.windowAlpha ?? null,
      };
    }

    if (row.kind === "image") {
      if (!row.localPath) continue;
      if (row.rawText) ocrMap[row.localPath] = row.rawText;
      images.push({
        id: row.id,
        path: row.localPath,
        createdAt: row.createdAt ?? new Date().toISOString(),
        mediaKind: "image",
        ...(row.rawText ? { ocr: row.rawText } : {}),
        ...(row.explanation ? { explanation: row.explanation } : {}),
        ...(contextFocus ? { contextFocus } : {}),
        ...(tagIds?.length ? { tagIds } : {}),
        ...(sv ? { sensitiveVerdict: sv } : {}),
        ...(row.sizeMediaKb != null ? { fileSize: row.sizeMediaKb * 1024 } : typeof meta.fileSize === "number" ? { fileSize: meta.fileSize as number } : {}),
        ...(row.ketyServerPath ? { gcsPath: row.ketyServerPath } : {}),
        ...(row.indexState ? { indexState: row.indexState } : {}),
        ...(row.indexError ? { indexError: row.indexError } : {}),
      });
    } else if (row.kind === "video") {
      if (!row.localPath) continue;
      videos.push({
        id: row.id,
        path: row.localPath,
        createdAt: row.createdAt ?? new Date().toISOString(),
        mediaKind: "video",
        ...(row.rawText ? { transcription: row.rawText } : {}),
        ...(row.explanation ? { explanation: row.explanation } : {}),
        ...(contextFocus ? { contextFocus } : {}),
        ...(typeof meta.lang === "string" ? { lang: meta.lang } : {}),
        ...(typeof meta.thumbnailPath === "string" ? { thumbnailPath: meta.thumbnailPath } : {}),
        ...(tagIds?.length ? { tagIds } : {}),
        ...(sv ? { sensitiveVerdict: sv } : {}),
        ...(row.sizeMediaKb != null ? { fileSize: row.sizeMediaKb * 1024 } : typeof meta.fileSize === "number" ? { fileSize: meta.fileSize as number } : {}),
        ...(row.ketyServerPath ? { gcsPath: row.ketyServerPath } : {}),
        ...(row.indexState ? { indexState: row.indexState } : {}),
        ...(row.indexError ? { indexError: row.indexError } : {}),
      });
    } else {
      // note or document
      const source = row.subKind ? parseContextNoteSource(row.subKind) : undefined;
      if (row.kind === "document") {
        const summary = (typeof meta.summary === "string" ? meta.summary : null) ?? row.rawText ?? "";
        if (!summary.trim() && !row.localPath) continue;
        notes.push({
          id: row.id,
          kind: "document",
          summary: summary.trim(),
          createdAt: row.createdAt ?? new Date().toISOString(),
          ...(row.explanation ? { explanation: row.explanation } : {}),
          ...(contextFocus ? { contextFocus } : {}),
          ...(row.localPath ? { filePath: row.localPath } : {}),
          ...(row.sizeMediaKb != null ? { fileSize: row.sizeMediaKb * 1024 } : row.sizeKb != null ? { fileSize: row.sizeKb * 1024 } : typeof meta.fileSize === "number" ? { fileSize: meta.fileSize as number } : {}),
          ...(typeof meta.lang === "string" ? { lang: meta.lang } : {}),
          mediaKind: "file",
          ...(tagIds?.length ? { tagIds } : {}),
          ...(sv ? { sensitiveVerdict: sv } : {}),
          ...(row.processDocIndexDoc != null ? { process_doc_index_doc: row.processDocIndexDoc } : {}),
          ...(row.indexState ? { indexState: row.indexState } : {}),
          ...(row.indexError ? { indexError: row.indexError } : {}),
        });
      } else {
        if (!row.rawText) continue;
        notes.push({
          id: row.id,
          text: row.rawText,
          createdAt: row.createdAt ?? new Date().toISOString(),
          ...(row.explanation ? { explanation: row.explanation } : {}),
          ...(source ? { source } : {}),
          ...(contextFocus ? { contextFocus } : {}),
          ...(typeof meta.lang === "string" ? { lang: meta.lang } : {}),
          ...(tagIds?.length ? { tagIds } : {}),
          ...(sv ? { sensitiveVerdict: sv } : {}),
          ...(row.indexMeetRawTranscript != null ? { indexMeetRawTranscript: row.indexMeetRawTranscript } : {}),
          ...(row.indexState ? { indexState: row.indexState } : {}),
          ...(row.indexError ? { indexError: row.indexError } : {}),
        });
      }
    }
  }
  return { notes, images, videos, ocrMap };
}

export function isValidTagSensitiveScanModel(v: string): boolean {
  return (
    v === "disabled" ||
    v === "local" ||
    v.startsWith("local:") ||
    v.startsWith(OPENAI_MODEL_PREFIX)
  );
}

/** Legacy stores had separate `sensitiveScanModel` and `autoTagModel`; one row now uses `sensitiveScanModel` only. */
export function mergeTagSensitiveModelsOnLoad(sens: string | undefined, tag: string | undefined): string {
  const s = sens && isValidTagSensitiveScanModel(sens) ? sens : undefined;
  const t = tag && isValidTagSensitiveScanModel(tag) ? tag : undefined;
  if (s != null) return s;
  if (t != null) return t;
  return "disabled";
}

export function pruneCopyHistoryNotesByRetention(notes: OffSessionNote[], maxAgeMs: number | null): OffSessionNote[] {
  if (maxAgeMs == null) return notes;
  const cutoff = Date.now() - maxAgeMs;
  return notes.filter((n) => {
    const t = Date.parse(n.createdAt);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

export function pruneDictationHistoryInjectsByRetention(
  items: DictationHistoryInject[],
  maxAgeMs: number | null,
): DictationHistoryInject[] {
  if (maxAgeMs == null) return items;
  const cutoff = Date.now() - maxAgeMs;
  return items.filter((d) => {
    const t = Date.parse(d.createdAt);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

export function parseOffSessionContextFocus(raw: unknown): OffSessionContextFocus | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const wbRaw = o.windowBounds;
  let windowBounds: WindowBounds | null = null;
  if (wbRaw != null && typeof wbRaw === "object" && !Array.isArray(wbRaw)) {
    const w = wbRaw as Record<string, unknown>;
    const num = (v: unknown): number => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : NaN;
      }
      return NaN;
    };
    const x = num(w.x);
    const y = num(w.y);
    const width = num(w.width);
    const height = num(w.height);
    if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(width) && !Number.isNaN(height)) {
      windowBounds = { x, y, width, height };
    }
  }
  const optStr = (v: unknown): string | null =>
    v == null ? null : typeof v === "string" ? v : String(v);
  const optI32 = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
  const optF64 = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const processId =
    typeof o.processId === "number" && Number.isFinite(o.processId)
      ? Math.trunc(o.processId)
      : 0;
  return {
    appName: optStr(o.appName),
    bundleId: optStr(o.bundleId),
    processId,
    appHidden: o.appHidden === true,
    activationPolicy:
      typeof o.activationPolicy === "number" && Number.isFinite(o.activationPolicy)
        ? Math.trunc(o.activationPolicy)
        : 0,
    bundlePath: optStr(o.bundlePath),
    executablePath: optStr(o.executablePath),
    windowNumber: optI32(o.windowNumber),
    windowName: optStr(o.windowName),
    windowOwnerName: optStr(o.windowOwnerName),
    windowLayer: optI32(o.windowLayer),
    windowBounds,
    windowAlpha: optF64(o.windowAlpha),
  };
}
