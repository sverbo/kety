import { useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ContextSourceIcon, DocumentContextIcon } from "./ContextSourceIcon";
import { isLinkNote } from "./contextNoteTypes";
import { NoteChip, MediaChip } from "./SegmentContextBlock";
import type { OffSessionNote, OffSessionVideo, DetailedSourceType, ContextNoteItem } from "./appTypes";
import { IconPhoto, IconVideoCamera } from "./AppIcons";

export function offSessionNoteBody(n: OffSessionNote): string {
  if (n.kind === "document") return n.summary ?? "";
  return n.text ?? "";
}

export function formatDurationMs(startedAt: string, endedAt: string): string {
  const a = Date.parse(startedAt);
  const b = Date.parse(endedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "-";
  const sec = Math.round((b - a) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export function formatSessionDateTime(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return "-";
  return new Date(d).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function localDateStr(isoUtc: string): string {
  const d = new Date(isoUtc);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtBytes(b: number): string {
  if (b <= 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function IconLink() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" className="context-source-icon" aria-hidden>
      <path d="M6.5 9.5a4 4 0 0 0 5.657 0l1.414-1.414a4 4 0 0 0-5.657-5.657L7.5 3.843" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9.5 6.5a4 4 0 0 0-5.657 0L2.43 7.914a4 4 0 0 0 5.657 5.657l.414-.414" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function ContextNoteChipRow({
  note,
  useDocumentIcon,
  highlightTerm,
  onSave,
  onDelete,
  onOpenFile,
  downloadPath,
  processEnabled,
  onToggleProcess,
  meetRawIndexEnabled,
  onToggleMeetRawIndex,
  itemKey,
  selectedIds,
  onToggleSelect,
}: {
  note: ContextNoteItem;
  useDocumentIcon?: boolean;
  highlightTerm?: string;
  onSave?: (text: string, explanation: string) => void;
  onDelete?: () => void;
  onOpenFile?: () => void;
  /** Local file behind this note; when set, a "copy to Downloads" button is shown. */
  downloadPath?: string | null;
  processEnabled?: boolean;
  onToggleProcess?: () => void;
  meetRawIndexEnabled?: boolean;
  onToggleMeetRawIndex?: () => void;
  itemKey?: string;
  selectedIds?: Set<string>;
  onToggleSelect?: (key: string) => void;
}) {
  const isLink = note.source === "link" || isLinkNote(note.text);
  const icon = useDocumentIcon
    ? <DocumentContextIcon />
    : isLink
      ? <IconLink />
      : <ContextSourceIcon source={note.source} />;
  const openAction = useDocumentIcon && onOpenFile
    ? onOpenFile
    : isLink
      ? () => void openUrl(note.text.trim()).catch(console.error)
      : undefined;
  return (
    <NoteChip
      icon={icon}
      text={note.text}
      explanation={note.explanation}
      highlightTerm={highlightTerm}
      onSave={onSave}
      onDelete={onDelete}
      onOpenFile={openAction}
      downloadPath={downloadPath}
      processEnabled={processEnabled}
      onToggleProcess={onToggleProcess}
      meetRawIndexEnabled={meetRawIndexEnabled}
      onToggleMeetRawIndex={onToggleMeetRawIndex}
      itemKey={itemKey}
      selectedIds={selectedIds}
      onToggleSelect={onToggleSelect}
    />
  );
}

function fileBaseName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function IconMissingFile() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
      <path d="m10 13 4 4M14 13l-4 4" />
    </svg>
  );
}

/** Shown in place of a thumbnail when the capture's file is no longer on this computer. */
function MissingFileThumb({ path }: { path: string }) {
  const name = fileBaseName(path);
  return (
    <div
      className="context-image-thumb"
      style={{
        cursor: "default",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "14px 10px",
        minWidth: 120,
        textAlign: "center",
        opacity: 0.75,
      }}
    >
      <IconMissingFile />
      <span
        title={name}
        style={{
          fontSize: 11,
          fontWeight: 600,
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      <span style={{ fontSize: 10.5, lineHeight: 1.35 }}>File not available on this computer.</span>
    </div>
  );
}

function ImageThumbButton({
  path,
  onOpenViewer,
}: {
  path: string;
  onOpenViewer?: (path: string, kind: "image" | "video") => void;
}) {
  const [missing, setMissing] = useState(false);
  if (missing) return <MissingFileThumb path={path} />;
  return (
    <button
      type="button"
      className="context-image-thumb"
      title={onOpenViewer ? "Click to view" : "Click to open screenshot in default app"}
      onClick={() => {
        if (onOpenViewer) onOpenViewer(path, "image");
        else void openPath(path).catch(console.error);
      }}
    >
      <img
        src={convertFileSrc(path)}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setMissing(true)}
      />
    </button>
  );
}

function VideoThumbButton({
  video,
  onOpenViewer,
}: {
  video: OffSessionVideo;
  onOpenViewer?: (path: string, kind: "image" | "video") => void;
}) {
  // A missing poster image only means we fall back to the video frame; only a
  // failing video tells us the recording itself is gone.
  const [posterMissing, setPosterMissing] = useState(false);
  const [missing, setMissing] = useState(false);
  if (missing) return <MissingFileThumb path={video.path} />;
  const showPoster = Boolean(video.thumbnailPath) && !posterMissing;
  return (
    <button
      type="button"
      className="context-image-thumb context-video-thumb"
      title={onOpenViewer ? "Click to play" : "Open in full screen"}
      onClick={() => {
        if (onOpenViewer) onOpenViewer(video.path, "video");
        else void openPath(video.path).catch(console.error);
      }}
    >
      {showPoster ? (
        <img
          src={convertFileSrc(video.thumbnailPath!)}
          alt=""
          className="context-video-preview"
          draggable={false}
          onError={() => setPosterMissing(true)}
        />
      ) : (
        <video
          src={convertFileSrc(video.path)}
          muted
          preload="metadata"
          className="context-video-preview"
          aria-hidden
          onError={() => setMissing(true)}
        />
      )}
      <span className="context-video-play-icon" aria-hidden>▶</span>
    </button>
  );
}

export function ContextImageThumbs({
  paths,
  reverseOrder = true,
  onRequestDelete,
  ocrTexts,
  explanationByPath,
  highlightTerm,
  onOpenViewer,
  onSave,
  itemKey,
  selectedIds,
  onToggleSelect,
}: {
  paths: string[];
  reverseOrder?: boolean;
  onRequestDelete?: (absolutePath: string) => void;
  ocrTexts?: Record<string, string>;
  explanationByPath?: Record<string, string>;
  highlightTerm?: string;
  /** When provided, clicking the thumbnail opens the in-app viewer instead of the default app. */
  onOpenViewer?: (path: string, kind: "image" | "video") => void;
  onSave?: (path: string, text: string, explanation: string) => void;
  itemKey?: string;
  selectedIds?: Set<string>;
  onToggleSelect?: (key: string) => void;
}) {
  if (paths.length === 0) return null;
  const display = reverseOrder ? [...paths].reverse() : paths;
  return (
    <div className="context-image-thumbs" role="list" aria-label="Context screenshots">
      {display.map((p) => {
        const ocrText = ocrTexts?.[p] ?? "";
        const explanation = explanationByPath?.[p];
        const copyText = explanation ? `${ocrText}\n${explanation}` : ocrText;
        return (
          <div key={p} className="context-media-thumb-row" role="listitem">
            <ImageThumbButton path={p} onOpenViewer={onOpenViewer} />
            <div className="context-media-chip-wrap">
              <MediaChip
                icon={<IconPhoto width={14} height={14} className="context-source-icon" />}
                text={ocrText}
                explanation={explanation}
                copyText={copyText}
                highlightTerm={highlightTerm}
                textLabel="OCR text"
                placeholder="OCR text (clear to remove)…"
                downloadPath={p}
                onSave={onSave ? (text, exp) => onSave(p, text, exp) : undefined}
                onDelete={onRequestDelete ? () => onRequestDelete(p) : undefined}
                itemKey={itemKey}
                selectedIds={selectedIds}
                onToggleSelect={onToggleSelect}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ContextVideoThumbs({
  videos,
  onRequestDelete,
  highlightTerm,
  onOpenViewer,
  onSave,
  itemKey,
  selectedIds,
  onToggleSelect,
}: {
  videos: OffSessionVideo[];
  onRequestDelete?: (video: OffSessionVideo) => void;
  highlightTerm?: string;
  /** When provided, clicking the thumbnail opens the in-app viewer instead of the default app. */
  onOpenViewer?: (path: string, kind: "image" | "video") => void;
  onSave?: (videoId: string, transcription: string, explanation: string) => void;
  itemKey?: string;
  selectedIds?: Set<string>;
  onToggleSelect?: (key: string) => void;
}) {
  if (videos.length === 0) return null;
  return (
    <div className="context-image-thumbs" role="list" aria-label="Screen recordings">
      {videos.map((v) => {
        const rawTranscription = v.transcription?.trim() ?? "";
        const displayText = rawTranscription.replace(/^\[Screen recording - \d+:\d{2}\]\s*/, "");
        const duration = rawTranscription.match(/\[Screen recording - (\d+:\d{2})\]/)?.[1];
        const prefix = rawTranscription.match(/^\[Screen recording - \d+:\d{2}\]\s*/)?.[0] ?? "";
        const copyText = v.explanation ? `${displayText}\n${v.explanation}` : displayText;
        return (
          <div key={v.id} className="context-media-thumb-row" role="listitem">
            <VideoThumbButton video={v} onOpenViewer={onOpenViewer} />
            <div className="context-media-chip-wrap">
              <MediaChip
                icon={<IconVideoCamera />}
                headerExtra={duration ? <span className="context-media-chip-duration">{duration}</span> : undefined}
                text={displayText}
                explanation={v.explanation}
                copyText={copyText}
                highlightTerm={highlightTerm}
                textLabel="Transcription"
                downloadPath={v.path}
                onSave={onSave ? (text, exp) => onSave(v.id, prefix + text, exp) : undefined}
                onDelete={onRequestDelete ? () => onRequestDelete(v) : undefined}
                itemKey={itemKey}
                selectedIds={selectedIds}
                onToggleSelect={onToggleSelect}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const DETAILED_SOURCE_TYPE_LABELS: Record<DetailedSourceType, string> = {
  "file": "File",
  "screenshot": "Screenshot",
  "screen-recording": "Screen Recording",
  "link": "Link",
  "dictation": "Dictation",
  "clipboard": "Clipboard",
  "manual": "Manual",
  "googleMeet": "Google Meet",
  "segment": "Segment",
};

export function getDetailedSourceType(entry: {
  kind: "note" | "image" | "video" | "segment";
  data: { kind?: "document"; source?: string; text?: string };
}): DetailedSourceType {
  if (entry.kind === "image") return "screenshot";
  if (entry.kind === "video") return "screen-recording";
  if (entry.kind === "segment") return "segment";
  // note
  if (entry.data.kind === "document") return "file";
  if (entry.data.source === "screenRecording") return "screen-recording";
  if (entry.data.source === "link" || isLinkNote(entry.data.text)) return "link";
  if (entry.data.source === "dictation") return "dictation";
  if (entry.data.source === "googleMeet") return "googleMeet";
  if (entry.data.source === "clipboard" || entry.data.source === "highlight") return "clipboard";
  return "manual";
}

const MINI_CAL_DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MINI_CAL_MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export function MiniCalendar({ value, onChange, onClose }: { value: string; onChange: (v: string) => void; onClose: () => void }) {
  const today = new Date();
  const init = value ? new Date(value + "T00:00:00") : today;
  const [vy, setVy] = useState(init.getFullYear());
  const [vm, setVm] = useState(init.getMonth());
  const daysInMonth = new Date(vy, vm + 1, 0).getDate();
  const firstDow = new Date(vy, vm, 1).getDay();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const prevM = () => { if (vm === 0) { setVy(y => y-1); setVm(11); } else setVm(m => m-1); };
  const nextM = () => { if (vm === 11) { setVy(y => y+1); setVm(0); } else setVm(m => m+1); };
  return (
    <div className="mini-calendar" onMouseDown={(e) => e.preventDefault()}>
      <div className="mini-calendar-header">
        <button type="button" className="mini-calendar-nav" onClick={prevM}>‹</button>
        <span className="mini-calendar-title">{MINI_CAL_MONTHS[vm]} {vy}</span>
        <button type="button" className="mini-calendar-nav" onClick={nextM}>›</button>
      </div>
      <div className="mini-calendar-grid">
        {MINI_CAL_DAYS.map(d => <span key={d} className="mini-calendar-dow">{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const ds = `${vy}-${String(vm+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
          const isSel = ds === value;
          const isToday = d === today.getDate() && vm === today.getMonth() && vy === today.getFullYear();
          return (
            <button key={i} type="button"
              className={`mini-calendar-day${isSel ? " sel" : ""}${isToday ? " today" : ""}`}
              onClick={() => { onChange(ds); onClose(); }}
            >{d}</button>
          );
        })}
      </div>
    </div>
  );
}
