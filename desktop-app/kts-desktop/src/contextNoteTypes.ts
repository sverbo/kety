/** Matches Rust `ContextNoteSource` (JSON uses lowercase except `screenRecording`, `copyHistory`). */
export type ContextNoteSource =
  | "highlight"
  | "clipboard"
  | "copyHistory"
  | "manual"
  | "dictation"
  | "screenRecording"
  | "googleMeet"
  | "textTransform"
  | "link";

export function parseContextNoteSource(raw: unknown): ContextNoteSource {
  if (
    raw === "highlight" ||
    raw === "clipboard" ||
    raw === "copyHistory" ||
    raw === "manual" ||
    raw === "dictation" ||
    raw === "screenRecording" ||
    raw === "googleMeet" ||
    raw === "textTransform" ||
    raw === "link"
  ) {
    return raw;
  }
  return "manual";
}

/** Returns true if the note text is a bare URL (http/https, no whitespace). */
export function isLinkNote(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return /^https?:\/\/\S+$/.test(t);
}

export type ContextNoteItem = {
  text: string;
  explanation?: string;
  source: ContextNoteSource;
  filePath?: string;
  fileSize?: number;
};

function attachmentPathFromRaw(raw: Record<string, unknown>): string | undefined {
  const primary = raw.filePath ?? raw.path ?? raw.fileUrl;
  if (typeof primary === "string" && primary.trim()) return primary.trim();
  return undefined;
}

/** Une entrée depuis le store ou Rust ; les anciennes sessions n’avaient que des chaînes. */
export function normalizeContextNoteItem(raw: unknown): ContextNoteItem | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    return { text: t, source: "manual" };
  }
  if (raw != null && typeof raw === "object" && "text" in raw) {
    const o = raw as Record<string, unknown>;
    const t = o.text;
    if (typeof t !== "string") return null;
    const trimmed = t.trim();
    if (!trimmed) return null;
    const rawExp = o.explanation;
    const explanation =
      typeof rawExp === "string" && rawExp.trim() ? rawExp.trim() : undefined;
    const filePath = attachmentPathFromRaw(o);
    const rawFs = o.fileSize;
    const fileSize =
      typeof rawFs === "number" && Number.isFinite(rawFs) && rawFs > 0 ? rawFs : undefined;
    return {
      text: trimmed,
      ...(explanation !== undefined ? { explanation } : {}),
      source: parseContextNoteSource(o.source),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(fileSize !== undefined ? { fileSize } : {}),
    };
  }
  return null;
}

export function normalizeContextNotesArray(raw: unknown): ContextNoteItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeContextNoteItem)
    .filter((x): x is ContextNoteItem => x != null);
}
