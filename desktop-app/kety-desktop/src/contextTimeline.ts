import type { ContextNoteItem, ContextNoteSource } from "./contextNoteTypes";
import {
  normalizeContextNoteItem,
  parseContextNoteSource,
} from "./contextNoteTypes";

/**
 * Lignes de `contextTimeline` dans un segment :
 *
 * - **`kind`** : `text` (note / dictée / presse-papiers…), `document` (résumé + fichier), `screenshot`, `screenRecording`.
 * - Pour `text`, **`source`** précise la provenance. Les **`document`** n’ont pas de `source` (le kind suffit).
 * - Corps principal : `text` | `summary` | `ocr` | `transcription` selon le kind.
 * - **`lang`** : optionnel (dictée, enregistrement écran, document, OCR)  stocké pour usage futur.
 */

/** Segment enregistré (évite import circulaire avec `App.tsx`). */
export type SegmentContextLike = {
  contextTimeline?: unknown;
  contextNotes?: unknown;
  contextImagePaths?: unknown;
};

/** Aligné sur `ContextTimelineItem` (Rust) - ordre d’arrivée dans le segment. */
export type ContextTimelineItem =
  | {
      kind: "text";
      text: string;
      explanation?: string;
      source: ContextNoteSource;
      lang?: string;
      /** Aligné sur Rust `clientId` : identifiant stable (ex. flux Meet). */
      clientId?: string;
    }
  | {
      kind: "document";
      summary: string;
      filePath: string;
      explanation?: string;
      lang?: string;
      fileSize?: number;
      process_doc_index_doc?: boolean;
    }
  | {
      kind: "screenshot";
      path: string;
      explanation?: string;
      ocr?: string;
      lang?: string;
    }
  | {
      kind: "screenRecording";
      path: string;
      transcription: string;
      appName?: string;
      thumbnailPath?: string;
      explanation?: string;
      lang?: string;
    };

function parseLangField(o: Record<string, unknown>): string | undefined {
  const raw = o.lang;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return raw.trim();
}

export function normalizeContextTimelineItem(raw: unknown): ContextTimelineItem | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const k = o.kind;
  const lang = parseLangField(o);

  if (k === "document") {
    const summRaw = o.summary ?? o.text;
    if (typeof summRaw !== "string") return null;
    const summary = summRaw.trim();
    if (!summary) return null;
    const rawPath = o.filePath ?? o.path ?? o.fileUrl;
    if (typeof rawPath !== "string" || !rawPath.trim()) return null;
    const filePath = rawPath.trim();
    const rawExp = o.explanation;
    const explanation =
      typeof rawExp === "string" && rawExp.trim() ? rawExp.trim() : undefined;
    const rawFs = o.fileSize;
    const fileSize =
      typeof rawFs === "number" && Number.isFinite(rawFs) && rawFs > 0 ? rawFs : undefined;
    return {
      kind: "document",
      summary,
      filePath,
      ...(explanation !== undefined ? { explanation } : {}),
      ...(lang !== undefined ? { lang } : {}),
      ...(fileSize !== undefined ? { fileSize } : {}),
      ...(o.process_doc_index_doc === false ? { process_doc_index_doc: false } : {}),
    };
  }

  if (k === "text") {
    const text = o.text;
    if (typeof text !== "string") return null;
    const t = text.trim();
    if (!t) return null;
    const rawExp = o.explanation;
    const explanation =
      typeof rawExp === "string" && rawExp.trim() ? rawExp.trim() : undefined;
    const src = parseContextNoteSource(o.source);
    const rawCid = o.clientId;
    const clientId =
      typeof rawCid === "string" && rawCid.trim() ? rawCid.trim() : undefined;
    return {
      kind: "text",
      text: t,
      ...(explanation !== undefined ? { explanation } : {}),
      source: src,
      ...(lang !== undefined ? { lang } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    };
  }
  if (k === "screenshot") {
    const pathRaw = o.path ?? o.url;
    if (typeof pathRaw !== "string" || !pathRaw.trim()) return null;
    const path = pathRaw.trim();
    const exp = typeof o.explanation === "string" && o.explanation.trim() ? o.explanation.trim() : undefined;
    const ocrRaw = o.ocr ?? o.description;
    const ocr = typeof ocrRaw === "string" && ocrRaw.trim() ? ocrRaw.trim() : undefined;
    return {
      kind: "screenshot",
      path,
      ...(exp ? { explanation: exp } : {}),
      ...(ocr ? { ocr } : {}),
      ...(lang !== undefined ? { lang } : {}),
    };
  }
  if (k === "screenRecording") {
    const pathRaw = o.path ?? o.url;
    const transRaw = o.transcription ?? o.description;
    if (typeof pathRaw !== "string" || !pathRaw.trim()) return null;
    const path = pathRaw.trim();
    if (typeof transRaw !== "string") return null;
    const transcription = transRaw.trim();
    const appName = typeof o.appName === "string" ? o.appName : undefined;
    const thumbnailPath = typeof o.thumbnailPath === "string" ? o.thumbnailPath : undefined;
    const exp = typeof o.explanation === "string" && o.explanation.trim() ? o.explanation.trim() : undefined;
    return {
      kind: "screenRecording",
      path,
      transcription,
      ...(appName !== undefined ? { appName } : {}),
      ...(thumbnailPath !== undefined ? { thumbnailPath } : {}),
      ...(exp ? { explanation: exp } : {}),
      ...(lang !== undefined ? { lang } : {}),
    };
  }
  return null;
}

export function normalizeContextTimelineArray(raw: unknown): ContextTimelineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeContextTimelineItem)
    .filter((x): x is ContextTimelineItem => x != null);
}

/** Ancien format : notes puis captures (ordre partiel). */
export function migrateLegacySegmentContext(seg: SegmentContextLike): ContextTimelineItem[] {
  const out: ContextTimelineItem[] = [];
  const rawNotes = seg.contextNotes;
  const notes = Array.isArray(rawNotes) ? rawNotes : [];
  for (const n of notes) {
    const it = normalizeContextNoteItem(n);
    if (it) {
      out.push({
        kind: "text",
        text: it.text,
        source: it.source,
      });
    }
  }
  const rawPaths = seg.contextImagePaths;
  const paths = Array.isArray(rawPaths) ? rawPaths : [];
  for (const p of paths) {
    if (typeof p === "string" && p.trim()) out.push({ kind: "screenshot", path: p.trim() });
  }
  return out;
}

export function getSegmentTimeline(seg: SegmentContextLike): ContextTimelineItem[] {
  const tl = seg.contextTimeline;
  if (Array.isArray(tl) && tl.length > 0) {
    return normalizeContextTimelineArray(tl);
  }
  return migrateLegacySegmentContext(seg);
}

export function collectMediaPathsFromTimeline(items: ContextTimelineItem[]): string[] {
  const paths: string[] = [];
  for (const it of items) {
    if (it.kind === "screenshot" || it.kind === "screenRecording") paths.push(it.path);
    if (it.kind === "document") paths.push(it.filePath);
  }
  return paths;
}

export function collectMediaPathsFromSegment(seg: SegmentContextLike): string[] {
  return collectMediaPathsFromTimeline(getSegmentTimeline(seg));
}

export function timelineHasTextOrMedia(items: ContextTimelineItem[]): boolean {
  for (const it of items) {
    if (it.kind === "text" || it.kind === "document") return true;
    if (it.kind === "screenshot" || it.kind === "screenRecording") return true;
  }
  return false;
}

export function countTextNotesInTimeline(items: ContextTimelineItem[]): number {
  return items.filter((x) => x.kind === "text" || x.kind === "document").length;
}

/** Pour l’export JSON : source « historique » distincte (clipboard vs sélection Accessibilité). */
export function historySourceForExport(item: ContextTimelineItem): string {
  switch (item.kind) {
    case "text":
      switch (item.source) {
        case "clipboard":
          return "clipboardPaste";
        case "copyHistory":
          return "copyHistory";
        case "highlight":
          return "accessibilitySelection";
        case "manual":
          return "manualEntry";
        case "dictation":
          return "dictation";
        case "screenRecording":
          return "screenRecordingTranscript";
        case "googleMeet":
          return "googleMeetCaptions";
        default:
          return "text";
      }
    case "document":
      return "document";
    case "screenshot":
      return "screenshot";
    case "screenRecording":
      return "screenRecording";
  }
}

export function timelineItemToNoteItem(it: ContextTimelineItem): ContextNoteItem | null {
  if (it.kind !== "text") return null;
  return {
    text: it.text,
    source: it.source,
    ...(it.explanation !== undefined ? { explanation: it.explanation } : {}),
  };
}

/** Contenu principal (description produit) : note, résumé document, OCR, ou transcription. */
export function timelineItemDescription(it: ContextTimelineItem): string {
  switch (it.kind) {
    case "text":
      return it.text;
    case "document":
      return it.summary;
    case "screenshot":
      return (it.ocr ?? "").trim();
    case "screenRecording":
      return (it.transcription ?? "").trim();
  }
}

/** Note utilisateur optionnelle - même sens pour tous les types de ligne. */
export function timelineItemExplanation(it: ContextTimelineItem): string | undefined {
  const e = it.explanation?.trim();
  return e || undefined;
}

/** Libellé court de type pour l’UI (History, etc.). */
export function timelineItemTypeLabel(it: ContextTimelineItem): string {
  switch (it.kind) {
    case "text":
      switch (it.source) {
        case "clipboard":
          return "Clipboard";
        case "copyHistory":
          return "Copy history";
        case "highlight":
          return "Highlight";
        case "dictation":
          return "Dictation";
        case "screenRecording":
          return "Transcript";
        case "googleMeet":
          return "Google Meet";
        case "manual":
        default:
          return "Note";
      }
    case "document":
      return "Document";
    case "screenshot":
      return "Screenshot";
    case "screenRecording":
      return "Screen recording";
  }
}

/** Chemin fichier média (tous les kinds sauf `text`). */
export function timelineMediaPath(it: ContextTimelineItem): string | undefined {
  if (it.kind === "screenshot" || it.kind === "screenRecording") return it.path;
  if (it.kind === "document") return it.filePath;
  return undefined;
}
