import type { ReactNode } from "react";
import type { UploadFocusContentLine } from "./uploadPrepareFilter";

/**
 * Wraps case-insensitive matches of `rawQuery` in `<mark class="upload-focus-search-hit">`.
 */
export function highlightSearchTerm(text: string, rawQuery: string): ReactNode {
  const q = rawQuery.trim();
  if (!q) return text;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${esc})`, "gi"));
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={`m-${i}`} className="upload-focus-search-hit">
            {part}
          </mark>
        ) : (
          <span key={`t-${i}`}>{part}</span>
        )
      )}
    </>
  );
}

export function textMatchesSearch(haystack: string, rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (!q) return false;
  return haystack.toLowerCase().includes(q.toLowerCase());
}

/** Case-insensitive, non-overlapping occurrences of `rawQuery` in `haystack` (trimmed query). */
export function countSearchOccurrences(haystack: string, rawQuery: string): number {
  const q = rawQuery.trim();
  if (!q || !haystack) return 0;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc, "gi");
  let c = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    c += 1;
    if (m[0].length === 0) break;
  }
  return c;
}

/** Whether any visible field on the line matches the search (case-insensitive). */
export function uploadFocusLineMatchesSearch(
  line: UploadFocusContentLine,
  rawQuery: string,
  opts?: { textDraft?: string }
): boolean {
  const q = rawQuery.trim();
  if (!q) return false;
  const editable =
    line.editTextId != null &&
    (line.kind === "text" || line.kind === "screenRecording");
  if (editable && opts?.textDraft !== undefined) {
    const blobs = [opts.textDraft, line.detail ?? "", line.mediaPath ?? ""];
    return blobs.some((p) => textMatchesSearch(p, q));
  }
  const blobs = [
    line.preview,
    line.fullText ?? "",
    line.fullTranscription ?? "",
    line.detail ?? "",
    line.mediaPath ?? "",
  ];
  return blobs.some((p) => textMatchesSearch(p, q));
}

/** Same fields as {@link uploadFocusLineMatchesSearch}; sums occurrence counts (may double if text repeats across fields). */
export function countUploadFocusLineSearchOccurrences(
  line: UploadFocusContentLine,
  rawQuery: string,
  opts?: { textDraft?: string }
): number {
  const q = rawQuery.trim();
  if (!q) return 0;
  const editable =
    line.editTextId != null &&
    (line.kind === "text" || line.kind === "screenRecording");
  if (editable && opts?.textDraft !== undefined) {
    return (
      countSearchOccurrences(opts.textDraft, q) +
      countSearchOccurrences(line.detail ?? "", q) +
      countSearchOccurrences(line.mediaPath ?? "", q)
    );
  }
  return (
    countSearchOccurrences(line.preview, q) +
    countSearchOccurrences(line.fullText ?? "", q) +
    countSearchOccurrences(line.fullTranscription ?? "", q) +
    countSearchOccurrences(line.detail ?? "", q) +
    countSearchOccurrences(line.mediaPath ?? "", q)
  );
}
