import type { ContextNoteItem, ContextNoteSource } from "./contextNoteTypes";
import type { ContextTimelineItem } from "./contextTimeline";

export type { ContextNoteItem, ContextNoteSource } from "./contextNoteTypes";
export type { ContextTimelineItem } from "./contextTimeline";

export type OcrResultPayload = {
  path: string;
  text: string;
};

export type RecordingTrayPayload = {
  action: "start" | "stop" | "pause" | "toggle_recording";
};

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OffSessionContextFocus = {
  appName: string | null;
  bundleId: string | null;
  processId: number;
  appHidden: boolean;
  activationPolicy: number;
  bundlePath: string | null;
  executablePath: string | null;
  windowNumber: number | null;
  windowName: string | null;
  windowOwnerName: string | null;
  windowLayer: number | null;
  windowBounds: WindowBounds | null;
  windowAlpha: number | null;
};

export type FocusSegment = {
  sessionId?: string;
  startedAt: string;
  endedAt: string;
  source: string;
  contextTimeline?: ContextTimelineItem[];
  /** @deprecated Migrated to contextTimeline on load. */
  contextNotes?: ContextNoteItem[];
  /** @deprecated Migrated to contextTimeline on load. */
  contextImagePaths?: string[];
  contextImages?: { url: string; ocr?: string }[];
  appName: string | null;
  bundleId: string | null;
  processId: number;
  appHidden: boolean;
  activationPolicy: number;
  bundlePath: string | null;
  executablePath: string | null;
  windowNumber: number | null;
  windowName: string | null;
  windowOwnerName: string | null;
  windowLayer: number | null;
  windowBounds: WindowBounds | null;
  windowAlpha: number | null;
  tagIds?: string[];
  sensitiveVerdict?: "critical" | "potential" | "clean";
};

export type Session = {
  id: string;
  startedAt: string;
  endedAt?: string;
  name?: string;
  segments: FocusSegment[];
};

export type LiveFocusSnapshot = Omit<FocusSegment, "endedAt">;

export type FocusCurrentPayload =
  | { sessionId?: string; live: false }
  | (LiveFocusSnapshot & { live: true; sessionId?: string });

export type SegmentContextPendingPayload = {
  sessionId?: string;
  contextTimeline: ContextTimelineItem[];
};

export type GoogleMeetManualIngestedPayload = {
  clientId?: string;
  text?: string;
  sessionId?: string | null;
  usedLiveSegment?: boolean;
  skipAutoSummary?: boolean;
};

export type SensitivePreviewResponse = { rawOutput: string; parsed: number | null; label: string };

/** Fn/Globe dictation lines shown in capture context history (not persisted as captures). */
export type DictationHistoryInject = { id: string; text: string; createdAt: string };

export type OffSessionNote = {
  id: string;
  text?: string;
  summary?: string;
  kind?: "document";
  explanation?: string;
  createdAt: string;
  source?: ContextNoteSource;
  lang?: string;
  contextFocus?: OffSessionContextFocus;
  filePath?: string;
  fileSize?: number;
  process_doc_index_doc?: boolean;
  indexMeetRawTranscript?: boolean;
  mediaKind?: "text" | "file" | "image" | "video";
  tagIds?: string[];
  sensitiveVerdict?: "critical" | "potential" | "clean";
  /** Local indexing state: "pending" | "indexing" | "indexed" | "failed" | "excluded". */
  indexState?: string;
  indexError?: string | null;
};

export type OffSessionImage = {
  id: string;
  path: string;
  /** GCS URL set in-memory after upload; not persisted to SQLite. Use path for local display. */
  gcsPath?: string;
  createdAt: string;
  mediaKind: "text" | "file" | "image" | "video";
  ocr?: string;
  explanation?: string;
  contextFocus?: OffSessionContextFocus;
  tagIds?: string[];
  sensitiveVerdict?: "critical" | "potential" | "clean";
  fileSize?: number;
  /** Local indexing state: "pending" | "indexing" | "indexed" | "failed" | "excluded". */
  indexState?: string;
  indexError?: string | null;
};

export type OffSessionVideo = {
  id: string;
  path: string;
  /** GCS URL set in-memory after upload; not persisted to SQLite. Use path for local display. */
  gcsPath?: string;
  createdAt: string;
  mediaKind: "text" | "file" | "image" | "video";
  explanation?: string;
  lang?: string;
  contextFocus?: OffSessionContextFocus;
  thumbnailPath?: string;
  transcription?: string;
  tagIds?: string[];
  sensitiveVerdict?: "critical" | "potential" | "clean";
  fileSize?: number;
  /** Local indexing state: "pending" | "indexing" | "indexed" | "failed" | "excluded". */
  indexState?: string;
  indexError?: string | null;
};

export type OffSessionImagePayload = {
  path: string;
  createdAt: string;
  contextFocus?: unknown;
  fileSize?: number;
};

export type OffSessionVideoPayload = {
  path: string;
  createdAt: string;
  contextFocus?: unknown;
  thumbnailPath?: string;
  transcription?: string;
  lang?: string;
  fileSize?: number;
};

export type CaptureTag = {
  id: string;
  name: string;
  description: string;
  color: string;
  autoAssignApps: string[];
  createdAt: string;
};

export type SelectableItemSnapshot =
  | { kind: "offNote"; id: string }
  | { kind: "offImage"; id: string; path: string }
  | { kind: "offVideo"; id: string; path: string };

export type ConfirmKind =
  | { type: "deleteSelected"; items: SelectableItemSnapshot[] }
  | { type: "deleteOffNote"; id: string }
  | { type: "deleteOffImage"; id: string; path: string }
  | { type: "deleteOffVideo"; id: string; path: string }
  | {
      type: "removeWhisperModel";
      filename: string;
      label: string;
      isSelected: boolean;
      nextFilename: string;
    }
  | {
      type: "removeQwenModel";
      filename: string;
      label: string;
      isSelected: boolean;
      nextFilename: string;
    }
  | {
      type: "removeEmbedModel";
      filename: string;
      label: string;
      isActive: boolean;
    }
  | {
      type: "localModelInUseWarning";
      modelLabel: string;
      usedIn: Array<{ label: string; sectionId: string }>;
    };

export type RecordingSelfIdentity = {
  processId: number;
  bundleId: string | null;
  configIdentifier: string;
};

export type DetailedSourceType =
  | "file" | "screenshot" | "screen-recording"
  | "link" | "dictation" | "clipboard" | "manual"
  | "googleMeet"
  | "segment";

// ── Types currently defined inside the App component, promoted to module level ─

export type AppMainTab = "sessions" | "chat" | "settings";

export const DICTATION_PROVIDER_LOCAL = "local" as const;
export const DICTATION_PROVIDER_OPENAI_WHISPER_1 = "openai:whisper-1" as const;
export type DictationProvider =
  | typeof DICTATION_PROVIDER_LOCAL
  | typeof DICTATION_PROVIDER_OPENAI_WHISPER_1;

export type WhisperModelStatus = {
  id: string;
  filename: string;
  label: string;
  sizeLabel: string;
  installed: boolean;
};

export type WhisperStatus = {
  cli: boolean;
  selectedModel: string;
  models: WhisperModelStatus[];
};

export type QwenModelStatus = {
  id: string;
  filename: string;
  label: string;
  sizeLabel: string;
  installed: boolean;
};

export type QwenModelsStatus = {
  selectedModel: string;
  models: QwenModelStatus[];
};

export type LocalLlmStatus = {
  cliPresent: boolean;
  selectedModelFilename: string;
  modelFilePresent: boolean;
  ready: boolean;
};

export type HotkeyKeyLetters = {
  contextText: string;
  contextHighlight: string;
  noteWindow: string;
  screenshot: string;
  recordingToggle: string;
  dictation: string;
  /** ⌘⌥ + letter: dictation with optional OpenAI post-processing of the transcript. */
  customDictation: string;
  screenRecord: string;
  assistant: string;
  openApp: string;
  /** ⌘⌥ + letter: show text-actions HUD on selected text. */
  textTransform: string;
};

// ── Local index types ─────────────────────────────────────────────────────────

export type EmbedModelStatus = {
  id: string;
  filename: string;
  label: string;
  sizeLabel: string;
  dim: number;
  installed: boolean;
  isOpenAi: boolean;
};

export type EmbedModelsStatus = {
  activeModel: string;
  activeDim: number;
  models: EmbedModelStatus[];
};

export type LocalIndexStats = {
  totalCaptures: number;
  totalChunks: number;
  capturesMissingEmbed: number;
  activeEmbedModel: string;
  activeEmbedDim: number;
};

export type LocalSearchHit = {
  captureId: string;
  chunkText: string;
  rawText: string | null;
  title: string | null;
  localPath: string | null;
  score: number;
  kind: string;
  tagIds: string[];
};

export type IndexCaptureRequest = {
  captureId: string;
  rawText: string;
  title?: string | null;
};
