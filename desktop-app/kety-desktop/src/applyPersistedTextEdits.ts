/**
 * Applies Prepare / review text edits (content ids) to in-memory recording state for disk persistence.
 * Keys: `st|sessionId|segStartedAt|index`, `on|noteId`, `oi|imageId`.
 */

import type {
  OffSessionImage,
  OffSessionNote,
  Session,
} from "./App";
import { getSegmentTimeline } from "./contextTimeline";
import type { ContextTimelineItem } from "./contextTimeline";

function applyStEdit(sessions: Session[], key: string, value: string): Session[] {
  const re = /^st\|([^|]+)\|(.+)\|(\d+)$/;
  const m = key.match(re);
  if (!m) return sessions;
  const sessionId = m[1];
  const segStartedAt = m[2];
  const timelineIndex = parseInt(m[3], 10);
  if (Number.isNaN(timelineIndex)) return sessions;

  return sessions.map((s) => {
    if (s.id !== sessionId) return s;
    return {
      ...s,
      segments: s.segments.map((seg) => {
        if (seg.startedAt !== segStartedAt) return seg;
        const tl = getSegmentTimeline(seg).map((it) => ({ ...it })) as ContextTimelineItem[];
        const it = tl[timelineIndex];
        if (!it) return seg;
        if (it.kind === "text") {
          tl[timelineIndex] = { ...it, text: value };
        } else if (it.kind === "document") {
          tl[timelineIndex] = { ...it, summary: value };
        } else if (it.kind === "screenRecording") {
          tl[timelineIndex] = { ...it, transcription: value };
        } else {
          return seg;
        }
        return { ...seg, contextTimeline: tl };
      }),
    };
  });
}

function applyOnEdit(notes: OffSessionNote[], key: string, value: string): OffSessionNote[] {
  if (!key.startsWith("on|")) return notes;
  const id = key.slice(3);
  return notes.map((n) => {
    if (n.id !== id) return n;
    if (n.kind === "document") return { ...n, summary: value };
    return { ...n, text: value };
  });
}

function applyOiEdit(
  images: OffSessionImage[],
  ocrMap: Record<string, string>,
  key: string,
  value: string
): { images: OffSessionImage[]; ocrMap: Record<string, string> } {
  if (!key.startsWith("oi|")) return { images, ocrMap };
  const id = key.slice(3);
  const nextImages = images.map((im) => (im.id === id ? { ...im, ocr: value } : im));
  const im = images.find((i) => i.id === id);
  const nextOcr = { ...ocrMap };
  if (im) nextOcr[im.path] = value;
  return { images: nextImages, ocrMap: nextOcr };
}

export function applyPersistedTextEditsToStores(
  sessions: Session[],
  offNotes: OffSessionNote[],
  offImages: OffSessionImage[],
  ocrTextByPath: Record<string, string>,
  edits: ReadonlyMap<string, string>
): {
  sessions: Session[];
  offNotes: OffSessionNote[];
  offImages: OffSessionImage[];
  ocrTextByPath: Record<string, string>;
} {
  let outSessions = sessions;
  let outNotes = offNotes;
  let outImages = offImages;
  let outOcr = { ...ocrTextByPath };

  for (const [key, value] of edits) {
    if (key.startsWith("st|")) {
      outSessions = applyStEdit(outSessions, key, value);
    } else if (key.startsWith("on|")) {
      outNotes = applyOnEdit(outNotes, key, value);
    } else if (key.startsWith("oi|")) {
      const r = applyOiEdit(outImages, outOcr, key, value);
      outImages = r.images;
      outOcr = r.ocrMap;
    }
  }

  return {
    sessions: outSessions,
    offNotes: outNotes,
    offImages: outImages,
    ocrTextByPath: outOcr,
  };
}
