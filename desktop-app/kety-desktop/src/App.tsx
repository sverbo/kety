import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { store } from "./appStore";
import {
  type ContextNoteSource,
  parseContextNoteSource,
  isLinkNote,
} from "./contextNoteTypes";
// formatOffSessionContextFocus moved to CapturesTab
import { saveCapturesZipToDownloads, buildCaptureExportEntries } from "./recordingsZipPipeline";
import {
  noteToSaveReq,
  imageToSaveReq,
  videoToSaveReq,
  captureRowsToOffSession,
  isValidTagSensitiveScanModel,
  mergeTagSensitiveModelsOnLoad,
  pruneCopyHistoryNotesByRetention,
  pruneDictationHistoryInjectsByRetention,
  parseOffSessionContextFocus,
} from "./captureStoreHelpers";
import {
  IconDatabase,
  IconDocument,
  IconSettings,
  IconFaqHelp,
} from "./AppIcons";
import {
  offSessionNoteBody,
} from "./captureDisplayHelpers";
import {
  OpenAiKeyConfigureFeaturesModal,
  openAiNewKeyModalSections,
  openAiNewKeyModalHasAnySection,
} from "./OpenAiKeyConfigureFeaturesModal";
// import { applyPersistedTextEditsToStores } from "./applyPersistedTextEdits"; // used by removed ProcessTab
import { getConfirmCopy } from "./appHelpers";
import { CapturesTab } from "./CapturesTab";
// ProcessTab removed (session recording feature deleted)
import { type PdfDropZoneHandle } from "./PdfDropZone";
import {
  AssistantChatTab,
  type AssistantChatContextTab,
} from "./AssistantChatTab";
import { FaqPage } from "./FaqPage";
import {
  ASSISTANT_CHAT_LAST_CONTEXT_KEY,
  clearStoreIfOutdated,
  migrateLegacyGlobalKeysToCurrentUser,
  migrateSessionAndSettingsToUser,
  sessionStoreKeyForUser,
} from "./sessionStoreUser";
import {
  loadImportedAssistants,
  UNREADABLE_IMPORTED_ASSISTANTS_MESSAGE,
  type ImportedAssistant,
} from "./importedAssistants";
import {
  fetchShareContacts,
  type ShareContactRow,
} from "./shareService";
import {
  type UploadProgress,
} from "./uploadService";
import {
  useAuth,
} from "./authContext";
import { updateProfilePreferredLanguage } from "./profileService";
import SetupOnboardingModal, { IconOnboarding } from "./SetupOnboardingModal";
import {
  OPENAI_MODEL_PREFIX,
} from "./openaiTextModelOptions";
import {
  type OcrResultPayload,
  type GoogleMeetManualIngestedPayload,
  type SensitivePreviewResponse,
  type OffSessionNote,
  type OffSessionImage,
  type OffSessionVideo,
  type OffSessionImagePayload,
  type OffSessionVideoPayload,
  type CaptureTag,
  type ConfirmKind,
  type AppMainTab,
  type DictationProvider,
  DICTATION_PROVIDER_LOCAL,
  DICTATION_PROVIDER_OPENAI_WHISPER_1,
  type WhisperStatus,
  type QwenModelsStatus,
  type LocalLlmStatus,
  type EmbedModelsStatus,
  type HotkeyKeyLetters,
  type DictationHistoryInject,
} from "./appTypes";
import { checkEmbedModels, localSaveCapture, localListCaptures, localSaveTag, localListTags, localDeleteTag, type LocalCaptureRow } from "./localIndex";
import { useCaptures } from "./useCaptures";
export type {
  WindowBounds,
  OffSessionContextFocus,
  FocusSegment,
  Session,
  LiveFocusSnapshot,
  OffSessionNote,
  OffSessionImage,
  OffSessionVideo,
  CaptureTag,
  SelectableItemSnapshot,
  ConfirmKind,
  RecordingSelfIdentity,
  DetailedSourceType,
} from "./appTypes";
import { SettingsTab } from "./SettingsTab";
import { ChromeExtensionInstallPopup } from "./ChromeExtensionInstallPopup";
import { TagsManagerModal } from "./TagsManagerModal";
import { CaptureHistoryPopup } from "./CaptureHistoryPopup";
import { AssignTagsPickerModal } from "./AssignTagsPickerModal";
import { LanguageSyncModal } from "./LanguageSyncModal";
import { SqliteInspectorModal } from "./SqliteInspectorModal";
import { StoreInspectorModal } from "./StoreInspectorModal";
import {
  ASSISTANT_MODEL_OPTIONS,
  ASSISTANT_MODEL_DISABLED,
  isAssistantDirectOpenAiModel,
  isAssistantLocalQwenModel,
  buildGoogleMeetSummaryUserPrompt,
  isKnownOutputLanguageCode,
  resolveGoogleMeetSummaryOutputLangForApi,
  GOOGLE_MEET_SUMMARY_LANG_SAME_AS_ACCOUNT,
  GOOGLE_MEET_CAPTURE_APP_NAME,
  GOOGLE_MEET_CAPTURE_WINDOW_NAME,
  isCaptureHistoryRetention,
  captureHistoryRetentionMs,
  CAPTURE_HISTORY_RETENTION_DEFAULT,
  type CaptureHistoryRetention,
} from "./appConstants";
import "./App.css";

/** Per signed-in user: first-run setup modal dismissed from intro (permanent). */
const SETUP_ONBOARDING_DISMISS_LS_PREFIX = "kts_setup_onboarding_dismissed:";

const SENSITIVE_SCAN_CHUNK_CHARS = 1500;

// ── Re-exports for consumers that import from "./App" ─────────────────────────
export {
  offSessionNoteBody,
  formatDurationMs,
  formatSessionDateTime,
  localDateStr,
  fmtBytes,
  IconLink,
  ContextNoteChipRow,
  ContextImageThumbs,
  ContextVideoThumbs,
  DETAILED_SOURCE_TYPE_LABELS,
  getDetailedSourceType,
  MiniCalendar,
} from "./captureDisplayHelpers";
export { IconDownload, IconPhoto, IconVideoCamera } from "./AppIcons";
// ─────────────────────────────────────────────────────────────────────────────

export type { ContextNoteItem, ContextNoteSource, ContextTimelineItem } from "./appTypes";

/** Aligné sur `ASSISTANT_OPEN_EVENT` dans `src-tauri/src/lib.rs`. */
const ASSISTANT_OPEN_EVENT = "kts:assistant/open";

/** Aligné sur `SETTINGS_OPEN_EVENT` dans `src-tauri/src/lib.rs`. */
const SETTINGS_OPEN_EVENT = "kts:settings/open";


/** Aligné sur `lib.rs` `OFF_SESSION_NOTE_EVENT`. */
const OFF_SESSION_NOTE_EVENT = "kts:recording/off-session-note";

/** Aligné sur `lib.rs` `OFF_SESSION_IMAGE_EVENT`. */
const OFF_SESSION_IMAGE_EVENT = "kts:recording/off-session-image";

/** Aligné sur `lib.rs` `OCR_RESULT_EVENT`. */
const OCR_RESULT_EVENT = "kts:ocr/result";

/** Aligné sur `lib.rs` `OFF_SESSION_VIDEO_EVENT`. */
const OFF_SESSION_VIDEO_EVENT = "kts:recording/off-session-video";

/** Aligné sur `lib.rs` `GOOGLE_MEET_MANUAL_INGESTED_EVENT`. */
const GOOGLE_MEET_MANUAL_INGESTED_EVENT = "kts:google-meet/manual-ingested";

/** Aligné sur `lib.rs` `DICTATION_FIELD_INJECT_EVENT`. */
const DICTATION_FIELD_INJECT_EVENT = "kts:dictation/field-inject";


function offSessionNotesDedupSame(a: OffSessionNote, b: OffSessionNote): boolean {
  return a.createdAt === b.createdAt && offSessionNoteBody(a) === offSessionNoteBody(b);
}



function mergeByCreatedAtDesc<T extends { createdAt: string }>(
  buffered: T[],
  fromStore: T[]
): T[] {
  return [...buffered, ...fromStore].sort(
    (x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt)
  );
}




function safeInvokeUnlisten(unlisten: (() => void) | undefined | null): void {
  if (!unlisten) return;
  const isKnownListenerRaceError = (value: unknown): boolean => {
    const msg = value instanceof Error ? value.message : String(value);
    return (
      msg.includes("listeners[eventId]") ||
      msg.includes("handlerId") ||
      msg.includes("Cannot read properties of undefined")
    );
  };
  try {
    const maybePromise = unlisten() as unknown;
    if (
      maybePromise != null &&
      typeof maybePromise === "object" &&
      "catch" in maybePromise &&
      typeof (maybePromise as { catch?: unknown }).catch === "function"
    ) {
      void (maybePromise as Promise<unknown>).catch((err) => {
        if (isKnownListenerRaceError(err)) return;
        console.warn("unlisten failed:", err);
      });
    }
  } catch (err) {
    if (isKnownListenerRaceError(err)) return;
    console.warn("unlisten failed:", err);
  }
}

function App() {
  const {
    session,
    authReady,
    authenticatedFetch,
    profileReady,
    refreshProfile,
    isSuperAdmin,
  } = useAuth();
  const [assistantChatResetNonce] = useState(0);
  const [activeTab, setActiveTab] = useState<"sessions" | "chat" | "settings">(
    "sessions"
  );
  const [faqOpen, setFaqOpen] = useState(false);
  const [setupOnboardingOpen, setSetupOnboardingOpen] = useState(false);
  const [sqliteInspectorOpen, setSqliteInspectorOpen] = useState(false);
  const [storeInspectorOpen, setStoreInspectorOpen] = useState(false);
  const [setupOnboardingSource, setSetupOnboardingSource] = useState<"auto" | "manual">("auto");
  /** Increment to open Settings → Advanced → File & Meet → Google Meet (extension) from onboarding. */
  const [meetExtensionSetupJumpNonce, setMeetExtensionSetupJumpNonce] = useState(0);
  const [onboardingExtensionZipBusy, setOnboardingExtensionZipBusy] = useState(false);
  /** Incrémenté à l’ouverture de l’onglet Assistant ou sur ⌃A / menu tray → focus champ chat. */
  const [assistantFocusNonce, setAssistantFocusNonce] = useState(0);
  /** Increment from Settings → Assistant Advanced to open the in-chat preferences modal. */
  const [assistantPreferencesOpenNonce, setAssistantPreferencesOpenNonce] = useState(0);
  /** Assistant multi-context: reload chat transcripts from disk (after the tab list changes). */
  const [assistantChatStoreRevision, setAssistantChatStoreRevision] = useState(0);
  /** Bumped to re-read captures from SQLite without switching tabs (e.g. after unindexing). */
  const [captureReloadNonce, setCaptureReloadNonce] = useState(0);
  const [shareContacts, setShareContacts] = useState<ShareContactRow[] | null>(null);
  /**
   * Knowledge indexes imported from someone else, as stored in this profile's
   * registry. One chat tab each, beside "Me". Re-read with
   * `refreshImportedAssistants` after an import or a delete.
   */
  const [importedAssistants, setImportedAssistants] = useState<ImportedAssistant[]>([]);
  /** False until the registry has been read once, so an empty list is not mistaken for "none". */
  const [importedAssistantsLoaded, setImportedAssistantsLoaded] = useState(false);
  /**
   * Set when the registry could not be read at all, so the chat can say so.
   *
   * An unreadable registry and an empty one produce the same tab strip — "Me"
   * alone — and they mean opposite things. Without this the app shows the second
   * while the first is true: every imported tab silently gone, the user with no
   * way to tell a read failure from having nothing. The list is deliberately
   * still emptied; what this adds is the sentence saying the knowledge itself is
   * untouched and only the reading of the list failed.
   */
  const [importedAssistantsError, setImportedAssistantsError] = useState<string | null>(null);
  const [assistantActiveContextId, setAssistantActiveContextId] =
    useState<string>("self");
  /** Avoid writing the default chat context to disk before load from store completes. */
  const [assistantSharePrefsHydrated, setAssistantSharePrefsHydrated] =
    useState(false);
  const [loaded, setLoaded] = useState(false);
  /** Inférences locales en parallèle lors du scan sensible (Process). */
  const [localLlmParallelCalls, setLocalLlmParallelCalls] = useState(1);
  /** Default: index raw document content when a new document capture is created. */
  const [defaultIndexDocContent, setDefaultIndexDocContent] = useState(false);
  const defaultIndexDocContentRef = useRef(false);
  /** Settings → index captures automatically as they arrive. */
  const [autoIndexEnabled, setAutoIndexEnabled] = useState(true);
  /** Default: index raw Google Meet transcript when a new Meet capture is created. */
  const [defaultIndexMeetTranscript, setDefaultIndexMeetTranscript] = useState(false);
  const defaultIndexMeetTranscriptRef = useRef(false);
  /** CPU threads for llama-cli during local embedding reindex. */
  const [embedThreads, setEmbedThreads] = useState(4);
  /** Number of texts per OpenAI batch embedding call. */
  const [embedOpenAiBatchSize, setEmbedOpenAiBatchSize] = useState(128);
  /** Concurrent OpenAI batch embedding requests. */
  const [embedOpenAiParallel, setEmbedOpenAiParallel] = useState(3);
  /** OpenAI key used for cloud LLM calls from desktop settings. */
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  /** True while entering a replacement key (stored key stays hidden). */
  const [openAiApiKeyReplaceMode, setOpenAiApiKeyReplaceMode] = useState(false);
  /** Draft for replace flow only; never mirrors the stored key for display. */
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState("");
  /** Legacy guard message (e.g. invalid combinations); removing the API key no longer uses this for blocking. */
  const [openAiApiKeyGuardError, setOpenAiApiKeyGuardError] = useState<string | null>(null);
  const [openAiNewKeyConfigureDialogOpen, setOpenAiNewKeyConfigureDialogOpen] = useState(false);
  const hadOpenAiApiKeyRef = useRef(false);
  /** AI Assistant model: "disabled", a GPT model ID (direct OpenAI call), or "local:{filename}" for on-device Qwen. */
  const [assistantModel, setAssistantModel] = useState<string>(ASSISTANT_MODEL_DISABLED);
  /** File processing: page count above which the large-document warning is shown (default 10). */
  const [pdfWarnThreshold, setPdfWarnThreshold] = useState(10);
  /** File processing: language for all LLM summaries. "document" = match input language. */
  const [pdfSummaryLang, setPdfSummaryLang] = useState("en");
  /** File processing: mode - "count" (fixed number) or "percent" (fraction of document). */
  const [pdfPagesMode, setPdfPagesMode] = useState<"count" | "percent">("count");
  /** File processing: number of pages to summarize per dropped file (count mode). */
  const [pdfPagesCount, setPdfPagesCount] = useState(1);
  /** File processing: percentage of pages to summarize (percent mode). One of 10, 25, 50, 100. */
  const [pdfPagesPercent, setPdfPagesPercent] = useState(100);
  /** File processing: Qwen model filename for PDF summarization (independent from sensitive preview model). */
  const [pdfModelFilename, setPdfModelFilename] = useState("");
  /** Sensitive scan model choice: `local` (Qwen) or `openai:<model>`. */
  const [sensitiveScanModel, setSensitiveScanModel] = useState<string>("local");
  /** File processing: number of pages to process in parallel (1 = sequential). */
  const [pdfParallelism, setPdfParallelism] = useState(1);
  /** Super admin: upload test mode (mirror History, keep pending + files). Persisted per user. */
  const [testUploadPreserveLocalState, setTestUploadPreserveLocalState] = useState(true);
  /** ProcessTab (Prepare) enregistre ici un flush des textes inline avant le retour aux sessions. */
  const prepareLeaveFlushRef = useRef<(() => void) | null>(null);
  /** Nonce incrémenté quand l’utilisateur clique "Add to knowledge" - déclenche handlePrepare dans ProcessTab. */
  /** Dialogue de confirmation pour le bouton "Back to sessions" (depuis l’état prepare upload). */
  const [showLeavePrepareBackDialog, setShowLeavePrepareBackDialog] = useState(false);
  /** Upload GCS en cours : avertir avant changement d’onglet. */
  const [processUploadBlocked] = useState(false);
  const [leaveUploadTargetTab, setLeaveUploadTargetTab] = useState<AppMainTab | null>(null);
  /** Progress overlay shown while ProcessTab uploads from a hidden state (Add to Knowledge flow). */
  const [uploadOverlayProgress, setUploadOverlayProgress] = useState<{ phase: string; progress: UploadProgress } | null>(null);
  /** True when the user has clicked "cancel" in the upload overlay and is confirming. */
  const [uploadCancelConfirm, setUploadCancelConfirm] = useState(false);
  /** Set to true when the user confirms cancel - prevents onUploadComplete from running. */
  const uploadCancelledRef = useRef(false);
  /** True while PdfDropZone is actively processing. */
  const [pdfIsProcessing, setPdfIsProcessing] = useState(false);
  /** Pending tab the user wants to switch to while PDF is processing. */
  const [leavePdfTargetTab, setLeavePdfTargetTab] = useState<AppMainTab | null>(null);
  /** Imperative ref to interrupt PDF processing from outside the component. */
  const pdfDropZoneRef = useRef<PdfDropZoneHandle>(null);
  /** dump_id serveur de l’upload en cours - pour discard si l’utilisateur quitte l’onglet. */
  const activeUploadServerDumpIdRef = useRef<string | null>(null);
  /** Template prompt sensible (fichier kts/) - édité dans Settings → Process. */
  const [sensitivePromptTemplate, setSensitivePromptTemplate] = useState("");
  const [sensitivePromptSaveBusy, setSensitivePromptSaveBusy] = useState(false);
  /** macOS : enrichir notes / captures hors session avec l’app + fenêtre au premier plan. */
  const [attachOffSessionFocus, setAttachOffSessionFocus] = useState(true);
  /** Chrome Meet: auto-sync transcript to Kety when the Meet tab closes (+ gate non-manual extension POSTs). */
  const [chromeExtensionAutoMeetCaptures, setChromeExtensionAutoMeetCaptures] = useState(true);
  const [showChromeExtensionInstallPopup, setShowChromeExtensionInstallPopup] = useState(false);
  /** Secret + port for the local Meet listener (session store; optional env override in Rust). */
  const [meetBridgeToken, setMeetBridgeToken] = useState("");
  const [meetBridgePort, setMeetBridgePort] = useState(17171);
  const [chromeExtZipExportMessage, setChromeExtZipExportMessage] = useState<string | null>(null);
  const meetBridgeSettingsHydratedRef = useRef(false);
  /** Empty string = same model as Settings → Captures → File processing → document summary. */
  const [googleMeetSummaryModel, setGoogleMeetSummaryModel] = useState("");
  /** Extra instructions appended when summarizing Meet captions (stored for pipeline). */
  const [googleMeetSummaryPrompt, setGoogleMeetSummaryPrompt] = useState("");
  /** Output language for Meet summary + to-dos (fixed locale from `OUTPUT_LANGUAGE_OPTIONS`). */
  const [googleMeetSummaryLang, setGoogleMeetSummaryLang] = useState("en");

  /** OpenAI `openai:…` chat model for ⌘⌥ custom dictation post-processing, or `disabled`. */
  const [dictationCustomModel, setDictationCustomModel] = useState("disabled");
  /** Hydrated from store or `get_dictation_custom_prompt_defaults_cmd` (defaults live only in Rust). */
  const [dictationCustomPromptHighlight, setDictationCustomPromptHighlight] = useState("");
  const [dictationCustomPromptNoHighlight, setDictationCustomPromptNoHighlight] = useState("");

  // ── Tags ─────────────────────────────────────────────────────────────────────
  const [captureTags, setCaptureTags] = useState<CaptureTag[]>([]);
  const [showTagsManager, setShowTagsManager] = useState(false);
  const [editingTag, setEditingTag] = useState<CaptureTag | null>(null);
  const [tagDeletePending, setTagDeletePending] = useState<string | null>(null);
  const [showHistoryPopup, setShowHistoryPopup] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<"all" | "dictation" | "copy">("all");
  const [historyDeletePending, setHistoryDeletePending] = useState<string | null>(null);
  const [historyFlushAllPending, setHistoryFlushAllPending] = useState(false);
  /** 500ms green flash on the capture-history icon when a new Fn dictation (history) or clipboard copy lands. */
  const [historyFlash, setHistoryFlash] = useState(false);
  const historyFlashTimeoutRef = useRef<number | null>(null);
  const triggerHistoryFlash = useCallback(() => {
    if (historyFlashTimeoutRef.current != null) {
      window.clearTimeout(historyFlashTimeoutRef.current);
    }
    setHistoryFlash(true);
    historyFlashTimeoutRef.current = window.setTimeout(() => {
      setHistoryFlash(false);
      historyFlashTimeoutRef.current = null;
    }, 500);
  }, []);
  useEffect(() => () => {
    if (historyFlashTimeoutRef.current != null) {
      window.clearTimeout(historyFlashTimeoutRef.current);
      historyFlashTimeoutRef.current = null;
    }
  }, []);
  const [showScanPopup, setShowScanPopup] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanRescanDialog, setScanRescanDialog] = useState(false);
  const scanCancelRef = useRef(false);
  const [scanCancelPending, setScanCancelPending] = useState(false);
  const [scanResultCounts, setScanResultCounts] = useState<{ critical: number; atRisk: number } | null>(null);
  const scanResultCountsRef = useRef({ critical: 0, atRisk: 0 });
  const scanSnapshotRef = useRef<Record<string, "critical" | "potential" | "clean" | undefined>>({});
  const [filterSensitiveVerdicts, setFilterSensitiveVerdicts] = useState<("critical" | "potential")[]>([]);

  // ── Captures sort & filter ────────────────────────────────────────────────────
  const [capturesSort, setCapturesSort] = useState<"date" | "app" | "type">("date");
  const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
  /** How active tag filters and sensitive verdict filters combine (date/search still always AND). */
  const [filterTagSensitiveCombine, setFilterTagSensitiveCombine] = useState<"and" | "or">("and");
  const [filterTextSubTypes, setFilterTextSubTypes] = useState<string[]>([]);
  const [filterDateFrom, setFilterDateFrom] = useState<string>("");
  const [filterDateTo, setFilterDateTo] = useState<string>("");
  const [showFilters, setShowFilters] = useState(false);
  const [expandedAppGroups, setExpandedAppGroups] = useState<Record<string, boolean>>({});
  const [searchTermAtCollapse, setSearchTermAtCollapse] = useState<string | null>(null);
  const [showDateFromPicker, setShowDateFromPicker] = useState(false);
  const [showDateToPicker, setShowDateToPicker] = useState(false);
  const dateFromBtnRef = useRef<HTMLButtonElement>(null);
  const dateToBtnRef = useRef<HTMLButtonElement>(null);
  const [dateFromRect, setDateFromRect] = useState<DOMRect | null>(null);
  const [dateToRect, setDateToRect] = useState<DOMRect | null>(null);
  const [showDateRange, setShowDateRange] = useState(false);
  const currentGroupNamesRef = useRef<string[]>([]);

  // Collapse all groups when switching to grouped sort mode
  useEffect(() => {
    if (capturesSort === "app" || capturesSort === "type") {
      setExpandedAppGroups({});
      setSearchTermAtCollapse(null);
    }
  }, [capturesSort]);

  const [capturesSearch, setCapturesSearch] = useState("");
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [selectAllPending, setSelectAllPending] = useState(false);

  // ── Tag assignment picker ────────────────────────────────────────────────────
  const [showAssignTagPicker, setShowAssignTagPicker] = useState(false);
  /** Tag IDs the model may assign in the Assign-tags dialog (default: all tags). */
  const [assignTagAiPoolIds, setAssignTagAiPoolIds] = useState<string[]>([]);
  const [assignTagAiBusy, setAssignTagAiBusy] = useState(false);
  const [assignTagAiError, setAssignTagAiError] = useState<string | null>(null);
  /** Non–Kety server: per-capture AI assign progress in the dialog (done/total). */
  const [assignTagAiProgress, setAssignTagAiProgress] = useState<{ done: number; total: number } | null>(null);

  // ── Captures Category auto-processing ────────────────────────────────────────
  const [autoScanSensitive, setAutoScanSensitive] = useState(true);
  /**
   * When false (default), Meet sensitive scan uses only the Explanation (summary + to-dos), not raw captions.
   * When true, the full raw Meet transcript is scanned too (longer, higher cost).
   */
  const [meetSensitiveScanIncludeRawTranscript, setMeetSensitiveScanIncludeRawTranscript] =
    useState(false);
  const [autoAssignTags, setAutoAssignTags] = useState(true);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const submittedProcessRef = useRef<Set<string>>(new Set());
  const [captureHistoryRetention, setCaptureHistoryRetention] = useState<CaptureHistoryRetention>(
    CAPTURE_HISTORY_RETENTION_DEFAULT,
  );
  const captureHistoryRetentionRef = useRef(captureHistoryRetention);
  captureHistoryRetentionRef.current = captureHistoryRetention;
  defaultIndexDocContentRef.current = defaultIndexDocContent;
  defaultIndexMeetTranscriptRef.current = defaultIndexMeetTranscript;
  const [autoTagTextLimit, setAutoTagTextLimit] = useState(2000);
  const [showEnableAutoTagPopup, setShowEnableAutoTagPopup] = useState(false);
  const [keepCopyHistory, setKeepCopyHistory] = useState(false);
  /** When on, field-inject dictation lines (Fn / Globe and ⌘⌥E custom dictation) are kept in Capture history. Default on. */
  const [keepDictationHistory, setKeepDictationHistory] = useState(true);
  /** Touche Fn / Globe : dictée type Wispr (injection + historique). Désactivable (conflits clavier). */
  const [fnDictationShortcutEnabled, setFnDictationShortcutEnabled] = useState(true);
  /** Entrées dictée Fn (historique) dans le panneau note tray. */
  const [dictationFieldInjects, setDictationFieldInjects] = useState<DictationHistoryInject[]>([]);
  /** Qualité d’enregistrement écran : 0=low, 1=medium, 2=high. Défaut : 1. */
  const [screenRecordQuality, setScreenRecordQuality] = useState(1);
  /** 0 = désactivé. Lu par Rust au démarrage dictée (défaut 60). */
  const [dictationAutoStopMinutes, setDictationAutoStopMinutes] = useState(60);
  /** 0 = désactivé. Lu par Rust au démarrage screen record (défaut 120). */
  const [screenRecordAutoStopMinutes, setScreenRecordAutoStopMinutes] = useState(120);
  /** Langue pour la dictée whisper (code ISO ou "auto"). */
  const [dictationLang, setDictationLang] = useState("en");
  /** Provider de transcription pour la dictée + transcript micro du screen recording. */
  const [dictationProvider, setDictationProvider] = useState<DictationProvider>(
    DICTATION_PROVIDER_LOCAL,
  );
  /** Account-level preferred output language persisted in `profiles.preferred_language`. */
  const [preferredOutputLang, setPreferredOutputLang] = useState("en");
  const [preferredOutputLangSaving, setPreferredOutputLangSaving] = useState(false);
  const [preferredOutputLangError, setPreferredOutputLangError] = useState<string | null>(null);
  const [pendingLanguageSyncCode, setPendingLanguageSyncCode] = useState<string | null>(null);
  /** Whisper installation status: null = not yet checked. */
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null);
  /** Model ID currently being downloaded (null = none). */
  const [whisperDownloading, setWhisperDownloading] = useState<string | null>(null);
  /** Download progress percent (0–100). */
  const [whisperDownloadPercent, setWhisperDownloadPercent] = useState<number | null>(null);

  const [qwenStatus, setQwenStatus] = useState<QwenModelsStatus | null>(null);
  const [qwenDownloading, setQwenDownloading] = useState<string | null>(null);
  const [qwenDownloadPercent, setQwenDownloadPercent] = useState<number | null>(null);
  const [localLlmStatus, setLocalLlmStatus] = useState<LocalLlmStatus | null>(null);
  const [embedStatus, setEmbedStatus] = useState<EmbedModelsStatus | null>(null);
  const [embedDownloading, setEmbedDownloading] = useState<string | null>(null);
  const [embedDownloadPercent, setEmbedDownloadPercent] = useState<number | null>(null);
  const [localIndexStats, setLocalIndexStats] = useState<import("./appTypes").LocalIndexStats | null>(null);
  const hasOpenAiApiKey = openAiApiKey.trim().length > 0;
  const showOpenAiKeyMasked = hasOpenAiApiKey && !openAiApiKeyReplaceMode;

  useEffect(() => {
    if (!openAiApiKey.trim()) {
      setOpenAiApiKeyReplaceMode(false);
      setOpenAiApiKeyDraft("");
    }
  }, [openAiApiKey]);

  const commitOpenAiApiKeyRemoval = useCallback(() => {
    if (isAssistantDirectOpenAiModel(assistantModel)) {
      setAssistantModel(ASSISTANT_MODEL_DISABLED);
    }
    if (pdfModelFilename.startsWith(OPENAI_MODEL_PREFIX)) {
      setPdfModelFilename("");
    }
    if (sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX)) {
      setSensitiveScanModel("disabled");
      setAutoScanSensitive(false);
    }
    if (googleMeetSummaryModel.startsWith(OPENAI_MODEL_PREFIX)) {
      setGoogleMeetSummaryModel("");
    }
    if (dictationProvider === DICTATION_PROVIDER_OPENAI_WHISPER_1) {
      setDictationProvider(DICTATION_PROVIDER_LOCAL);
    }
    setOpenAiApiKey("");
    setOpenAiApiKeyReplaceMode(false);
    setOpenAiApiKeyDraft("");
    setOpenAiApiKeyGuardError(null);
  }, [
    assistantModel,
    pdfModelFilename,
    sensitiveScanModel,
    googleMeetSummaryModel,
    dictationProvider,
  ]);

  const goToSettingsSection = useCallback((sectionId: string) => {
    setActiveTab("settings");
    window.setTimeout(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  }, []);

  /** Settings → Assistant → Advanced: Assistant tab + in-chat preferences modal. */
  const openAssistantTabAndPreferences = useCallback(() => {
    if (!session) return;
    setActiveTab("chat");
    setAssistantFocusNonce((n) => n + 1);
    setAssistantPreferencesOpenNonce((n) => n + 1);
  }, [session]);

  const dismissOpenAiNewKeyConfigureDialog = useCallback(() => {
    setOpenAiNewKeyConfigureDialogOpen(false);
  }, []);


  useEffect(() => {
    if (!loaded) return;
    if (hasOpenAiApiKey && !hadOpenAiApiKeyRef.current) {
      const nk = openAiNewKeyModalSections(
        assistantModel,
        pdfModelFilename,
        sensitiveScanModel,
        dictationProvider,
        whisperStatus,
      );
      if (openAiNewKeyModalHasAnySection(nk)) {
        setOpenAiNewKeyConfigureDialogOpen(true);
      }
    }
    hadOpenAiApiKeyRef.current = hasOpenAiApiKey;
  }, [
    hasOpenAiApiKey,
    loaded,
    assistantModel,
    pdfModelFilename,
    sensitiveScanModel,
    dictationProvider,
    whisperStatus,
  ]);


  // Re-sync captures state from SQLite every time the user switches to the Sessions tab.
  // SQLite is the source of truth; this picks up uploads or edits that happened while on another tab.
  useEffect(() => {
    if (activeTab !== "sessions" || !loadCompleteRef.current) return;
    const uid = userIdRef.current;
    if (!uid) return;
    localListCaptures(uid)
      .then((rows) => {
        const { notes, images, videos, ocrMap } = captureRowsToOffSession(rows);
        const sqliteNoteIds = new Set(notes.map((n) => n.id));
        const sqliteImageIds = new Set(images.map((i) => i.id));
        const sqliteVideoIds = new Set(videos.map((v) => v.id));
        setOcrTextByPath((prev) => ({ ...prev, ...ocrMap }));
        setOffSessionNotes((prev) => {
          const ephemeral = prev.filter((n) => !sqliteNoteIds.has(n.id));
          return mergeByCreatedAtDesc(ephemeral, notes);
        });
        setOffSessionImages((prev) => {
          const ephemeral = prev.filter((i) => !sqliteImageIds.has(i.id));
          return mergeByCreatedAtDesc(ephemeral, images);
        });
        setOffSessionVideos((prev) => {
          const ephemeral = prev.filter((v) => !sqliteVideoIds.has(v.id));
          return mergeByCreatedAtDesc(ephemeral, videos);
        });
      })
      .catch((e) => console.error("[sync:sessions]", e));
  }, [activeTab, captureReloadNonce]);


  useEffect(() => {
    const pdfUsesOpenAi = pdfModelFilename.startsWith(OPENAI_MODEL_PREFIX);
    const scanUsesOpenAi = sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX);
    const assistantUsesOpenAi = isAssistantDirectOpenAiModel(assistantModel);
    if (!pdfUsesOpenAi && !scanUsesOpenAi && !assistantUsesOpenAi) {
      setOpenAiApiKeyGuardError(null);
    }
  }, [pdfModelFilename, sensitiveScanModel, assistantModel]);

  // effectiveSensitiveScanModelSelection / effectiveSensitiveScanModelLabel removed —
  // these were only passed to ProcessTab which has been deleted.

  const DEFAULT_HOTKEY_LETTERS: HotkeyKeyLetters = {
    contextText: "V",
    contextHighlight: "C",
    noteWindow: "X",
    screenshot: "B",
    recordingToggle: "N",
    dictation: "D",
    customDictation: "E",
    screenRecord: "S",
    assistant: "F",
    openApp: "K",
    textTransform: "T",
  };
  const HOTKEY_LETTER_KEYS = [
    "contextText",
    "contextHighlight",
    "noteWindow",
    "screenshot",
    "recordingToggle",
    "dictation",
    "customDictation",
    "screenRecord",
    "assistant",
    "openApp",
    "textTransform",
  ] as const satisfies readonly (keyof HotkeyKeyLetters)[];
  const sanitizeHotkeyLetters = (raw: unknown): HotkeyKeyLetters => {
    const base: HotkeyKeyLetters = { ...DEFAULT_HOTKEY_LETTERS };
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      for (const k of HOTKEY_LETTER_KEYS) {
        const v = o[k];
        if (typeof v === "string" && /^[a-zA-Z]$/.test(v.trim())) {
          base[k] = v.trim().toUpperCase();
        }
      }
    }
    return base;
  };
  const [hotkeyKeyLetters, setHotkeyKeyLetters] = useState<HotkeyKeyLetters>(DEFAULT_HOTKEY_LETTERS);
  const [hotkeyPickerKey, setHotkeyPickerKey] = useState<keyof HotkeyKeyLetters | null>(null);
  const hotkeyPickerAnchorRefs = useRef<Partial<Record<keyof HotkeyKeyLetters, HTMLDivElement | null>>>({});

  const pickHotkeyLetter = (rowKey: keyof HotkeyKeyLetters, L: string) => {
    const nextLetter = L.toUpperCase();
    const next = { ...hotkeyKeyLetters, [rowKey]: nextLetter };
    const vals = Object.values(next);
    if (vals.filter((x) => x === nextLetter).length > 1) return;
    setHotkeyKeyLetters(next);
    setHotkeyPickerKey(null);
  };

  useEffect(() => {
    if (hotkeyPickerKey == null) return;
    const onDocDown = (e: MouseEvent) => {
      const anchor = hotkeyPickerAnchorRefs.current[hotkeyPickerKey];
      if (anchor && !anchor.contains(e.target as Node)) {
        setHotkeyPickerKey(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHotkeyPickerKey(null);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [hotkeyPickerKey]);

  /**
   * Copy history entries (Rust `copyHistory`): macOS = ⌘C key tap + deferred read; other OS = clipboard poll.
   * Kept separate from `offSessionNotes`: not in the captures grid, no auto-tag/scan/upload batch.
   * Active paste (⌘⌥V / tray « Paste to context ») uses source `clipboard` and is a normal capture.
   */
  const [copyHistoryNotes, setCopyHistoryNotes] = useState<OffSessionNote[]>([]);

  const loadCompleteRef = useRef(false);
  /** Run Whisper/Qwen/Local LLM disk checks once per signed-in user (not only when Settings opens). */
  const setupModelsBootstrappedForUserRef = useRef<string | null>(null);
  const offSessionBufferRef = useRef<{
    notes: OffSessionNote[];
    images: OffSessionImage[];
    videos: OffSessionVideo[];
  }>({ notes: [], images: [], videos: [] });
  /** Chrome Meet manual re-sync (hors session) : sauter le LLM si l’Explanation existait déjà. */
  const meetManualResyncSkipSummaryRef = useRef<Set<string>>(new Set());

  /** Sélection multi-items pour suppression groupée. Clé: "offNote|id", "offImage|id", "offVideo|id", "session|id", "seg|sessionId|startedAt". */
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const toggleItemSelected = useCallback((key: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);


/** Dialogue de confirmation - les effets sont appliqués dans `runConfirmedAction` (état à jour). */
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null);
  const selectionScopeUserIdRef = useRef<string | null>(session?.user?.id ?? null);

  useEffect(() => {
    const nextUserId = session?.user?.id ?? null;
    if (selectionScopeUserIdRef.current === nextUserId) return;
    selectionScopeUserIdRef.current = nextUserId;
    // Reset account-scoped destructive UI state when auth user changes.
    setSelectedItemIds(new Set());
    setConfirmKind(null);
  }, [session?.user?.id]);

  const [zipDownloadBusy, setZipDownloadBusy] = useState(false);

  /** Bloc repliable « notes + captures hors session ». */
  const [offSessionBlockExpanded, setOffSessionBlockExpanded] = useState(true);

  /** Ref toujours à jour avec l'UID courant - utilisée dans les effets de sauvegarde. */
  const userIdRef = useRef<string | null>(session?.user.id ?? null);
  useEffect(() => {
    userIdRef.current = session?.user.id ?? null;
  }, [session?.user.id]);

  const {
    notes: offSessionNotes, setNotes: setOffSessionNotes, notesRef: offSessionNotesRef,
    images: offSessionImages, setImages: setOffSessionImages, imagesRef: offSessionImagesRef,
    videos: offSessionVideos, setVideos: setOffSessionVideos, videosRef: offSessionVideosRef,
    ocrTextByPath, setOcrTextByPath,
    fileSizeByPath, setFileSizeByPath,
    removeNoteById: removeOffSessionNoteById,
    removeImageById: removeOffSessionImageById,
    removeVideoById: removeOffSessionVideoById,
    updateOcrText,
  } = useCaptures(userIdRef);

  // addToKnowledgeEstimatedSizeKb removed — was only passed to ProcessTab which has been deleted.

  useEffect(() => {
    console.log("[App] mounted - DevTools are connected ✓");
    return () => { console.log("[App] unmounted"); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const dismissSetupOnboardingForever = useCallback(() => {
    const uid = session?.user?.id;
    if (uid) {
      try {
        localStorage.setItem(`${SETUP_ONBOARDING_DISMISS_LS_PREFIX}${uid}`, "1");
      } catch {
        /* ignore */
      }
    }
    setSetupOnboardingOpen(false);
  }, [session?.user?.id]);

  /** Close without writing permanent dismiss - modal can show again when deps change (e.g. new session) or manual. */
  const closeSetupOnboarding = useCallback(() => {
    setSetupOnboardingOpen(false);
  }, []);

  const setupOnboardingOpenRef = useRef(setupOnboardingOpen);
  const setupOnboardingSourceRef = useRef(setupOnboardingSource);
  useEffect(() => {
    setupOnboardingOpenRef.current = setupOnboardingOpen;
  }, [setupOnboardingOpen]);
  useEffect(() => {
    setupOnboardingSourceRef.current = setupOnboardingSource;
  }, [setupOnboardingSource]);

  const downloadExtensionZipFromOnboardingUi = useCallback(async () => {
    setOnboardingExtensionZipBusy(true);
    setChromeExtZipExportMessage(null);
    try {
      const r = await invoke<{ path: string; bridgeToken: string; bridgePort: number }>(
        "export_chrome_extension_zip_cmd"
      );
      setMeetBridgeToken(r.bridgeToken);
      setMeetBridgePort(r.bridgePort);
      setChromeExtZipExportMessage(`Saved: ${r.path}`);
    } catch (e: unknown) {
      setChromeExtZipExportMessage(
        typeof e === "string" ? e : e instanceof Error ? e.message : "Export failed."
      );
    } finally {
      setOnboardingExtensionZipBusy(false);
    }
  }, []);

  const jumpToAiTasksSetupFromOnboarding = useCallback(() => {
    setSetupOnboardingOpen(false);
    setActiveTab("settings");
    const needKey = openAiApiKey.trim().length === 0;
    const needWhisper = !(whisperStatus?.models.some((m) => m.installed) ?? false);
    const needQwen = !(qwenStatus?.models.some((m) => m.installed) ?? false);
    window.setTimeout(() => {
      document.getElementById("settings-ai-tasks")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => {
        if (needWhisper || needQwen) {
          document.getElementById("settings-local-lm")?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (needKey) {
          document.getElementById("settings-llm-api-key")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 320);
    }, 120);
  }, [openAiApiKey, whisperStatus, qwenStatus]);

  const openMeetExtensionAdvancedFromOnboarding = useCallback(() => {
    setSetupOnboardingOpen(false);
    setMeetExtensionSetupJumpNonce((n) => n + 1);
    setActiveTab("settings");
    window.setTimeout(() => {
      document.getElementById("settings-ai-tasks")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }, []);

  // Load embed catalog early — does not need auth, only checks local files.
  // The per-user bootstrap below will refresh it with the activeModel from the DB.
  useEffect(() => {
    if (!loaded) return;
    void checkEmbedModels(null).then(setEmbedStatus).catch(console.error);
  }, [loaded]);

  useEffect(() => {
    if (!loaded || !authReady || !session?.user?.id) {
      setupModelsBootstrappedForUserRef.current = null;
      return;
    }
    const uid = session.user.id;
    if (setupModelsBootstrappedForUserRef.current === uid) return;
    setupModelsBootstrappedForUserRef.current = uid;
    void invoke<WhisperStatus>("check_whisper_cmd")
      .then(setWhisperStatus)
      .catch((e) => console.error("check_whisper_cmd (bootstrap):", e));
    void invoke<QwenModelsStatus>("check_qwen_models_cmd")
      .then(setQwenStatus)
      .catch((e) => console.error("check_qwen_models_cmd (bootstrap):", e));
    void checkEmbedModels(uid)
      .then(setEmbedStatus)
      .catch((e) => console.error("check_embed_models_cmd (bootstrap):", e));
    void invoke<import("./appTypes").LocalIndexStats>("local_index_stats_cmd", { userId: uid })
      .then(setLocalIndexStats)
      .catch((e) => console.error("local_index_stats_cmd (bootstrap):", e));
    void invoke<LocalLlmStatus>("check_local_llm_cmd")
      .then(setLocalLlmStatus)
      .catch((e) => {
        console.error("check_local_llm_cmd (bootstrap):", e);
        setLocalLlmStatus(null);
      });
  }, [loaded, authReady, session?.user?.id]);

  // Intentionally omit `setupOnboardingOpen` / `setupOnboardingSource` from deps: closing the modal must not
  // immediately re-trigger an open while eligibility is unchanged (read latest values via refs).
  useEffect(() => {
    if (!loaded || !authReady || !session?.user?.id || !profileReady) return;
    if (whisperStatus === null || qwenStatus === null) return;
    const hasKey = openAiApiKey.trim().length > 0;
    const hasWhisper = whisperStatus.models.some((m) => m.installed);
    const hasQwen = qwenStatus.models.some((m) => m.installed);
    /** User is "covered" if they use OpenAI, or if both local bundles (voice + general) are present. */
    const setupComplete = hasKey || (hasWhisper && hasQwen);
    if (setupComplete) {
      if (setupOnboardingOpenRef.current && setupOnboardingSourceRef.current === "auto") {
        setSetupOnboardingOpen(false);
      }
      return;
    }
    if (setupOnboardingOpenRef.current) return;
    let dismissed = false;
    try {
      dismissed =
        localStorage.getItem(`${SETUP_ONBOARDING_DISMISS_LS_PREFIX}${session.user.id}`) === "1";
    } catch {
      dismissed = false;
    }
    if (dismissed) return;
    setSetupOnboardingSource("auto");
    setSetupOnboardingOpen(true);
  }, [loaded, authReady, session?.user?.id, profileReady, whisperStatus, qwenStatus, openAiApiKey]);

  // ── Chargement initial ──────────────────────────────────────────────
  useEffect(() => {
    if (!authReady) return;

    let cancelled = false;
    loadCompleteRef.current = false;
    meetBridgeSettingsHydratedRef.current = false;
    offSessionBufferRef.current = { notes: [], images: [], videos: [] };

    const loadData = async () => {
      await clearStoreIfOutdated(store);
      if (cancelled) return;

      const uid = session?.user.id ?? null;
      if (uid) {
        await migrateSessionAndSettingsToUser(store, uid);
      }
      if (cancelled) return;

      // Load captures from SQLite — single source of truth (store removed).
      const sqliteCaptures = uid
        ? await localListCaptures(uid).catch(() => [] as LocalCaptureRow[])
        : [];
      const { notes: savedOff, images: savedOffImg, videos: savedOffVid, ocrMap: savedOcrMap } = captureRowsToOffSession(sqliteCaptures);
      setOcrTextByPath((prev) => ({ ...prev, ...savedOcrMap }));

      const savedOffExpanded = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "offSessionBlockExpanded"))
        : undefined;
      if (typeof savedOffExpanded === "boolean") {
        setOffSessionBlockExpanded(savedOffExpanded);
      }
      const savedDictLang = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "dictationLang"))
        : undefined;
      const lang = typeof savedDictLang === "string" && savedDictLang ? savedDictLang : "en";
      setDictationLang(lang);
      void invoke("set_dictation_lang_cmd", { lang }).catch(console.error);

      const savedWhisperModel = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "whisperModel"))
        : undefined;
      if (typeof savedWhisperModel === "string") {
        // "" means Disabled - still pass it so Rust state matches the persisted choice.
        void invoke("set_whisper_model_cmd", { filename: savedWhisperModel }).catch(console.error);
      } else {
        // Not logged in or no saved model - disable Whisper.
        void invoke("set_whisper_model_cmd", { filename: "" }).catch(console.error);
      }

      const savedDictationProvider = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "dictationProvider"))
        : undefined;
      if (
        savedDictationProvider === DICTATION_PROVIDER_LOCAL ||
        savedDictationProvider === DICTATION_PROVIDER_OPENAI_WHISPER_1
      ) {
        setDictationProvider(savedDictationProvider);
      } else {
        setDictationProvider(DICTATION_PROVIDER_LOCAL);
      }

      const savedQwenLocal = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "qwenLocalModel"))
        : undefined;
      if (typeof savedQwenLocal === "string") {
        void invoke("set_qwen_local_model_cmd", { filename: savedQwenLocal }).catch(console.error);
      } else {
        void invoke("set_qwen_local_model_cmd", { filename: "" }).catch(console.error);
      }

      const savedParallel = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "localLlmParallelCalls"))
        : undefined;
      if (typeof savedParallel === "number" && !Number.isNaN(savedParallel)) {
        setLocalLlmParallelCalls(Math.min(8, Math.max(1, Math.floor(savedParallel))));
      }
      const savedEmbedThreads = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "embedThreads"))
        : undefined;
      if (typeof savedEmbedThreads === "number" && !Number.isNaN(savedEmbedThreads)) {
        setEmbedThreads(Math.min(16, Math.max(1, Math.floor(savedEmbedThreads))));
      }
      const savedEmbedOpenAiBatchSize = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "embedOpenAiBatchSize"))
        : undefined;
      if (typeof savedEmbedOpenAiBatchSize === "number" && !Number.isNaN(savedEmbedOpenAiBatchSize)) {
        setEmbedOpenAiBatchSize(Math.min(2048, Math.max(1, Math.floor(savedEmbedOpenAiBatchSize))));
      }
      const savedEmbedOpenAiParallel = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "embedOpenAiParallel"))
        : undefined;
      if (typeof savedEmbedOpenAiParallel === "number" && !Number.isNaN(savedEmbedOpenAiParallel)) {
        setEmbedOpenAiParallel(Math.min(8, Math.max(1, Math.floor(savedEmbedOpenAiParallel))));
      }
      const savedOpenAiApiKey = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "openAiApiKey"))
        : undefined;
      if (typeof savedOpenAiApiKey === "string") {
        setOpenAiApiKey(savedOpenAiApiKey);
      }
      const savedAssistantModel = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "assistantModel"))
        : undefined;
      if (
        typeof savedAssistantModel === "string" &&
        (savedAssistantModel === ASSISTANT_MODEL_DISABLED ||
          isAssistantLocalQwenModel(savedAssistantModel) ||
          ASSISTANT_MODEL_OPTIONS.some((m) => m.value === savedAssistantModel))
      ) {
        setAssistantModel(savedAssistantModel);
      }
      const savedSensitiveScanModel = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "sensitiveScanModel"))
        : undefined;
      const savedSensitiveScanModelG = await store.get<string | null>("sensitiveScanModel");
      const savedAutoTagModel = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "autoTagModel"))
        : undefined;
      const savedAutoTagModelG = await store.get<string | null>("autoTagModel");
      const sensEff =
        typeof savedSensitiveScanModel === "string"
          ? savedSensitiveScanModel
          : typeof savedSensitiveScanModelG === "string"
            ? savedSensitiveScanModelG
            : undefined;
      const tagEff =
        typeof savedAutoTagModel === "string" ? savedAutoTagModel : typeof savedAutoTagModelG === "string" ? savedAutoTagModelG : undefined;
      const mergedTagSensitive = mergeTagSensitiveModelsOnLoad(sensEff, tagEff);
      if (isValidTagSensitiveScanModel(mergedTagSensitive)) {
        setSensitiveScanModel(mergedTagSensitive);
      }

      const savedPdfWarnThreshold = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "pdfWarnThreshold"))
        : undefined;
      if (typeof savedPdfWarnThreshold === "number" && savedPdfWarnThreshold >= 1) {
        setPdfWarnThreshold(Math.floor(savedPdfWarnThreshold));
      }
      const savedPdfSummaryLang = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "pdfSummaryLang"))
        : undefined;
      if (typeof savedPdfSummaryLang === "string" && savedPdfSummaryLang.length > 0) {
        setPdfSummaryLang(savedPdfSummaryLang);
      }
      const savedPdfMode = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "pdfPagesMode"))
        : undefined;
      if (savedPdfMode === "count" || savedPdfMode === "percent") {
        setPdfPagesMode(savedPdfMode);
      }
      const savedPdfPages = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "pdfPagesCount"))
        : undefined;
      if (typeof savedPdfPages === "number" && savedPdfPages >= 1) {
        setPdfPagesCount(Math.max(1, Math.floor(savedPdfPages)));
      }
      const savedPdfPercent = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "pdfPagesPercent"))
        : undefined;
      if (typeof savedPdfPercent === "number" && [10, 25, 50, 100].includes(savedPdfPercent)) {
        setPdfPagesPercent(savedPdfPercent);
      }
      const savedPdfModel = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "pdfModelFilename"))
        : undefined;
      const savedMeetSummaryModel = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "googleMeetSummaryModel"))
        : undefined;
      const meetSummaryModelEff =
        typeof savedMeetSummaryModel === "string" ? savedMeetSummaryModel : undefined;
      let meetLegacy = "";
      if (typeof meetSummaryModelEff === "string") {
        meetLegacy = meetSummaryModelEff.trim();
        if (meetLegacy === "" && typeof savedPdfModel === "string" && savedPdfModel.trim() !== "") {
          meetLegacy = savedPdfModel.trim();
        }
      }
      const pdfStr = typeof savedPdfModel === "string" ? savedPdfModel.trim() : "";
      const unifiedSummary = pdfStr || meetLegacy;
      if (unifiedSummary) {
        setPdfModelFilename(unifiedSummary);
        setGoogleMeetSummaryModel(unifiedSummary);
      }
      const savedPdfParallelism = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "pdfParallelism"))
        : undefined;
      if (typeof savedPdfParallelism === "number" && savedPdfParallelism >= 1) {
        setPdfParallelism(Math.max(1, Math.floor(savedPdfParallelism)));
      }

      const savedAttachFocus = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "attachOffSessionFocus"))
        : undefined;
      if (typeof savedAttachFocus === "boolean") {
        setAttachOffSessionFocus(savedAttachFocus);
        // Keep global key in sync so Rust (which reads "attachOffSessionFocus" directly) sees the value.
        await store.set("attachOffSessionFocus", savedAttachFocus).catch(console.error);
      }

      const savedChromeMeetAuto = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "chromeExtensionAutoMeetCaptures"))
        : undefined;
      const savedChromeMeetAutoGlobal =
        await store.get<boolean | null>("chromeExtensionAutoMeetCaptures");
      const chromeMeetEff =
        typeof savedChromeMeetAuto === "boolean"
          ? savedChromeMeetAuto
          : typeof savedChromeMeetAutoGlobal === "boolean"
            ? savedChromeMeetAutoGlobal
            : undefined;
      if (typeof chromeMeetEff === "boolean") {
        setChromeExtensionAutoMeetCaptures(chromeMeetEff);
        await store.set("chromeExtensionAutoMeetCaptures", chromeMeetEff).catch(console.error);
      }

      const savedMeetSummaryPrompt = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "googleMeetSummaryPrompt"))
        : undefined;
      const savedMeetSummaryPromptG = await store.get<string | null>("googleMeetSummaryPrompt");
      const meetSummaryPromptEff =
        typeof savedMeetSummaryPrompt === "string"
          ? savedMeetSummaryPrompt
          : typeof savedMeetSummaryPromptG === "string"
            ? savedMeetSummaryPromptG
            : undefined;
      if (typeof meetSummaryPromptEff === "string") setGoogleMeetSummaryPrompt(meetSummaryPromptEff);

      const savedMeetSummaryLang = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "googleMeetSummaryLang"))
        : undefined;
      const meetLangEff =
        typeof savedMeetSummaryLang === "string" ? savedMeetSummaryLang : undefined;
      if (
        typeof meetLangEff === "string" &&
        (meetLangEff === GOOGLE_MEET_SUMMARY_LANG_SAME_AS_ACCOUNT ||
          meetLangEff === "document" ||
          isKnownOutputLanguageCode(meetLangEff))
      ) {
        setGoogleMeetSummaryLang(meetLangEff);
      }

      const savedDcm = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "dictationCustomModel"))
        : undefined;
      const savedDcmG = await store.get<string | null>("dictationCustomModel");
      const dcmEff =
        typeof savedDcm === "string" ? savedDcm : typeof savedDcmG === "string" ? savedDcmG : undefined;
      if (typeof dcmEff === "string") setDictationCustomModel(dcmEff);

      if (cancelled) return;
      const dictationPromptDefaults = await invoke<{
        promptHighlight: string;
        promptNoHighlight: string;
      }>("get_dictation_custom_prompt_defaults_cmd");
      if (cancelled) return;

      const savedDcH = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "dictationCustomPromptHighlight"))
        : undefined;
      const savedDcHG = await store.get<string | null>("dictationCustomPromptHighlight");
      const dcHEff =
        typeof savedDcH === "string" ? savedDcH : typeof savedDcHG === "string" ? savedDcHG : undefined;
      setDictationCustomPromptHighlight(
        typeof dcHEff === "string" ? dcHEff : dictationPromptDefaults.promptHighlight
      );

      const savedDcNH = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "dictationCustomPromptNoHighlight"))
        : undefined;
      const savedDcNHG = await store.get<string | null>("dictationCustomPromptNoHighlight");
      const dcNHEff =
        typeof savedDcNH === "string" ? savedDcNH : typeof savedDcNHG === "string" ? savedDcNHG : undefined;
      setDictationCustomPromptNoHighlight(
        typeof dcNHEff === "string" ? dcNHEff : dictationPromptDefaults.promptNoHighlight
      );

      const savedFnShortcut = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "fnDictationShortcutEnabled"))
        : undefined;
      const globalFn = await store.get<boolean | null>("fnDictationShortcutEnabled");
      const fnEff =
        typeof savedFnShortcut === "boolean"
          ? savedFnShortcut
          : typeof globalFn === "boolean"
            ? globalFn
            : true;
      setFnDictationShortcutEnabled(fnEff);
      if (uid) {
        await store.set(sessionStoreKeyForUser(uid, "fnDictationShortcutEnabled"), fnEff).catch(console.error);
      }
      await store.set("fnDictationShortcutEnabled", fnEff).catch(console.error);

      const rawHotkeyLetters = uid
        ? await store.get<unknown>(sessionStoreKeyForUser(uid, "hotkeyKeyLetters"))
        : undefined;
      const globalHotkeyLetters = await store.get<unknown>("hotkeyKeyLetters");
      const hotkeyLettersEff =
        rawHotkeyLetters !== undefined && rawHotkeyLetters !== null
          ? rawHotkeyLetters
          : globalHotkeyLetters !== undefined && globalHotkeyLetters !== null
            ? globalHotkeyLetters
            : undefined;
      const hotkeySanitized = sanitizeHotkeyLetters(hotkeyLettersEff);
      setHotkeyKeyLetters(hotkeySanitized);
      if (uid) {
        await store.set(sessionStoreKeyForUser(uid, "hotkeyKeyLetters"), hotkeySanitized).catch(console.error);
      }
      await store.set("hotkeyKeyLetters", hotkeySanitized).catch(console.error);

      const savedKeepCopyHistory = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "keepCopyHistory"))
        : undefined;
      if (typeof savedKeepCopyHistory === "boolean") setKeepCopyHistory(savedKeepCopyHistory);

      const savedKeepDictationHistory = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "keepDictationHistory"))
        : undefined;
      if (typeof savedKeepDictationHistory === "boolean") setKeepDictationHistory(savedKeepDictationHistory);

      const savedCaptureHistRetention = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "captureHistoryRetention"))
        : undefined;
      const savedCaptureHistRetentionG = await store.get<string | null>("captureHistoryRetention");
      const retentionEff =
        typeof savedCaptureHistRetention === "string"
          ? savedCaptureHistRetention
          : typeof savedCaptureHistRetentionG === "string"
            ? savedCaptureHistRetentionG
            : undefined;
      if (typeof retentionEff === "string" && isCaptureHistoryRetention(retentionEff)) {
        setCaptureHistoryRetention(retentionEff);
      }

      const savedQuality = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "screenRecordQuality"))
        : undefined;
      if (typeof savedQuality === "number" && savedQuality >= 0 && savedQuality <= 2) {
        setScreenRecordQuality(savedQuality);
        // Keep global key in sync so Rust reads the right value at recording start.
        await store.set("screenRecordQuality", savedQuality).catch(console.error);
      }

      const savedDictAutoStop = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "dictationAutoStopMinutes"))
        : undefined;
      const savedDictAutoStopG = await store.get<number | null>("dictationAutoStopMinutes");
      const dictAutoStopEff =
        typeof savedDictAutoStop === "number"
          ? savedDictAutoStop
          : typeof savedDictAutoStopG === "number"
            ? savedDictAutoStopG
            : undefined;
      if (typeof dictAutoStopEff === "number" && dictAutoStopEff >= 0 && dictAutoStopEff <= 1440) {
        setDictationAutoStopMinutes(Math.floor(dictAutoStopEff));
      }

      const savedSrAutoStop = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "screenRecordAutoStopMinutes"))
        : undefined;
      const savedSrAutoStopG = await store.get<number | null>("screenRecordAutoStopMinutes");
      const srAutoStopEff =
        typeof savedSrAutoStop === "number"
          ? savedSrAutoStop
          : typeof savedSrAutoStopG === "number"
            ? savedSrAutoStopG
            : undefined;
      if (typeof srAutoStopEff === "number" && srAutoStopEff >= 0 && srAutoStopEff <= 1440) {
        setScreenRecordAutoStopMinutes(Math.floor(srAutoStopEff));
      }

      const savedTestUploadPreserve = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "testUploadPreserveLocalState"))
        : undefined;
      if (typeof savedTestUploadPreserve === "boolean") {
        setTestUploadPreserveLocalState(savedTestUploadPreserve);
      }

      const savedDefaultIndexDoc = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "defaultIndexDocContent"))
        : undefined;
      if (typeof savedDefaultIndexDoc === "boolean") setDefaultIndexDocContent(savedDefaultIndexDoc);

      const storedAutoIndex = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "autoIndexEnabled"))
        : null;
      setAutoIndexEnabled(storedAutoIndex ?? true);

      const savedDefaultIndexMeet = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "defaultIndexMeetTranscript"))
        : undefined;
      if (typeof savedDefaultIndexMeet === "boolean") setDefaultIndexMeetTranscript(savedDefaultIndexMeet);

      if (uid) {
        const sqliteTags = await localListTags(uid).catch(() => []);
        if (sqliteTags.length > 0) {
          setCaptureTags(sqliteTags.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            color: t.color,
            autoAssignApps: (() => { try { return JSON.parse(t.autoAssignApps) as string[]; } catch { return []; } })(),
            createdAt: t.createdAt,
          })));
        } else {
          // One-time migration from store → SQLite
          const rawCaptureTags = await store.get<unknown>(sessionStoreKeyForUser(uid, "captureTags"));
          if (Array.isArray(rawCaptureTags)) {
            const migrated = rawCaptureTags.filter((t): t is CaptureTag =>
              t != null && typeof t === "object" && typeof (t as CaptureTag).id === "string"
            );
            setCaptureTags(migrated);
            for (const tag of migrated) {
              void localSaveTag(uid, {
                id: tag.id,
                name: tag.name,
                description: tag.description,
                color: tag.color,
                autoAssignApps: tag.autoAssignApps ?? [],
                createdAt: tag.createdAt,
              }).catch(console.error);
            }
          }
        }
        // Always delete stale store key — tags live in SQLite now
        void store.delete(sessionStoreKeyForUser(uid, "captureTags")).catch(() => {});
        void store.save().catch(() => {});
      }

      const savedAutoScanSensitive = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "autoScanSensitive"))
        : undefined;
      if (typeof savedAutoScanSensitive === "boolean") setAutoScanSensitive(savedAutoScanSensitive);

      const savedMeetSensitiveScanRaw = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "meetSensitiveScanIncludeRawTranscript"))
        : undefined;
      const meetSensRawEff =
        typeof savedMeetSensitiveScanRaw === "boolean" ? savedMeetSensitiveScanRaw : undefined;
      if (typeof meetSensRawEff === "boolean") {
        setMeetSensitiveScanIncludeRawTranscript(meetSensRawEff);
      }

      const savedAutoAssignTags = uid
        ? await store.get<boolean | null>(sessionStoreKeyForUser(uid, "autoAssignTags"))
        : undefined;
      if (typeof savedAutoAssignTags === "boolean") setAutoAssignTags(savedAutoAssignTags);

      const savedAutoTagTextLimit = uid
        ? await store.get<number | null>(sessionStoreKeyForUser(uid, "autoTagTextLimit"))
        : undefined;
      if (typeof savedAutoTagTextLimit === "number" && savedAutoTagTextLimit >= 1000) setAutoTagTextLimit(savedAutoTagTextLimit);

      // Sensitive prompt template: per-user in store is the source of truth.
      // The Rust file at kts/llm_sensitive_prompt_template.txt acts as a runtime cache that we
      // rewrite (or clear) on every user load so no template leaks across accounts on the same machine.
      const savedSensitivePrompt = uid
        ? await store.get<string | null>(sessionStoreKeyForUser(uid, "sensitivePromptTemplate"))
        : undefined;
      if (typeof savedSensitivePrompt === "string" && savedSensitivePrompt.length > 0) {
        setSensitivePromptTemplate(savedSensitivePrompt);
        await invoke("set_sensitive_prompt_template_cmd", { body: savedSensitivePrompt })
          .catch((e) => console.error("set_sensitive_prompt_template_cmd:", e));
      } else {
        // No stored template for this user → clear the shared Rust file and show the built-in default.
        await invoke("set_sensitive_prompt_template_cmd", { body: "" })
          .catch((e) => console.error("set_sensitive_prompt_template_cmd:", e));
        const defaultPrompt = await invoke<string>("get_sensitive_prompt_template_cmd")
          .catch((e) => {
            console.error("get_sensitive_prompt_template_cmd:", e);
            return "";
          });
        if (typeof defaultPrompt === "string") setSensitivePromptTemplate(defaultPrompt);
      }

      const bufNotes = offSessionBufferRef.current.notes;
      const bufNotesForGrid = bufNotes.filter((n) => n.source !== "copyHistory");
      const bufNotesCopyHistory = bufNotes.filter((n) => n.source === "copyHistory");
      const savedImgPaths = new Set(savedOffImg.map((i) => i.path));
      const savedVidPaths = new Set(savedOffVid.map((v) => v.path));
      const newBufNotes = bufNotesForGrid.filter((n) => !savedOff.some((s) => offSessionNotesDedupSame(s, n)));
      const newBufImgs  = offSessionBufferRef.current.images.filter((i) => !savedImgPaths.has(i.path));
      const newBufVids  = offSessionBufferRef.current.videos.filter((v) => !savedVidPaths.has(v.path));
      // Save buffered items to DB before adding to state (DB-first).
      if (uid) {
        await Promise.all([
          ...newBufNotes.map((n) => localSaveCapture(uid, noteToSaveReq(n, uid)).catch((e) => console.error("[buf:note] DB save failed:", e))),
          ...newBufImgs.map((i) => localSaveCapture(uid, imageToSaveReq(i, uid)).catch((e) => console.error("[buf:img] DB save failed:", e))),
          ...newBufVids.map((v) => localSaveCapture(uid, videoToSaveReq(v, uid)).catch((e) => console.error("[buf:vid] DB save failed:", e))),
        ]);
      }
      const mergedNotes = mergeByCreatedAtDesc(newBufNotes, savedOff);
      const mergedImg   = mergeByCreatedAtDesc(newBufImgs, savedOffImg);
      const mergedVid   = mergeByCreatedAtDesc(newBufVids, savedOffVid);
      offSessionBufferRef.current = { notes: [], images: [], videos: [] };
      loadCompleteRef.current = true;

      const rawCopyHistory = uid
        ? await store.get<unknown>(sessionStoreKeyForUser(uid, "copyHistoryNotes"))
        : undefined;
      const savedCopyHistory: OffSessionNote[] = Array.isArray(rawCopyHistory)
        ? rawCopyHistory.flatMap((row): OffSessionNote[] => {
            if (row == null || typeof row !== "object") return [];
            const r = row as Record<string, unknown>;
            const createdAt = r.createdAt;
            const text = r.text;
            if (typeof createdAt !== "string" || typeof text !== "string") return [];
            const id =
              typeof r.id === "string" && r.id.length > 0
                ? r.id
                : crypto.randomUUID();
            const cf = parseOffSessionContextFocus(r.contextFocus);
            const note: OffSessionNote = {
              id,
              text,
              source: "copyHistory",
              createdAt,
              ...(cf !== undefined ? { contextFocus: cf } : {}),
            };
            return [note];
          })
        : [];

      const mergedCopyHistory = mergeByCreatedAtDesc(bufNotesCopyHistory, savedCopyHistory);

      setOffSessionNotes(mergedNotes);
      setOffSessionImages(mergedImg);
      setOffSessionVideos(mergedVid);
      const captureHistRetentionResolved: CaptureHistoryRetention =
        typeof retentionEff === "string" && isCaptureHistoryRetention(retentionEff)
          ? retentionEff
          : CAPTURE_HISTORY_RETENTION_DEFAULT;
      setCopyHistoryNotes(
        pruneCopyHistoryNotesByRetention(mergedCopyHistory, captureHistoryRetentionMs(captureHistRetentionResolved)),
      );

      const savedMeetTok = await store.get<string | null>("meetBridgeToken");
      if (typeof savedMeetTok === "string" && savedMeetTok.trim()) {
        setMeetBridgeToken(savedMeetTok.trim());
      } else {
        setMeetBridgeToken("");
      }
      const savedMeetPort = await store.get<number | null>("meetBridgePort");
      if (typeof savedMeetPort === "number" && savedMeetPort >= 1 && savedMeetPort <= 65535) {
        setMeetBridgePort(Math.floor(savedMeetPort));
      } else {
        setMeetBridgePort(17171);
      }
      meetBridgeSettingsHydratedRef.current = true;

      hadOpenAiApiKeyRef.current =
        (typeof savedOpenAiApiKey === "string" ? savedOpenAiApiKey : "").trim().length > 0;

      if (!cancelled) setLoaded(true);
    };

    void loadData();
    return () => { cancelled = true; };
  }, [authReady, session?.user.id]);

  /** Hors session : écoute dès le montage (avant `loaded`) + buffer fusionné au chargement du store. */
  useEffect(() => {
    let unNote: (() => void) | undefined;
    let unImg: (() => void) | undefined;
    let unVid: (() => void) | undefined;

    const pNote = listen<Record<string, unknown>>(
      OFF_SESSION_NOTE_EVENT,
      (event) => {
        const p = event.payload;
        console.log(`[capture:note:RAW] event received - kind=${p.kind ?? "text"} source=${p.source ?? "?"} loadComplete=${loadCompleteRef.current} userId=${!!userIdRef.current}`);
        const createdAt = p.createdAt;
        if (typeof createdAt !== "string") { console.warn("[capture:note:RAW] dropped - no createdAt"); return; }
        if (!userIdRef.current) { console.warn("[capture:note:RAW] dropped - no userId (not logged in)"); return; }
        const rawExp = p.explanation;
        const exp = typeof rawExp === "string" && rawExp.trim() ? rawExp.trim() : undefined;
        const cf = parseOffSessionContextFocus(p.contextFocus);
        const fp = typeof p.filePath === "string" && p.filePath ? p.filePath : undefined;
        const fs = typeof p.fileSize === "number" && p.fileSize > 0 ? p.fileSize : undefined;
        const lang =
          typeof p.lang === "string" && p.lang.trim() ? p.lang.trim() : undefined;
        const processDocIx: boolean =
          p.process_doc_index_doc != null
            ? !!p.process_doc_index_doc
            : defaultIndexDocContentRef.current;

        const meetingUpsert = p.meetingCaptionsUpsert === true;
        const rawStableId = typeof p.id === "string" ? p.id.trim() : "";

        let row: OffSessionNote;
        if (p.kind === "document") {
          const summary = typeof p.summary === "string" ? p.summary : "";
          if (!summary.trim() || !fp) return;
          row = {
            id: crypto.randomUUID(),
            kind: "document",
            summary: summary.trim(),
            createdAt,
            ...(exp !== undefined ? { explanation: exp } : {}),
            ...(cf !== undefined ? { contextFocus: cf } : {}),
            filePath: fp,
            ...(fs !== undefined ? { fileSize: fs } : {}),
            mediaKind: "file",
            ...(lang !== undefined ? { lang } : {}),
            process_doc_index_doc: processDocIx,
          };
        } else {
          const text = p.text;
          if (typeof text !== "string") return;
          const sourceRaw = p.source;
          const src =
            sourceRaw !== undefined && sourceRaw !== null
              ? parseContextNoteSource(sourceRaw)
              : undefined;
          const rawMk = p.mediaKind;
          const mediaKind =
            rawMk === "file" ||
            rawMk === "text" ||
            rawMk === "image" ||
            rawMk === "video"
              ? rawMk
              : undefined;
          const noteId =
            meetingUpsert && rawStableId ? rawStableId : crypto.randomUUID();
          const isMeetNote = src === "googleMeet";
          row = {
            id: noteId,
            text,
            ...(exp !== undefined ? { explanation: exp } : {}),
            createdAt,
            ...(src != null ? { source: src } : {}),
            ...(cf !== undefined ? { contextFocus: cf } : {}),
            ...(fp !== undefined ? { filePath: fp } : {}),
            ...(fs !== undefined ? { fileSize: fs } : {}),
            ...(mediaKind !== undefined ? { mediaKind } : {}),
            ...(lang !== undefined ? { lang } : {}),
            ...(isMeetNote ? { indexMeetRawTranscript: defaultIndexMeetTranscriptRef.current } : {}),
          };
        }

        if (!loadCompleteRef.current) {
          console.log("[capture:note:RAW] buffered (load not complete yet)");
          if (meetingUpsert && rawStableId && p.kind !== "document") {
            const buf = offSessionBufferRef.current.notes;
            const bi = buf.findIndex((n) => n.id === rawStableId);
            if (bi >= 0) {
              const cur = buf[bi]!;
              if (cur.kind !== "document") {
                const priorMeetExp = (cur.explanation ?? "").trim();
                if (priorMeetExp) meetManualResyncSkipSummaryRef.current.add(rawStableId);
                else meetManualResyncSkipSummaryRef.current.delete(rawStableId);
                buf[bi] = { ...cur, text: row.text, ...(row.source !== undefined ? { source: row.source } : {}) };
              }
            } else if (!buf.some((n) => offSessionNotesDedupSame(n, row))) {
              meetManualResyncSkipSummaryRef.current.delete(rawStableId);
              buf.unshift(row);
            }
            return;
          }
          if (!offSessionBufferRef.current.notes.some((n) => offSessionNotesDedupSame(n, row))) {
            offSessionBufferRef.current.notes.unshift(row);
          }
          return;
        }
        // Passive copy-monitor only (`copyHistory`). ⌘⌥V / tray paste uses `clipboard` → captures.
        if (row.source === "copyHistory") {
          console.log(`[copy-history] new copyHistory entry id=${row.id}`);
          let added = false;
          setCopyHistoryNotes((prev) => {
            if (prev.some((n) => offSessionNotesDedupSame(n, row))) return prev;
            added = true;
            const ms = captureHistoryRetentionMs(captureHistoryRetentionRef.current);
            return pruneCopyHistoryNotesByRetention([row, ...prev], ms);
          });
          if (added) triggerHistoryFlash();
          return;
        }
        if (meetingUpsert && rawStableId && p.kind !== "document") {
          const priorFromLive = offSessionNotesRef.current
            .find((n) => n.id === rawStableId)
            ?.explanation?.trim();
          const priorFromBuf = offSessionBufferRef.current.notes
            .find((n) => n.id === rawStableId)
            ?.explanation?.trim();
          const priorMeetExp = (priorFromLive ?? priorFromBuf ?? "").trim();
          if (priorMeetExp) meetManualResyncSkipSummaryRef.current.add(rawStableId);
          else meetManualResyncSkipSummaryRef.current.delete(rawStableId);
          setOffSessionNotes((prev) => {
            const j = prev.findIndex((n) => n.id === rawStableId);
            if (j >= 0) {
              const cur = prev[j]!;
              if (cur.kind === "document") return prev;
              return prev.map((n, idx) =>
                idx === j
                  ? {
                      ...cur,
                      text: row.text,
                      ...(row.source !== undefined ? { source: row.source } : {}),
                      ...(row.explanation !== undefined ? { explanation: row.explanation } : {}),
                      ...(row.lang !== undefined ? { lang: row.lang } : {}),
                    }
                  : n
              );
            }
            const ids = autoTagIds({ appName: row.contextFocus?.appName ?? undefined });
            const rowWithTags = ids.length ? { ...row, tagIds: ids } : row;
            return [rowWithTags, ...prev];
          });
          return;
        }
        console.log(`[capture:note] new note id=${row.id} source=${row.source ?? "?"} kind=${row.kind ?? "text"} appName="${row.contextFocus?.appName}" autoAssignTags=${autoAssignTagsRef.current} autoScanSensitive=${autoScanSensitiveRef.current}`);
        const ids = autoTagIds({ appName: row.contextFocus?.appName ?? undefined });
        const rowWithTags = ids.length ? { ...row, tagIds: ids } : row;
        if (userIdRef.current) {
          const uid = userIdRef.current;
          localSaveCapture(uid, noteToSaveReq(rowWithTags, uid))
            .then(() => {
              setOffSessionNotes((prev) =>
                prev.some((n) => offSessionNotesDedupSame(n, rowWithTags)) ? prev : [rowWithTags, ...prev]
              );
              if (
                (autoScanSensitiveRef.current && sensitiveScanModelRef.current !== "disabled") ||
                (autoAssignTagsRef.current && sensitiveScanModelRef.current !== "disabled")
              ) {
                setProcessingIds((prev) => new Set([...prev, rowWithTags.id]));
              }
            })
            .catch((err) => console.error(`[capture:note] DB save failed, not adding to state:`, err));
        }
      }
    ).then((fn) => {
      unNote = fn;
    });

    const pImg = listen<OffSessionImagePayload>(
      OFF_SESSION_IMAGE_EVENT,
      (event) => {
        const { path, createdAt, contextFocus: cfRaw, fileSize: payloadFileSize } = event.payload;
        console.log(`[capture:image:RAW] event received - path=${path} loadComplete=${loadCompleteRef.current} userId=${!!userIdRef.current}`);
        if (typeof path !== "string" || typeof createdAt !== "string") { console.warn("[capture:image:RAW] dropped - invalid payload"); return; }
        if (!userIdRef.current) { console.warn("[capture:image:RAW] dropped - no userId"); return; }
        const cf = parseOffSessionContextFocus(cfRaw);
        const fileSize = typeof payloadFileSize === "number" && payloadFileSize > 0 ? payloadFileSize : undefined;
        const row: OffSessionImage = {
          id: crypto.randomUUID(),
          path,
          createdAt,
          mediaKind: "image",
          ...(cf !== undefined ? { contextFocus: cf } : {}),
          ...(fileSize !== undefined ? { fileSize } : {}),
        };
        if (!loadCompleteRef.current) {
          console.log("[capture:image:RAW] buffered");
          if (!offSessionBufferRef.current.images.some((i) => i.path === row.path)) {
            offSessionBufferRef.current.images.unshift(row);
          }
          return;
        }
        console.log(`[capture:image] new image id=${row.id} appName="${row.contextFocus?.appName}" autoAssignTags=${autoAssignTagsRef.current}`);
        const ids = autoTagIds({ appName: row.contextFocus?.appName ?? undefined });
        console.log(`[capture:image] autoTag appName-match: ${ids.length} tag(s):`, ids);
        const rowWithTags = ids.length ? { ...row, tagIds: ids } : row;
        const imgAlreadyKnown = offSessionImagesRef.current.some((i) => i.path === rowWithTags.path);
        if (!imgAlreadyKnown && userIdRef.current) {
          const uid = userIdRef.current;
          localSaveCapture(uid, imageToSaveReq(rowWithTags, uid))
            .then(() => setOffSessionImages((prev) => prev.some((i) => i.path === rowWithTags.path) ? prev : [rowWithTags, ...prev]))
            .catch((err) => console.error(`[capture:image] DB save failed, not adding to state:`, err));
        }
      }
    ).then((fn) => {
      unImg = fn;
    });

    const pVid = listen<OffSessionVideoPayload>(
      OFF_SESSION_VIDEO_EVENT,
      (event) => {
        const {
          path,
          createdAt,
          contextFocus: cfRaw,
          thumbnailPath,
          transcription,
          lang: vidLang,
          fileSize: payloadFileSize,
        } = event.payload;
        console.log(`[capture:video:RAW] event received - path=${path} loadComplete=${loadCompleteRef.current} userId=${!!userIdRef.current}`);
        if (typeof path !== "string" || typeof createdAt !== "string") { console.warn("[capture:video:RAW] dropped - invalid payload"); return; }
        if (!userIdRef.current) { console.warn("[capture:video:RAW] dropped - no userId"); return; }
        const cf = parseOffSessionContextFocus(cfRaw);
        const lang =
          typeof vidLang === "string" && vidLang.trim() ? vidLang.trim() : undefined;
        const fileSize = typeof payloadFileSize === "number" && payloadFileSize > 0 ? payloadFileSize : undefined;
        const row: OffSessionVideo = {
          id: crypto.randomUUID(),
          path,
          createdAt,
          mediaKind: "video",
          ...(cf !== undefined ? { contextFocus: cf } : {}),
          ...(typeof thumbnailPath === "string" ? { thumbnailPath } : {}),
          ...(typeof transcription === "string" && transcription.trim() ? { transcription: transcription.trim() } : {}),
          ...(lang !== undefined ? { lang } : {}),
          ...(fileSize !== undefined ? { fileSize } : {}),
        };
        if (!loadCompleteRef.current) {
          console.log("[capture:video:RAW] buffered");
          if (!offSessionBufferRef.current.videos.some((v) => v.path === row.path)) {
            offSessionBufferRef.current.videos.unshift(row);
          }
          return;
        }
        console.log(`[capture:video] new video id=${row.id} appName="${row.contextFocus?.appName}" autoAssignTags=${autoAssignTagsRef.current}`);
        const ids = autoTagIds({ appName: row.contextFocus?.appName ?? undefined });
        const rowWithTags = ids.length ? { ...row, tagIds: ids } : row;
        const vidAlreadyKnown = offSessionVideosRef.current.some((v) => v.path === rowWithTags.path);
        if (!vidAlreadyKnown && userIdRef.current) {
          const uid = userIdRef.current;
          localSaveCapture(uid, videoToSaveReq(rowWithTags, uid))
            .then(() => setOffSessionVideos((prev) => prev.some((v) => v.path === rowWithTags.path) ? prev : [rowWithTags, ...prev]))
            .catch((err) => console.error(`[capture:video] DB save failed, not adding to state:`, err));
        }
        if (
          (typeof transcription === "string" && transcription.trim()) &&
          ((autoScanSensitiveRef.current && sensitiveScanModelRef.current !== "disabled") ||
           (autoAssignTagsRef.current && sensitiveScanModelRef.current !== "disabled"))
        ) {
          setProcessingIds((prev) => new Set([...prev, rowWithTags.id]));
        }
      }
    ).then((fn) => {
      unVid = fn;
    });

    return () => {
      void pNote.then(() => unNote?.());
      void pImg.then(() => unImg?.());
      void pVid.then(() => unVid?.());
    };
  }, []);


  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "localLlmParallelCalls") : "localLlmParallelCalls";
    void store.set(key, localLlmParallelCalls).then(() => store.save()).catch(console.error);
  }, [localLlmParallelCalls, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "embedThreads") : "embedThreads";
    void store.set(key, embedThreads).then(() => store.save()).catch(console.error);
  }, [embedThreads, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "embedOpenAiBatchSize") : "embedOpenAiBatchSize";
    void store.set(key, embedOpenAiBatchSize).then(() => store.save()).catch(console.error);
  }, [embedOpenAiBatchSize, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "embedOpenAiParallel") : "embedOpenAiParallel";
    void store.set(key, embedOpenAiParallel).then(() => store.save()).catch(console.error);
  }, [embedOpenAiParallel, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "openAiApiKey") : "openAiApiKey";
    void store.set(key, openAiApiKey).then(() => store.save()).catch(console.error);
  }, [openAiApiKey, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "assistantModel") : "assistantModel";
    void store.set(key, assistantModel).then(() => store.save()).catch(console.error);
  }, [assistantModel, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const keySens = uid ? sessionStoreKeyForUser(uid, "sensitiveScanModel") : "sensitiveScanModel";
    const keyTag = uid ? sessionStoreKeyForUser(uid, "autoTagModel") : "autoTagModel";
    void Promise.all([store.set(keySens, sensitiveScanModel), store.set(keyTag, sensitiveScanModel)])
      .then(() => store.save())
      .catch(console.error);
  }, [sensitiveScanModel, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "pdfWarnThreshold") : "pdfWarnThreshold", pdfWarnThreshold)
      .then(() => store.save()).catch(console.error);
  }, [pdfWarnThreshold, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "pdfSummaryLang") : "pdfSummaryLang", pdfSummaryLang)
      .then(() => store.save()).catch(console.error);
  }, [pdfSummaryLang, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "pdfPagesMode") : "pdfPagesMode", pdfPagesMode)
      .then(() => store.save()).catch(console.error);
  }, [pdfPagesMode, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "pdfPagesCount") : "pdfPagesCount", pdfPagesCount)
      .then(() => store.save()).catch(console.error);
  }, [pdfPagesCount, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "pdfPagesPercent") : "pdfPagesPercent", pdfPagesPercent)
      .then(() => store.save()).catch(console.error);
  }, [pdfPagesPercent, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const pdfKey = uid ? sessionStoreKeyForUser(uid, "pdfModelFilename") : "pdfModelFilename";
    const meetModelKey = uid ? sessionStoreKeyForUser(uid, "googleMeetSummaryModel") : "googleMeetSummaryModel";
    void Promise.all([
      store.set(pdfKey, pdfModelFilename),
      store.set(meetModelKey, pdfModelFilename),
    ])
      .then(() => store.save())
      .catch(console.error);
  }, [pdfModelFilename, loaded]);

  useEffect(() => {
    setGoogleMeetSummaryModel((m) => (m === pdfModelFilename ? m : pdfModelFilename));
  }, [pdfModelFilename]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "pdfParallelism") : "pdfParallelism", pdfParallelism)
      .then(() => store.save()).catch(console.error);
  }, [pdfParallelism, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "defaultIndexDocContent") : "defaultIndexDocContent", defaultIndexDocContent)
      .then(() => store.save()).catch(console.error);
  }, [defaultIndexDocContent, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "autoIndexEnabled") : "autoIndexEnabled", autoIndexEnabled)
      .then(() => store.save()).catch(console.error);
  }, [autoIndexEnabled, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "defaultIndexMeetTranscript") : "defaultIndexMeetTranscript", defaultIndexMeetTranscript)
      .then(() => store.save()).catch(console.error);
  }, [defaultIndexMeetTranscript, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX) && !hasOpenAiApiKey) {
      setSensitiveScanModel("disabled");
      setAutoScanSensitive(false);
    }
  }, [hasOpenAiApiKey, loaded, sensitiveScanModel]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "dictationProvider") : "dictationProvider";
    void store.set(key, dictationProvider).then(() => store.save()).catch(console.error);
  }, [dictationProvider, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (dictationProvider === DICTATION_PROVIDER_OPENAI_WHISPER_1 && !hasOpenAiApiKey) {
      setDictationProvider(DICTATION_PROVIDER_LOCAL);
    }
  }, [dictationProvider, hasOpenAiApiKey, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const payload =
      dictationProvider === DICTATION_PROVIDER_OPENAI_WHISPER_1
        ? { provider: dictationProvider, openaiApiKey: openAiApiKey.trim() }
        : { provider: DICTATION_PROVIDER_LOCAL, openaiApiKey: "" };
    void invoke("set_dictation_provider_cmd", payload).catch(console.error);
  }, [dictationProvider, openAiApiKey, loaded]);

  useEffect(() => {
    if (!loaded) return;
    // Until Qwen catalog is fetched, `qwenStatus` is null and `hasLocal` would read false — same tick as
    // `loaded` we would wrongly force Tags & sensitive to Disabled and persist cleared auto-scan / auto-assign.
    // Custom dictation has no equivalent guardrail; wait for status like we wait for real catalog data.
    if (qwenStatus == null) return;
    const hasLocal = qwenStatus.models.length > 0;
    const noModelsAtAll = !hasLocal && !hasOpenAiApiKey;
    if (noModelsAtAll && sensitiveScanModel !== "disabled") setSensitiveScanModel("disabled");
    if (sensitiveScanModel === "disabled") {
      setAutoAssignTags(false);
      setAutoScanSensitive(false);
    }
  }, [sensitiveScanModel, hasOpenAiApiKey, qwenStatus, loaded]);

  // Migrate legacy sensitiveScanModel "local" → "local:<filename>" once qwenStatus is available
  useEffect(() => {
    if (!loaded || sensitiveScanModel !== "local") return;
    const firstInstalled = qwenStatus?.models.find((m) => m.installed);
    if (firstInstalled) setSensitiveScanModel(`local:${firstInstalled.filename}`);
  }, [loaded, sensitiveScanModel, qwenStatus?.models]);

  useEffect(() => {
    if (!loaded) return;
    if (pdfModelFilename.startsWith(OPENAI_MODEL_PREFIX) && !hasOpenAiApiKey) {
      setPdfModelFilename("");
    }
  }, [hasOpenAiApiKey, loaded, pdfModelFilename]);

  useEffect(() => {
    if (!loaded) return;
    if (isAssistantDirectOpenAiModel(assistantModel) && !hasOpenAiApiKey) {
      setAssistantModel(ASSISTANT_MODEL_DISABLED);
    }
  }, [hasOpenAiApiKey, loaded, assistantModel]);


  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "autoScanSensitive") : "autoScanSensitive", autoScanSensitive)
      .then(() => store.save()).catch(console.error);
  }, [autoScanSensitive, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid
      ? sessionStoreKeyForUser(uid, "meetSensitiveScanIncludeRawTranscript")
      : "meetSensitiveScanIncludeRawTranscript";
    void Promise.all([
      store.set(key, meetSensitiveScanIncludeRawTranscript),
    ])
      .then(() => store.save())
      .catch(console.error);
  }, [meetSensitiveScanIncludeRawTranscript, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "autoAssignTags") : "autoAssignTags", autoAssignTags)
      .then(() => store.save()).catch(console.error);
  }, [autoAssignTags, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "autoTagTextLimit") : "autoTagTextLimit", autoTagTextLimit)
      .then(() => store.save()).catch(console.error);
  }, [autoTagTextLimit, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "captureHistoryRetention") : "captureHistoryRetention";
    void store.set(key, captureHistoryRetention).then(() => store.save()).catch(console.error);
  }, [captureHistoryRetention, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const ms = captureHistoryRetentionMs(captureHistoryRetention);
    setCopyHistoryNotes((prev) => pruneCopyHistoryNotesByRetention(prev, ms));
    setDictationFieldInjects((prev) => pruneDictationHistoryInjectsByRetention(prev, ms));
  }, [captureHistoryRetention, loaded]);

  // Auto-patch notes whose text is a bare URL to source: "link"
  useEffect(() => {
    if (!loaded) return;
    setOffSessionNotes((prev) => {
      const next = prev.map((n) => {
        if (n.source === "link") return n;
        if (n.kind === "document") return n;
        if (isLinkNote(n.text)) return { ...n, source: "link" as ContextNoteSource };
        return n;
      });
      return next.some((n, i) => n !== prev[i]) ? next : prev;
    });
  }, [loaded, offSessionNotes.length]);

  // Keep a ref so the tray-note settings listener always sees current values without re-registering.
  const pdfSettingsForTrayRef = useRef({
    modelFilename: pdfModelFilename,
    openaiApiKey: openAiApiKey,
    summaryLang: pdfSummaryLang,
    pagesMode: pdfPagesMode,
    pagesCount: pdfPagesCount,
    pagesPercent: pdfPagesPercent,
    warnThreshold: pdfWarnThreshold,
    parallelism: pdfParallelism,
  });
  useEffect(() => {
    pdfSettingsForTrayRef.current = {
      modelFilename: pdfModelFilename,
      openaiApiKey: openAiApiKey,
      summaryLang: pdfSummaryLang,
      pagesMode: pdfPagesMode,
      pagesCount: pdfPagesCount,
      pagesPercent: pdfPagesPercent,
      warnThreshold: pdfWarnThreshold,
      parallelism: pdfParallelism,
    };
  }, [openAiApiKey, pdfModelFilename, pdfSummaryLang, pdfPagesMode, pdfPagesCount, pdfPagesPercent, pdfWarnThreshold, pdfParallelism]);

  /** Répond aux requêtes de settings PDF depuis la fenêtre tray-note. */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const promise = listen("kts:tray-note/request-pdf-settings", () => {
      void emit("kts:tray-note/pdf-settings", pdfSettingsForTrayRef.current);
    }).then((fn) => { unlisten = fn; });
    return () => { void promise.then(() => { safeInvokeUnlisten(unlisten); }); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Répond aux requêtes d'historique (dictation + clipboard) depuis la fenêtre tray-note. */
  const copyHistoryNotesRef = useRef(copyHistoryNotes);
  useEffect(() => { copyHistoryNotesRef.current = copyHistoryNotes; }, [copyHistoryNotes]);
  const dictationFieldInjectsRef = useRef(dictationFieldInjects);
  useEffect(() => { dictationFieldInjectsRef.current = dictationFieldInjects; }, [dictationFieldInjects]);
  const keepDictationHistoryRef = useRef(keepDictationHistory);
  useEffect(() => { keepDictationHistoryRef.current = keepDictationHistory; }, [keepDictationHistory]);
  const captureTagsRef = useRef(captureTags);
  useEffect(() => { captureTagsRef.current = captureTags; }, [captureTags]);
  const autoScanSensitiveRef = useRef(autoScanSensitive);
  useEffect(() => { autoScanSensitiveRef.current = autoScanSensitive; }, [autoScanSensitive]);
  const meetSensitiveScanIncludeRawTranscriptRef = useRef(meetSensitiveScanIncludeRawTranscript);
  useEffect(() => {
    meetSensitiveScanIncludeRawTranscriptRef.current = meetSensitiveScanIncludeRawTranscript;
  }, [meetSensitiveScanIncludeRawTranscript]);
  const autoAssignTagsRef = useRef(autoAssignTags);
  useEffect(() => { autoAssignTagsRef.current = autoAssignTags; }, [autoAssignTags]);
  const sensitiveScanModelRef = useRef(sensitiveScanModel);
  useEffect(() => { sensitiveScanModelRef.current = sensitiveScanModel; }, [sensitiveScanModel]);
  const openAiApiKeyRef = useRef(openAiApiKey);
  useEffect(() => { openAiApiKeyRef.current = openAiApiKey; }, [openAiApiKey]);

  // Draining the indexing queue is Rust's job now (`auto_index.rs`): it reads the
  // active profile and this same auto-indexing setting from the session store on
  // every tick, so captures keep being indexed while the window is hidden.
  const autoTagTextLimitRef = useRef(autoTagTextLimit);
  useEffect(() => { autoTagTextLimitRef.current = autoTagTextLimit; }, [autoTagTextLimit]);
  const googleMeetSummaryModelRef = useRef(googleMeetSummaryModel);
  useEffect(() => {
    googleMeetSummaryModelRef.current = googleMeetSummaryModel;
  }, [googleMeetSummaryModel]);
  const googleMeetSummaryPromptRef = useRef(googleMeetSummaryPrompt);
  useEffect(() => {
    googleMeetSummaryPromptRef.current = googleMeetSummaryPrompt;
  }, [googleMeetSummaryPrompt]);
  const googleMeetSummaryLangRef = useRef(googleMeetSummaryLang);
  useEffect(() => {
    googleMeetSummaryLangRef.current = googleMeetSummaryLang;
  }, [googleMeetSummaryLang]);
  const preferredOutputLangRef = useRef(preferredOutputLang);
  useEffect(() => {
    preferredOutputLangRef.current = preferredOutputLang;
  }, [preferredOutputLang]);
  const pdfModelFilenameRef = useRef(pdfModelFilename);
  useEffect(() => {
    pdfModelFilenameRef.current = pdfModelFilename;
  }, [pdfModelFilename]);
  const pdfSummaryLangRef = useRef(pdfSummaryLang);
  useEffect(() => {
    pdfSummaryLangRef.current = pdfSummaryLang;
  }, [pdfSummaryLang]);
  const authenticatedFetchRef = useRef(authenticatedFetch);
  useEffect(() => {
    authenticatedFetchRef.current = authenticatedFetch;
  }, [authenticatedFetch]);
  const meetSummaryFlightRef = useRef<Set<string>>(new Set());

  const endProcessing = (id: string) => setProcessingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });

  // Seed submittedProcessRef with all IDs that existed at load time - they are never auto-processed.
  // Must be defined BEFORE the processing effects so it runs first.
  useEffect(() => {
    if (!loaded) return;
    for (const n of offSessionNotesRef.current) submittedProcessRef.current.add(n.id);
    for (const i of offSessionImagesRef.current) submittedProcessRef.current.add(i.id);
    for (const v of offSessionVideosRef.current) submittedProcessRef.current.add(v.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Auto-process new notes. processingIds is already set by the event handler in the same React
  // batch as the capture, so the spinner shows on first render. The effect starts the actual work.
  useEffect(() => {
    if (!loaded) return;
    type Item = { id: string; rawText: string; explanation: string; scanText: string; willLLM: boolean; willScan: boolean; appName: string; windowTitle: string; captureKind: "note" | "document" };
    const toProcess: Item[] = [];
    for (const note of offSessionNotes) {
      const captureKind: "note" | "document" = note.kind === "document" ? "document" : "note";
      const rawText = captureKind === "document" ? (note.summary ?? "") : (note.text ?? "");
      const explanation = note.explanation ?? "";
      const isGoogleMeet = captureKind === "note" && note.source === "googleMeet";
      const resolvedMeetModel = (
        googleMeetSummaryModel.trim() || pdfModelFilename.trim()
      ).trim();
      const waitingForMeetAutoSummary =
        isGoogleMeet &&
        !explanation.trim() &&
        resolvedMeetModel !== "" &&
        resolvedMeetModel !== "disabled";
      if (waitingForMeetAutoSummary) {
        continue;
      }
      if (submittedProcessRef.current.has(note.id)) continue;
      /** Meet: by default sensitive-scan only Explanation; optional full raw transcript (Settings). */
      const scanText = isGoogleMeet
        ? meetSensitiveScanIncludeRawTranscriptRef.current
          ? `${rawText.trim()}\n\n${explanation.trim()}`.trim()
          : explanation.trim()
        : rawText.trim();
      const willLLM =
        autoAssignTagsRef.current &&
        sensitiveScanModelRef.current !== "disabled" &&
        (isGoogleMeet
          ? !!explanation.trim()
          : !!(
              rawText.trim() ||
              explanation.trim() ||
              note.contextFocus?.appName ||
              note.contextFocus?.windowName
            ));
      const willScan =
        !note.sensitiveVerdict && autoScanSensitiveRef.current && sensitiveScanModelRef.current !== "disabled" && !!scanText.trim();
      const appName = isGoogleMeet ? GOOGLE_MEET_CAPTURE_APP_NAME : (note.contextFocus?.appName ?? "");
      const windowTitle = isGoogleMeet ? GOOGLE_MEET_CAPTURE_WINDOW_NAME : (note.contextFocus?.windowName ?? "");
      console.log(`[autoProcess:note] id=${note.id} kind=${captureKind} willLLM=${willLLM} willScan=${willScan} | autoAssignTags=${autoAssignTagsRef.current} tagSensitiveModel=${sensitiveScanModelRef.current} rawTextLen=${rawText.trim().length} expLen=${explanation.trim().length} | autoScanSensitive=${autoScanSensitiveRef.current} sensitiveScanModel=${sensitiveScanModelRef.current}`);
      if (willLLM || willScan) {
        toProcess.push({ id: note.id, rawText, explanation, scanText, willLLM, willScan, appName, windowTitle, captureKind });
      } else {
        submittedProcessRef.current.add(note.id);
        endProcessing(note.id);
      }
    }
    if (toProcess.length === 0) return;
    let tid: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      tid = setTimeout(() => {
        for (const item of toProcess) {
          if (submittedProcessRef.current.has(item.id)) continue;
          submittedProcessRef.current.add(item.id);
          const ops: Promise<void>[] = [];
          if (item.willLLM) ops.push(autoTagIdsLLM({ captureId: item.id, kind: item.captureKind, appName: item.appName, windowTitle: item.windowTitle, rawText: item.rawText, explanation: item.explanation }));
          if (item.willScan) ops.push(autoScanCapture("note", item.id, item.scanText, item.appName, item.windowTitle));
          void Promise.all(ops).finally(() => endProcessing(item.id));
        }
      }, 0);
    });
    return () => { cancelAnimationFrame(raf); if (tid !== undefined) clearTimeout(tid); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offSessionNotes, loaded]);

  // Auto-process new videos.
  useEffect(() => {
    if (!loaded) return;
    type Item = { id: string; rawText: string; explanation: string; scanText: string; willLLM: boolean; willScan: boolean; appName: string; windowTitle: string };
    const toProcess: Item[] = [];
    for (const video of offSessionVideos) {
      if (submittedProcessRef.current.has(video.id)) continue;
      const rawText = (video.transcription ?? "").trim();
      // No transcription yet: do not mark submitted - a later update (e.g. after Whisper) must be able to run scan/tag.
      if (!rawText) continue;
      const explanation = video.explanation ?? "";
      const scanText = rawText;
      const appName = video.contextFocus?.appName ?? "";
      const windowTitle = video.contextFocus?.windowName ?? "";
      const willLLM = autoAssignTagsRef.current && sensitiveScanModelRef.current !== "disabled";
      const willScan = autoScanSensitiveRef.current && sensitiveScanModelRef.current !== "disabled";
      console.log(`[autoProcess:video] id=${video.id} willLLM=${willLLM} willScan=${willScan} | autoAssignTags=${autoAssignTagsRef.current} tagSensitiveModel=${sensitiveScanModelRef.current} rawTextLen=${rawText.length} | autoScanSensitive=${autoScanSensitiveRef.current} sensitiveScanModel=${sensitiveScanModelRef.current}`);
      if (willLLM || willScan) {
        toProcess.push({ id: video.id, rawText, explanation, scanText, willLLM, willScan, appName, windowTitle });
      } else {
        submittedProcessRef.current.add(video.id);
        endProcessing(video.id);
      }
    }
    if (toProcess.length === 0) return;
    let tid: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      tid = setTimeout(() => {
        for (const item of toProcess) {
          if (submittedProcessRef.current.has(item.id)) continue;
          submittedProcessRef.current.add(item.id);
          const ops: Promise<void>[] = [];
          if (item.willLLM) ops.push(autoTagIdsLLM({ captureId: item.id, kind: "video", appName: item.appName, windowTitle: item.windowTitle, rawText: item.rawText, explanation: item.explanation }));
          if (item.willScan) ops.push(autoScanCapture("video", item.id, item.scanText, item.appName, item.windowTitle));
          void Promise.all(ops).finally(() => endProcessing(item.id));
        }
      }, 0);
    });
    return () => { cancelAnimationFrame(raf); if (tid !== undefined) clearTimeout(tid); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offSessionVideos, loaded]);

  // Auto-process images once OCR text arrives.
  useEffect(() => {
    if (!loaded) return;
    type Item = { id: string; rawText: string; scanText: string; willScan: boolean; willLLM: boolean; appName: string; windowTitle: string };
    const toProcess: Item[] = [];
    for (const img of offSessionImages) {
      if (submittedProcessRef.current.has(img.id)) continue;
      const ocrText = ocrTextByPath[img.path];
      if (!ocrText?.trim()) continue;
      const appName = img.contextFocus?.appName ?? "";
      const windowTitle = img.contextFocus?.windowName ?? "";
      const willScan = !img.sensitiveVerdict && autoScanSensitiveRef.current && sensitiveScanModelRef.current !== "disabled";
      const willLLM = autoAssignTagsRef.current && sensitiveScanModelRef.current !== "disabled";
      console.log(`[autoProcess:image] id=${img.id} willLLM=${willLLM} willScan=${willScan} | autoAssignTags=${autoAssignTagsRef.current} tagSensitiveModel=${sensitiveScanModelRef.current} ocrTextLen=${ocrText.trim().length} | autoScanSensitive=${autoScanSensitiveRef.current} sensitiveScanModel=${sensitiveScanModelRef.current}`);
      if (willScan || willLLM) {
        toProcess.push({ id: img.id, rawText: ocrText, scanText: ocrText, willScan, willLLM, appName, windowTitle });
      } else {
        submittedProcessRef.current.add(img.id);
        endProcessing(img.id);
      }
    }
    if (toProcess.length === 0) return;
    let tid: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      tid = setTimeout(() => {
        for (const item of toProcess) {
          if (submittedProcessRef.current.has(item.id)) continue;
          submittedProcessRef.current.add(item.id);
          const ops: Promise<void>[] = [];
          if (item.willScan) ops.push(autoScanCapture("image", item.id, item.scanText, item.appName, item.windowTitle));
          if (item.willLLM) ops.push(autoTagIdsLLM({ captureId: item.id, kind: "image", appName: item.appName, windowTitle: item.windowTitle, rawText: item.rawText }));
          void Promise.all(ops).finally(() => endProcessing(item.id));
        }
      }, 0);
    });
    return () => { cancelAnimationFrame(raf); if (tid !== undefined) clearTimeout(tid); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocrTextByPath, offSessionImages, loaded]);

  const autoScanCapture = async (
    kind: "note" | "image" | "video",
    id: string,
    text: string,
    appName: string,
    windowTitle: string,
  ): Promise<void> => {
    if (!autoScanSensitiveRef.current) return;
    const model = sensitiveScanModelRef.current;
    if (model === "disabled") return;
    const scanUsesRemote = model.startsWith(OPENAI_MODEL_PREFIX);
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += SENSITIVE_SCAN_CHUNK_CHARS) {
      chunks.push(text.slice(i, i + SENSITIVE_SCAN_CHUNK_CHARS));
    }
    console.log(`[autoScan] starting ${kind}=${id} model=${model} textLen=${text.length} chunks=${chunks.length}`);
    try {
      let worst: "critical" | "potential" | "clean" = "clean";
      for (const chunk of chunks) {
        let r = await invoke<SensitivePreviewResponse>("sensitive_preview_run_cmd", {
          req: { text: chunk, displayApp: appName, windowTitle },
          sensitiveScanModel: scanUsesRemote ? model : null,
          openaiApiKey: model.startsWith(OPENAI_MODEL_PREFIX) ? openAiApiKeyRef.current.trim() : null,
        });
        if (r.parsed === null) {
          r = await invoke<SensitivePreviewResponse>("sensitive_preview_run_cmd", {
            req: { text: chunk, displayApp: appName, windowTitle },
            sensitiveScanModel: scanUsesRemote ? model : null,
            openaiApiKey: model.startsWith(OPENAI_MODEL_PREFIX) ? openAiApiKeyRef.current.trim() : null,
          });
        }
        if (r.parsed !== null) {
          const v: "critical" | "potential" | "clean" = r.parsed === -1 ? "critical" : r.parsed === 0 ? "potential" : "clean";
          if (v === "critical" || (v === "potential" && worst === "clean")) worst = v;
        }
        if (worst === "critical") break;
      }
      console.log(`[autoScan] done ${kind}=${id} worst=${worst}`);
      if (kind === "note") { const n = offSessionNotesRef.current.find((n) => n.id === id); if (n) { const u = { ...n, sensitiveVerdict: worst }; setOffSessionNotes((prev) => prev.map((x) => x.id === id ? u : x)); if (userIdRef.current) void localSaveCapture(userIdRef.current, noteToSaveReq(u, userIdRef.current)).catch(console.error); } }
      else if (kind === "image") { const img = offSessionImagesRef.current.find((i) => i.id === id); if (img) { const u = { ...img, sensitiveVerdict: worst }; setOffSessionImages((prev) => prev.map((x) => x.id === id ? u : x)); if (userIdRef.current) void localSaveCapture(userIdRef.current, imageToSaveReq(u, userIdRef.current)).catch(console.error); } }
      else if (kind === "video") { const vid = offSessionVideosRef.current.find((v) => v.id === id); if (vid) { const u = { ...vid, sensitiveVerdict: worst }; setOffSessionVideos((prev) => prev.map((x) => x.id === id ? u : x)); if (userIdRef.current) void localSaveCapture(userIdRef.current, videoToSaveReq(u, userIdRef.current)).catch(console.error); } }
    } catch (err) {
      console.error(`[autoScan] error (${kind}=${id}):`, err);
    }
  };

  // eslint-disable-next-line no-control-regex
  const normalizeTagStr = (s: string) => s.replace(/[\u0000-\u001F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "").trim().toLowerCase();

  const truncateAutoTagFields = (rawText: string, explanation: string | undefined, limit: number): { raw: string; exp: string } => {
    let raw = rawText.trim();
    let exp = (explanation ?? "").trim();
    const combined = raw.length + exp.length;
    if (combined > limit) {
      const rawRatio = combined > 0 ? raw.length / combined : 1;
      const rawAlloc = Math.floor(limit * rawRatio);
      const expAlloc = limit - rawAlloc;
      if (raw.length > rawAlloc) raw = raw.slice(0, Math.max(0, rawAlloc - 3)) + "...";
      if (exp.length > expAlloc) exp = exp.slice(0, Math.max(0, expAlloc - 3)) + "...";
    }
    return { raw, exp };
  };

  /** Same parsing as local/OpenAI auto-tag (numeric short IDs or raw UUID). */
  const parseAutoTagIdsFromCommaRaw = (
    raw: string,
    tIndexed: Array<CaptureTag & { shortId: string }>,
    allTags: CaptureTag[],
  ): string[] => {
    const normalized = raw.trim().toLowerCase();
    if (!normalized || normalized === "none") return [];
    return normalized
      .split(/[\s,]+/)
      .map((token) => token.replace(/['"]/g, "").trim())
      .map((token) => {
        const idx = parseInt(token, 10) - 1;
        if (!Number.isNaN(idx) && idx >= 0 && idx < tIndexed.length) return tIndexed[idx].id;
        return allTags.find((t) => t.id === token)?.id ?? null;
      })
      .filter((id): id is string => id !== null);
  };

  const autoTagIds = (opts: { appName?: string }): string[] => {
    const tags = captureTagsRef.current;
    if (tags.length === 0 || !autoAssignTagsRef.current) return [];
    if (!opts.appName) return [];
    const normApp = normalizeTagStr(opts.appName);
    if (!normApp) return [];
    const matched = tags.filter((t) => t.autoAssignApps.some((a) => normalizeTagStr(a) === normApp));
    console.log(`[autoTag] appName="${opts.appName}" → ${matched.length} match(es): [${matched.map((t) => t.name).join(", ")}]`);
    return matched.map((t) => t.id);
  };

  const autoTagIdsLLM = async (opts: {
    captureId: string;
    kind: "note" | "document" | "image" | "video";
    appName: string;
    windowTitle: string;
    rawText: string;
    explanation?: string;
  }): Promise<void> => {
    if (!autoAssignTagsRef.current) { console.log(`[autoTagLLM] skip: autoAssignTags=false`); return; }
    const model = sensitiveScanModelRef.current;
    if (model === "disabled") { console.log(`[autoTagLLM] skip: model=disabled`); return; }
    const tags = captureTagsRef.current;
    if (tags.length === 0) { console.log(`[autoTagLLM] skip: no tags defined`); return; }

    const limit = autoTagTextLimitRef.current;
    const { raw, exp } = truncateAutoTagFields(opts.rawText, opts.explanation, limit);

    if (!raw && !exp && !opts.appName && !opts.windowTitle) {
      console.log(`[autoTagLLM] skip: no content for captureId=${opts.captureId}`);
      return;
    }

    const kindLabel = opts.kind === "image" ? "Screenshot" : opts.kind === "video" ? "Screen recording" : opts.kind === "document" ? "Document" : "Note";
    const contentParts: string[] = [`Type: ${kindLabel}`];
    if (opts.appName) contentParts.push(`App: ${opts.appName}`);
    if (opts.windowTitle) contentParts.push(`Window: ${opts.windowTitle}`);
    if (raw) contentParts.push(`Text:\n${raw}`);
    if (exp) contentParts.push(`Explanation:\n${exp}`);
    const contentSection = contentParts.join("\n");

    // Use short numeric IDs in the prompt to reduce hallucination; map back to UUIDs after
    const tagIndexed = tags.map((t, i) => ({ ...t, shortId: String(i + 1) }));
    const tagLines = tagIndexed.map((t) => {
      const desc = t.description?.trim();
      return `- ID=${t.shortId} | Name="${t.name}"${desc ? ` | Description="${desc}"` : ""}`;
    }).join("\n");

    const prompt = [
      `You assign content tags. Given the list of tags and captured content below, reply with ONLY the numeric IDs of matching tags as a comma-separated list (e.g. 1,3). If none match, reply with "none".`,
      "",
      "Tags:",
      tagLines,
      "",
      "Content:",
      contentSection,
      "",
      `Matching tag IDs (comma-separated, or "none"):`,
    ].join("\n");

    const isOpenAi = model.startsWith(OPENAI_MODEL_PREFIX);
    console.log(`[autoTagLLM] running model=${model} captureId=${opts.captureId} kind=${opts.kind} rawLen=${raw.length} expLen=${exp.length} tags=${tags.length}`);
    console.log(`[autoTagLLM] prompt:\n${prompt}`);
    try {
      const raw = await invoke<string>("run_prompt_cmd", {
        modelSelection: model,
        prompt,
        maxTokens: 64,
        openaiApiKey: isOpenAi ? openAiApiKeyRef.current.trim() : null,
      });
      console.log(`[autoTagLLM] raw="${raw.trim()}"`);
      const matched = parseAutoTagIdsFromCommaRaw(raw, tagIndexed, tags);
      if (matched.length === 0) {
        console.log(`[autoTagLLM] no valid IDs in response`);
        return;
      }
      console.log(`[autoTagLLM] matched ${matched.length} tag(s): [${matched.map((id) => tags.find((t) => t.id === id)?.name ?? id).join(", ")}]`);
      if (opts.kind === "note") {
        const updated = offSessionNotesRef.current.find((n) => n.id === opts.captureId);
        if (updated) { const u = { ...updated, tagIds: [...new Set([...(updated.tagIds ?? []), ...matched])] }; setOffSessionNotes((prev) => prev.map((n) => n.id !== opts.captureId ? n : u)); if (userIdRef.current) void localSaveCapture(userIdRef.current, noteToSaveReq(u, userIdRef.current)).catch(console.error); }
        else { setOffSessionNotes((prev) => prev.map((n) => n.id !== opts.captureId ? n : { ...n, tagIds: [...new Set([...(n.tagIds ?? []), ...matched])] })); }
      } else if (opts.kind === "image") {
        const updated = offSessionImagesRef.current.find((i) => i.id === opts.captureId);
        if (updated) { const u = { ...updated, tagIds: [...new Set([...(updated.tagIds ?? []), ...matched])] }; setOffSessionImages((prev) => prev.map((i) => i.id !== opts.captureId ? i : u)); if (userIdRef.current) void localSaveCapture(userIdRef.current, imageToSaveReq(u, userIdRef.current)).catch(console.error); }
        else { setOffSessionImages((prev) => prev.map((i) => i.id !== opts.captureId ? i : { ...i, tagIds: [...new Set([...(i.tagIds ?? []), ...matched])] })); }
      } else if (opts.kind === "video") {
        const updated = offSessionVideosRef.current.find((v) => v.id === opts.captureId);
        if (updated) { const u = { ...updated, tagIds: [...new Set([...(updated.tagIds ?? []), ...matched])] }; setOffSessionVideos((prev) => prev.map((v) => v.id !== opts.captureId ? v : u)); if (userIdRef.current) void localSaveCapture(userIdRef.current, videoToSaveReq(u, userIdRef.current)).catch(console.error); }
        else { setOffSessionVideos((prev) => prev.map((v) => v.id !== opts.captureId ? v : { ...v, tagIds: [...new Set([...(v.tagIds ?? []), ...matched])] })); }
      }
    } catch (err) {
      console.error(`[autoTagLLM] error (${opts.kind}=${opts.captureId}):`, err);
    }
  };

  useEffect(() => {
    if (showAssignTagPicker) {
      setAssignTagAiPoolIds(captureTags.map((t) => t.id));
      setAssignTagAiError(null);
      setAssignTagAiProgress(null);
    }
  }, [showAssignTagPicker]);

  const persistCaptureTags = useCallback((key: string, newTagIds: string[]) => {
    if (!userIdRef.current) return;
    const uid = userIdRef.current;
    if (key.startsWith("offNote|")) {
      const note = offSessionNotesRef.current.find((n) => n.id === key.slice(8));
      if (!note) return;
      const updated = { ...note, tagIds: newTagIds };
      setOffSessionNotes((prev) => prev.map((n) => n.id === note.id ? updated : n));
      void localSaveCapture(uid, noteToSaveReq(updated, uid)).catch(console.error);
    } else if (key.startsWith("offImage|")) {
      const img = offSessionImagesRef.current.find((i) => i.id === key.slice(9));
      if (!img) return;
      const updated = { ...img, tagIds: newTagIds };
      setOffSessionImages((prev) => prev.map((i) => i.id === img.id ? updated : i));
      void localSaveCapture(uid, imageToSaveReq(updated, uid)).catch(console.error);
    } else if (key.startsWith("offVideo|")) {
      const vid = offSessionVideosRef.current.find((v) => v.id === key.slice(9));
      if (!vid) return;
      const updated = { ...vid, tagIds: newTagIds };
      setOffSessionVideos((prev) => prev.map((v) => v.id === vid.id ? updated : v));
      void localSaveCapture(uid, videoToSaveReq(updated, uid)).catch(console.error);
    }
  }, []);

  const persistSensitiveState = useCallback((key: string, state: string) => {
    if (!userIdRef.current) return;
    const uid = userIdRef.current;
    if (key.startsWith("offNote|")) {
      const note = offSessionNotesRef.current.find((n) => n.id === key.slice(8));
      if (note) void localSaveCapture(uid, noteToSaveReq({ ...note, sensitiveVerdict: state as OffSessionNote["sensitiveVerdict"] }, uid)).catch(console.error);
    } else if (key.startsWith("offImage|")) {
      const img = offSessionImagesRef.current.find((i) => i.id === key.slice(9));
      if (img) void localSaveCapture(uid, imageToSaveReq({ ...img, sensitiveVerdict: state as OffSessionImage["sensitiveVerdict"] }, uid)).catch(console.error);
    } else if (key.startsWith("offVideo|")) {
      const vid = offSessionVideosRef.current.find((v) => v.id === key.slice(9));
      if (vid) void localSaveCapture(uid, videoToSaveReq({ ...vid, sensitiveVerdict: state as OffSessionVideo["sensitiveVerdict"] }, uid)).catch(console.error);
    }
  }, []);

  const persistCaptureData = useCallback((key: string, fields: { text?: string | null; explanation?: string | null; transcription?: string | null; processDocIndexDoc?: boolean | null }) => {
    if (!userIdRef.current) return;
    const uid = userIdRef.current;
    if (key.startsWith("offNote|")) {
      const note = offSessionNotesRef.current.find((n) => n.id === key.slice(8));
      if (!note) return;
      const updated: OffSessionNote = {
        ...note,
        ...(fields.text !== undefined ? (note.kind === "document" ? { summary: fields.text ?? undefined } : { text: fields.text ?? undefined }) : {}),
        ...(fields.explanation !== undefined ? { explanation: fields.explanation ?? undefined } : {}),
        ...(fields.processDocIndexDoc !== undefined ? { process_doc_index_doc: fields.processDocIndexDoc ?? undefined } : {}),
      };
      setOffSessionNotes((prev) => prev.map((n) => n.id === note.id ? updated : n));
      void localSaveCapture(uid, noteToSaveReq(updated, uid)).catch(console.error);
    } else if (key.startsWith("offImage|")) {
      const img = offSessionImagesRef.current.find((i) => i.id === key.slice(9));
      if (!img) return;
      const updated = {
        ...img,
        ...(fields.text !== undefined ? { ocr: fields.text ?? undefined } : {}),
        ...(fields.explanation !== undefined ? { explanation: fields.explanation ?? undefined } : {}),
      };
      setOffSessionImages((prev) => prev.map((i) => i.id === img.id ? updated : i));
      void localSaveCapture(uid, imageToSaveReq(updated, uid)).catch(console.error);
    } else if (key.startsWith("offVideo|")) {
      const vid = offSessionVideosRef.current.find((v) => v.id === key.slice(9));
      if (!vid) return;
      const updated = {
        ...vid,
        ...(fields.transcription !== undefined ? { transcription: fields.transcription ?? undefined } : {}),
        ...(fields.explanation !== undefined ? { explanation: fields.explanation ?? undefined } : {}),
      };
      setOffSessionVideos((prev) => prev.map((v) => v.id === vid.id ? updated : v));
      void localSaveCapture(uid, videoToSaveReq(updated, uid)).catch(console.error);
    }
  }, []);

  const addHistoryNoteAsCapture = useCallback((note: OffSessionNote) => {
    if (userIdRef.current) {
      const uid = userIdRef.current;
      localSaveCapture(uid, noteToSaveReq(note, uid))
        .then(() => setOffSessionNotes((prev) => prev.some((n) => offSessionNotesDedupSame(n, note)) ? prev : [note, ...prev]))
        .catch((err) => console.error(`[addHistoryNote] DB save failed, not adding to state:`, err));
    }
  }, []);

  const handleAssignTagsWithAi = useCallback(async () => {
    const model = sensitiveScanModelRef.current;
    if (model === "disabled") {
      setAssignTagAiError(
        "Choose a Tags & sensitive model in Settings → AI tasks (it cannot be Disabled).",
      );
      return;
    }
    const poolTags = captureTags.filter((t) => assignTagAiPoolIds.includes(t.id));
    if (poolTags.length === 0) {
      setAssignTagAiError("Select at least one tag in the AI pool below.");
      return;
    }
    const keys = [...selectedItemIds].filter(
      (k) => k.startsWith("offNote|") || k.startsWith("offImage|") || k.startsWith("offVideo|") || k.startsWith("seg|"),
    );
    if (keys.length === 0) {
      setAssignTagAiError("Select at least one note, screenshot, recording, or segment.");
      return;
    }
    type AiTarget = {
      selKey: string;
      llmKind: "note" | "document" | "image" | "video" | "segment";
      captureId: string;
      sessionId?: string;
      startedAt?: string;
      appName: string;
      windowTitle: string;
      rawText: string;
      explanation?: string;
    };
    const targets: AiTarget[] = [];
    for (const key of keys) {
      if (key.startsWith("offNote|")) {
        const id = key.slice(8);
        const n = offSessionNotes.find((x) => x.id === id);
        if (!n) continue;
        const rawText = offSessionNoteBody(n);
        targets.push({
          selKey: key,
          llmKind: n.kind === "document" ? "document" : "note",
          captureId: id,
          appName: n.contextFocus?.appName ?? "",
          windowTitle: n.contextFocus?.windowName ?? "",
          rawText,
          explanation: n.explanation,
        });
      } else if (key.startsWith("offImage|")) {
        const id = key.slice(9);
        const img = offSessionImages.find((x) => x.id === id);
        if (!img) continue;
        const rawText = (ocrTextByPath[img.path] ?? img.ocr ?? "").trim();
        targets.push({
          selKey: key,
          llmKind: "image",
          captureId: id,
          appName: img.contextFocus?.appName ?? "",
          windowTitle: img.contextFocus?.windowName ?? "",
          rawText,
          explanation: img.explanation,
        });
      } else if (key.startsWith("offVideo|")) {
        const id = key.slice(9);
        const vid = offSessionVideos.find((x) => x.id === id);
        if (!vid) continue;
        targets.push({
          selKey: key,
          llmKind: "video",
          captureId: id,
          appName: vid.contextFocus?.appName ?? "",
          windowTitle: vid.contextFocus?.windowName ?? "",
          rawText: (vid.transcription ?? "").trim(),
          explanation: vid.explanation,
        });
      }
    }
    if (targets.length === 0) {
      setAssignTagAiError("No assignable captures in the current selection.");
      return;
    }

    const applyMatchedToKey = (selKey: string, matched: string[]) => {
      if (matched.length === 0) return;
      if (selKey.startsWith("offNote|")) {
        const id = selKey.slice(8);
        setOffSessionNotes((prev) =>
          prev.map((n) => (n.id !== id ? n : { ...n, tagIds: [...new Set([...(n.tagIds ?? []), ...matched])] })),
        );
      } else if (selKey.startsWith("offImage|")) {
        const id = selKey.slice(9);
        setOffSessionImages((prev) =>
          prev.map((i) => (i.id !== id ? i : { ...i, tagIds: [...new Set([...(i.tagIds ?? []), ...matched])] })),
        );
      } else if (selKey.startsWith("offVideo|")) {
        const id = selKey.slice(9);
        setOffSessionVideos((prev) =>
          prev.map((v) => (v.id !== id ? v : { ...v, tagIds: [...new Set([...(v.tagIds ?? []), ...matched])] })),
        );
      }
    };

    const buildContentSection = (t: AiTarget): string => {
      const limit = autoTagTextLimitRef.current;
      const { raw, exp } = truncateAutoTagFields(t.rawText, t.explanation, limit);
      const kindLabel =
        t.llmKind === "image"
          ? "Screenshot"
          : t.llmKind === "video"
            ? "Screen recording"
            : t.llmKind === "document"
              ? "Document"
              : t.llmKind === "segment"
                ? "Recording segment"
                : "Note";
      const contentParts: string[] = [`Type: ${kindLabel}`];
      if (t.appName) contentParts.push(`App: ${t.appName}`);
      if (t.windowTitle) contentParts.push(`Window: ${t.windowTitle}`);
      if (raw) contentParts.push(`Text:\n${raw}`);
      if (exp) contentParts.push(`Explanation:\n${exp}`);
      return contentParts.join("\n");
    };

    const buildPromptForPool = (contentSection: string) => {
      const tagIndexed = poolTags.map((x, i) => ({ ...x, shortId: String(i + 1) }));
      const tagLines = tagIndexed
        .map((x) => {
          const desc = x.description?.trim();
          return `- ID=${x.shortId} | Name="${x.name}"${desc ? ` | Description="${desc}"` : ""}`;
        })
        .join("\n");
      const prompt = [
        `You assign content tags. Given the list of tags and captured content below, reply with ONLY the numeric IDs of matching tags as a comma-separated list (e.g. 1,3). If none match, reply with "none".`,
        "",
        "Tags:",
        tagLines,
        "",
        "Content:",
        contentSection,
        "",
        `Matching tag IDs (comma-separated, or "none"):`,
      ].join("\n");
      return { prompt, tagIndexed };
    };

    const isOpenAi = model.startsWith(OPENAI_MODEL_PREFIX);
    const processingKeys = targets.map((t) => t.selKey);

    setAssignTagAiBusy(true);
    setAssignTagAiError(null);
    setProcessingIds((prev) => new Set([...prev, ...processingKeys]));
    setAssignTagAiProgress({ done: 0, total: targets.length });
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]!;
        const contentSection = buildContentSection(t);
        const { prompt, tagIndexed } = buildPromptForPool(contentSection);
        const raw = await invoke<string>("run_prompt_cmd", {
          modelSelection: model,
          prompt,
          maxTokens: 64,
          openaiApiKey: isOpenAi ? openAiApiKeyRef.current.trim() : null,
        });
        const matched = parseAutoTagIdsFromCommaRaw(raw.trim(), tagIndexed, poolTags);
        applyMatchedToKey(t.selKey, matched);
        setAssignTagAiProgress({ done: i + 1, total: targets.length });
      }
      setShowAssignTagPicker(false);
    } catch (e) {
      console.error("[assignTagAi]", e);
      setAssignTagAiError(e instanceof Error ? e.message : "AI assign failed.");
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        for (const k of processingKeys) next.delete(k);
        return next;
      });
      setAssignTagAiProgress(null);
      setAssignTagAiBusy(false);
    }
  }, [
    assignTagAiPoolIds,
    captureTags,
    offSessionImages,
    offSessionNotes,
    offSessionVideos,
    ocrTextByPath,
    selectedItemIds,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const promise = listen("kts:tray-note/request-history", () => {
      const dictItems = dictationFieldInjectsRef.current.slice(0, 15).map((d) => ({
        id: d.id,
        text: d.text,
        source: "dictation" as const,
        createdAt: "",
      }));
      const copyItems = copyHistoryNotesRef.current
        .slice(0, 15)
        .map((n) => ({ id: n.id, text: n.text ?? "", source: "clipboard" as const, createdAt: n.createdAt }));
      const items = [...dictItems, ...copyItems];
      void emit("kts:tray-note/history", { items });
    }).then((fn) => { unlisten = fn; });
    return () => { void promise.then(() => { safeInvokeUnlisten(unlisten); }); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Setting removed) autoprocess is now a per-upload choice in the Add-to-knowledge dialog.

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "attachOffSessionFocus") : "attachOffSessionFocus";
    // Also write the global key so Rust (which reads "attachOffSessionFocus" directly) sees the current value.
    const saves = uid
      ? [store.set(key, attachOffSessionFocus), store.set("attachOffSessionFocus", attachOffSessionFocus)]
      : [store.set(key, attachOffSessionFocus)];
    void Promise.all(saves).then(() => store.save()).catch(console.error);
  }, [attachOffSessionFocus, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid
      ? sessionStoreKeyForUser(uid, "chromeExtensionAutoMeetCaptures")
      : "chromeExtensionAutoMeetCaptures";
    const saves = uid
      ? [
          store.set(key, chromeExtensionAutoMeetCaptures),
          store.set("chromeExtensionAutoMeetCaptures", chromeExtensionAutoMeetCaptures),
        ]
      : [store.set(key, chromeExtensionAutoMeetCaptures)];
    void Promise.all(saves).then(() => store.save()).catch(console.error);
  }, [chromeExtensionAutoMeetCaptures, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const pKey = uid ? sessionStoreKeyForUser(uid, "googleMeetSummaryPrompt") : "googleMeetSummaryPrompt";
    const langKey = uid ? sessionStoreKeyForUser(uid, "googleMeetSummaryLang") : "googleMeetSummaryLang";
    void Promise.all([
      store.set(pKey, googleMeetSummaryPrompt),
      store.set(langKey, googleMeetSummaryLang),
    ])
      .then(() => store.save())
      .catch(console.error);
  }, [googleMeetSummaryPrompt, googleMeetSummaryLang, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const k1 = uid ? sessionStoreKeyForUser(uid, "dictationCustomModel") : "dictationCustomModel";
    const k2 = uid
      ? sessionStoreKeyForUser(uid, "dictationCustomPromptHighlight")
      : "dictationCustomPromptHighlight";
    const k3 = uid
      ? sessionStoreKeyForUser(uid, "dictationCustomPromptNoHighlight")
      : "dictationCustomPromptNoHighlight";
    void Promise.all([
      store.set(k1, dictationCustomModel),
      store.set(k2, dictationCustomPromptHighlight),
      store.set(k3, dictationCustomPromptNoHighlight),
    ])
      .then(() => store.save())
      .catch(console.error);
  }, [dictationCustomModel, dictationCustomPromptHighlight, dictationCustomPromptNoHighlight, loaded]);

  useEffect(() => {
    if (!loaded) return;
    void invoke("sync_dictation_custom_settings_cmd", {
      model: dictationCustomModel,
      promptHighlight: dictationCustomPromptHighlight,
      promptNoHighlight: dictationCustomPromptNoHighlight,
    }).catch((e) => console.error("sync_dictation_custom_settings_cmd:", e));
  }, [dictationCustomModel, dictationCustomPromptHighlight, dictationCustomPromptNoHighlight, loaded]);

  useEffect(() => {
    if (!loaded || !meetBridgeSettingsHydratedRef.current) return;
    void Promise.all([
      store.set("meetBridgeToken", meetBridgeToken),
      store.set("meetBridgePort", meetBridgePort),
    ])
      .then(() => store.save())
      .catch(console.error);
  }, [meetBridgeToken, meetBridgePort, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "fnDictationShortcutEnabled") : "fnDictationShortcutEnabled";
    const saves = uid
      ? [store.set(key, fnDictationShortcutEnabled), store.set("fnDictationShortcutEnabled", fnDictationShortcutEnabled)]
      : [store.set(key, fnDictationShortcutEnabled)];
    void Promise.all(saves)
      .then(() => store.save())
      .then(() => invoke("set_fn_dictation_shortcut_enabled_cmd", { enabled: fnDictationShortcutEnabled }))
      .catch(console.error);
  }, [fnDictationShortcutEnabled, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(uid ? sessionStoreKeyForUser(uid, "keepCopyHistory") : "keepCopyHistory", keepCopyHistory)
      .then(() => store.save()).catch(console.error);
    void invoke("set_clipboard_monitor_enabled_cmd", { enabled: keepCopyHistory }).catch(console.error);
  }, [keepCopyHistory, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    void store.set(
      uid ? sessionStoreKeyForUser(uid, "keepDictationHistory") : "keepDictationHistory",
      keepDictationHistory,
    )
      .then(() => store.save()).catch(console.error);
  }, [keepDictationHistory, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "screenRecordQuality") : "screenRecordQuality";
    // Also write the global key so Rust reads the right value at recording start.
    const saves = uid
      ? [store.set(key, screenRecordQuality), store.set("screenRecordQuality", screenRecordQuality)]
      : [store.set(key, screenRecordQuality)];
    void Promise.all(saves).then(() => store.save()).catch(console.error);
  }, [screenRecordQuality, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const k1 = uid ? sessionStoreKeyForUser(uid, "dictationAutoStopMinutes") : "dictationAutoStopMinutes";
    const k2 = uid ? sessionStoreKeyForUser(uid, "screenRecordAutoStopMinutes") : "screenRecordAutoStopMinutes";
    const saves = uid
      ? [
          store.set(k1, dictationAutoStopMinutes),
          store.set(k2, screenRecordAutoStopMinutes),
          store.set("dictationAutoStopMinutes", dictationAutoStopMinutes),
          store.set("screenRecordAutoStopMinutes", screenRecordAutoStopMinutes),
        ]
      : [store.set(k1, dictationAutoStopMinutes), store.set(k2, screenRecordAutoStopMinutes)];
    void Promise.all(saves).then(() => store.save()).catch(console.error);
  }, [dictationAutoStopMinutes, screenRecordAutoStopMinutes, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid
      ? sessionStoreKeyForUser(uid, "testUploadPreserveLocalState")
      : "testUploadPreserveLocalState";
    void store.set(key, testUploadPreserveLocalState).then(() => store.save()).catch(console.error);
  }, [testUploadPreserveLocalState, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "dictationLang") : "dictationLang";
    void store.set(key, dictationLang).then(() => store.save()).catch(console.error);
    void invoke("set_dictation_lang_cmd", { lang: dictationLang }).catch(console.error);
  }, [dictationLang, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "offSessionBlockExpanded") : "offSessionBlockExpanded";
    void store.set(key, offSessionBlockExpanded).then(() => store.save()).catch(console.error);
  }, [offSessionBlockExpanded, loaded]);

  const downloadRecordingsContextArchive = useCallback(async () => {
    if (zipDownloadBusy) return;
    setZipDownloadBusy(true);
    const exportedAt = new Date().toISOString();
    try {
      const captures = buildCaptureExportEntries(
        offSessionNotes,
        offSessionImages,
        offSessionVideos,
      );
      await saveCapturesZipToDownloads(captures, exportedAt);
    } catch (e) {
      console.error("export captures ZIP:", e);
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`Could not save export: ${msg}`);
    } finally {
      setZipDownloadBusy(false);
    }
  }, [zipDownloadBusy, offSessionNotes, offSessionImages, offSessionVideos]);

  const syncRecordingUiState = useCallback(
    async (sessionId: string | null, focusCapture: boolean) => {
      try {
        await invoke("sync_recording_ui_state", {
          sessionId,
          focusCaptureActive: focusCapture,
        });
      } catch (err) {
        console.error("sync recording ui-state:", err);
      }
    },
    []
  );

  useEffect(() => {
    if (!loaded) return;

    let unlisten: (() => void) | undefined;
    const promise = listen(ASSISTANT_OPEN_EVENT, () => {
      setActiveTab("chat");
      setAssistantFocusNonce((n) => n + 1);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      void promise.then(() => {
        safeInvokeUnlisten(unlisten);
      });
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;

    let unlisten: (() => void) | undefined;
    const promise = listen(SETTINGS_OPEN_EVENT, () => {
      setActiveTab("settings");
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      void promise.then(() => {
        safeInvokeUnlisten(unlisten);
      });
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const signedIn = authReady && session != null;
    void invoke("set_tray_signed_in_cmd", { signedIn }).catch((e) =>
      console.error("set_tray_signed_in_cmd:", e)
    );
  }, [loaded, authReady, session]);


  useEffect(() => {
    if (!loaded) return;
    let unlisten: (() => void) | undefined;
    const promise = listen<GoogleMeetManualIngestedPayload>(
      GOOGLE_MEET_MANUAL_INGESTED_EVENT,
      (event) => {
        void (async () => {
          const p = event.payload;
          const clientId = typeof p.clientId === "string" ? p.clientId.trim() : "";
          const transcript = typeof p.text === "string" ? p.text : "";
          const usedLiveSegment = p.usedLiveSegment === true;
          if (!clientId || !transcript.trim()) return;
          if (p.skipAutoSummary === true) return;
          if (meetManualResyncSkipSummaryRef.current.has(clientId)) {
            meetManualResyncSkipSummaryRef.current.delete(clientId);
            return;
          }

          const flight = meetSummaryFlightRef.current;
          if (flight.has(clientId)) return;
          flight.add(clientId);

          const meetPick = googleMeetSummaryModelRef.current.trim();
          const pdfPick = pdfModelFilenameRef.current.trim();
          const resolved = meetPick || pdfPick;
          if (!resolved || resolved === "disabled") {
            console.error(
              "[meetSummary] No model configured: choose a model in Settings → AI tasks → File & Meet summaries."
            );
            flight.delete(clientId);
            return;
          }
          if (resolved.startsWith(OPENAI_MODEL_PREFIX) && !openAiApiKeyRef.current.trim()) {
            console.error("[meetSummary] OpenAI model selected but the LLM API key is empty.");
            flight.delete(clientId);
            return;
          }

          const extra = googleMeetSummaryPromptRef.current ?? "";
          const outputLang = resolveGoogleMeetSummaryOutputLangForApi(
            googleMeetSummaryLangRef.current,
            preferredOutputLangRef.current
          );

          try {
            let summaryText: string;
            {
              const prompt = buildGoogleMeetSummaryUserPrompt(transcript, extra, outputLang);
              summaryText = (
                await invoke<string>("run_prompt_cmd", {
                  modelSelection: resolved,
                  prompt,
                  maxTokens: 6000,
                  openaiApiKey: resolved.startsWith(OPENAI_MODEL_PREFIX)
                    ? openAiApiKeyRef.current.trim()
                    : null,
                })
              ).trim();
              if (!summaryText) {
                console.error("[meetSummary] Local or OpenAI model returned an empty response.");
                return;
              }
            }

            if (usedLiveSegment) {
              // Live-segment path removed (session recording deleted); skip.
              return;
            } else {
              submittedProcessRef.current.delete(clientId);
              const existingNote = offSessionNotesRef.current.find((n) => n.id === clientId);
              if (existingNote && existingNote.kind !== "document") {
                const updatedNote = { ...existingNote, explanation: summaryText };
                setOffSessionNotes((prev) => prev.map((n) => n.id === clientId ? updatedNote : n));
                if (userIdRef.current) void localSaveCapture(userIdRef.current, noteToSaveReq(updatedNote, userIdRef.current)).catch(console.error);
              } else {
                setOffSessionNotes((prev) => {
                  const j = prev.findIndex((n) => n.id === clientId);
                  if (j < 0) return prev;
                  const cur = prev[j]!;
                  if (cur.kind === "document") return prev;
                  return prev.map((n, idx) => idx === j ? { ...cur, explanation: summaryText } : n);
                });
              }
              const bufNotes = offSessionBufferRef.current.notes;
              const bi = bufNotes.findIndex((n) => n.id === clientId);
              if (bi >= 0) {
                const cur = bufNotes[bi]!;
                if (cur.kind !== "document") {
                  bufNotes[bi] = { ...cur, explanation: summaryText };
                }
              }
              setProcessingIds((prev) => new Set([...prev, clientId]));
            }
          } catch (err) {
            console.error("[meetSummary]", err);
          } finally {
            meetSummaryFlightRef.current.delete(clientId);
          }
        })();
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      void promise.then(() => {
        safeInvokeUnlisten(unlisten);
      });
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    let unlisten: (() => void) | undefined;
    const promise = listen<OcrResultPayload>(OCR_RESULT_EVENT, (event) => {
      const { path, text } = event.payload;
      if (typeof path !== "string" || typeof text !== "string") return;
      setOcrTextByPath((prev) => ({ ...prev, [path]: text }));
      const ocrImg = offSessionImagesRef.current.find((i) => i.path === path);
      if (ocrImg && userIdRef.current) {
        const updatedWithOcr = { ...ocrImg, ocr: text };
        setOffSessionImages((prev) => prev.map((i) => i.path === path ? updatedWithOcr : i));
        void localSaveCapture(userIdRef.current, imageToSaveReq(updatedWithOcr, userIdRef.current)).catch(console.error);
      }
      if (
        text.trim() &&
        ((autoScanSensitiveRef.current && sensitiveScanModelRef.current !== "disabled") ||
         (autoAssignTagsRef.current && sensitiveScanModelRef.current !== "disabled"))
      ) {
        const img = offSessionImagesRef.current.find((i) => i.path === path);
        if (img) setProcessingIds((prev) => new Set([...prev, img.id]));
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      void promise.then(() => {
        safeInvokeUnlisten(unlisten);
      });
    };
  }, [loaded]);

  // Fetch file sizes for images / videos not yet in the map
  useEffect(() => {
    if (!loaded) return;
    const missing = [
      ...offSessionImages.map((i) => i.path),
      ...offSessionVideos.map((v) => v.path),
    ].filter((p) => !(p in fileSizeByPath));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map((p) => invoke<number>("sum_file_sizes_cmd", { paths: [p] }).catch(() => 0))
    ).then((sizes) => {
      setFileSizeByPath((prev) => {
        const next = { ...prev };
        missing.forEach((p, idx) => { next[p] = sizes[idx] ?? 0; });
        return next;
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, offSessionImages, offSessionVideos]);


  useEffect(() => {
    if (!loaded) return;
    const uid = userIdRef.current;
    const key = uid ? sessionStoreKeyForUser(uid, "hotkeyKeyLetters") : "hotkeyKeyLetters";
    const saves = uid
      ? [store.set(key, hotkeyKeyLetters), store.set("hotkeyKeyLetters", hotkeyKeyLetters)]
      : [store.set(key, hotkeyKeyLetters)];
    void Promise.all(saves)
      .then(() => store.save())
      .then(() => invoke("apply_macos_hotkey_key_letters_cmd", { letters: hotkeyKeyLetters }))
      .catch((e) => console.error("hotkeyKeyLetters apply failed:", e));
  }, [hotkeyKeyLetters, loaded]);

  // Fetch Whisper status when entering Settings tab (refresh each time)
  useEffect(() => {
    if (activeTab !== "settings") return;
    void invoke<WhisperStatus>("check_whisper_cmd")
      .then(setWhisperStatus)
      .catch((e) => console.error("check_whisper_cmd failed:", e));
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "settings") return;
    void invoke<QwenModelsStatus>("check_qwen_models_cmd")
      .then(setQwenStatus)
      .catch((e) => console.error("check_qwen_models_cmd failed:", e));
    void invoke<LocalLlmStatus>("check_local_llm_cmd")
      .then(setLocalLlmStatus)
      .catch((e) => {
        console.error("check_local_llm_cmd failed:", e);
        setLocalLlmStatus(null);
      });
  }, [activeTab]);

  // Reload Supabase `profiles` row when opening Settings or AI Assistant (plan, super-admin, etc.)
  useEffect(() => {
    if (
      (activeTab !== "settings" && activeTab !== "chat") ||
      !authReady ||
      !session?.user?.id
    ) {
      return;
    }
    void refreshProfile();
  }, [activeTab, authReady, session?.user?.id, refreshProfile]);

  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setPreferredOutputLang("en");
      setPreferredOutputLangError(null);
      setPreferredOutputLangSaving(false);
      setPendingLanguageSyncCode(null);
      return;
    }
    void (async () => {
      const stored = await store.get<string | null>(
        sessionStoreKeyForUser(uid, "preferredLanguageCode"),
      );
      const code = typeof stored === "string" ? stored.trim().toLowerCase() : "";
      setPreferredOutputLang(isKnownOutputLanguageCode(code) ? code : "en");
    })();
  }, [session?.user?.id]);

  /** Legacy Meet values `same_as_account` / `document` / unknown codes → concrete `OUTPUT_LANGUAGE_OPTIONS` code. */
  useEffect(() => {
    if (!loaded) return;
    setGoogleMeetSummaryLang((prev) => {
      if (
        prev === GOOGLE_MEET_SUMMARY_LANG_SAME_AS_ACCOUNT ||
        prev === "document" ||
        !isKnownOutputLanguageCode(prev)
      ) {
        return isKnownOutputLanguageCode(preferredOutputLang) ? preferredOutputLang : "en";
      }
      return prev;
    });
  }, [loaded, preferredOutputLang]);

  useEffect(() => {
    if (!session?.user?.id) {
      setAssistantSharePrefsHydrated(false);
      setAssistantActiveContextId("self");
      return;
    }
    const uid = session.user.id;
    let cancelled = false;
    setAssistantSharePrefsHydrated(false);
    void (async () => {
      await migrateLegacyGlobalKeysToCurrentUser(store, uid);
      if (cancelled) return;
      const last = await store.get<string>(
        sessionStoreKeyForUser(uid, ASSISTANT_CHAT_LAST_CONTEXT_KEY),
      );
      if (cancelled) return;
      setAssistantActiveContextId(
        typeof last === "string" && last.length > 0 ? last : "self",
      );
      setAssistantSharePrefsHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  useEffect(() => {
    if (!assistantSharePrefsHydrated || !authReady || !session?.user?.id) return;
    const uid = session.user.id;
    void store
      .set(
        sessionStoreKeyForUser(uid, ASSISTANT_CHAT_LAST_CONTEXT_KEY),
        assistantActiveContextId,
      )
      .then(() => store.save());
  }, [
    assistantActiveContextId,
    assistantSharePrefsHydrated,
    authReady,
    session?.user?.id,
  ]);

  // Fetch unified share contacts as soon as auth is ready.
  useEffect(() => {
    if (!authReady || !session) return;
    void fetchShareContacts()
      .then(setShareContacts)
      .catch(() => setShareContacts([]));
  }, [authReady, session, authenticatedFetch]);

  /**
   * Re-read the imported-assistant registry from disk. Call it after an import
   * or a delete; the effect below calls it on mount and whenever the profile
   * changes. The generation guard is there because switching profiles while a
   * read is in flight would otherwise show one profile's assistants under
   * another's identity.
   */
  const importedAssistantsGenRef = useRef(0);
  /** Ids last handed to the tab list, so a no-op refresh costs nothing. */
  const importedAssistantIdsRef = useRef("");
  const refreshImportedAssistants = useCallback(async () => {
    const gen = ++importedAssistantsGenRef.current;
    const uid = session?.user?.id;
    let next: ImportedAssistant[] = [];
    let failed: string | null = null;
    if (uid) {
      try {
        next = await loadImportedAssistants(uid);
      } catch (err) {
        // An unreadable registry must not take the chat down with it: "Me" still
        // works. But it must not pass for an empty one either — the tab strip
        // those two produce is identical, so the failure has to be carried to the
        // screen or it is a silent lie. The sentence goes to the user, the
        // technical tail to the console.
        console.error("[App] load imported assistants:", err);
        failed = UNREADABLE_IMPORTED_ASSISTANTS_MESSAGE;
        next = [];
      }
    }
    if (importedAssistantsGenRef.current !== gen) return;
    setImportedAssistantsError(failed);
    const idsKey = next.map((a) => a.assistantId).join(" ");
    if (importedAssistantIdsRef.current !== idsKey) {
      importedAssistantIdsRef.current = idsKey;
      // The set of contexts changed, so the transcripts the chat holds in memory
      // no longer match the tabs: make it re-read them from disk.
      setAssistantChatStoreRevision((r) => r + 1);
    }
    setImportedAssistants(next);
    setImportedAssistantsLoaded(true);
  }, [session?.user?.id]);

  useEffect(() => {
    setImportedAssistantsLoaded(false);
    void refreshImportedAssistants();
  }, [refreshImportedAssistants]);

  const assistantContextTabs = useMemo((): AssistantChatContextTab[] => {
    const uid = session?.user?.id;
    if (!uid) return [];
    // "Me" first, then one tab per imported index, in registry order.
    //
    // `aiAssistantUserId` stays the profile's own id on every tab, including the
    // imported ones. It names the *identity* a request is made as, not the index
    // it reads: an imported assistant lives inside this profile, under
    // local-index/{uid}/assistants/{assistantId}. Which index gets read is
    // decided by `contextId` alone, routed as the `assistantId` argument on the
    // local read commands. Putting the assistant id here instead would make the
    // chat send it to the server as `ai_assistant_user_id`, which is the deleted
    // cloud-sharing path and means nothing to the backend now.
    const tabs: AssistantChatContextTab[] = [
      { contextId: "self", label: "Me", aiAssistantUserId: uid },
    ];
    for (const assistant of importedAssistants) {
      tabs.push({
        contextId: assistant.assistantId,
        label: assistant.name.trim() || "Imported knowledge",
        aiAssistantUserId: uid,
      });
    }
    return tabs;
  }, [session?.user?.id, importedAssistants]);

  // Fall back to "Me" when the remembered tab no longer exists — but only once both
  // the remembered id and the registry have actually been read. Judged too early, the
  // still-empty registry makes every imported assistant look deleted and throws away
  // the tab the user was last on.
  useEffect(() => {
    if (!assistantSharePrefsHydrated || !importedAssistantsLoaded) return;
    const ids = new Set(assistantContextTabs.map((t) => t.contextId));
    if (!ids.has(assistantActiveContextId)) {
      setAssistantActiveContextId("self");
    }
  }, [
    assistantContextTabs,
    assistantActiveContextId,
    assistantSharePrefsHydrated,
    importedAssistantsLoaded,
  ]);

  // Listen for Whisper download events
  useEffect(() => {
    type ProgressPayload = { modelId: string; phase: string; percent?: number };
    type DonePayload = string;
    type ErrorPayload = { modelId: string; error: string };
    type CancelledPayload = { modelId: string };

    let unlistenProgress: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenCancelled: (() => void) | undefined;
    let unlistenNotInstalled: (() => void) | undefined;

    // Flag shared by all listeners in this effect.
    // Set to true on cancel so that stale progress events emitted by the polling
    // thread (which keeps running for ~2s after curl is killed) don't re-show
    // the progress UI. Reset to false when a new download starts ("starting" phase).
    let cancelled = false;

    const p1 = listen<ProgressPayload>("kts:whisper/download-progress", (ev) => {
      const { modelId, phase, percent } = ev.payload;
      if (phase === "starting") cancelled = false; // new download - reset flag
      if (cancelled) return;
      setWhisperDownloading(modelId);
      setWhisperDownloadPercent(typeof percent === "number" ? percent : null);
    }).then((fn) => { unlistenProgress = fn; });

    const p2 = listen<DonePayload>("kts:whisper/download-done", () => {
      cancelled = false;
      setWhisperDownloading(null);
      setWhisperDownloadPercent(null);
      void (async () => {
        const updated = await invoke<WhisperStatus>("check_whisper_cmd");
        setWhisperStatus(updated);
        // Persist auto-selection (e.g. first download while Disabled).
        if (updated.selectedModel) {
          const uid = userIdRef.current;
          const wKey = uid ? sessionStoreKeyForUser(uid, "whisperModel") : "whisperModel";
          await store.set(wKey, updated.selectedModel);
          await store.save();
        }
      })().catch(console.error);
    }).then((fn) => { unlistenDone = fn; });

    const p3 = listen<ErrorPayload>("kts:whisper/download-error", (ev) => {
      cancelled = false;
      setWhisperDownloading(null);
      setWhisperDownloadPercent(null);
      console.error("Whisper download error:", ev.payload.error);
    }).then((fn) => { unlistenError = fn; });

    const p4 = listen<CancelledPayload>("kts:whisper/download-cancelled", () => {
      cancelled = true;
      setWhisperDownloading(null);
      setWhisperDownloadPercent(null);
    }).then((fn) => { unlistenCancelled = fn; });

    const p5 = listen<null>("kts:whisper/not-installed", () => {
      setActiveTab("settings");
    }).then((fn) => { unlistenNotInstalled = fn; });

    return () => {
      void Promise.all([p1, p2, p3, p4, p5]).then(() => {
        safeInvokeUnlisten(unlistenProgress);
        safeInvokeUnlisten(unlistenDone);
        safeInvokeUnlisten(unlistenError);
        safeInvokeUnlisten(unlistenCancelled);
        safeInvokeUnlisten(unlistenNotInstalled);
      });
    };
  }, []);

  // Qwen GGUF download events (Settings → Process)
  useEffect(() => {
    type ProgressPayload = { modelId: string; phase: string; percent?: number };
    type DonePayload = string;
    type ErrorPayload = { modelId: string; error: string };
    type CancelledPayload = { modelId: string };

    let unlistenProgress: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenCancelled: (() => void) | undefined;
    let cancelled = false;

    const p1 = listen<ProgressPayload>("kts:qwen/download-progress", (ev) => {
      const { modelId, phase, percent } = ev.payload;
      if (phase === "starting") cancelled = false;
      if (cancelled) return;
      setQwenDownloading(modelId);
      setQwenDownloadPercent(typeof percent === "number" ? percent : null);
    }).then((fn) => {
      unlistenProgress = fn;
    });

    const p2 = listen<DonePayload>("kts:qwen/download-done", () => {
      cancelled = false;
      setQwenDownloading(null);
      setQwenDownloadPercent(null);
      void (async () => {
        const updated = await invoke<QwenModelsStatus>("check_qwen_models_cmd");
        setQwenStatus(updated);
        const llm = await invoke<LocalLlmStatus>("check_local_llm_cmd");
        setLocalLlmStatus(llm);
        if (updated.selectedModel) {
          const uid = userIdRef.current;
          const key = uid ? sessionStoreKeyForUser(uid, "qwenLocalModel") : "qwenLocalModel";
          await store.set(key, updated.selectedModel);
          await store.save();
        }
      })().catch(console.error);
    }).then((fn) => {
      unlistenDone = fn;
    });

    const p3 = listen<ErrorPayload>("kts:qwen/download-error", (ev) => {
      cancelled = false;
      setQwenDownloading(null);
      setQwenDownloadPercent(null);
      console.error("Qwen download error:", ev.payload.error);
    }).then((fn) => {
      unlistenError = fn;
    });

    const p4 = listen<CancelledPayload>("kts:qwen/download-cancelled", () => {
      cancelled = true;
      setQwenDownloading(null);
      setQwenDownloadPercent(null);
    }).then((fn) => {
      unlistenCancelled = fn;
    });

    return () => {
      void Promise.all([p1, p2, p3, p4]).then(() => {
        safeInvokeUnlisten(unlistenProgress);
        safeInvokeUnlisten(unlistenDone);
        safeInvokeUnlisten(unlistenError);
        safeInvokeUnlisten(unlistenCancelled);
      });
    };
  }, []);

  // Embed model download events
  useEffect(() => {
    type ProgressPayload = { modelId: string; phase: string; percent?: number };
    type DonePayload = { modelId: string };
    type ErrorPayload = { modelId: string; error: string };
    type CancelledPayload = { modelId: string };

    let unlistenProgress: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenCancelled: (() => void) | undefined;
    let cancelled = false;

    const p1 = listen<ProgressPayload>("kts:embed/download-progress", (ev) => {
      const { modelId, phase, percent } = ev.payload;
      if (phase === "starting") cancelled = false;
      if (cancelled) return;
      setEmbedDownloading(modelId);
      setEmbedDownloadPercent(typeof percent === "number" ? percent : null);
    }).then((fn) => { unlistenProgress = fn; });

    const p2 = listen<DonePayload>("kts:embed/download-done", (ev) => {
      cancelled = false;
      setEmbedDownloading(null);
      setEmbedDownloadPercent(null);
      const uid = session?.user?.id;
      void checkEmbedModels(uid).then((status) => {
        setEmbedStatus(status);
        // Auto-set the downloaded model if no active model is configured yet
        if (!status.activeModel && uid) {
          const justDownloaded = status.models.find((m) => m.id === ev.payload.modelId);
          if (justDownloaded) {
            void import("./localIndex").then(({ setActiveEmbedModel }) =>
              setActiveEmbedModel(justDownloaded.id, uid)
                .then(() => checkEmbedModels(uid))
                .then(setEmbedStatus)
                .catch(console.error)
            );
          }
        }
      }).catch(console.error);
    }).then((fn) => { unlistenDone = fn; });

    const p3 = listen<ErrorPayload>("kts:embed/download-error", (ev) => {
      cancelled = false;
      setEmbedDownloading(null);
      setEmbedDownloadPercent(null);
      console.error("Embed download error:", ev.payload.error);
    }).then((fn) => { unlistenError = fn; });

    const p4 = listen<CancelledPayload>("kts:embed/download-cancelled", () => {
      cancelled = true;
      setEmbedDownloading(null);
      setEmbedDownloadPercent(null);
    }).then((fn) => { unlistenCancelled = fn; });

    return () => {
      void Promise.all([p1, p2, p3, p4]).then(() => {
        safeInvokeUnlisten(unlistenProgress);
        safeInvokeUnlisten(unlistenDone);
        safeInvokeUnlisten(unlistenError);
        safeInvokeUnlisten(unlistenCancelled);
      });
    };
  }, []);

  // Dictation field-inject: collect entries for the expandable history div.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const promise = listen<string>(DICTATION_FIELD_INJECT_EVENT, (ev) => {
      if (!keepDictationHistoryRef.current) return;
      const text = ev.payload;
      if (!text.trim()) return;
      setDictationFieldInjects((prev) => {
        const ms = captureHistoryRetentionMs(captureHistoryRetentionRef.current);
        return pruneDictationHistoryInjectsByRetention(
          [
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              text,
              createdAt: new Date().toISOString(),
            },
            ...prev,
          ],
          ms,
        );
      });
      triggerHistoryFlash();
    }).then((fn) => { unlisten = fn; });
    return () => { void promise.then(() => { safeInvokeUnlisten(unlisten); }); };
  }, []);

  const handlePdfSummaryReady = useCallback(
    async (combined: string, docName: string, filePath: string, fileSize: number, rawContent?: string[]) => {
      const sourcePath = filePath.trim();
      let persistedFilePath: string | undefined;
      if (sourcePath) {
        try {
          persistedFilePath = await invoke<string>("persist_context_source_file_cmd", {
            path: sourcePath,
          });
        } catch (error) {
          console.error("[PDF] unable to persist source file in app storage:", error);
        }
      }
      const effectiveFilePath = persistedFilePath || sourcePath || undefined;
      const explanation = `Summary of: ${docName}`;
      const langArg = pdfSummaryLang.trim() || undefined;
      // Save as an off-session note with file metadata
      if (!effectiveFilePath?.trim()) {
        console.error("[PDF] off-session document: missing file path after persist");
        return;
      }
      const uid = userIdRef.current;
      if (!uid) {
        console.error("[PDF] off-session document: no userId, cannot save");
        return;
      }
      const note: OffSessionNote = {
        id: `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "document",
        summary: combined,
        explanation,
        mediaKind: "file",
        createdAt: new Date().toISOString(),
        filePath: effectiveFilePath.trim(),
        fileSize: fileSize > 0 ? fileSize : undefined,
        ...(langArg !== undefined ? { lang: langArg } : {}),
        process_doc_index_doc: defaultIndexDocContentRef.current,
      };
      try {
        await localSaveCapture(uid, {
          ...noteToSaveReq(note, uid),
          rawContent: rawContent ?? null,
        });
      } catch (error) {
        console.error("[PDF] failed to save document to DB:", error);
        return;
      }
      setOffSessionNotes((prev) => [note, ...prev]);
    },
    [pdfSummaryLang]
  );

  const runConfirmedAction = useCallback(
    async (kind: ConfirmKind) => {
      try {
        switch (kind.type) {
          case "deleteSelected": {
            // Delete off-session items
            for (const item of kind.items) {
              if (item.kind === "offNote") removeOffSessionNoteById(item.id);
              else if (item.kind === "offImage") await removeOffSessionImageById(item.id, item.path);
              else if (item.kind === "offVideo") await removeOffSessionVideoById(item.id, item.path);
            }
            setSelectedItemIds(new Set());
            break;
          }
          case "deleteOffNote":
            removeOffSessionNoteById(kind.id);
            break;
          case "deleteOffImage":
            await removeOffSessionImageById(kind.id, kind.path);
            break;
          case "deleteOffVideo":
            await removeOffSessionVideoById(kind.id, kind.path);
            break;
          case "removeWhisperModel": {
            await invoke("remove_whisper_cmd", { filename: kind.filename });
            if (kind.isSelected) {
              // Switch to next model or "" (Disabled).
              await invoke("set_whisper_model_cmd", { filename: kind.nextFilename });
              const uid = userIdRef.current;
              const wKey = uid ? sessionStoreKeyForUser(uid, "whisperModel") : "whisperModel";
              await store.set(wKey, kind.nextFilename);
              await store.save();
            }
            const updated = await invoke<WhisperStatus>("check_whisper_cmd");
            setWhisperStatus(updated);
            break;
          }
          case "removeQwenModel": {
            await invoke("remove_qwen_model_cmd", { filename: kind.filename });
            if (kind.isSelected) {
              await invoke("set_qwen_local_model_cmd", { filename: kind.nextFilename });
              const uid = userIdRef.current;
              const qKey = uid ? sessionStoreKeyForUser(uid, "qwenLocalModel") : "qwenLocalModel";
              await store.set(qKey, kind.nextFilename);
              await store.save();
            }
            const qUpdated = await invoke<QwenModelsStatus>("check_qwen_models_cmd");
            setQwenStatus(qUpdated);
            const llm = await invoke<LocalLlmStatus>("check_local_llm_cmd");
            setLocalLlmStatus(llm);
            break;
          }
          case "removeEmbedModel": {
            const uid = userIdRef.current ?? "";
            await import("./localIndex").then(({ removeEmbedModel, checkEmbedModels: cEM, setActiveEmbedModel: sAEM }) =>
              removeEmbedModel(kind.filename)
                .then(() => kind.isActive && uid ? sAEM("", uid) : Promise.resolve())
                .then(() => cEM(uid))
                .then(setEmbedStatus)
            ).catch(console.error);
            break;
          }
          case "localModelInUseWarning":
            break; // dialog is informational only; dismiss closes it
          default: {
            const _e: never = kind;
            return _e;
          }
        }
        setConfirmKind(null);
      } catch (e) {
        console.error(e);
        window.alert(e instanceof Error ? e.message : String(e));
      }
    },
    [
      syncRecordingUiState,
      removeOffSessionImageById,
      removeOffSessionNoteById,
      removeOffSessionVideoById,
      setWhisperStatus,
      session?.user?.id,
      selectedItemIds,
    ]
  );

  // ProcessTab upload callbacks removed — ProcessTab has been deleted.

  const requestTabChange = useCallback(
    (tab: AppMainTab) => {
      // Block tab change if an upload is actually in progress (destructive regardless of destination).
      if (processUploadBlocked && tab !== activeTab) {
        setLeaveUploadTargetTab(tab);
        return;
      }
      // Block tab change while PDF is being processed.
      if (pdfIsProcessing && tab !== activeTab) {
        setLeavePdfTargetTab(tab);
        return;
      }
      // Switching from sessions prepare mode to other tabs is allowed - ProcessTab stays mounted.
      if (tab === "chat") {
        setAssistantFocusNonce((n) => n + 1);
      }
      setActiveTab(tab);
    },
    [activeTab, processUploadBlocked, pdfIsProcessing]
  );

  const handlePreferredOutputLanguageChange = useCallback(
    async (nextCodeRaw: string) => {
      const uid = session?.user?.id;
      if (!uid) return;
      const nextCode = nextCodeRaw.trim().toLowerCase();
      if (!isKnownOutputLanguageCode(nextCode)) return;
      if (nextCode === preferredOutputLang) return;

      setPreferredOutputLang(nextCode);
      setPreferredOutputLangError(null);
      await updateProfilePreferredLanguage(nextCode, uid);
      const meetDiffers = googleMeetSummaryLang !== nextCode;
      if (dictationLang !== nextCode || pdfSummaryLang !== nextCode || meetDiffers) {
        setPendingLanguageSyncCode(nextCode);
      }
    },
    [
      session?.user?.id,
      preferredOutputLang,
      dictationLang,
      pdfSummaryLang,
      googleMeetSummaryLang,
    ]
  );

  if (!loaded) {
    return (
      <div className="app-root">
        <div style={{ padding: 24, color: "var(--text-secondary)" }}>
          Loading…
        </div>
      </div>
    );
  }

  if (faqOpen) {
    return (
      <div className="app-root app-faq-root">
        <div className="faq-top-bar">
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => setFaqOpen(false)}
          >
            Back Home
          </button>
        </div>
        <FaqPage />
      </div>
    );
  }

  /** Full-bleed flex layout only when the real chat UI is shown - keeps sign-in / premium gates aligned with other tabs. */
  const showAssistantChatLayout =
    activeTab === "chat" && authReady && session && profileReady;

  return (
    <div className="app-root">
      {/* Header */}
      <header className="app-header">
        <img src="/kts-icon-brand.png" alt="Kety" className="kts-icon" />
        <h1 className="app-title">Kety</h1>
        <div className="app-header-icon-group">
          <button
            type="button"
            className="btn-icon-faq"
            onClick={() => setFaqOpen(true)}
            title="FAQ"
            aria-label="Open FAQ"
          >
            <IconFaqHelp />
          </button>
          {session && isSuperAdmin && (
            <button
              type="button"
              className="btn-icon-settings"
              onClick={() => {
                setSetupOnboardingSource("manual");
                setSetupOnboardingOpen(true);
              }}
              title="Preview setup onboarding (super admin)"
              aria-label="Preview setup onboarding"
            >
              <IconOnboarding />
            </button>
          )}
          {session && (
            <button
              type="button"
              className="btn-icon-settings"
              onClick={() => setSqliteInspectorOpen(true)}
              title="SQLite Inspector"
              aria-label="SQLite Inspector"
            >
              <IconDatabase />
            </button>
          )}
          {session && (
            <button
              type="button"
              className="btn-icon-settings"
              onClick={() => setStoreInspectorOpen(true)}
              title="Store Inspector"
              aria-label="Store Inspector"
            >
              <IconDocument />
            </button>
          )}
          <button
            type="button"
            className={`btn-icon-settings${activeTab === "settings" ? " btn-icon-settings--active" : ""}`}
            onClick={() => activeTab === "settings" ? setActiveTab("sessions") : requestTabChange("settings")}
            title={activeTab === "settings" ? "Close settings" : "Settings"}
            aria-label={activeTab === "settings" ? "Close settings" : "Settings"}
          >
            <IconSettings />
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <div className="tab-bar">
        <button
          className={`tab${activeTab === "sessions" ? " tab-active" : ""}`}
          onClick={() => requestTabChange("sessions")}
        >
          Captures
        </button>
        <button
          className={`tab${activeTab === "chat" ? " tab-active" : ""}`}
          onClick={() => requestTabChange("chat")}
        >
          AI Assistant
        </button>
      </div>

      {/* Content */}
      <div
        className={`tab-content${showAssistantChatLayout ? " tab-content--chat" : ""}${
          activeTab === "sessions" ? " tab-content--captures" : ""
        }`}
      >
        {/* ── Captures tab ─────────────────────────────────────────── */}
        {activeTab === "sessions" && (
          <CapturesTab
            authReady={authReady}
            session={session}
            capturesSort={capturesSort}
            setCapturesSort={setCapturesSort}
            showFilters={showFilters}
            setShowFilters={setShowFilters}
            filterTagIds={filterTagIds}
            setFilterTagIds={setFilterTagIds}
            filterSensitiveVerdicts={filterSensitiveVerdicts}
            setFilterSensitiveVerdicts={setFilterSensitiveVerdicts}
            filterTagSensitiveCombine={filterTagSensitiveCombine}
            setFilterTagSensitiveCombine={setFilterTagSensitiveCombine}
            filterDateFrom={filterDateFrom}
            setFilterDateFrom={setFilterDateFrom}
            filterDateTo={filterDateTo}
            setFilterDateTo={setFilterDateTo}
            capturesSearch={capturesSearch}
            setCapturesSearch={setCapturesSearch}
            searchMatchIndex={searchMatchIndex}
            setSearchMatchIndex={setSearchMatchIndex}
            searchTermAtCollapse={searchTermAtCollapse}
            setSearchTermAtCollapse={setSearchTermAtCollapse}
            showDateRange={showDateRange}
            setShowDateRange={setShowDateRange}
            dateFromBtnRef={dateFromBtnRef}
            dateFromRect={dateFromRect}
            setDateFromRect={setDateFromRect}
            showDateFromPicker={showDateFromPicker}
            setShowDateFromPicker={setShowDateFromPicker}
            dateToBtnRef={dateToBtnRef}
            dateToRect={dateToRect}
            setDateToRect={setDateToRect}
            showDateToPicker={showDateToPicker}
            setShowDateToPicker={setShowDateToPicker}
            captureTags={captureTags}
            setShowTagsManager={setShowTagsManager}
            setShowHistoryPopup={setShowHistoryPopup}
            setHistoryFilter={setHistoryFilter}
            setHistoryDeletePending={setHistoryDeletePending}
            setHistoryFlushAllPending={setHistoryFlushAllPending}
            historyFlash={historyFlash}
            expandedAppGroups={expandedAppGroups}
            setExpandedAppGroups={setExpandedAppGroups}
            currentGroupNamesRef={currentGroupNamesRef}
            offSessionNotes={offSessionNotes}
            offSessionImages={offSessionImages}
            offSessionVideos={offSessionVideos}
            setOffSessionNotes={setOffSessionNotes}
            setOffSessionImages={setOffSessionImages}
            setOffSessionVideos={setOffSessionVideos}
            selectedItemIds={selectedItemIds}
            setSelectedItemIds={setSelectedItemIds}
            toggleItemSelected={toggleItemSelected}
            selectAllPending={selectAllPending}
            setSelectAllPending={setSelectAllPending}
            setConfirmKind={setConfirmKind}
            setShowAssignTagPicker={setShowAssignTagPicker}
                processingIds={processingIds}
            scanCancelRef={scanCancelRef}
            scanResultCountsRef={scanResultCountsRef}
            sensitiveScanModel={sensitiveScanModel}
            openAiApiKey={openAiApiKey}
            setScanRescanDialog={setScanRescanDialog}
            setShowScanPopup={setShowScanPopup}
            setScanBusy={setScanBusy}
            setScanError={setScanError}
            setScanProgress={setScanProgress}
            setScanResultCounts={setScanResultCounts}
            setScanCancelPending={setScanCancelPending}
            onRequestCaptureReload={() => setCaptureReloadNonce((n) => n + 1)}
            zipDownloadBusy={zipDownloadBusy}
            downloadRecordingsContextArchive={downloadRecordingsContextArchive}
            fileSizeByPath={fileSizeByPath}
            ocrTextByPath={ocrTextByPath}
            updateOcrText={updateOcrText}
            pdfDropZoneRef={pdfDropZoneRef}
            pdfPagesMode={pdfPagesMode}
            pdfPagesCount={pdfPagesCount}
            pdfPagesPercent={pdfPagesPercent}
            pdfWarnThreshold={pdfWarnThreshold}
            pdfSummaryLang={pdfSummaryLang}
            pdfModelFilename={pdfModelFilename}
            pdfParallelism={pdfParallelism}
            setPdfIsProcessing={setPdfIsProcessing}
            handlePdfSummaryReady={handlePdfSummaryReady}
            filterTextSubTypes={filterTextSubTypes}
            setFilterTextSubTypes={setFilterTextSubTypes}
            onCaptureTagChange={persistCaptureTags}
            onSensitiveStateChange={persistSensitiveState}
            onCaptureDataSave={persistCaptureData}
          />
        )}

        {/* ── Assistant Chat tab ─────────────────────────────────── */}
        {/* Auth/loading gates: only shown when on the chat tab. */}
        {activeTab === "chat" &&
          (!authReady ? (
            <div className="glass-card">
              <p className="settings-hint">Loading…</p>
            </div>
          ) : !profileReady ? (
            <div className="glass-card">
              <p className="settings-hint">Loading…</p>
            </div>
          ) : null)}
        {/* AssistantChatTab stays mounted once auth is ready so in-flight streams
            survive tab switches. Hidden via CSS when not on the chat tab.
            TODO: replace with proper async architecture (server-side history, polling/ws). */}
        {authReady && session && profileReady && (
          <div style={{ display: activeTab === "chat" ? "contents" : "none" }}>
            <AssistantChatTab
              sessionUserId={session.user.id}
              contextTabs={assistantContextTabs}
              contextTabsError={importedAssistantsError}
              activeContextId={assistantActiveContextId}
              onActiveContextChange={setAssistantActiveContextId}
              focusNonce={assistantFocusNonce}
              assistantPreferencesOpenNonce={assistantPreferencesOpenNonce}
              chatResetNonce={assistantChatResetNonce}
              externalStoreRevision={assistantChatStoreRevision}
              premiumAssistantLocked={false}
              isSuperAdmin={isSuperAdmin}
              openAiApiKey={openAiApiKey}
              assistantModel={assistantModel}
              embedStatus={embedStatus}
              localIndexStats={localIndexStats}
              qwenStatus={qwenStatus}
              onAssistantModelChange={setAssistantModel}
              onImportedAssistantsChanged={async (activateContextId) => {
                await refreshImportedAssistants();
                // Only after the refresh: the fallback effect above sends the
                // chat back to "Me" whenever the active id is not among the
                // tabs, and a freshly imported id is not among them until the
                // registry has been re-read.
                if (activateContextId) setAssistantActiveContextId(activateContextId);
              }}
              onGoToSettings={(scrollToId) => {
                setActiveTab("settings");
                setTimeout(() => {
                  const id =
                    scrollToId && scrollToId.length > 0 ? scrollToId : "settings-ai-tasks";
                  document.getElementById(id)?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }, 100);
              }}
              captureTags={captureTags}
            />
          </div>
        )}

        {/* ── Settings tab ──────────────────────────────────────── */}
        {activeTab === "settings" && (
          <SettingsTab
            authReady={authReady}
            session={session}
            preferredOutputLang={preferredOutputLang}
            preferredOutputLangSaving={preferredOutputLangSaving}
            preferredOutputLangError={preferredOutputLangError}
            handlePreferredOutputLanguageChange={handlePreferredOutputLanguageChange}
            assistantModel={assistantModel}
            setAssistantModel={setAssistantModel}
            hasOpenAiApiKey={hasOpenAiApiKey}
            onOpenAssistantPreferences={openAssistantTabAndPreferences}
            attachOffSessionFocus={attachOffSessionFocus}
            setAttachOffSessionFocus={setAttachOffSessionFocus}
            chromeExtensionAutoMeetCaptures={chromeExtensionAutoMeetCaptures}
            setChromeExtensionAutoMeetCaptures={setChromeExtensionAutoMeetCaptures}
            meetBridgeToken={meetBridgeToken}
            setMeetBridgeToken={setMeetBridgeToken}
            meetBridgePort={meetBridgePort}
            setMeetBridgePort={setMeetBridgePort}
            chromeExtZipExportMessage={chromeExtZipExportMessage}
            setChromeExtZipExportMessage={setChromeExtZipExportMessage}
            setShowChromeExtensionInstallPopup={setShowChromeExtensionInstallPopup}
            googleMeetSummaryLang={googleMeetSummaryLang}
            setGoogleMeetSummaryLang={setGoogleMeetSummaryLang}
            googleMeetSummaryPrompt={googleMeetSummaryPrompt}
            setGoogleMeetSummaryPrompt={setGoogleMeetSummaryPrompt}
            dictationCustomModel={dictationCustomModel}
            setDictationCustomModel={setDictationCustomModel}
            dictationCustomPromptHighlight={dictationCustomPromptHighlight}
            setDictationCustomPromptHighlight={setDictationCustomPromptHighlight}
            dictationCustomPromptNoHighlight={dictationCustomPromptNoHighlight}
            setDictationCustomPromptNoHighlight={setDictationCustomPromptNoHighlight}
            autoTagTextLimit={autoTagTextLimit}
            setAutoTagTextLimit={setAutoTagTextLimit}
            showEnableAutoTagPopup={showEnableAutoTagPopup}
            setShowEnableAutoTagPopup={setShowEnableAutoTagPopup}
            autoScanSensitive={autoScanSensitive}
            setAutoScanSensitive={setAutoScanSensitive}
            meetSensitiveScanIncludeRawTranscript={meetSensitiveScanIncludeRawTranscript}
            setMeetSensitiveScanIncludeRawTranscript={setMeetSensitiveScanIncludeRawTranscript}
            autoAssignTags={autoAssignTags}
            setAutoAssignTags={setAutoAssignTags}
            setShowTagsManager={setShowTagsManager}
            dictationProvider={dictationProvider}
            setDictationProvider={setDictationProvider}
            dictationLang={dictationLang}
            setDictationLang={setDictationLang}
            keepDictationHistory={keepDictationHistory}
            setKeepDictationHistory={setKeepDictationHistory}
            keepCopyHistory={keepCopyHistory}
            setKeepCopyHistory={setKeepCopyHistory}
            captureHistoryRetention={captureHistoryRetention}
            setCaptureHistoryRetention={setCaptureHistoryRetention}
            screenRecordQuality={screenRecordQuality}
            setScreenRecordQuality={setScreenRecordQuality}
            dictationAutoStopMinutes={dictationAutoStopMinutes}
            setDictationAutoStopMinutes={setDictationAutoStopMinutes}
            screenRecordAutoStopMinutes={screenRecordAutoStopMinutes}
            setScreenRecordAutoStopMinutes={setScreenRecordAutoStopMinutes}
            localLlmParallelCalls={localLlmParallelCalls}
            setLocalLlmParallelCalls={setLocalLlmParallelCalls}
            sensitivePromptTemplate={sensitivePromptTemplate}
            setSensitivePromptTemplate={setSensitivePromptTemplate}
            sensitivePromptSaveBusy={sensitivePromptSaveBusy}
            setSensitivePromptSaveBusy={setSensitivePromptSaveBusy}
            sensitiveScanModel={sensitiveScanModel}
            setSensitiveScanModel={setSensitiveScanModel}
            localLlmStatus={localLlmStatus}
            pdfWarnThreshold={pdfWarnThreshold}
            setPdfWarnThreshold={setPdfWarnThreshold}
            pdfSummaryLang={pdfSummaryLang}
            setPdfSummaryLang={setPdfSummaryLang}
            pdfPagesMode={pdfPagesMode}
            setPdfPagesMode={setPdfPagesMode}
            pdfPagesCount={pdfPagesCount}
            setPdfPagesCount={setPdfPagesCount}
            pdfPagesPercent={pdfPagesPercent}
            setPdfPagesPercent={setPdfPagesPercent}
            pdfParallelism={pdfParallelism}
            setPdfParallelism={setPdfParallelism}
            pdfModelFilename={pdfModelFilename}
            setPdfModelFilename={setPdfModelFilename}
            whisperStatus={whisperStatus}
            setWhisperStatus={setWhisperStatus}
            whisperDownloading={whisperDownloading}
            setWhisperDownloading={setWhisperDownloading}
            whisperDownloadPercent={whisperDownloadPercent}
            setWhisperDownloadPercent={setWhisperDownloadPercent}
            qwenStatus={qwenStatus}
            setQwenStatus={setQwenStatus}
            qwenDownloading={qwenDownloading}
            setQwenDownloading={setQwenDownloading}
            qwenDownloadPercent={qwenDownloadPercent}
            setQwenDownloadPercent={setQwenDownloadPercent}
            embedStatus={embedStatus}
            setEmbedStatus={setEmbedStatus}
            localIndexStats={localIndexStats}
            embedDownloading={embedDownloading}
            setEmbedDownloading={setEmbedDownloading}
            embedDownloadPercent={embedDownloadPercent}
            setEmbedDownloadPercent={setEmbedDownloadPercent}
            openAiApiKey={openAiApiKey}
            setOpenAiApiKey={setOpenAiApiKey}
            openAiApiKeyReplaceMode={openAiApiKeyReplaceMode}
            setOpenAiApiKeyReplaceMode={setOpenAiApiKeyReplaceMode}
            openAiApiKeyDraft={openAiApiKeyDraft}
            setOpenAiApiKeyDraft={setOpenAiApiKeyDraft}
            openAiApiKeyGuardError={openAiApiKeyGuardError}
            setOpenAiApiKeyGuardError={setOpenAiApiKeyGuardError}
            showOpenAiKeyMasked={showOpenAiKeyMasked}
            commitOpenAiApiKeyRemoval={commitOpenAiApiKeyRemoval}
            hotkeyKeyLetters={hotkeyKeyLetters}
            hotkeyPickerKey={hotkeyPickerKey}
            setHotkeyPickerKey={setHotkeyPickerKey}
            pickHotkeyLetter={pickHotkeyLetter}
            hotkeyPickerAnchorRefs={hotkeyPickerAnchorRefs}
            fnDictationShortcutEnabled={fnDictationShortcutEnabled}
            setFnDictationShortcutEnabled={setFnDictationShortcutEnabled}
            setConfirmKind={setConfirmKind}
            userIdRef={userIdRef}
            meetExtensionSetupJumpNonce={meetExtensionSetupJumpNonce}
            embedThreads={embedThreads}
            setEmbedThreads={setEmbedThreads}
            embedOpenAiBatchSize={embedOpenAiBatchSize}
            setEmbedOpenAiBatchSize={setEmbedOpenAiBatchSize}
            embedOpenAiParallel={embedOpenAiParallel}
            setEmbedOpenAiParallel={setEmbedOpenAiParallel}
            activeEmbedModelId={embedStatus?.activeModel ?? ""}
            autoIndexEnabled={autoIndexEnabled}
            setAutoIndexEnabled={setAutoIndexEnabled}
            defaultIndexDocContent={defaultIndexDocContent}
            setDefaultIndexDocContent={setDefaultIndexDocContent}
            defaultIndexMeetTranscript={defaultIndexMeetTranscript}
            setDefaultIndexMeetTranscript={setDefaultIndexMeetTranscript}
          />
        )}
      </div>

      {openAiNewKeyConfigureDialogOpen ? (
        <OpenAiKeyConfigureFeaturesModal
          onDismiss={dismissOpenAiNewKeyConfigureDialog}
          onOpenSettingsToSection={goToSettingsSection}
          qwenStatus={qwenStatus}
          assistantModel={assistantModel}
          setAssistantModel={setAssistantModel}
          pdfModelFilename={pdfModelFilename}
          setPdfModelFilename={setPdfModelFilename}
          sensitiveScanModel={sensitiveScanModel}
          setSensitiveScanModel={setSensitiveScanModel}
          setQwenStatus={setQwenStatus}
          dictationProvider={dictationProvider}
          setDictationProvider={setDictationProvider}
          whisperStatus={whisperStatus}
        />
      ) : null}


      {leaveUploadTargetTab != null && (
        <div
          className="history-error-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-upload-title"
          onClick={() => setLeaveUploadTargetTab(null)}
        >
          <div
            className="history-error-dialog glass-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="leave-upload-title" className="history-error-title">
              Upload in progress
            </h3>
            <p className="settings-hint" style={{ marginBottom: 16 }}>
              Files are currently being uploaded to the cloud. Switching tabs will interrupt the
              upload - the batch will not be saved on the server.
            </p>
            <div className="controls-row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setLeaveUploadTargetTab(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const tab = leaveUploadTargetTab;
                  if (tab == null) return;
                  setLeaveUploadTargetTab(null);
                  activeUploadServerDumpIdRef.current = null;
                  if (tab === "chat") {
                    setAssistantFocusNonce((n) => n + 1);
                  }
                  setActiveTab(tab);
                }}
              >
                Discard and switch tab
              </button>
            </div>
          </div>
        </div>
      )}

      {leavePdfTargetTab != null && (
        <div
          className="history-error-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-pdf-title"
          onClick={() => setLeavePdfTargetTab(null)}
        >
          <div
            className="history-error-dialog glass-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="leave-pdf-title" className="history-error-title">
              PDF processing in progress
            </h3>
            <p className="settings-hint" style={{ marginBottom: 16 }}>
              A document is being summarized. What would you like to do before switching tabs?
            </p>
            <div className="controls-row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setLeavePdfTargetTab(null)}
              >
                Keep processing
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  const tab = leavePdfTargetTab;
                  pdfDropZoneRef.current?.discard();
                  setLeavePdfTargetTab(null);
                  if (tab === "chat") setAssistantFocusNonce((n) => n + 1);
                  setActiveTab(tab);
                }}
              >
                Discard all &amp; stop now
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const tab = leavePdfTargetTab;
                  pdfDropZoneRef.current?.stopAndSave();
                  setLeavePdfTargetTab(null);
                  if (tab === "chat") setAssistantFocusNonce((n) => n + 1);
                  setActiveTab(tab);
                }}
              >
                Stop here &amp; save
              </button>
            </div>
          </div>
        </div>
      )}

      {showLeavePrepareBackDialog && (
        <div
          className="history-error-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-prepare-back-title"
          onClick={() => setShowLeavePrepareBackDialog(false)}
        >
          <div
            className="history-error-dialog glass-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="leave-prepare-back-title" className="history-error-title">
              Back to sessions?
            </h3>
            <p className="settings-hint" style={{ marginBottom: 10 }}>
              Filters, exclusions, and sensitive-scan results will be discarded.
            </p>
            <p className="settings-hint" style={{ marginBottom: 16 }}>
              Text edits already saved to disk are kept. Pending inline edits are saved before leaving.
            </p>
            <div className="controls-row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowLeavePrepareBackDialog(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowLeavePrepareBackDialog(false);
                  prepareLeaveFlushRef.current?.();
                }}
              >
                Discard and go back
              </button>
            </div>
          </div>
        </div>
      )}

      <TagsManagerModal
        open={showTagsManager}
        onClose={() => setShowTagsManager(false)}
        editingTag={editingTag}
        setEditingTag={setEditingTag}
        tagDeletePending={tagDeletePending}
        setTagDeletePending={setTagDeletePending}
        captureTags={captureTags}
        setCaptureTags={setCaptureTags}
        offSessionNotes={offSessionNotes}
        offSessionImages={offSessionImages}
        offSessionVideos={offSessionVideos}
        setOffSessionNotes={setOffSessionNotes}
        setOffSessionImages={setOffSessionImages}
        setOffSessionVideos={setOffSessionVideos}
        shareContacts={shareContacts}
        onSaveTag={(tag) => {
          const uid = userIdRef.current;
          if (uid) void localSaveTag(uid, {
            id: tag.id,
            name: tag.name,
            description: tag.description,
            color: tag.color,
            autoAssignApps: tag.autoAssignApps ?? [],
            createdAt: tag.createdAt,
          }).catch(console.error);
        }}
        onDeleteTag={(tagId) => {
          const uid = userIdRef.current;
          if (uid) void localDeleteTag(uid, tagId).catch(console.error);
        }}
      />

      <ChromeExtensionInstallPopup
        open={showChromeExtensionInstallPopup}
        onClose={() => setShowChromeExtensionInstallPopup(false)}
      />

      <CaptureHistoryPopup
        open={showHistoryPopup}
        onClose={() => setShowHistoryPopup(false)}
        dictationFieldInjects={dictationFieldInjects}
        setDictationFieldInjects={setDictationFieldInjects}
        copyHistoryNotes={copyHistoryNotes}
        setCopyHistoryNotes={setCopyHistoryNotes}
        historyFilter={historyFilter}
        setHistoryFilter={setHistoryFilter}
        historyDeletePending={historyDeletePending}
        setHistoryDeletePending={setHistoryDeletePending}
        historyFlushAllPending={historyFlushAllPending}
        setHistoryFlushAllPending={setHistoryFlushAllPending}
        onAddCapture={addHistoryNoteAsCapture}
        setActiveTab={setActiveTab}
      />

      {scanRescanDialog && (() => {
        const alreadyScanned = [...selectedItemIds].filter((key) => {
          if (key.startsWith("offNote|")) {
            const note = offSessionNotes.find((n) => n.id === key.slice(8));
            return !!note?.sensitiveVerdict;
          }
          return false;
        }).length;
        const runScan = async (mode: "all" | "new") => {
          setScanRescanDialog(false);
          setShowScanPopup(true);
          setScanBusy(true);
          setScanError(null);
          setScanCancelPending(false);
          setScanResultCounts(null);
          scanResultCountsRef.current = { critical: 0, atRisk: 0 };
          scanCancelRef.current = false;
          // Snapshot current verdicts for discard
          const snap: Record<string, "critical" | "potential" | "clean" | undefined> = {};
          for (const key of selectedItemIds) {
            if (key.startsWith("offNote|")) snap[key] = offSessionNotes.find((n) => n.id === key.slice(8))?.sensitiveVerdict;
          }
          scanSnapshotRef.current = snap;
          type ScanItem = { text: string; appName: string; windowTitle: string; kind: "note"; noteId?: string };
          const items: ScanItem[] = [];
          for (const key of selectedItemIds) {
            if (key.startsWith("offNote|")) {
              const note = offSessionNotes.find((n) => n.id === key.slice(8));
              if (!note) continue;
              if (mode === "new" && note.sensitiveVerdict) continue;
              const text = offSessionNoteBody(note);
              if (!text.trim()) continue;
              items.push({ text, appName: note.contextFocus?.appName ?? "", windowTitle: note.contextFocus?.windowName ?? "", kind: "note", noteId: note.id });
            }
          }
          setScanProgress({ done: 0, total: items.length });
          const scanUsesRemote = sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX);
          for (let i = 0; i < items.length; i++) {
            if (scanCancelRef.current) break;
            const item = items[i]!;
            try {
              let r = await invoke<SensitivePreviewResponse>("sensitive_preview_run_cmd", {
                req: { text: item.text, displayApp: item.appName, windowTitle: item.windowTitle },
                sensitiveScanModel: scanUsesRemote ? sensitiveScanModel : null,
                openaiApiKey: sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX) ? openAiApiKey.trim() : null,
              });
              if (r.parsed === null && !scanCancelRef.current) {
                r = await invoke<SensitivePreviewResponse>("sensitive_preview_run_cmd", {
                  req: { text: item.text, displayApp: item.appName, windowTitle: item.windowTitle },
                  sensitiveScanModel: scanUsesRemote ? sensitiveScanModel : null,
                  openaiApiKey: sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX) ? openAiApiKey.trim() : null,
                });
              }
              if (r.parsed !== null) {
                const verdict: "critical" | "potential" | "clean" = r.parsed === -1 ? "critical" : r.parsed === 0 ? "potential" : "clean";
                if (verdict === "critical") scanResultCountsRef.current.critical += 1;
                else if (verdict === "potential") scanResultCountsRef.current.atRisk += 1;
                setOffSessionNotes((prev) => prev.map((n) => n.id === item.noteId ? { ...n, sensitiveVerdict: verdict } : n));
              }
            } catch { /* skip */ }
            setScanProgress({ done: i + 1, total: items.length });
          }
          setScanResultCounts({ ...scanResultCountsRef.current }); setScanBusy(false); setScanCancelPending(false);
        };
        return (
          <div className="history-error-overlay" role="dialog" aria-modal="true" aria-labelledby="scan-rescan-title" onClick={() => setScanRescanDialog(false)}>
            <div className="history-popup-solid" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
              <h3 id="scan-rescan-title" className="history-error-title">Some captures already scanned</h3>
              <p className="settings-hint" style={{ marginBottom: 16 }}>{alreadyScanned} of the selected captures have been scanned before. Skip them and only scan the rest, or re-run the scan on all selected captures?</p>
              <div className="controls-row" style={{ gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="btn btn-secondary" onClick={() => setScanRescanDialog(false)}>Cancel</button>
                <button type="button" className="btn btn-secondary" onClick={() => void runScan("new")}>Skip already scanned</button>
                <button type="button" className="btn btn-primary" onClick={() => void runScan("all")}>Re-scan all</button>
              </div>
            </div>
          </div>
        );
      })()}

      {showScanPopup && (
        <div className="history-error-overlay" role="dialog" aria-modal="true" aria-labelledby="scan-progress-title">
          <div className="history-popup-solid" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 id="scan-progress-title" className="history-error-title">
              {scanBusy ? "Scanning for sensitive data…" : "Scan complete"}
            </h3>
            {scanProgress && (
              <>
                <div className="scan-progress-bar-wrap">
                  <div className="scan-progress-bar" style={{ width: `${Math.round((scanProgress.done / Math.max(1, scanProgress.total)) * 100)}%` }} />
                </div>
                <p className="settings-hint" style={{ marginTop: 8 }}>{scanProgress.done} / {scanProgress.total}</p>
              </>
            )}
            {scanError && <p style={{ color: "var(--destructive)", fontSize: 13, marginTop: 8 }}>{scanError}</p>}
            {!scanBusy && !scanCancelPending && scanResultCounts && (
              <div style={{ marginTop: 10 }}>
                {scanResultCounts.critical === 0 && scanResultCounts.atRisk === 0 ? (
                  <p className="settings-hint">No sensitive data detected.</p>
                ) : (
                  <p className="settings-hint">
                    Found{scanResultCounts.critical > 0 ? <> <strong style={{ color: "#dc2626" }}>{scanResultCounts.critical} critical</strong></> : null}{scanResultCounts.critical > 0 && scanResultCounts.atRisk > 0 ? " and" : null}{scanResultCounts.atRisk > 0 ? <> <strong style={{ color: "#ea580c" }}>{scanResultCounts.atRisk} at risk</strong></> : null}{" "}warning{scanResultCounts.critical + scanResultCounts.atRisk !== 1 ? "s" : ""}. Filters opened automatically.
                  </p>
                )}
              </div>
            )}
            {scanCancelPending && (
              <p className="settings-hint" style={{ marginTop: 10 }}>
                Scan stopped. What would you like to do with the results gathered so far?
              </p>
            )}
            <div className="controls-row" style={{ marginTop: 14, justifyContent: "flex-end", gap: 8 }}>
              {scanBusy && !scanCancelPending && (
                <button type="button" className="btn btn-secondary" onClick={() => { scanCancelRef.current = true; setScanCancelPending(true); }}>Stop</button>
              )}
              {scanCancelPending && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      const snap = scanSnapshotRef.current;
                      setOffSessionNotes((prev) => prev.map((n) => { const key = `offNote|${n.id}`; return key in snap ? { ...n, sensitiveVerdict: snap[key] } : n; }));
                      setShowScanPopup(false); setScanProgress(null); setScanError(null); setScanCancelPending(false);
                    }}
                  >
                    Discard results
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => { setShowScanPopup(false); setScanProgress(null); setScanError(null); setScanCancelPending(false); }}
                  >
                    Keep results so far
                  </button>
                </>
              )}
              {!scanBusy && !scanCancelPending && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const counts = scanResultCounts;
                    setShowScanPopup(false); setScanProgress(null); setScanError(null);
                    if (counts && (counts.critical > 0 || counts.atRisk > 0)) {
                      const verdicts: ("critical" | "potential")[] = [];
                      if (counts.critical > 0) verdicts.push("critical");
                      if (counts.atRisk > 0) verdicts.push("potential");
                      setFilterSensitiveVerdicts(verdicts);
                      setShowFilters(true);
                      if (capturesSort === "app" || capturesSort === "type") {
                        // Expand all groups so filtered items are visible
                        setExpandedAppGroups((prev) => {
                          const next: Record<string, boolean> = { ...prev };
                          for (const k of currentGroupNamesRef.current) next[k] = true;
                          return next;
                        });
                      }
                    }
                  }}
                >
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <AssignTagsPickerModal
        open={showAssignTagPicker}
        onClose={() => setShowAssignTagPicker(false)}
        selectedItemIds={selectedItemIds}
        captureTags={captureTags}
        assignTagAiPoolIds={assignTagAiPoolIds}
        setAssignTagAiPoolIds={setAssignTagAiPoolIds}
        assignTagAiBusy={assignTagAiBusy}
        assignTagAiProgress={assignTagAiProgress}
        assignTagAiError={assignTagAiError}
        setAssignTagAiError={setAssignTagAiError}
        sensitiveScanModel={sensitiveScanModel}
        onAssignTagsWithAi={handleAssignTagsWithAi}
        offSessionNotes={offSessionNotes}
        offSessionImages={offSessionImages}
        offSessionVideos={offSessionVideos}
        setOffSessionNotes={setOffSessionNotes}
        setOffSessionImages={setOffSessionImages}
        setOffSessionVideos={setOffSessionVideos}
        onCaptureTagChange={persistCaptureTags}
      />

      {session && (
        <SetupOnboardingModal
          open={setupOnboardingOpen}
          source={setupOnboardingSource}
          onClose={closeSetupOnboarding}
          onDismissForever={dismissSetupOnboardingForever}
          onSetupNow={jumpToAiTasksSetupFromOnboarding}
          onConfigureMeetExtension={openMeetExtensionAdvancedFromOnboarding}
          onDownloadExtensionZip={downloadExtensionZipFromOnboardingUi}
          downloadBusy={onboardingExtensionZipBusy}
          zipExportMessage={chromeExtZipExportMessage}
          preferredOutputLang={preferredOutputLang}
          preferredOutputLangSaving={preferredOutputLangSaving}
          preferredOutputLangError={preferredOutputLangError}
          onPreferredOutputLanguageChange={handlePreferredOutputLanguageChange}
        />
      )}

      {sqliteInspectorOpen && session?.user?.id && (
        <SqliteInspectorModal
          userId={session.user.id}
          onClose={() => setSqliteInspectorOpen(false)}
        />
      )}

      {storeInspectorOpen && (
        <StoreInspectorModal onClose={() => setStoreInspectorOpen(false)} />
      )}

      <LanguageSyncModal
        pendingCode={pendingLanguageSyncCode}
        dictationLang={dictationLang}
        pdfSummaryLang={pdfSummaryLang}
        googleMeetSummaryLang={googleMeetSummaryLang}
        onClose={() => setPendingLanguageSyncCode(null)}
        onAlign={(code) => {
          setDictationLang(code);
          setPdfSummaryLang(code);
          setGoogleMeetSummaryLang(code);
          setPendingLanguageSyncCode(null);
        }}
      />

      {confirmKind && (
        <div
          className="confirm-overlay"
          onClick={() => setConfirmKind(null)}
          role="presentation"
        >
          <div
            className="confirm-dialog confirm-dialog-wide"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
          >
            {(() => {
              if (confirmKind.type === "localModelInUseWarning") {
                return (
                  <>
                    <h2 id="confirm-dialog-title" className="confirm-title">
                      Cannot remove {confirmKind.modelLabel}
                    </h2>
                    <p className="confirm-intro">
                      This model is currently in use. Please choose a different model first:
                    </p>
                    <ul className="confirm-detail-list" style={{ marginTop: 8 }}>
                      {confirmKind.usedIn.map((u) => (
                        <li key={u.sectionId} style={{ marginBottom: 4 }}>
                          <button
                            type="button"
                            style={{
                              background: "none",
                              border: "none",
                              color: "var(--color-accent, #60a5fa)",
                              cursor: "pointer",
                              padding: 0,
                              fontSize: 13,
                              textDecoration: "underline",
                            }}
                            onClick={() => {
                              setConfirmKind(null);
                              document
                                .getElementById(u.sectionId)
                                ?.scrollIntoView({ behavior: "smooth", block: "start" });
                            }}
                          >
                            {u.label} →
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="confirm-actions" style={{ marginTop: 16 }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setConfirmKind(null)}
                      >
                        Got it
                      </button>
                    </div>
                  </>
                );
              }
              const copy = getConfirmCopy(confirmKind);
              return (
                <>
                  <h2 id="confirm-dialog-title" className="confirm-title">
                    {copy.title}
                  </h2>
                  <p className="confirm-intro">{copy.intro}</p>
                  {copy.bullets.length > 0 && (
                    <ul className="confirm-detail-list">
                      {copy.bullets.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                  <p className="confirm-warning">{copy.warning}</p>
                  <div className="confirm-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setConfirmKind(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-destructive"
                      onClick={() => void runConfirmedAction(confirmKind)}
                    >
                      {copy.confirmLabel}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
      {uploadOverlayProgress != null && (
        <div className="upload-overlay">
          <div className="glass-card upload-overlay-card" onClick={(e) => e.stopPropagation()}>
            {uploadCancelConfirm ? (
              <>
                <p className="section-label" style={{ marginBottom: 10 }}>Cancel upload?</p>
                <p className="settings-hint" style={{ marginBottom: 16 }}>
                  Your captures will remain intact but the batch will not be processed.
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button className="btn btn-secondary" onClick={() => setUploadCancelConfirm(false)}>
                    Continue upload
                  </button>
                  <button
                    className="btn btn-destructive"
                    onClick={() => {
                      uploadCancelledRef.current = true;
                      setUploadCancelConfirm(false);
                      setUploadOverlayProgress(null);
                    }}
                  >
                    Cancel anyway
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <p className="section-label" style={{ marginBottom: 0 }}>Uploading…</p>
                  <button
                    className="upload-overlay-cancel-btn"
                    onClick={() => setUploadCancelConfirm(true)}
                    title="Cancel upload"
                  >
                    ✕
                  </button>
                </div>
                {(() => {
                  const pct = uploadOverlayProgress.progress.total === 0
                    ? 0
                    : Math.round((uploadOverlayProgress.progress.current / uploadOverlayProgress.progress.total) * 100);
                  return (
                    <div className="upload-progress">
                      <div className="upload-progress-bar-track">
                        <div className="upload-progress-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="upload-progress-message">{uploadOverlayProgress.progress.message}</p>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
