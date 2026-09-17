import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { ReactNode, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { ContextSourceIcon, DocumentContextIcon } from "./ContextSourceIcon";
import type { ContextTimelineItem } from "./contextTimeline";
import { timelineItemToNoteItem, timelineMediaPath } from "./contextTimeline";
import type { ContextNoteItem } from "./contextNoteTypes";
import { copyLocalFileToDownloads } from "./localIndex";

function highlightText(text: string, term: string): ReactElement | string {
  if (!term) return text;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <mark key={i} className="capture-search-highlight">{part}</mark> : part
      )}
    </>
  );
}

function IconVideoCamera() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      className="context-source-icon" aria-hidden>
      <path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.88v6.24a1 1 0 0 1-1.447.91L15 14" />
      <rect x="2" y="7" width="13" height="10" rx="2" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function IconDownloadSpinner() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" className="capture-processing-spinner" aria-hidden>
      <circle cx="12" cy="12" r="9" strokeDasharray="36 28" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function IconScreenshotFrame() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} className="context-source-icon" aria-hidden>
      <rect x={3} y={5} width={18} height={14} rx={2} />
      <circle cx={8.5} cy={10} r={1.5} />
      <path d="M3 17l5-5 4 4 5-6 4 3v4H3z" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function IconIndexed() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M10 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L10 1z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      <path d="M10 1v4h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M5.5 9.5l2 2 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

/** Meet raw caption log indexing (distinct from PDF “file processed” icon). */
function IconMeetTranscriptIndexed() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 3.5h11M2.5 6.5h8M2.5 9.5h10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M11 12.5l1.8 1.8L15 12" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx={8} cy={8} r={6.5} stroke="currentColor" strokeWidth="1.4"/>
      <path d="M8 7v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx={8} cy={5} r={0.75} fill="currentColor"/>
    </svg>
  );
}

/** Visible lines before explanation scrolls (matches `.context-note-explanation--overflow` in App.css). */
const NOTE_CHIP_EXPLANATION_VISIBLE_LINES = 8;

/**
 * Chip bleu unifié - utilisé pour les notes texte, l'OCR et les transcriptions.
 * Le rendu est identique ; seul l'icône, le label d'édition et le header varient.
 */
export function NoteChip({
  icon,
  headerExtra,
  text,
  explanation,
  textLabel,
  placeholder,
  withExplanation = true,
  copyText,
  highlightTerm,
  onSave,
  onDelete,
  onOpenFile,
  downloadPath,
  processEnabled,
  onToggleProcess,
  /** Google Meet: embed raw caption transcript for server search (default off). */
  meetRawIndexEnabled,
  onToggleMeetRawIndex,
  itemKey,
  selectedIds,
  onToggleSelect,
}: {
  icon: ReactNode;
  /** Contenu affiché au-dessus du texte (ex. durée vidéo). */
  headerExtra?: ReactNode;
  text: string;
  explanation?: string;
  /** Label au-dessus du premier textarea en mode édition. */
  textLabel?: string;
  placeholder?: string;
  /** Affiche le champ Explanation en mode édition (défaut true). */
  withExplanation?: boolean;
  /** Texte copié dans le presse-papiers (défaut : text + explanation). */
  copyText?: string;
  highlightTerm?: string;
  onSave?: (text: string, explanation: string) => void;
  onDelete?: () => void;
  /** Bouton spécial pour ouvrir le fichier joint (document). */
  onOpenFile?: () => void;
  /** Local file behind this chip; when set, a "copy to Downloads" button is shown. */
  downloadPath?: string | null;
  /** Indique si le contenu du fichier sera indexé et queryable (documents uniquement). */
  processEnabled?: boolean;
  onToggleProcess?: () => void;
  meetRawIndexEnabled?: boolean;
  onToggleMeetRawIndex?: () => void;
  itemKey?: string;
  selectedIds?: Set<string>;
  onToggleSelect?: (key: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [draftExp, setDraftExp] = useState(explanation ?? "");
  const [copied, setCopied] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [textOverflow, setTextOverflow] = useState(false);
  const [explanationOverflow, setExplanationOverflow] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const explanationRef = useRef<HTMLQuoteElement>(null);
  const hasSelect = Boolean(itemKey && onToggleSelect);
  const localDownloadPath = downloadPath?.trim() ? downloadPath.trim() : null;
  const hasActions = Boolean(
    onDelete ||
      onSave ||
      hasSelect ||
      localDownloadPath ||
      onToggleProcess !== undefined ||
      onToggleMeetRawIndex !== undefined
  );
  const actualCopyText = copyText ?? (explanation ? `${text}\n${explanation}` : text);

  // Sync draft with incoming props when not editing (e.g. after external update).
  useEffect(() => {
    if (!editing) {
      setDraft(text);
      setDraftExp(explanation ?? "");
    }
  }, [text, explanation, editing]);

  // Overflow detection: cap at 5 rows.
  useEffect(() => {
    if (editing) return;
    const el = textRef.current;
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18.9;
    setTextOverflow(el.scrollHeight > lh * 5 + 4);
  }, [text, editing]);

  // Explanation: show up to 8 lines, then scroll like raw text.
  useEffect(() => {
    if (editing) return;
    const el = explanationRef.current;
    if (!el || !explanation) {
      setExplanationOverflow(false);
      return;
    }
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16.2;
    setExplanationOverflow(el.scrollHeight > lh * NOTE_CHIP_EXPLANATION_VISIBLE_LINES + 4);
  }, [explanation, editing]);

  const handleSave = () => {
    if (onSave) onSave(draft.trim(), draftExp.trim());
    setEditing(false);
  };

  const handleCancel = () => {
    setDraft(text);
    setDraftExp(explanation ?? "");
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={`context-note-chip${(onDelete || hasSelect) ? " context-note-chip-has-actions" : ""}`}>
        {/* Delete / select still visible while editing */}
        {(onDelete || hasSelect) && (
          <div className="context-note-chip-actions">
            {onDelete && (
              <button type="button"
                className="context-note-icon-btn context-note-icon-btn-danger"
                style={{ gridColumn: 1, gridRow: 1 }}
                aria-label="Delete" onClick={onDelete}>
                <IconTrash />
              </button>
            )}
            {hasSelect && (
              <input type="checkbox"
                className="item-select-checkbox"
                style={{ gridColumn: 2, gridRow: 1 }}
                checked={selectedIds?.has(itemKey!) ?? false}
                onChange={() => onToggleSelect!(itemKey!)}
                aria-label="Select item"
              />
            )}
          </div>
        )}
        <div className="context-note-chip-main">
          <span className="context-source-icon-wrap">{icon}</span>
          <div className="context-note-edit-fields">
            {headerExtra && <div className="context-media-chip-header">{headerExtra}</div>}
            {textLabel && <span className="context-note-edit-field-label">{textLabel}</span>}
            <textarea className="context-note-edit-area"
              value={draft} onChange={(e) => setDraft(e.target.value)}
              rows={3} placeholder={placeholder} autoFocus
            />
            {withExplanation && (
              <span className="context-note-edit-field-label">Explanation (optional)</span>
            )}
            {withExplanation && (
              <textarea className="context-note-edit-area"
                value={draftExp} onChange={(e) => setDraftExp(e.target.value)}
                rows={2} placeholder="Add an explanation…"
                style={{ opacity: 0.85, minHeight: 44 }}
              />
            )}
          </div>
        </div>
        {/* Save/Cancel below - direct child of chip (block layout → stacks vertically) */}
        <div className="context-note-edit-actions">
          <button type="button" className="btn btn-primary btn-small" onClick={handleSave}>Save</button>
          <button type="button" className="btn btn-small" onClick={handleCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`context-note-chip${hasActions ? " context-note-chip-has-actions" : ""}`}>
      <div className="context-note-chip-main">
        {onOpenFile ? (
          <button type="button"
            className="context-note-icon-btn context-note-icon-btn--file"
            onClick={onOpenFile} title="Open original file" aria-label="Open original file">
            {icon}
          </button>
        ) : (
          <span className="context-source-icon-wrap">{icon}</span>
        )}
        <div className="context-note-text-block">
          {headerExtra && <div className="context-media-chip-header">{headerExtra}</div>}
          <div ref={textRef}
            className={`context-note-text${textOverflow ? " context-note-text--overflow" : ""}`}>
            {highlightTerm ? highlightText(text, highlightTerm) : text}
          </div>
          {explanation && (
            <blockquote
              ref={explanationRef}
              className={`context-note-explanation${explanationOverflow ? " context-note-explanation--overflow" : ""}`}
            >
              {highlightTerm ? highlightText(explanation, highlightTerm) : explanation}
            </blockquote>
          )}
        </div>
      </div>
      {hasActions && (
        <div className="context-note-chip-actions">
          {onDelete && (
            <button type="button"
              className="context-note-icon-btn context-note-icon-btn-danger"
              style={{ gridColumn: 1, gridRow: 1 }}
              aria-label="Delete" onClick={onDelete}>
              <IconTrash />
            </button>
          )}
          {hasSelect && (
            <input type="checkbox"
              className="item-select-checkbox"
              style={{ gridColumn: 2, gridRow: 1 }}
              checked={selectedIds?.has(itemKey!) ?? false}
              onChange={() => onToggleSelect!(itemKey!)}
              aria-label="Select item"
            />
          )}
          {onSave && (
            <button type="button"
              className="context-note-icon-btn"
              style={{ gridColumn: 1, gridRow: 2 }}
              aria-label="Edit" onClick={() => setEditing(true)}>
              <IconPencil />
            </button>
          )}
          <button type="button"
            className={`context-note-icon-btn${copied ? " context-note-icon-btn--copied" : ""}`}
            style={{ gridColumn: 2, gridRow: 2 }}
            aria-label="Copy" title="Copy text"
            onClick={() => {
              void invoke("copy_text_to_clipboard", { text: actualCopyText }).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}>
            <IconCopy />
          </button>
          {localDownloadPath && (
            <button type="button"
              className="context-note-icon-btn"
              style={{ gridColumn: 1, gridRow: 5 }}
              aria-label="Copy to Downloads and reveal in Finder"
              title="Copy to Downloads and reveal in Finder"
              disabled={downloadBusy}
              onClick={(e) => {
                e.stopPropagation();
                setDownloadBusy(true);
                void copyLocalFileToDownloads(localDownloadPath)
                  .catch((err) => window.alert(String(err)))
                  .finally(() => setDownloadBusy(false));
              }}>
              {downloadBusy ? <IconDownloadSpinner /> : <IconDownload />}
            </button>
          )}
          {onToggleProcess !== undefined && (
            <>
              <button
                type="button"
                className={`context-note-icon-btn context-note-process-btn${processEnabled !== false ? " context-note-process-btn--on" : ""}`}
                style={{ gridColumn: 1, gridRow: 3 }}
                aria-label={
                  processEnabled !== false
                    ? "Enabled: search uses the full file. Click to disable and use the summary only."
                    : "Disabled: search uses the summary only. Click to enable and use the full file."
                }
                title={
                  processEnabled !== false
                    ? "Enabled - search uses the full file. Click to switch off (summary only)."
                    : "Disabled - search uses the summary only. Click to switch on (full file)."
                }
                onClick={onToggleProcess}
              >
                <IconIndexed />
              </button>
              <span
                className="context-note-icon-btn context-note-info-btn"
                style={{ gridColumn: 2, gridRow: 3 }}
                aria-label="How file search works"
              >
                <IconInfo />
                <span className="context-note-info-tooltip" role="tooltip">
                  <strong>When this is enabled</strong> (button looks “on”), Kety reads the whole file so answers can use what’s inside it.
                  {" "}
                  <strong>When this is disabled</strong> (button looks “off”), only your short summary is used for search-the file can still appear as a link, but its contents are not searched.
                </span>
              </span>
            </>
          )}
          {onToggleMeetRawIndex !== undefined && (
            <>
              <button
                type="button"
                className={`context-note-icon-btn context-note-process-btn${meetRawIndexEnabled === true ? " context-note-process-btn--on" : ""}`}
                style={{ gridColumn: 1, gridRow: 4 }}
                aria-label={
                  meetRawIndexEnabled === true
                    ? "Enabled: search uses the full live captions. Click to disable and keep recap and to-dos only."
                    : "Disabled: search uses your recap and to-dos only. Click to enable and include full live captions."
                }
                title={
                  meetRawIndexEnabled === true
                    ? "Enabled - search uses full live captions. Click to switch off (recap and to-dos only)."
                    : "Disabled - search uses recap and to-dos only. Click to switch on (full captions)."
                }
                onClick={onToggleMeetRawIndex}
              >
                <IconMeetTranscriptIndexed />
              </button>
              <span
                className="context-note-icon-btn context-note-info-btn"
                style={{ gridColumn: 2, gridRow: 4 }}
                aria-label="How Google Meet search works"
              >
                <IconInfo />
                <span className="context-note-info-tooltip context-note-info-tooltip--long" role="tooltip">
                  <strong>When this is enabled</strong> (button looks “on”), answers and search can use everything that was captioned live during the meeting.
                  {" "}
                  <strong>When this is disabled</strong> (button looks “off”), answers and search stick to your meeting recap and to-dos. The live captions are still saved with your upload; they are simply not used for search-often better if something sensitive was said.
                  {" "}
                  <strong>Sensitive content check</strong> - By default it reviews your recap. To have it review the full captions too, open Settings → Tags and turn on “Google Meet: also scan full raw transcript.” Do that if you leave this option enabled.
                </span>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Keep MediaChip as a re-export alias so App.tsx import still works during transition.
export const MediaChip = NoteChip;

/** Une ligne de la timeline : texte, capture ou enregistrement écran. */
export function SegmentContextBlock({
  items,
  ocrTextByPath,
  onEditText,
  onEditMediaItem,
  onDeleteItem,
  onOcrTextChange,
  selectedIds,
  onToggleSelect,
  getItemKey,
}: {
  items: ContextTimelineItem[];
  ocrTextByPath: Record<string, string>;
  onEditText?: (index: number, newText: string, newExplanation: string) => void;
  onEditMediaItem?: (index: number, patch: { text?: string; explanation?: string }) => void;
  onDeleteItem?: (index: number) => void;
  onOcrTextChange: (path: string, newText: string) => void;
  selectedIds?: Set<string>;
  onToggleSelect?: (key: string) => void;
  getItemKey?: (index: number) => string;
}) {
  if (items.length === 0) return null;
  const displayRows = items.map((it, index) => ({ it, index })).reverse();
  return (
    <div className="segment-context-timeline" role="list" aria-label="Segment context">
      {displayRows.map(({ it, index }) => (
        <TimelineRow
          key={`${index}-${it.kind}-${
            it.kind === "text"
              ? (it.clientId ?? it.text.slice(0, 12))
              : (timelineMediaPath(it) ?? "").slice(0, 48)
          }`}
          index={index}
          item={it}
          ocrTextByPath={ocrTextByPath}
          onEditText={onEditText}
          onEditMediaItem={onEditMediaItem}
          onDeleteItem={onDeleteItem}
          onOcrTextChange={onOcrTextChange}
          itemKey={getItemKey?.(index)}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}

function TimelineRow({
  index, item, ocrTextByPath, onEditText, onEditMediaItem,
  onDeleteItem, onOcrTextChange, itemKey, selectedIds, onToggleSelect,
}: {
  index: number;
  item: ContextTimelineItem;
  ocrTextByPath: Record<string, string>;
  onEditText?: (index: number, newText: string, newExplanation: string) => void;
  onEditMediaItem?: (index: number, patch: { text?: string; explanation?: string }) => void;
  onDeleteItem?: (index: number) => void;
  onOcrTextChange: (path: string, newText: string) => void;
  itemKey?: string;
  selectedIds?: Set<string>;
  onToggleSelect?: (key: string) => void;
}) {
  if (item.kind === "text") {
    const note: ContextNoteItem = timelineItemToNoteItem(item)!;
    return (
      <div className="segment-context-timeline-row segment-context-timeline-text" role="listitem">
        <NoteChip
          icon={<ContextSourceIcon source={note.source} />}
          text={note.text}
          explanation={note.explanation}
          onSave={onEditText ? (t, exp) => onEditText(index, t, exp) : undefined}
          onDelete={onDeleteItem ? () => onDeleteItem(index) : undefined}
          itemKey={itemKey}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
        />
      </div>
    );
  }

  if (item.kind === "document") {
    const srcPath = item.filePath.trim();
    const openAttached = !/^https?:\/\//i.test(srcPath)
      ? () => void openPath(srcPath).catch(console.error)
      : undefined;
    return (
      <div className="segment-context-timeline-row segment-context-timeline-text" role="listitem">
        <NoteChip
          icon={<DocumentContextIcon />}
          text={item.summary}
          explanation={item.explanation}
          onSave={onEditText ? (t, exp) => onEditText(index, t, exp) : undefined}
          onDelete={onDeleteItem ? () => onDeleteItem(index) : undefined}
          onOpenFile={openAttached}
          itemKey={itemKey}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
        />
      </div>
    );
  }

  if (item.kind === "screenshot") {
    const ocrText = ocrTextByPath[item.path] ?? "";
    return (
      <div className="segment-context-timeline-row segment-context-timeline-shot" role="listitem">
        <MediaThumbRow
          thumbnail={
            <button type="button" className="context-image-thumb" title="Screenshot">
              <img src={convertFileSrc(item.path)} alt="" className="context-image-thumb-img" />
            </button>
          }
          chip={
            <NoteChip
              icon={<IconScreenshotFrame />}
              text={ocrText}
              explanation={item.explanation}
              textLabel="OCR text"
              placeholder="OCR text (clear to remove)…"
              onSave={onEditMediaItem
                ? (text, exp) => {
                    onOcrTextChange(item.path, text);
                    onEditMediaItem(index, { explanation: exp || undefined });
                  }
                : undefined}
              onDelete={onDeleteItem ? () => onDeleteItem(index) : undefined}
              itemKey={itemKey}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
            />
          }
        />
      </div>
    );
  }

  if (item.kind === "screenRecording") {
  const displayText = item.transcription.replace(/^\[Screen recording - \d+:\d{2}\]\s*/, "");
  const duration = item.transcription.match(/\[Screen recording - (\d+:\d{2})\]/)?.[1];
  const prefix = item.transcription.match(/^\[Screen recording - \d+:\d{2}\]\s*/)?.[0] ?? "";
  return (
    <div className="segment-context-timeline-row segment-context-timeline-rec" role="listitem">
      <MediaThumbRow
        thumbnail={
          <button type="button"
            className="context-image-thumb context-video-thumb"
            title="Open in full screen"
            onClick={() => void openPath(item.path)}>
            {item.thumbnailPath ? (
              <img src={convertFileSrc(item.thumbnailPath)} alt="" className="context-video-preview" draggable={false} />
            ) : (
              <video src={convertFileSrc(item.path)} muted preload="metadata" className="context-video-preview" aria-hidden />
            )}
            <span className="context-video-play-icon" aria-hidden>▶</span>
          </button>
        }
        chip={
          <NoteChip
            icon={<IconVideoCamera />}
            headerExtra={duration ? <span className="context-media-chip-duration">{duration}</span> : undefined}
            text={displayText}
            explanation={item.explanation}
            textLabel="Transcription"
            onSave={onEditMediaItem
              ? (text, exp) => onEditMediaItem(index, { text: prefix + text, explanation: exp || undefined })
              : undefined}
            onDelete={onDeleteItem ? () => onDeleteItem(index) : undefined}
            itemKey={itemKey}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
          />
        }
      />
    </div>
  );
  }

  return null;
}

/** Layout partagé : miniature à gauche, chip à droite. */
function MediaThumbRow({ thumbnail, chip }: { thumbnail: ReactNode; chip: ReactNode }) {
  return (
    <div className="context-media-thumb-row">
      {thumbnail}
      <div className="context-media-chip-wrap">{chip}</div>
    </div>
  );
}
