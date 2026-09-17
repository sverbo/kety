import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import type { KtsSession } from "./authContext";
import { useProfile } from "./profileContext";
import { invoke } from "@tauri-apps/api/core";
import { store } from "./appStore";
import {
  type DictationProvider,
  type ConfirmKind,
  type HotkeyKeyLetters,
  type LocalLlmStatus,
  type WhisperStatus,
  type QwenModelsStatus,
  type LocalIndexStats,
  DICTATION_PROVIDER_LOCAL,
  DICTATION_PROVIDER_OPENAI_WHISPER_1,
} from "./appTypes";
import { checkEmbedModels, downloadEmbedModel, cancelEmbedDownload, setActiveEmbedModel } from "./localIndex";
import {
  OPENAI_MODEL_PREFIX,
  OPENAI_TEXT_MODEL_OPTIONS as OPENAI_MODEL_OPTIONS,
  openAiCloudSelectOptionPlainLabel,
} from "./openaiTextModelOptions";
import { sessionStoreKeyForUser } from "./sessionStoreUser";
import { ONBOARDING_QWEN_MODEL_ID, ONBOARDING_WHISPER_MODEL_ID } from "./SetupOnboardingModal";
import { SensitivePromptHelpText } from "./SensitivePromptHelpText";
import { InfoTooltip, InfoTooltipProvider } from "./InfoTooltip";
import {
  OUTPUT_LANGUAGE_OPTIONS,
  ASSISTANT_MODEL_OPTIONS,
  ASSISTANT_MODEL_DISABLED,
  isAssistantDirectOpenAiModel,
  isAssistantLocalQwenModel,
  maskOpenAiApiKeyForDisplay,
  CAPTURE_HISTORY_RETENTION_OPTIONS,
  IconCaptureHistoryClock,
  type CaptureHistoryRetention,
} from "./appConstants";
import { SettingsModelPicker, type SettingsModelPickerOption } from "./SettingsModelPicker";
import { GcpShareSettings } from "./GcpShareSettings";
import { ProfileSettings } from "./ProfileSettings";

const EMBED_MODELS_CATALOG = [
  {
    id: "qwen3-embed-0.6b-q8",
    filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    label: "Qwen3-Embedding 0.6B (Q8)",
    sizeLabel: "~660 MB",
    dim: 1024,
  },
  {
    id: "qwen3-embed-4b-q4km",
    filename: "Qwen3-Embedding-4B-Q4_K_M.gguf",
    label: "Qwen3-Embedding 4B (Q4_K_M)",
    sizeLabel: "~2.5 GB",
    dim: 2560,
  },
] as const;

// ── Local pure constants ──────────────────────────────────────────────────────

const HOTKEY_LETTERS_AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const formatMacHotkeyDisplay = (letter: string) => `⌘⌥${letter.trim().toUpperCase()}`;
/**
 * Local GGUF filename used for Tags & sensitive when that row is set to on-device Qwen.
 * OpenAI choices do not reference a local file and must not block removing a GGUF.
 */
function tagsSensitiveLocalQwenFilename(
  sensitiveScanModel: string,
  installedModels: ReadonlyArray<{ filename: string; installed: boolean }>,
): string | null {
  if (sensitiveScanModel === "disabled") return null;
  if (sensitiveScanModel.startsWith(OPENAI_MODEL_PREFIX)) return null;
  if (sensitiveScanModel.startsWith("local:")) {
    const fn = sensitiveScanModel.slice(6).trim();
    return fn.length > 0 ? fn : null;
  }
  if (sensitiveScanModel === "local") {
    return installedModels.find((m) => m.installed)?.filename ?? null;
  }
  return null;
}

/** Checkbox label text: macOS shows ⌘ glyph + “C only”; other OS matches clipboard polling. */
function copyHistoryCheckboxTitle(): ReactNode {
  const isMac =
    typeof navigator !== "undefined" && (navigator.platform || "").toLowerCase().startsWith("mac");
  if (isMac) {
    return (
      <>
        Copy history{" ("}
        <kbd className="shortcut-key">⌘</kbd>
        {"C only)"}
      </>
    );
  }
  return <>Copy history (clipboard)</>;
}

/** Port the local MCP API listens on — MCP_PORT in `src-tauri/src/mcp_api.rs`. */
const MCP_PORT = 47847;

/** Shape returned by the `mcp_api_info_cmd` Tauri command. */
type McpApiInfo = {
  listening: boolean;
  authenticated: boolean;
  port: number;
  token: string;
  tokenFromEnv: boolean;
};

/** The one MCP endpoint the app serves (Streamable HTTP). */
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

const CODE_BLOCK_STYLE: CSSProperties = {
  background: "var(--glass-bg, rgba(0,0,0,0.06))",
  border: "1px solid var(--glass-border, rgba(0,0,0,0.1))",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 12,
  overflowX: "auto",
  margin: 0,
  userSelect: "all",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

/**
 * `claude mcp add` for a Streamable HTTP server with a bearer token. Verified
 * against `claude mcp add --help`: `-t/--transport` takes `stdio|sse|http`, and
 * `-H/--header` sets headers for HTTP servers.
 */
function claudeCodeCommand(token: string): string {
  return `claude mcp add --transport http --scope user kety-knowledge ${MCP_URL} --header "Authorization: Bearer ${token}"`;
}

/** Project-scoped `.mcp.json`, the file Claude Code really reads. */
function claudeCodeJson(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "kety-knowledge": {
          type: "http",
          url: MCP_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Claude Desktop only launches stdio servers from its config file, so it goes
 * through the Node bridge, which reads the key from its `env` block.
 */
function claudeDesktopJson(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "kety-knowledge": {
          command: "node",
          args: ["/absolute/path/to/mcp-server/index.js"],
          env: { KETY_MCP_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}

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

// ── Props ─────────────────────────────────────────────────────────────────────

export type SettingsTabProps = {
  // Auth
  authReady: boolean;
  session: KtsSession | null;

  // Output language
  preferredOutputLang: string;
  preferredOutputLangSaving: boolean;
  preferredOutputLangError: string | null;
  handlePreferredOutputLanguageChange: (code: string) => void | Promise<void>;

  // Assistant
  assistantModel: string;
  setAssistantModel: Dispatch<SetStateAction<string>>;
  hasOpenAiApiKey: boolean;
  /** Switch to the Assistant tab and open in-chat preferences (prompt preferences & assistant sharing). */
  onOpenAssistantPreferences?: () => void;

  // Captures
  attachOffSessionFocus: boolean;
  setAttachOffSessionFocus: Dispatch<SetStateAction<boolean>>;

  // Chrome extension
  chromeExtensionAutoMeetCaptures: boolean;
  setChromeExtensionAutoMeetCaptures: Dispatch<SetStateAction<boolean>>;
  meetBridgeToken: string;
  setMeetBridgeToken: Dispatch<SetStateAction<string>>;
  meetBridgePort: number;
  setMeetBridgePort: Dispatch<SetStateAction<number>>;
  chromeExtZipExportMessage: string | null;
  setChromeExtZipExportMessage: Dispatch<SetStateAction<string | null>>;
  setShowChromeExtensionInstallPopup: Dispatch<SetStateAction<boolean>>;

  // Google Meet (language & prompt; extension lives in Advanced → Google Meet)
  googleMeetSummaryLang: string;
  setGoogleMeetSummaryLang: Dispatch<SetStateAction<string>>;
  googleMeetSummaryPrompt: string;
  setGoogleMeetSummaryPrompt: Dispatch<SetStateAction<string>>;
  dictationCustomModel: string;
  setDictationCustomModel: Dispatch<SetStateAction<string>>;
  dictationCustomPromptHighlight: string;
  setDictationCustomPromptHighlight: Dispatch<SetStateAction<string>>;
  dictationCustomPromptNoHighlight: string;
  setDictationCustomPromptNoHighlight: Dispatch<SetStateAction<string>>;

  // Tags & sensitive (shared model in App state: sensitiveScanModel)
  autoTagTextLimit: number;
  setAutoTagTextLimit: Dispatch<SetStateAction<number>>;
  showEnableAutoTagPopup: boolean;
  setShowEnableAutoTagPopup: Dispatch<SetStateAction<boolean>>;
  autoScanSensitive: boolean;
  setAutoScanSensitive: Dispatch<SetStateAction<boolean>>;
  meetSensitiveScanIncludeRawTranscript: boolean;
  setMeetSensitiveScanIncludeRawTranscript: Dispatch<SetStateAction<boolean>>;
  autoAssignTags: boolean;
  setAutoAssignTags: Dispatch<SetStateAction<boolean>>;
  setShowTagsManager: Dispatch<SetStateAction<boolean>>;

  // Dictation
  dictationProvider: DictationProvider;
  setDictationProvider: Dispatch<SetStateAction<DictationProvider>>;
  dictationLang: string;
  setDictationLang: Dispatch<SetStateAction<string>>;
  keepDictationHistory: boolean;
  setKeepDictationHistory: Dispatch<SetStateAction<boolean>>;
  keepCopyHistory: boolean;
  setKeepCopyHistory: Dispatch<SetStateAction<boolean>>;
  captureHistoryRetention: CaptureHistoryRetention;
  setCaptureHistoryRetention: Dispatch<SetStateAction<CaptureHistoryRetention>>;

  // Screen recording
  screenRecordQuality: number;
  setScreenRecordQuality: Dispatch<SetStateAction<number>>;
  /** 0 = off. Rust reads store when recording starts. */
  dictationAutoStopMinutes: number;
  setDictationAutoStopMinutes: Dispatch<SetStateAction<number>>;
  screenRecordAutoStopMinutes: number;
  setScreenRecordAutoStopMinutes: Dispatch<SetStateAction<number>>;

  // Process (parallel used for batch sensitive scan + batch tagging in Process)
  localLlmParallelCalls: number;
  setLocalLlmParallelCalls: Dispatch<SetStateAction<number>>;

  // Embedding advanced settings
  embedThreads: number;
  setEmbedThreads: Dispatch<SetStateAction<number>>;
  embedOpenAiBatchSize: number;
  setEmbedOpenAiBatchSize: Dispatch<SetStateAction<number>>;
  embedOpenAiParallel: number;
  setEmbedOpenAiParallel: Dispatch<SetStateAction<number>>;
  /** Active embed model ID — needed to decide which fields to show. */
  activeEmbedModelId?: string;
  sensitivePromptTemplate: string;
  setSensitivePromptTemplate: Dispatch<SetStateAction<string>>;
  sensitivePromptSaveBusy: boolean;
  setSensitivePromptSaveBusy: Dispatch<SetStateAction<boolean>>;
  sensitiveScanModel: string;
  setSensitiveScanModel: Dispatch<SetStateAction<string>>;
  localLlmStatus: LocalLlmStatus | null;

  // File processing
  pdfWarnThreshold: number;
  setPdfWarnThreshold: Dispatch<SetStateAction<number>>;
  pdfSummaryLang: string;
  setPdfSummaryLang: Dispatch<SetStateAction<string>>;
  pdfPagesMode: "count" | "percent";
  setPdfPagesMode: Dispatch<SetStateAction<"count" | "percent">>;
  pdfPagesCount: number;
  setPdfPagesCount: Dispatch<SetStateAction<number>>;
  pdfPagesPercent: number;
  setPdfPagesPercent: Dispatch<SetStateAction<number>>;
  pdfParallelism: number;
  setPdfParallelism: Dispatch<SetStateAction<number>>;
  pdfModelFilename: string;
  setPdfModelFilename: Dispatch<SetStateAction<string>>;

  // Local LM / Whisper
  whisperStatus: WhisperStatus | null;
  setWhisperStatus: Dispatch<SetStateAction<WhisperStatus | null>>;
  whisperDownloading: string | null;
  setWhisperDownloading: Dispatch<SetStateAction<string | null>>;
  whisperDownloadPercent: number | null;
  setWhisperDownloadPercent: Dispatch<SetStateAction<number | null>>;
  qwenStatus: QwenModelsStatus | null;
  setQwenStatus: Dispatch<SetStateAction<QwenModelsStatus | null>>;
  qwenDownloading: string | null;
  setQwenDownloading: Dispatch<SetStateAction<string | null>>;
  qwenDownloadPercent: number | null;
  setQwenDownloadPercent: Dispatch<SetStateAction<number | null>>;

  // Local knowledge index (embedding models)
  embedStatus: import("./appTypes").EmbedModelsStatus | null;
  setEmbedStatus: Dispatch<SetStateAction<import("./appTypes").EmbedModelsStatus | null>>;
  localIndexStats: LocalIndexStats | null;
  embedDownloading: string | null;
  setEmbedDownloading: Dispatch<SetStateAction<string | null>>;
  embedDownloadPercent: number | null;
  setEmbedDownloadPercent: Dispatch<SetStateAction<number | null>>;

  // API key
  openAiApiKey: string;
  setOpenAiApiKey: Dispatch<SetStateAction<string>>;
  openAiApiKeyReplaceMode: boolean;
  setOpenAiApiKeyReplaceMode: Dispatch<SetStateAction<boolean>>;
  openAiApiKeyDraft: string;
  setOpenAiApiKeyDraft: Dispatch<SetStateAction<string>>;
  openAiApiKeyGuardError: string | null;
  setOpenAiApiKeyGuardError: Dispatch<SetStateAction<string | null>>;
  showOpenAiKeyMasked: boolean;
  /** Clears the stored key and resets any choices that required this key (no remembered “before” state). */
  commitOpenAiApiKeyRemoval: () => void;

  // Shortcuts
  hotkeyKeyLetters: HotkeyKeyLetters;
  hotkeyPickerKey: keyof HotkeyKeyLetters | null;
  setHotkeyPickerKey: Dispatch<SetStateAction<keyof HotkeyKeyLetters | null>>;
  pickHotkeyLetter: (rowKey: keyof HotkeyKeyLetters, L: string) => void;
  hotkeyPickerAnchorRefs: MutableRefObject<Partial<Record<keyof HotkeyKeyLetters, HTMLDivElement | null>>>;
  fnDictationShortcutEnabled: boolean;
  setFnDictationShortcutEnabled: Dispatch<SetStateAction<boolean>>;

  // Indexing defaults
  autoIndexEnabled: boolean;
  setAutoIndexEnabled: Dispatch<SetStateAction<boolean>>;
  defaultIndexDocContent: boolean;
  setDefaultIndexDocContent: Dispatch<SetStateAction<boolean>>;
  defaultIndexMeetTranscript: boolean;
  setDefaultIndexMeetTranscript: Dispatch<SetStateAction<boolean>>;

  setConfirmKind: Dispatch<SetStateAction<ConfirmKind | null>>;

  /** When incremented from App (e.g. onboarding), open File & Meet → Advanced → Google Meet. */
  meetExtensionSetupJumpNonce?: number;

  // Refs
  userIdRef: MutableRefObject<string | null> | RefObject<string | null>;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function SettingsTab({
  authReady,
  session,
  preferredOutputLang,
  preferredOutputLangSaving,
  preferredOutputLangError,
  handlePreferredOutputLanguageChange,
  assistantModel,
  setAssistantModel,
  hasOpenAiApiKey,
  onOpenAssistantPreferences,
  attachOffSessionFocus,
  setAttachOffSessionFocus,
  chromeExtensionAutoMeetCaptures,
  setChromeExtensionAutoMeetCaptures,
  meetBridgeToken,
  setMeetBridgeToken,
  meetBridgePort,
  setMeetBridgePort,
  chromeExtZipExportMessage,
  setChromeExtZipExportMessage,
  setShowChromeExtensionInstallPopup,
  googleMeetSummaryLang,
  setGoogleMeetSummaryLang,
  googleMeetSummaryPrompt,
  setGoogleMeetSummaryPrompt,
  dictationCustomModel,
  setDictationCustomModel,
  dictationCustomPromptHighlight,
  setDictationCustomPromptHighlight,
  dictationCustomPromptNoHighlight,
  setDictationCustomPromptNoHighlight,
  autoTagTextLimit,
  setAutoTagTextLimit,
  showEnableAutoTagPopup,
  setShowEnableAutoTagPopup,
  autoScanSensitive,
  setAutoScanSensitive,
  meetSensitiveScanIncludeRawTranscript,
  setMeetSensitiveScanIncludeRawTranscript,
  autoAssignTags,
  setAutoAssignTags,
  setShowTagsManager,
  dictationProvider,
  setDictationProvider,
  dictationLang,
  setDictationLang,
  keepDictationHistory,
  setKeepDictationHistory,
  keepCopyHistory,
  setKeepCopyHistory,
  captureHistoryRetention,
  setCaptureHistoryRetention,
  screenRecordQuality,
  setScreenRecordQuality,
  dictationAutoStopMinutes,
  setDictationAutoStopMinutes,
  screenRecordAutoStopMinutes,
  setScreenRecordAutoStopMinutes,
  localLlmParallelCalls,
  setLocalLlmParallelCalls,
  embedThreads,
  setEmbedThreads,
  embedOpenAiBatchSize,
  setEmbedOpenAiBatchSize,
  embedOpenAiParallel,
  setEmbedOpenAiParallel,
  activeEmbedModelId,
  sensitivePromptTemplate,
  setSensitivePromptTemplate,
  sensitivePromptSaveBusy,
  setSensitivePromptSaveBusy,
  sensitiveScanModel,
  setSensitiveScanModel,
  localLlmStatus,
  pdfWarnThreshold,
  setPdfWarnThreshold,
  pdfSummaryLang,
  setPdfSummaryLang,
  pdfPagesMode,
  setPdfPagesMode,
  pdfPagesCount,
  setPdfPagesCount,
  pdfPagesPercent,
  setPdfPagesPercent,
  pdfParallelism,
  setPdfParallelism,
  pdfModelFilename,
  setPdfModelFilename,
  whisperStatus,
  setWhisperStatus,
  whisperDownloading,
  setWhisperDownloading,
  whisperDownloadPercent,
  setWhisperDownloadPercent,
  qwenStatus,
  setQwenStatus,
  qwenDownloading,
  setQwenDownloading,
  qwenDownloadPercent,
  setQwenDownloadPercent,
  embedStatus,
  setEmbedStatus,
  localIndexStats,
  embedDownloading,
  setEmbedDownloading,
  embedDownloadPercent,
  setEmbedDownloadPercent,
  openAiApiKey,
  setOpenAiApiKey,
  openAiApiKeyReplaceMode,
  setOpenAiApiKeyReplaceMode,
  openAiApiKeyDraft,
  setOpenAiApiKeyDraft,
  openAiApiKeyGuardError,
  setOpenAiApiKeyGuardError,
  showOpenAiKeyMasked,
  commitOpenAiApiKeyRemoval,
  hotkeyKeyLetters,
  hotkeyPickerKey,
  setHotkeyPickerKey,
  pickHotkeyLetter,
  hotkeyPickerAnchorRefs,
  fnDictationShortcutEnabled,
  setFnDictationShortcutEnabled,
  autoIndexEnabled,
  setAutoIndexEnabled,
  defaultIndexDocContent,
  setDefaultIndexDocContent,
  defaultIndexMeetTranscript,
  setDefaultIndexMeetTranscript,
  setConfirmKind,
  userIdRef,
  meetExtensionSetupJumpNonce = 0,
}: SettingsTabProps) {
  const isHotkeyLetterTakenByOther = (rowKey: keyof HotkeyKeyLetters, L: string) =>
    HOTKEY_LETTER_KEYS.some((k) => k !== rowKey && hotkeyKeyLetters[k] === L);

  const { activeProfile, profiles, createProfile, switchProfile, deleteProfile, updateProfileName } = useProfile();
  const [activeSettingsSection, setActiveSettingsSection] = useState<string>("settings-account");
  const settingsRootRef = useRef<HTMLDivElement | null>(null);
  /** Ignore scroll-spy while a nav-initiated smooth scroll is settling (avoids flicker). */
  const programmaticScrollUntilRef = useRef(0);
  const navScrollSyncTimerRef = useRef<number | null>(null);
  const lastMeetExtensionJumpNonceRef = useRef(0);

  const [advFileOpen, setAdvFileOpen] = useState(false);
  const [advEmbedOpen, setAdvEmbedOpen] = useState(false);
  const [advTagsOpen, setAdvTagsOpen] = useState(false);
  const [advTagsSubTab, setAdvTagsSubTab] = useState<"tags" | "sensitive">("tags");
  const [advDictOpen, setAdvDictOpen] = useState(false);
  const [advDictCustomOpen, setAdvDictCustomOpen] = useState(false);
  const [dictCustomPromptTab, setDictCustomPromptTab] = useState<"highlight" | "noHighlight">("highlight");
  const [advFileSubTab, setAdvFileSubTab] = useState<"file" | "meet" | "chrome">("file");
  /** Shown after Generate new code (Chrome extension link); cleared when the Captures advanced modal closes. */
  const [meetBridgeNewCodeNotice, setMeetBridgeNewCodeNotice] = useState<
    null | { variant: "success" | "error"; message: string }
  >(null);

  // ── Text Actions state ────────────────────────────────────────────────────
  interface TextActionItem { id: string; title: string; prompt: string; }
  const DEFAULT_TEXT_ACTIONS: TextActionItem[] = [
    { id: "translate-en", title: "Translate to English", prompt: "Translate the following text to English without reformulating it:\n\n{context}" },
    { id: "correct-same-language", title: "Correct (same language)", prompt: "Correct grammar and spelling in the following text, keeping it in the same language and without rephrasing or changing its meaning:\n\n{context}" },
    { id: "rephrase-same-language", title: "Rephrase (same language)", prompt: "Rephrase the following text in the same language to improve clarity and flow, keeping the meaning intact:\n\n{context}" },
  ];
  const [textActions, setTextActions] = useState<TextActionItem[]>(DEFAULT_TEXT_ACTIONS);
  const [textActionsSaveHistory, setTextActionsSaveHistory] = useState(false);
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [editingActionTitle, setEditingActionTitle] = useState("");
  const [editingActionPrompt, setEditingActionPrompt] = useState("");

  useEffect(() => {
    void invoke<{ actions: TextActionItem[]; saveToHistory: boolean }>(
      "get_text_actions_config_cmd"
    ).then((cfg) => {
      if (cfg.actions.length > 0) setTextActions(cfg.actions);
      setTextActionsSaveHistory(cfg.saveToHistory);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistTextActions = (actions: TextActionItem[], saveHistory: boolean) => {
    void invoke("save_text_actions_cmd", {
      actions,
      saveToHistory: saveHistory,
    }).catch(() => {});
  };

  const startEditAction = (action: TextActionItem) => {
    setEditingActionId(action.id);
    setEditingActionTitle(action.title);
    setEditingActionPrompt(action.prompt);
  };

  const commitEditAction = () => {
    if (!editingActionId) return;
    let newActions: TextActionItem[];
    if (editingActionId === "__new__") {
      const newId = `action-${Date.now()}`;
      newActions = [...textActions, { id: newId, title: editingActionTitle.trim(), prompt: editingActionPrompt.trim() }];
    } else {
      newActions = textActions.map((a) =>
        a.id === editingActionId ? { ...a, title: editingActionTitle.trim(), prompt: editingActionPrompt.trim() } : a
      );
    }
    setTextActions(newActions);
    setEditingActionId(null);
    setEditingActionTitle("");
    setEditingActionPrompt("");
    persistTextActions(newActions, textActionsSaveHistory);
  };

  const cancelEditAction = () => {
    setEditingActionId(null);
    setEditingActionTitle("");
    setEditingActionPrompt("");
  };

  const deleteAction = (id: string) => {
    const newActions = textActions.filter((a) => a.id !== id);
    setTextActions(newActions);
    if (editingActionId === id) cancelEditAction();
    persistTextActions(newActions, textActionsSaveHistory);
  };

  const rec = (on: boolean) => (on ? " ★" : "");
  const firstInstalledQwenFilename = qwenStatus?.models.find((m) => m.installed)?.filename ?? "";
  const firstInstalledWhisperFilename = whisperStatus?.models.find((m) => m.installed)?.filename ?? "";
  const anyWhisperInstalled = (whisperStatus?.models ?? []).some((m) => m.installed);
  const hasLocalWhisperReady =
    Boolean(whisperStatus?.selectedModel?.trim()) &&
    (whisperStatus?.models ?? []).some(
      (m) => m.installed && m.filename === whisperStatus?.selectedModel
    );
  const localWhisperDictationRow = whisperStatus?.selectedModel
    ? whisperStatus.models.find((m) => m.filename === whisperStatus.selectedModel)
    : undefined;
  const localWhisperDictationLabelSuffix =
    localWhisperDictationRow?.installed && localWhisperDictationRow.label
      ? ` - ${localWhisperDictationRow.label}`
      : !anyWhisperInstalled
        ? " - download a bundle under Local models"
        : "";

  const dictationUnifiedValue =
    dictationProvider === DICTATION_PROVIDER_OPENAI_WHISPER_1
      ? DICTATION_PROVIDER_OPENAI_WHISPER_1
      : dictationProvider === DICTATION_PROVIDER_LOCAL && hasLocalWhisperReady
        ? DICTATION_PROVIDER_LOCAL
        : "dictation-off";

  const setDictationUnifiedValue = (raw: string) => {
    if (raw === "dictation-off") {
      setDictationProvider(DICTATION_PROVIDER_LOCAL);
      const uid = userIdRef.current;
      void invoke("set_whisper_model_cmd", { filename: "" })
        .then(() => {
          const wKey = uid ? sessionStoreKeyForUser(uid, "whisperModel") : "whisperModel";
          return store.set(wKey, "").then(() => store.save());
        })
        .then(() => invoke<WhisperStatus>("check_whisper_cmd"))
        .then(setWhisperStatus)
        .catch(console.error);
      return;
    }
    if (raw === DICTATION_PROVIDER_OPENAI_WHISPER_1) {
      if (!hasOpenAiApiKey) return;
      setDictationProvider(DICTATION_PROVIDER_OPENAI_WHISPER_1);
      return;
    }
    if (raw === DICTATION_PROVIDER_LOCAL) {
      if (!anyWhisperInstalled) return;
      const pick =
        whisperStatus?.selectedModel?.trim() || firstInstalledWhisperFilename || "";
      if (!pick) return;
      setDictationProvider(DICTATION_PROVIDER_LOCAL);
      if (whisperStatus?.selectedModel?.trim() !== pick) {
        void invoke("set_whisper_model_cmd", { filename: pick })
          .then(() => {
            const uid = userIdRef.current;
            const wKey = uid ? sessionStoreKeyForUser(uid, "whisperModel") : "whisperModel";
            return store.set(wKey, pick).then(() => store.save());
          })
          .then(() => invoke<WhisperStatus>("check_whisper_cmd"))
          .then(setWhisperStatus)
          .catch(console.error);
      }
      return;
    }
    if (raw.startsWith("local:")) {
      const filename = raw.slice(6);
      setDictationProvider(DICTATION_PROVIDER_LOCAL);
      void invoke("set_whisper_model_cmd", { filename })
        .then(() => {
          const uid = userIdRef.current;
          const wKey = uid ? sessionStoreKeyForUser(uid, "whisperModel") : "whisperModel";
          return store.set(wKey, filename).then(() => store.save());
        })
        .then(() => invoke<WhisperStatus>("check_whisper_cmd"))
        .then(setWhisperStatus)
        .catch(console.error);
    }
  };

  const assistantModelPickerOptions = useMemo((): SettingsModelPickerOption[] => {
    const opts: SettingsModelPickerOption[] = [];
    opts.push({ value: ASSISTANT_MODEL_DISABLED, label: "Disabled (AI assistant off)", kind: "none" });
    for (const m of qwenStatus?.models ?? []) {
      opts.push({
        value: `local:${m.filename}`,
        label: `${m.label} (local)${!m.installed ? " — not downloaded" : ""}`,
        disabled: !m.installed,
        kind: "local",
      });
    }
    for (const m of ASSISTANT_MODEL_OPTIONS) {
      opts.push({
        value: m.value,
        label: `${m.label}${m.recommended ? rec(true) : ""}${!hasOpenAiApiKey ? " — add API key" : ""}`,
        disabled: !hasOpenAiApiKey,
        kind: "openai",
      });
    }
    return opts;
  }, [hasOpenAiApiKey, qwenStatus?.models]);

  const embedModelPickerOptions = useMemo((): SettingsModelPickerOption[] => {
    const opts: SettingsModelPickerOption[] = [
      { value: "", label: "Disabled (no local indexing)", kind: "none" },
    ];
    for (const m of EMBED_MODELS_CATALOG) {
      const installed = embedStatus?.models.some((s) => s.id === m.id && s.installed) ?? false;
      if (installed) {
        opts.push({ value: m.id, label: `${m.label}${rec(true)}`, kind: "local" });
      } else {
        opts.push({ value: m.id, label: `${m.label} — not downloaded`, disabled: true, kind: "local" });
      }
    }
    opts.push({
      value: "openai:text-embedding-3-small",
      label: `OpenAI text-embedding-3-small (1536-dim)${!hasOpenAiApiKey ? " — add API key" : ""}`,
      disabled: !hasOpenAiApiKey,
      kind: "openai",
    });
    return opts;
  }, [embedStatus?.models, hasOpenAiApiKey]);

  const pdfModelPickerOptions = useMemo((): SettingsModelPickerOption[] => {
    const opts: SettingsModelPickerOption[] = [{ value: "", label: "Disabled (no summarization)", kind: "none" }];
    for (const m of qwenStatus?.models ?? []) {
      opts.push({
        value: m.filename,
        label: `${m.label}${!m.installed ? " — not downloaded" : ""}${
          m.installed && m.filename === firstInstalledQwenFilename ? rec(true) : ""
        }`,
        disabled: !m.installed,
        kind: "local",
      });
    }
    for (const m of OPENAI_MODEL_OPTIONS) {
      opts.push({
        value: m.value,
        label: `${openAiCloudSelectOptionPlainLabel(m)}${!hasOpenAiApiKey ? " — add API key" : ""}`,
        disabled: !hasOpenAiApiKey,
        kind: "openai",
      });
    }
    return opts;
  }, [qwenStatus?.models, firstInstalledQwenFilename, hasOpenAiApiKey]);

  const dictationAudioPickerOptions = useMemo((): SettingsModelPickerOption[] => {
    return [
      { value: "dictation-off", label: "Disabled", kind: "none" },
      {
        value: DICTATION_PROVIDER_LOCAL,
        label: `Local Whisper${localWhisperDictationLabelSuffix}${
          localWhisperDictationRow?.installed && localWhisperDictationRow.id === ONBOARDING_WHISPER_MODEL_ID
            ? rec(true)
            : ""
        }`,
        disabled: !anyWhisperInstalled,
        kind: "local",
      },
      {
        value: DICTATION_PROVIDER_OPENAI_WHISPER_1,
        label: `OpenAI Whisper-1${hasOpenAiApiKey ? rec(true) : ""}${!hasOpenAiApiKey ? " — add API key" : ""}`,
        disabled: !hasOpenAiApiKey,
        kind: "openai",
      },
    ];
  }, [
    localWhisperDictationLabelSuffix,
    localWhisperDictationRow?.installed,
    localWhisperDictationRow?.id,
    anyWhisperInstalled,
    hasOpenAiApiKey,
  ]);

  const dictationCustomPickerOptions = useMemo((): SettingsModelPickerOption[] => {
    const opts: SettingsModelPickerOption[] = [{ value: "disabled", label: "Disabled", kind: "none" }];
    for (const m of qwenStatus?.models ?? []) {
      opts.push({
        value: `local:${m.filename}`,
        label: `${m.label}${!m.installed ? " — not downloaded" : ""}${
          m.installed && m.filename === firstInstalledQwenFilename ? rec(true) : ""
        }`,
        disabled: !m.installed,
        kind: "local",
      });
    }
    for (const m of OPENAI_MODEL_OPTIONS) {
      opts.push({
        value: m.value,
        label: `${openAiCloudSelectOptionPlainLabel(m)}${!hasOpenAiApiKey ? " — add API key" : ""}`,
        disabled: !hasOpenAiApiKey,
        kind: "openai",
      });
    }
    return opts;
  }, [qwenStatus?.models, firstInstalledQwenFilename, hasOpenAiApiKey]);

  const sensitiveScanPickerOptions = useMemo((): SettingsModelPickerOption[] => {
    const opts: SettingsModelPickerOption[] = [{ value: "disabled", label: "Disabled", kind: "none" }];
    for (const m of qwenStatus?.models ?? []) {
      opts.push({
        value: `local:${m.filename}`,
        label: `${m.label}${!m.installed ? " — not downloaded" : ""}${
          m.installed && m.filename === firstInstalledQwenFilename ? rec(true) : ""
        }`,
        disabled: !m.installed,
        kind: "local",
      });
    }
    for (const m of OPENAI_MODEL_OPTIONS) {
      opts.push({
        value: m.value,
        label: `${openAiCloudSelectOptionPlainLabel(m)}${!hasOpenAiApiKey ? " — add API key" : ""}`,
        disabled: !hasOpenAiApiKey,
        kind: "openai",
      });
    }
    return opts;
  }, [qwenStatus?.models, firstInstalledQwenFilename, hasOpenAiApiKey]);

  const navSectionIds = useMemo(() => {
    const ids = ["settings-account", "settings-shortcuts", "settings-selection-transform", "settings-sharing", "settings-mcp"];
    if (authReady && session) {
      ids.splice(1, 0, "settings-ai-tasks", "settings-captures");
    }
    return ids;
  }, [authReady, session]);

  const [mcpStatus, setMcpStatus] = useState<"checking" | "connected" | "disconnected">("checking");
  const [mcpToken, setMcpToken] = useState("");
  const [mcpTokenFromEnv, setMcpTokenFromEnv] = useState(false);
  const [mcpTokenVisible, setMcpTokenVisible] = useState(false);
  const [mcpTokenNotice, setMcpTokenNotice] = useState("");
  // Read over `invoke` rather than by fetching the local port: the MCP server
  // turns away anything that sends an `Origin` header, and a request from this
  // webview would send one.
  useEffect(() => {
    invoke<McpApiInfo>("mcp_api_info_cmd")
      .then((info) => {
        setMcpStatus(info.listening && info.authenticated ? "connected" : "disconnected");
        setMcpToken(info.token);
        setMcpTokenFromEnv(info.tokenFromEnv);
      })
      .catch(() => setMcpStatus("disconnected"));
  }, [session?.user.id]);

  const regenerateMcpToken = useCallback(() => {
    setMcpTokenNotice("");
    invoke<string>("regenerate_mcp_api_token_cmd")
      .then((fresh) => {
        setMcpToken(fresh);
        setMcpTokenVisible(true);
        setMcpTokenNotice(
          "New key created. The old one stopped working straight away — update it everywhere you pasted it.",
        );
      })
      .catch((e: unknown) => setMcpTokenNotice(String(e)));
  }, []);


  const findScrollableParent = useCallback((start: HTMLElement | null): HTMLElement | null => {
    let el: HTMLElement | null = start?.parentElement ?? null;
    while (el) {
      const { overflowY } = window.getComputedStyle(el);
      if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 2) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }, []);

  const computeActiveSectionFromScroll = useCallback(() => {
    const scrollRoot = findScrollableParent(settingsRootRef.current);
    if (!scrollRoot || navSectionIds.length === 0) return;
    const rootRect = scrollRoot.getBoundingClientRect();
    // Sticky settings bar + padding: treat “current section” as the one whose heading has crossed this line.
    const markerY = rootRect.top + 88;
    let active = navSectionIds[0] ?? "settings-account";
    for (const id of navSectionIds) {
      const section = document.getElementById(id);
      if (!section) continue;
      const top = section.getBoundingClientRect().top;
      if (top <= markerY) active = id;
    }
    setActiveSettingsSection(active);
  }, [findScrollableParent, navSectionIds]);

  useEffect(() => {
    const scrollRoot = findScrollableParent(settingsRootRef.current);
    if (!scrollRoot) return;

    const onScroll = () => {
      if (Date.now() < programmaticScrollUntilRef.current) return;
      computeActiveSectionFromScroll();
    };

    const onResize = () => {
      computeActiveSectionFromScroll();
    };

    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    const id = requestAnimationFrame(() => {
      computeActiveSectionFromScroll();
    });

    return () => {
      cancelAnimationFrame(id);
      scrollRoot.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [computeActiveSectionFromScroll, findScrollableParent]);

  useEffect(() => {
    if (!meetExtensionSetupJumpNonce || meetExtensionSetupJumpNonce === lastMeetExtensionJumpNonceRef.current) {
      return;
    }
    lastMeetExtensionJumpNonceRef.current = meetExtensionSetupJumpNonce;
    setAdvFileSubTab("meet");
    setAdvFileOpen(true);
    const t = window.setTimeout(() => {
      document.getElementById("settings-chrome-extension-meet")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [meetExtensionSetupJumpNonce]);

  useEffect(() => {
    if (!advFileOpen) setMeetBridgeNewCodeNotice(null);
  }, [advFileOpen]);

  useEffect(
    () => () => {
      if (navScrollSyncTimerRef.current != null) {
        window.clearTimeout(navScrollSyncTimerRef.current);
        navScrollSyncTimerRef.current = null;
      }
    },
    [],
  );

  const scrollToSettingsSection = useCallback((id: string) => {
    if (navScrollSyncTimerRef.current != null) {
      window.clearTimeout(navScrollSyncTimerRef.current);
    }
    setActiveSettingsSection(id);
    programmaticScrollUntilRef.current = Date.now() + 700;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    navScrollSyncTimerRef.current = window.setTimeout(() => {
      navScrollSyncTimerRef.current = null;
      programmaticScrollUntilRef.current = 0;
      computeActiveSectionFromScroll();
    }, 720);
  }, [computeActiveSectionFromScroll]);

  return (
    <InfoTooltipProvider>
      <div className="settings-layout" ref={settingsRootRef}>
        <nav className="settings-nav">
          <button
            type="button"
            className={`settings-nav-item${activeSettingsSection === "settings-account" ? " settings-nav-item--active" : ""}`}
            onClick={() => scrollToSettingsSection("settings-account")}
          >
            Account
          </button>
          {authReady && session && (
            <>
              <button
                type="button"
                className={`settings-nav-item${activeSettingsSection === "settings-ai-tasks" ? " settings-nav-item--active" : ""}`}
                onClick={() => scrollToSettingsSection("settings-ai-tasks")}
              >
                AI tasks
              </button>
              <button
                type="button"
                className={`settings-nav-item${activeSettingsSection === "settings-captures" ? " settings-nav-item--active" : ""}`}
                onClick={() => scrollToSettingsSection("settings-captures")}
              >
                Captures
              </button>
            </>
          )}
          <button
            type="button"
            className={`settings-nav-item${activeSettingsSection === "settings-shortcuts" ? " settings-nav-item--active" : ""}`}
            onClick={() => scrollToSettingsSection("settings-shortcuts")}
          >
            Shortcuts
          </button>
          <button
            type="button"
            className={`settings-nav-item${activeSettingsSection === "settings-selection-transform" ? " settings-nav-item--active" : ""}`}
            onClick={() => scrollToSettingsSection("settings-selection-transform")}
          >
            Selection Transform
          </button>
          <button
            type="button"
            className={`settings-nav-item${activeSettingsSection === "settings-mcp" ? " settings-nav-item--active" : ""}`}
            onClick={() => scrollToSettingsSection("settings-mcp")}
          >
            MCP
          </button>
          <button
            type="button"
            className={`settings-nav-item${activeSettingsSection === "settings-sharing" ? " settings-nav-item--active" : ""}`}
            onClick={() => scrollToSettingsSection("settings-sharing")}
          >
            Sharing
          </button>
        </nav>
        <div className="glass-card" style={{ flex: 1, minWidth: 0 }}>
        <div id="settings-account" className="settings-field settings-main-section" style={{ marginBottom: 24 }}>
          <div className="settings-account-heading">
            <p className="section-label settings-main-section-label">Account</p>
          </div>
          <ProfileSettings
            activeProfile={activeProfile}
            profiles={profiles}
            createProfile={createProfile}
            switchProfile={switchProfile}
            deleteProfile={deleteProfile}
            updateProfileName={updateProfileName}
          />
          <div className="settings-field" style={{ marginBottom: 12, marginTop: 16 }}>
            <label className="settings-label" htmlFor="preferred-output-language">
              Preferred output language
              <InfoTooltip>
                {
                  "Used as the default written language for generated text. When you change it, Kety can align Dictation, File processing summary language, and (if set to follow the account) Google Meet summary language. You can set Meet language explicitly under AI tasks → File & Meet summaries → Advanced → Google Meet."
                }
              </InfoTooltip>
            </label>
            <select
              id="preferred-output-language"
              className="settings-input"
              value={preferredOutputLang}
              disabled={preferredOutputLangSaving}
              onChange={(e) => {
                void handlePreferredOutputLanguageChange(e.target.value);
              }}
              style={{ cursor: preferredOutputLangSaving ? "wait" : "pointer" }}
            >
              {OUTPUT_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
            {preferredOutputLangError ? (
              <p
                className="settings-hint"
                style={{ color: "var(--color-error, #f87171)", marginTop: 8 }}
              >
                {preferredOutputLangError}
              </p>
            ) : null}
          </div>
        </div>

        {authReady && session && (
          <div id="settings-ai-tasks" className="settings-main-section">
            <p className="section-label settings-main-section-label">AI tasks</p>
            <p className="settings-hint" style={{ marginBottom: 16, maxWidth: 760, lineHeight: 1.55 }}>
              Open your <strong>OpenAI API key</strong> and <strong>local models</strong> sections below, then assign
              each task. ★ marks a recommended option when your plan and installed models allow it.
            </p>
            <details className="settings-details-block settings-ai-tasks-menu" style={{ marginBottom: 10 }}>
              <summary>API key (OpenAI)</summary>
              <div id="settings-llm-api-key" className="settings-ai-tasks-menu-body settings-ai-tasks-menu-stack">
                  <label className="settings-label" htmlFor="llm-api-key">
                    OpenAI API key
                    <InfoTooltip>
                      {
                        "Used when you select a GPT model for the AI Assistant (prompt_only mode), file summarization, or sensitive scan. The key is stored only on this device."
                      }
                    </InfoTooltip>
                  </label>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <input
                      id="llm-api-key"
                      type={showOpenAiKeyMasked ? "text" : "password"}
                      className="settings-input"
                      style={{
                        flex: "1 1 220px",
                        minWidth: 0,
                        maxWidth: 560,
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        fontSize: 13,
                        letterSpacing: "0.02em",
                      }}
                      readOnly={showOpenAiKeyMasked}
                      value={
                        openAiApiKeyReplaceMode
                          ? openAiApiKeyDraft
                          : hasOpenAiApiKey
                            ? maskOpenAiApiKeyForDisplay(openAiApiKey)
                            : openAiApiKey
                      }
                      onChange={(e) => {
                        if (showOpenAiKeyMasked) return;
                        if (openAiApiKeyReplaceMode) {
                          setOpenAiApiKeyDraft(e.target.value);
                        } else {
                          setOpenAiApiKey(e.target.value);
                        }
                      }}
                      placeholder="sk-..."
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={
                        showOpenAiKeyMasked
                          ? "OpenAI API key (prefix and last four characters visible, middle masked). Use Replace API key to change it."
                          : openAiApiKeyReplaceMode
                            ? "Enter a new OpenAI API key"
                            : "OpenAI API key"
                      }
                    />
                    {hasOpenAiApiKey && !openAiApiKeyReplaceMode ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
                          onClick={() => {
                            setOpenAiApiKeyGuardError(null);
                            setOpenAiApiKeyReplaceMode(true);
                            setOpenAiApiKeyDraft("");
                          }}
                        >
                          Replace API key
                        </button>
                        <button
                          type="button"
                          className="btn btn-destructive"
                          style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
                          onClick={() => {
                            commitOpenAiApiKeyRemoval();
                          }}
                        >
                          Remove
                        </button>
                      </>
                    ) : null}
                    {openAiApiKeyReplaceMode ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
                          onClick={() => {
                            const trimmed = openAiApiKeyDraft.trim();
                            if (trimmed === "") {
                              commitOpenAiApiKeyRemoval();
                              return;
                            }
                            setOpenAiApiKeyGuardError(null);
                            setOpenAiApiKey(trimmed);
                            setOpenAiApiKeyReplaceMode(false);
                            setOpenAiApiKeyDraft("");
                          }}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
                          onClick={() => {
                            setOpenAiApiKeyGuardError(null);
                            setOpenAiApiKeyReplaceMode(false);
                            setOpenAiApiKeyDraft("");
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : null}
                  </div>
                  {openAiApiKeyGuardError ? (
                    <p
                      className="settings-hint"
                      role="alert"
                      style={{ marginTop: 8, color: "var(--color-danger, #e53e3e)" }}
                    >
                      {openAiApiKeyGuardError}
                    </p>
                  ) : null}
                  <p className="settings-hint" style={{ marginTop: 8 }}>
                    {openAiApiKeyReplaceMode
                      ? "Enter a new key, then Save to replace the stored key, or Cancel to keep the current one. Saving an empty value removes the key."
                      : hasOpenAiApiKey
                        ? ""
                        : "Without a key: only locally installed models (Qwen / Whisper) below."}
                  </p>
                  <div
                    className="settings-hint"
                    style={{
                      marginTop: 12,
                      padding: "10px 12px",
                      borderLeft: "3px solid var(--color-warning, #f59e0b)",
                      background: "rgba(245, 158, 11, 0.06)",
                      borderRadius: 4,
                      lineHeight: 1.5,
                    }}
                  >
                    <strong>Warning.</strong> This API key is stored only on this device (in the app settings).
                    However, OpenAI models run in the cloud: the text sent to the model leaves your machine, you must
                    trust OpenAI, and processing is no longer strictly &quot;local only&quot;.
                  </div>
              </div>
            </details>
            <details className="settings-details-block settings-ai-tasks-menu" style={{ marginBottom: 14 }}>
              <summary>Local models (Whisper, Qwen &amp; Embedding)</summary>
              <div id="settings-local-lm" className="settings-ai-tasks-menu-body settings-ai-tasks-menu-stack">
                <p className="settings-hint" style={{ margin: 0, lineHeight: 1.5 }}>
                  Download sizes are listed below. Local models never send your text to the cloud.
                </p>
                <div>
                  <p className="settings-label" style={{ marginBottom: 4 }}>
                    Dictation LLM
                    <InfoTooltip>
                      {"Whisper models for voice dictation. whisper-cli is bundled with the app. Download at least one model to enable voice dictation."}
                    </InfoTooltip>
                  </p>
                  <p className="settings-hint" style={{ marginBottom: 10 }}>
                    whisper-cli{" "}
                    <span style={{ color: whisperStatus?.cli ? "var(--color-success, #4ade80)" : "var(--color-error, #f87171)" }}>
                      {whisperStatus === null ? "…" : whisperStatus.cli ? "✓ bundled" : "✗ not found"}
                    </span>
                  </p>
                  {whisperStatus?.models.map((m) => {
                    const isDownloading = whisperDownloading === m.id;
                    return (
                      <div
                        key={m.id}
                        className="settings-local-lm-download-row"
                      >
                        <span style={{ flex: 1, fontSize: 13 }}>
                          <strong>{m.label}</strong>
                          {m.id === ONBOARDING_WHISPER_MODEL_ID ? rec(true) : ""}{" "}
                          <span className="settings-hint" style={{ margin: 0 }}>{m.sizeLabel}</span>
                        </span>
                        {m.installed ? (
                          <button
                            type="button"
                            className="btn btn-destructive"
                            style={{ fontSize: 11, padding: "2px 8px" }}
                            onClick={() => {
                              if (whisperStatus?.selectedModel === m.filename) {
                                setConfirmKind({
                                  type: "localModelInUseWarning",
                                  modelLabel: m.label,
                                  usedIn: [
                                    {
                                      label: "Dictation (audio) — Local Whisper",
                                      sectionId: "preprocess-dictation-model",
                                    },
                                  ],
                                });
                                return;
                              }
                              setConfirmKind({
                                type: "removeWhisperModel",
                                filename: m.filename,
                                label: m.label,
                                isSelected: false,
                                nextFilename: "",
                              });
                            }}
                          >
                            Remove
                          </button>
                        ) : isDownloading ? (
                          <>
                            <span style={{ fontSize: 11, minWidth: 34, textAlign: "right" }}>
                              {whisperDownloadPercent !== null ? `${whisperDownloadPercent}%` : "…"}
                            </span>
                            <button
                              type="button"
                              className="btn btn-destructive"
                              style={{ fontSize: 11, padding: "2px 8px" }}
                              onClick={() => void invoke("cancel_whisper_download_cmd").catch(console.error)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ fontSize: 11, padding: "2px 8px" }}
                            disabled={whisperDownloading !== null}
                            onClick={() => {
                              setWhisperDownloading(m.id);
                              void invoke("download_whisper_cmd", { modelId: m.id }).catch((e) => {
                                console.error(e);
                                setWhisperDownloading(null);
                                setWhisperDownloadPercent(null);
                              });
                            }}
                          >
                            Download
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div>
                  <p className="settings-label" style={{ marginBottom: 4 }}>
                    Qwen GGUF (local)
                    <InfoTooltip>
                      {"Qwen GGUF models for local processing (sensitive preview, file summarization). llama-cli is bundled with the app."}
                    </InfoTooltip>
                  </p>
                  <p className="settings-hint" style={{ marginBottom: 10 }}>
                    llama-cli{" "}
                    <span style={{ color: localLlmStatus?.cliPresent ? "var(--color-success, #4ade80)" : "var(--color-error, #f87171)" }}>
                      {localLlmStatus === null ? "…" : localLlmStatus.cliPresent ? "✓ bundled" : "✗ not found"}
                    </span>
                  </p>
                  {qwenStatus?.models.map((m) => {
                    const isDownloading = qwenDownloading === m.id;
                    return (
                      <div
                        key={m.id}
                        className="settings-local-lm-download-row"
                      >
                        <span style={{ flex: 1, fontSize: 13 }}>
                          <strong>{m.label}</strong>
                          {m.id === ONBOARDING_QWEN_MODEL_ID ? rec(true) : ""}{" "}
                          <span className="settings-hint" style={{ margin: 0 }}>{m.sizeLabel}</span>
                        </span>
                        {m.installed ? (
                          <button
                            type="button"
                            className="btn btn-destructive"
                            style={{ fontSize: 11, padding: "2px 8px" }}
                            onClick={() => {
                              const usedIn: Array<{ label: string; sectionId: string }> = [];
                              const tagLocal = tagsSensitiveLocalQwenFilename(
                                sensitiveScanModel,
                                qwenStatus?.models ?? [],
                              );
                              if (tagLocal === m.filename) {
                                usedIn.push({
                                  label: "Tags & sensitive (local Qwen)",
                                  sectionId: "preprocess-tag-sensitive-model",
                                });
                              }
                              if (pdfModelFilename === m.filename) {
                                usedIn.push({
                                  label: "File & Meet summaries (local Qwen)",
                                  sectionId: "preprocess-file-model",
                                });
                              }
                              if (dictationCustomModel === `local:${m.filename}`) {
                                usedIn.push({
                                  label: "Custom dictation post-processing (local Qwen)",
                                  sectionId: "preprocess-dictation-custom-model",
                                });
                              }
                              if (usedIn.length > 0) {
                                setConfirmKind({ type: "localModelInUseWarning", modelLabel: m.label, usedIn });
                                return;
                              }
                              setConfirmKind({
                                type: "removeQwenModel",
                                filename: m.filename,
                                label: m.label,
                                isSelected: false,
                                nextFilename: "",
                              });
                            }}
                          >
                            Remove
                          </button>
                        ) : isDownloading ? (
                          <>
                            <span style={{ fontSize: 11, minWidth: 34, textAlign: "right" }}>
                              {qwenDownloadPercent !== null ? `${qwenDownloadPercent}%` : "…"}
                            </span>
                            <button
                              type="button"
                              className="btn btn-destructive"
                              style={{ fontSize: 11, padding: "2px 8px" }}
                              onClick={() => void invoke("cancel_qwen_download_cmd").catch(console.error)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ fontSize: 11, padding: "2px 8px" }}
                            disabled={qwenDownloading !== null}
                            onClick={() => {
                              setQwenDownloading(m.id);
                              void invoke("download_qwen_model_cmd", { modelId: m.id }).catch((e) => {
                                console.error(e);
                                setQwenDownloading(null);
                                setQwenDownloadPercent(null);
                              });
                            }}
                          >
                            Download
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div>
                  <p className="settings-label" style={{ marginBottom: 4 }}>
                    Embedding models (local index)
                    <InfoTooltip>
                      {"Qwen3-Embedding models for on-device vector search. llama-cli is bundled with the app. Download at least one model and select it in Models by task → Capture indexing."}
                    </InfoTooltip>
                  </p>
                  <p className="settings-hint" style={{ marginBottom: 10 }}>
                    llama-cli{" "}
                    <span style={{ color: localLlmStatus?.cliPresent ? "var(--color-success, #4ade80)" : "var(--color-error, #f87171)" }}>
                      {localLlmStatus === null ? "…" : localLlmStatus.cliPresent ? "✓ bundled" : "✗ not found"}
                    </span>
                  </p>
                  {EMBED_MODELS_CATALOG.map((m) => {
                    const isInstalled = embedStatus?.models.some(
                      (s) => s.id === m.id && s.installed
                    ) ?? false;
                    const isDownloading = embedDownloading === m.id;
                    return (
                      <div key={m.id} className="settings-local-lm-download-row">
                        <span style={{ flex: 1, fontSize: 13 }}>
                          <strong>{m.label}</strong>{" "}
                          <span className="settings-hint" style={{ margin: 0 }}>{m.sizeLabel} · {m.dim}-dim</span>
                        </span>
                        {isInstalled ? (
                          <button
                            type="button"
                            className="btn btn-destructive"
                            style={{ fontSize: 11, padding: "2px 8px" }}
                            onClick={() => {
                              setConfirmKind({
                                type: "removeEmbedModel",
                                filename: m.filename,
                                label: m.label,
                                isActive: embedStatus?.activeModel === m.id,
                              });
                            }}
                          >
                            Remove
                          </button>
                        ) : isDownloading ? (
                          <>
                            <span style={{ fontSize: 11, minWidth: 34, textAlign: "right" }}>
                              {embedDownloadPercent !== null ? `${embedDownloadPercent}%` : "…"}
                            </span>
                            <button
                              type="button"
                              className="btn btn-destructive"
                              style={{ fontSize: 11, padding: "2px 8px" }}
                              onClick={() => void cancelEmbedDownload().catch(console.error)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ fontSize: 11, padding: "2px 8px" }}
                            disabled={embedDownloading !== null}
                            onClick={() => {
                              setEmbedDownloading(m.id);
                              void downloadEmbedModel(m.id).catch((e) => {
                                console.error(e);
                                setEmbedDownloading(null);
                                setEmbedDownloadPercent(null);
                              });
                            }}
                          >
                            Download
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </details>
            <p className="settings-subsection-label">Models by task</p>
            <p className="settings-hint" style={{ marginBottom: 12, lineHeight: 1.5 }}>
              One row per purpose: model dropdown and <strong>Advanced</strong> for extra options. ★ = recommended when available.
            </p>

            <div className="settings-model-task-grid">
              <span className="settings-model-task-label-cell">
                <span className="settings-model-task-label-text">AI assistant</span>
                <InfoTooltip>
                  {"GPT models call OpenAI from this device with your API key. Local Qwen runs fully on-device."}
                </InfoTooltip>
              </span>
              <div className="settings-model-task-control">
                <SettingsModelPicker
                  id="assistant-model-select"
                  className="settings-input"
                  aria-label="Assistant model"
                  value={assistantModel ?? ASSISTANT_MODEL_DISABLED}
                  options={assistantModelPickerOptions}
                  onChange={(v) => {
                    setAssistantModel(v);
                  }}
                />
              </div>
              <div className="settings-model-task-action-col">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => onOpenAssistantPreferences?.()}
                >
                  Advanced
                </button>
              </div>
            </div>
            {isAssistantDirectOpenAiModel(assistantModel) ? (
              <p className="settings-hint" style={{ marginTop: -6, marginBottom: 12 }}>
                Assistant calls OpenAI ({assistantModel}).
              </p>
            ) : isAssistantLocalQwenModel(assistantModel) ? (
              <p className="settings-hint" style={{ marginTop: -6, marginBottom: 12 }}>
                Assistant uses local Qwen on this device.
              </p>
            ) : assistantModel === ASSISTANT_MODEL_DISABLED || !assistantModel ? (
              <p className="settings-hint" style={{ marginTop: -6, marginBottom: 12 }}>
                Pick a GPT model or a local Qwen model (if downloaded).
              </p>
            ) : null}

            <div className="settings-model-task-grid" id="capture-indexing-model-row">
              <span className="settings-model-task-label-cell">
                <span className="settings-model-task-label-text">Capture indexing</span>
                <InfoTooltip>
                  {"Embedding model used to index your captures locally for on-device search. Qwen3-Embedding runs fully on-device. The OpenAI option sends text to OpenAI servers. Available on all plans."}
                </InfoTooltip>
              </span>
              <div className="settings-model-task-control">
                <SettingsModelPicker
                  id="capture-indexing-model-select"
                  className="settings-input"
                  aria-label="Capture indexing model"
                  value={embedStatus?.activeModel ?? ""}
                  options={embedModelPickerOptions}
                  onChange={(v) => {
                    const uid = userIdRef.current ?? "";
                    void setActiveEmbedModel(v, uid)
                      .then(() => checkEmbedModels(uid))
                      .then(setEmbedStatus)
                      .catch(console.error);
                  }}
                />
              </div>
              <div className="settings-model-task-action-col">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => setAdvEmbedOpen(true)}
                >
                  Advanced
                </button>
              </div>
            </div>
            {(localIndexStats?.capturesMissingEmbed ?? 0) > 0 && (
              <p className="settings-hint" style={{ marginTop: -6, marginBottom: 12, color: "var(--color-warning, #fbbf24)" }}>
                {localIndexStats!.capturesMissingEmbed} capture
                {localIndexStats!.capturesMissingEmbed !== 1 ? "s" : ""} need re-embedding with{" "}
                <strong>{localIndexStats!.activeEmbedModel}</strong>.
              </p>
            )}

            <div className="settings-model-task-grid">
              <span className="settings-model-task-label-cell">
                <span className="settings-model-task-label-text">File &amp; Meet summaries</span>
                <InfoTooltip>
                  {
                    "One model for PDF/DOCX summaries and for Google Meet meeting notes. OpenAI sends extracted text with your key."
                  }
                </InfoTooltip>
              </span>
              <div className="settings-model-task-control">
                <SettingsModelPicker
                  id="preprocess-file-model"
                  className="settings-input"
                  aria-label="File and Meet summary model"
                  value={pdfModelFilename}
                  options={pdfModelPickerOptions}
                  onChange={(next) => {
                    setPdfModelFilename(next);
                  }}
                />
              </div>
              <div className="settings-model-task-action-col">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => {
                    setAdvFileSubTab("file");
                    setAdvFileOpen(true);
                  }}
                >
                  Advanced
                </button>
              </div>
            </div>
            <p className="settings-hint" style={{ marginTop: -4, marginBottom: 10, lineHeight: 1.5 }}>
              Meet meeting notes use this model when the extension sends a transcript. Note language, extra prompts, and
              the Chrome extension are under <strong>Advanced</strong>.
            </p>
            {!meetBridgeToken.trim() ? (
              <div
                role="alert"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  marginBottom: 14,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 45%, transparent)",
                  background: "color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)",
                  maxWidth: 720,
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>
                  ⚠️
                </span>
                <p className="settings-hint" style={{ margin: 0, lineHeight: 1.5 }}>
                  Install the <strong>Chrome extension</strong> and link code so Meet captions can reach Kety. Open{" "}
                  <button
                    type="button"
                    className="btn-inline-link"
                    onClick={() => {
                      setAdvFileSubTab("meet");
                      setAdvFileOpen(true);
                    }}
                  >
                    Advanced → Google Meet
                  </button>{" "}
                  to download the ZIP and configure the extension.
                </p>
              </div>
            ) : null}

            <div className="settings-model-task-grid">
              <span className="settings-model-task-label-cell">
                <span className="settings-model-task-label-text">Dictation (audio)</span>
                <InfoTooltip>
                  {
                    "Voice dictation and screen-recording microphone transcript. Pick OpenAI Whisper or on-device Local Whisper (the bundle selected under Local models)."
                  }
                </InfoTooltip>
              </span>
              <div className="settings-model-task-control">
                <SettingsModelPicker
                  id="preprocess-dictation-model"
                  className="settings-input"
                  aria-label="Dictation audio model"
                  value={dictationUnifiedValue}
                  options={dictationAudioPickerOptions}
                  onChange={(v) => setDictationUnifiedValue(v)}
                />
              </div>
              <div className="settings-model-task-action-col">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setAdvDictOpen(true)}>
                  Advanced
                </button>
              </div>
            </div>

            <div className="settings-model-task-grid">
              <span className="settings-model-task-label-cell">
                <span className="settings-model-task-label-text">Custom dictation (text)</span>
                <InfoTooltip>
                  {
                    "After audio dictation finishes, post-process the transcript with your prompt (⌘⌥ + letter). Transcription still follows Dictation (audio) above. Post-processing: OpenAI (your API key) or local Qwen GGUF. Placeholders: {{DICTATION_TEXT}}, {{HIGHLIGHTS}}."
                  }
                </InfoTooltip>
              </span>
              <div className="settings-model-task-control">
                <SettingsModelPicker
                  id="preprocess-dictation-custom-model"
                  className="settings-input"
                  aria-label="Custom dictation post-processing model"
                  value={dictationCustomModel}
                  options={dictationCustomPickerOptions}
                  onChange={(next) => {
                    setDictationCustomModel(next);
                  }}
                />
              </div>
              <div className="settings-model-task-action-col">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setAdvDictCustomOpen(true)}>
                  Edit prompt
                </button>
              </div>
            </div>

            <div className="settings-model-task-grid">
              <span className="settings-model-task-label-cell">
                <span className="settings-model-task-label-text">Tags &amp; sensitive</span>
                <InfoTooltip>
                  {
                    "One model for LLM auto-tagging and for sensitive-content classification on captures. Limits, batch parallelism, tag list, Meet raw-transcript scan, and the sensitive prompt live under Advanced."
                  }
                </InfoTooltip>
              </span>
              <div className="settings-model-task-control">
                <SettingsModelPicker
                  id="preprocess-tag-sensitive-model"
                  className="settings-input"
                  aria-label="Tags and sensitive scan model"
                  value={sensitiveScanModel}
                  options={sensitiveScanPickerOptions}
                  onChange={(next) => {
                    const prev = sensitiveScanModel;
                    setSensitiveScanModel(next);
                    if (next === "disabled") {
                      setAutoScanSensitive(false);
                    }
                    if (next.startsWith("local:")) {
                      const filename = next.slice(6);
                      void invoke("set_qwen_local_model_cmd", { filename })
                        .then(() => invoke<QwenModelsStatus>("check_qwen_models_cmd"))
                        .then(setQwenStatus)
                        .catch(console.error);
                    }
                    if (prev === "disabled" && next !== "disabled" && (!autoAssignTags || !autoScanSensitive)) {
                      setShowEnableAutoTagPopup(true);
                    }
                  }}
                />
              </div>
              <div className="settings-model-task-action-col">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => {
                    setAdvTagsSubTab("tags");
                    setAdvTagsOpen(true);
                  }}
                >
                  Advanced
                </button>
              </div>
            </div>
            <div className="settings-field" style={{ marginBottom: 12 }}>
              {showEnableAutoTagPopup && (
                <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--color-surface-raised, rgba(0,0,0,0.04))", borderRadius: 8 }}>
                  <p className="settings-hint" style={{ marginBottom: 8 }}>
                    Also enable <strong>automatic sensitive scan</strong> and <strong>automatic tag assignment</strong> on new captures?
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => {
                        setAutoScanSensitive(true);
                        setAutoAssignTags(true);
                        setShowEnableAutoTagPopup(false);
                      }}
                    >
                      Yes, enable both
                    </button>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => setShowEnableAutoTagPopup(false)}>
                      No, I&apos;ll use toggles below
                    </button>
                  </div>
                </div>
              )}
              <div
                className="settings-field"
                style={{
                  marginTop: 12,
                  marginBottom: 0,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 16,
                  alignItems: "flex-start",
                }}
              >
                <label
                  className="settings-label"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    cursor: sensitiveScanModel === "disabled" ? "not-allowed" : "pointer",
                    opacity: sensitiveScanModel === "disabled" ? 0.45 : 1,
                    flex: "1 1 200px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={autoScanSensitive}
                    disabled={sensitiveScanModel === "disabled"}
                    onChange={(e) => setAutoScanSensitive(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    Auto-scan sensitive
                    <InfoTooltip>
                      {"When on, new captures are scanned for sensitive content using the model above."}
                    </InfoTooltip>
                  </span>
                </label>
                <label
                  className="settings-label"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    cursor: sensitiveScanModel === "disabled" ? "not-allowed" : "pointer",
                    opacity: sensitiveScanModel === "disabled" ? 0.45 : 1,
                    flex: "1 1 200px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={autoAssignTags}
                    disabled={sensitiveScanModel === "disabled"}
                    onChange={(e) => setAutoAssignTags(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    Auto-assign tags
                    <InfoTooltip>{"When on, new captures get LLM-suggested tags from your tag list."}</InfoTooltip>
                  </span>
                </label>
              </div>
            </div>

          </div>
        )}


        {authReady && session ? (
        <>
        <div id="settings-captures" className="settings-main-section" style={{ marginTop: 24 }}>
          <p className="section-label settings-main-section-label">Captures</p>

          <div className="settings-field">
            <label className="settings-label" htmlFor="attach-off-session-focus">
              <input
                id="attach-off-session-focus"
                type="checkbox"
                checked={attachOffSessionFocus}
                onChange={(e) => setAttachOffSessionFocus(e.target.checked)}
                style={{ marginRight: 8, verticalAlign: "middle" }}
              />
              Attach frontmost app and window
              <InfoTooltip>
                {
                  "Tags dictation, screenshots, clipboard/highlight captures, and tray notes with the active app and window. For the note window, focus is sampled just before it opens."
                }
              </InfoTooltip>
            </label>
            <p className="settings-hint" style={{ marginTop: 8 }}>
              Attaches the frontmost app and window name to dictation, screenshots, and clipboard/highlight captures.
            </p>
          </div>
        </div>

        <div id="settings-capture-history" style={{ marginTop: 24 }}>
          <p className="settings-subsection-label">Capture context history</p>
          <p className="settings-hint" style={{ marginBottom: 12, lineHeight: 1.5 }}>
            Choose what appears in the list you open with{" "}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                verticalAlign: "text-bottom",
                margin: "0 2px",
                color: "var(--fg-muted, currentColor)",
              }}
              title="Capture history"
            >
              <IconCaptureHistoryClock width={15} height={15} />
            </span>{" "}
            on the Captures tab or from the Capture note panel. That list is only for reuse—nothing is added to
            Captures automatically.
          </p>
          <div className="settings-field" style={{ marginBottom: 10 }}>
            <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={keepDictationHistory}
                onChange={(e) => setKeepDictationHistory(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>Dictation
                <InfoTooltip>
                  {
                    "When on, lines from Fn dictation and from Custom dictation (⌘⌥E) can appear in Capture history for reuse after a successful paste or after the copy-history fallback. Turning this off stops both. They stay in that list only—they are not captures until you send one. \"Dictation (capture)\" (⌘⌥D) below sends straight into capture context as a capture, not into this history."
                  }
                </InfoTooltip>
              </span>
            </label>
          </div>
          <div className="settings-field">
            <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={keepCopyHistory}
                onChange={(e) => setKeepCopyHistory(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                {copyHistoryCheckboxTitle()}
                <InfoTooltip>
                  {
                    "When on, copied text shows in Capture history so you can reuse it in notes. It stays in that list only—it is not a capture until you send it from there."
                  }
                </InfoTooltip>
              </span>
            </label>
          </div>
          <div className="settings-field" style={{ marginTop: 12 }}>
            <label className="settings-label" htmlFor="capture-hist-retention" style={{ display: "block", marginBottom: 6 }}>
              Auto-flush capture context history older than
              <InfoTooltip>
                {
                  "How long lines stay in Capture history before they disappear. “Never” keeps them until you clear the list yourself."
                }
              </InfoTooltip>
            </label>
            <select
              id="capture-hist-retention"
              className="settings-input"
              style={{ maxWidth: 320, cursor: "pointer" }}
              value={captureHistoryRetention}
              onChange={(e) => setCaptureHistoryRetention(e.target.value as CaptureHistoryRetention)}
            >
              {CAPTURE_HISTORY_RETENTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <p className="settings-subsection-label" style={{ marginTop: 16 }}>
            Minutes until auto-stop (safety)
          </p>
          <p className="settings-hint" style={{ marginBottom: 10, lineHeight: 1.5 }}>
            If a dictation or screen recording stays open too long, Kety stops it automatically. Set to{" "}
            <strong>0</strong> to disable. Values are read when recording starts (defaults: dictation 60 min, screen 120 min).
          </p>
          <div className="settings-field" style={{ marginBottom: 10 }}>
            <label className="settings-label" htmlFor="dictation-auto-stop-min" style={{ display: "block", marginBottom: 6 }}>
              Dictation
            </label>
            <input
              id="dictation-auto-stop-min"
              type="number"
              className="settings-input"
              style={{ maxWidth: 100 }}
              min={0}
              max={1440}
              step={1}
              value={dictationAutoStopMinutes}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isNaN(n)) return;
                setDictationAutoStopMinutes(Math.min(1440, Math.max(0, n)));
              }}
            />
            <span className="settings-hint" style={{ marginLeft: 8 }}>minutes (0 = off)</span>
          </div>
          <div className="settings-field">
            <label className="settings-label" htmlFor="screen-record-auto-stop-min" style={{ display: "block", marginBottom: 6 }}>
              Screen recording
            </label>
            <input
              id="screen-record-auto-stop-min"
              type="number"
              className="settings-input"
              style={{ maxWidth: 100 }}
              min={0}
              max={1440}
              step={1}
              value={screenRecordAutoStopMinutes}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isNaN(n)) return;
                setScreenRecordAutoStopMinutes(Math.min(1440, Math.max(0, n)));
              }}
            />
            <span className="settings-hint" style={{ marginLeft: 8 }}>minutes (0 = off)</span>
          </div>
        </div>

        <div id="settings-recording" style={{ marginTop: 24 }}>
          <p className="settings-subsection-label">Screen Recording</p>

          <div className="settings-field">
            <label className="settings-label">
              Video quality
              <InfoTooltip>{"Controls file size vs. quality for screen recordings. Low: 15fps, ½ resolution, ~1.5 Mbps. Medium: 20fps, ¾ resolution, ~4 Mbps. High: 30fps, native resolution, no bitrate cap."}</InfoTooltip>
            </label>
            <div className="quality-picker">
              {([0, 1, 2] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`quality-option${screenRecordQuality === q ? " quality-option--active" : ""}`}
                  onClick={() => setScreenRecordQuality(q)}
                >
                  {q === 0 ? "Low" : q === 1 ? "Medium" : "High"}
                </button>
              ))}
            </div>
          </div>
        </div>

        </>
        ) : null}

        <div id="settings-shortcuts" className="settings-main-section" style={{ marginTop: 24 }}>
        <p className="section-label settings-main-section-label">Shortcuts (macOS)</p>
        <p className="settings-hint" style={{ marginBottom: 12 }}>
          Modifiers are fixed to ⌘⌥. Choose one letter per action (A–Z). Each letter must be unique.
        </p>
        <div className="shortcuts-table">
          {([
            { key: "contextText" as const, label: "Paste clipboard", tip: "Pastes plain text from the clipboard into the active recording segment (or an off-session capture when not recording). This is separate from Capture history, which only logs passive copies when Copy history is enabled in settings." },
            { key: "contextHighlight" as const, label: "Highlight selection", tip: "Captures the currently selected text via the Accessibility API. Plays a failure sound if no text is selected (e.g. in apps that don't expose selection via Accessibility). Requires Kety in System Settings → Privacy & Security → Accessibility." },
            { key: "screenshot" as const, label: "Screenshot", tip: "Captures a full-screen PNG and attaches it to the current segment (or off-session if idle). A confirmation sound plays on success. Requires Kety in System Settings → Privacy & Security → Screen Recording." },
            { key: "noteWindow" as const, label: "Capture note window", tip: "Opens the capture note window where you last placed it (first time: top center of the screen under the cursor). Escape or Cancel hides it without losing content. Reopen from the tray menu." },
            { key: "recordingToggle" as const, label: "Recording toggle", tip: "Toggles recording start/pause/stop from the tray workflow (same as the tray recording controls)." },
            { key: "dictation" as const, label: "Dictation (capture)", tip: "Opens the dictation HUD and saves the result as capture context, even when a text field is focused. Selected text at the start is included as context above the dictated note. This path does not use Capture history—use Fn or Custom dictation (⌘⌥E) if you want lines there (see Capture context history → Dictation). Short press toggles start/stop; hold the shortcut about 2s and release to stop." },
            {
              key: "customDictation" as const,
              label: "Custom dictation (⌘⌥E)",
              tip: "Like dictation (HUD, mic), then post-processes the transcript with your model and prompts (with vs without selection templates). Does not add a capture-context note: Kety tries to paste into the focused field, and if paste fails falls back to Copy History. When Capture context history → Dictation is on, the line is also listed for reuse. Short press toggles start/stop; hold about 2s and release to stop.",
            },
            { key: "screenRecord" as const, label: "Screen recording", tip: "Opens the screen recording HUD. Use the Start button in the HUD to begin recording and the Stop button to end it and save. Requires Kety in System Settings → Privacy & Security → Screen Recording." },
            { key: "assistant" as const, label: "Open assistant", tip: "Opens the Assistant tab and focuses the last active chat." },
            { key: "openApp" as const, label: "Open app (Captures)", tip: "Opens the app and switches to the Captures tab." },
            { key: "textTransform" as const, label: "Selection transform", tip: "Shows a popup near the highlighted text with your configured transforms (translate, reformat, etc.) applied to the selection. Configure actions in the Selection Transform section below." },
          ]).map((row) => (
            <div
              key={row.key}
              className="shortcut-row"
            >
              <span className="shortcut-label">{row.label}</span>
              <div
                className="shortcut-hotkey-anchor"
                ref={(el) => {
                  hotkeyPickerAnchorRefs.current[row.key] = el;
                }}
              >
                <button
                  type="button"
                  className={
                    hotkeyPickerKey === row.key
                      ? "shortcut-hotkey-trigger shortcut-hotkey-trigger--open"
                      : "shortcut-hotkey-trigger"
                  }
                  aria-haspopup="listbox"
                  aria-expanded={hotkeyPickerKey === row.key}
                  aria-label={`${row.label}: ${formatMacHotkeyDisplay(hotkeyKeyLetters[row.key])}, choose letter`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHotkeyPickerKey((k) => (k === row.key ? null : row.key));
                  }}
                >
                  <span className="shortcut-hotkey-trigger-text">
                    {formatMacHotkeyDisplay(hotkeyKeyLetters[row.key])}
                  </span>
                  <span className="shortcut-hotkey-trigger-chevron" aria-hidden>
                    ▾
                  </span>
                </button>
                {hotkeyPickerKey === row.key ? (
                  <div
                    className="shortcut-hotkey-popover"
                    role="listbox"
                    aria-label={`Letters for ${row.label}`}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <div className="shortcut-hotkey-popover-grid">
                      {HOTKEY_LETTERS_AZ.map((L) => {
                        const taken = isHotkeyLetterTakenByOther(row.key, L);
                        return (
                          <button
                            key={L}
                            type="button"
                            role="option"
                            aria-selected={hotkeyKeyLetters[row.key] === L}
                            disabled={taken}
                            className={
                              hotkeyKeyLetters[row.key] === L
                                ? "shortcut-hotkey-letter shortcut-hotkey-letter--current"
                                : taken
                                  ? "shortcut-hotkey-letter shortcut-hotkey-letter--taken"
                                  : "shortcut-hotkey-letter"
                            }
                            onClick={() => pickHotkeyLetter(row.key, L)}
                          >
                            {L}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
              <InfoTooltip>{row.tip}</InfoTooltip>
            </div>
          ))}
          <div className="shortcut-row">
            <span className="shortcut-label">Dictation (Fn / Globe)</span>
            <kbd className="shortcut-key">Fn</kbd>
            <div className="shortcut-fn-toggle-wrap">
              <button
                type="button"
                className={
                  fnDictationShortcutEnabled
                    ? "prefs-toggle-btn"
                    : "prefs-toggle-btn prefs-toggle-btn--off"
                }
                aria-pressed={fnDictationShortcutEnabled}
                aria-label="Fn / Globe dictation"
                onClick={() => setFnDictationShortcutEnabled((v) => !v)}
              />
            </div>
            <InfoTooltip>
              {
                "Same timing as the capture shortcut: short press toggles; hold about 2s then release to stop. Tries to paste the transcript into the focused field afterward; if Capture context history → Dictation is on, the line can also appear there for reuse (not a capture until you send it). Requires Accessibility for the Fn / Globe key. Turn off if another app uses the key."
              }
            </InfoTooltip>
          </div>
        </div>
        </div>

        <div id="settings-selection-transform" className="settings-main-section" style={{ marginTop: 24 }}>
          <p className="section-label settings-main-section-label">Selection Transform</p>
          <p className="settings-hint" style={{ marginBottom: 4 }}>
            Actions shown when you press the selection-transform shortcut on highlighted text.
            Use <code>{"{context}"}</code> in the prompt to insert the selected text.
          </p>
          <p className="settings-hint" style={{ marginBottom: 12 }}>
            Uses the same model as <strong>Custom dictation</strong> (configure it in AI tasks above).
          </p>

          <>
              {/* Save to history toggle */}
              <div className="settings-field" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  id="text-actions-save-history"
                  checked={textActionsSaveHistory}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setTextActionsSaveHistory(v);
                    persistTextActions(textActions, v);
                  }}
                />
                <label htmlFor="text-actions-save-history" className="settings-label" style={{ margin: 0, cursor: "pointer" }}>
                  Save results to capture history
                </label>
              </div>

              {/* Action list */}
              <div style={{ marginBottom: 8 }}>
                {textActions.map((action) => (
                  <div key={action.id} style={{ marginBottom: 6, border: "1px solid var(--glass-border, rgba(0,0,0,0.1))", borderRadius: 8, padding: "8px 10px", background: "var(--glass-bg, rgba(255,255,255,0.3))" }}>
                    {editingActionId === action.id ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <input
                          className="settings-input"
                          placeholder="Title (e.g. Translate to English)"
                          value={editingActionTitle}
                          onChange={(e) => setEditingActionTitle(e.target.value)}
                          autoFocus
                        />
                        <textarea
                          className="settings-input"
                          placeholder={"Prompt — use {context} for the selected text"}
                          value={editingActionPrompt}
                          onChange={(e) => setEditingActionPrompt(e.target.value)}
                          rows={3}
                          style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
                        />
                        <div style={{ display: "flex", gap: 6 }}>
                          <button type="button" className="btn btn-primary" style={{ fontSize: 12, padding: "3px 10px" }} onClick={commitEditAction} disabled={!editingActionTitle.trim() || !editingActionPrompt.trim()}>Save</button>
                          <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: "3px 10px" }} onClick={cancelEditAction}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{action.title}</span>
                          <span style={{ fontSize: 11, color: "var(--text-muted, rgba(0,0,0,0.45))", marginLeft: 8 }}>
                            {action.prompt.length > 60 ? action.prompt.slice(0, 60) + "…" : action.prompt}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                          <button type="button" className="btn btn-secondary" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => startEditAction(action)}>Edit</button>
                          <button type="button" className="btn btn-secondary" style={{ fontSize: 11, padding: "2px 8px", color: "var(--color-danger, #ef4444)" }} onClick={() => deleteAction(action.id)}>Delete</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Add new action */}
              {editingActionId === "__new__" ? (
                <div style={{ border: "1px solid var(--glass-border, rgba(0,0,0,0.1))", borderRadius: 8, padding: "8px 10px", marginBottom: 8, background: "var(--glass-bg, rgba(255,255,255,0.3))" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input
                      className="settings-input"
                      placeholder="Title (e.g. Translate to English)"
                      value={editingActionTitle}
                      onChange={(e) => setEditingActionTitle(e.target.value)}
                      autoFocus
                    />
                    <textarea
                      className="settings-input"
                      placeholder={"Prompt — use {context} for the selected text"}
                      value={editingActionPrompt}
                      onChange={(e) => setEditingActionPrompt(e.target.value)}
                      rows={3}
                      style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" className="btn btn-primary" style={{ fontSize: 12, padding: "3px 10px" }} onClick={commitEditAction} disabled={!editingActionTitle.trim() || !editingActionPrompt.trim()}>Add</button>
                      <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: "3px 10px" }} onClick={cancelEditAction}>Cancel</button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 12, marginBottom: 12 }}
                  onClick={() => { setEditingActionId("__new__"); setEditingActionTitle(""); setEditingActionPrompt(""); }}
                >
                  + Add action
                </button>
              )}

          </>
        </div>

        <div id="settings-sharing" className="settings-field settings-main-section" style={{ marginBottom: 24 }}>
          <p className="section-label settings-main-section-label">Sharing</p>
          <GcpShareSettings profileId={activeProfile?.id ?? ""} />
        </div>

        <div id="settings-mcp" className="settings-main-section" style={{ marginTop: 24 }}>
          <p className="section-label settings-main-section-label">MCP integration</p>
          <p className="settings-hint" style={{ marginBottom: 16 }}>
            Connect Claude Code or any MCP-compatible AI to your Kety knowledge base.
            The desktop app must be running.
          </p>

          <div className="settings-field" style={{ marginBottom: 16 }}>
            <p className="settings-label" style={{ marginBottom: 6 }}>Status</p>
            {mcpStatus === "checking" && (
              <span className="settings-hint">Checking…</span>
            )}
            {mcpStatus === "connected" && (
              <span style={{ fontSize: 13, color: "var(--color-success, #22c55e)" }}>
                ● Connected{session ? ` · ${session.user.email ?? "signed in"}` : ""}
              </span>
            )}
            {mcpStatus === "disconnected" && (
              <span style={{ fontSize: 13, color: "var(--color-danger, #ef4444)" }}>
                ● Not connected — open Kety and sign in, then retry
              </span>
            )}
          </div>

          <div className="settings-field" style={{ marginBottom: 16 }}>
            <p className="settings-label" style={{ marginBottom: 6 }}>Access key</p>
            <p className="settings-hint" style={{ marginBottom: 8 }}>
              Anything that reads your knowledge base has to send this key. Keep it to
              yourself — treat it like a password.
            </p>
            <pre style={CODE_BLOCK_STYLE}>
              {mcpTokenVisible ? mcpToken || "—" : "•".repeat(36)}
            </pre>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setMcpTokenVisible((v) => !v)}
              >
                {mcpTokenVisible ? "Hide key" : "Show key"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => { void navigator.clipboard.writeText(mcpToken); }}
              >
                Copy key
              </button>
              {!mcpTokenFromEnv && (
                <button type="button" className="btn btn-secondary" onClick={regenerateMcpToken}>
                  Create a new key
                </button>
              )}
            </div>
            {mcpTokenFromEnv && (
              <p className="settings-hint" style={{ marginTop: 8 }}>
                This key comes from the KETY_MCP_TOKEN environment variable, so it can’t be
                changed here.
              </p>
            )}
            {mcpTokenNotice && (
              <p className="settings-hint" style={{ marginTop: 8 }}>{mcpTokenNotice}</p>
            )}
          </div>

          <div className="settings-field" style={{ marginBottom: 16 }}>
            <p className="settings-label" style={{ marginBottom: 6 }}>Add Kety to Claude Code</p>
            <p className="settings-hint" style={{ marginBottom: 8 }}>
              Run this in a terminal — it works from any folder. Use “Copy command” so your
              key is filled in for you:
            </p>
            <pre style={CODE_BLOCK_STYLE}>{claudeCodeCommand(mcpTokenVisible ? mcpToken : "YOUR-KEY")}</pre>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 8, marginBottom: 16 }}
              onClick={() => { void navigator.clipboard.writeText(claudeCodeCommand(mcpToken)); }}
            >
              Copy command
            </button>
            <p className="settings-hint" style={{ marginBottom: 8 }}>
              Prefer to edit a file? Put this in <code>.mcp.json</code> at the root of your
              project. Claude Code will ask you to approve it the first time. Note that
              <code> ~/.claude/settings.json</code> is not read for this — a server added there is
              ignored without any error.
            </p>
            <pre style={CODE_BLOCK_STYLE}>{claudeCodeJson(mcpTokenVisible ? mcpToken : "YOUR-KEY")}</pre>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 8 }}
              onClick={() => { void navigator.clipboard.writeText(claudeCodeJson(mcpToken)); }}
            >
              Copy config
            </button>
          </div>

          <div className="settings-field" style={{ marginBottom: 16 }}>
            <p className="settings-label" style={{ marginBottom: 6 }}>Add Kety to Claude Desktop</p>
            <p className="settings-hint" style={{ marginBottom: 8 }}>
              Claude Desktop can only start a small helper program, so it needs the Kety
              bridge from the project’s <code>mcp-server</code> folder. Open that folder in a
              terminal and run <code>npm install</code> once. Then open Claude Desktop →
              Settings → Developer → Edit Config, and add this, replacing the path with where
              that folder actually lives on your computer:
            </p>
            <pre style={CODE_BLOCK_STYLE}>{claudeDesktopJson(mcpTokenVisible ? mcpToken : "YOUR-KEY")}</pre>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 8 }}
              onClick={() => { void navigator.clipboard.writeText(claudeDesktopJson(mcpToken)); }}
            >
              Copy config
            </button>
            <p className="settings-hint" style={{ marginTop: 8 }}>
              That file is at <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
              {" "}on Mac. Quit and reopen Claude Desktop afterwards.
            </p>
          </div>

          <div className="settings-field" style={{ marginTop: 16 }}>
            <p className="settings-label" style={{ marginBottom: 6 }}>Available MCP tools</p>
            <ul className="settings-hint" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              <li><code>check_connection</code> — verify Kety is running</li>
              <li><code>list_assistants</code> — list accessible knowledge bases (yours + shared)</li>
              <li><code>list_tags</code> — list tags with names and descriptions</li>
              <li><code>search</code> — search the knowledge base by query, tags, and source</li>
            </ul>
          </div>
        </div>

        </div>
      </div>
      {advFileOpen ? (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setAdvFileOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setAdvFileOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-labelledby="adv-file-title"
            className="glass-card"
            style={{ maxWidth: advFileSubTab === "meet" ? 640 : 520, width: "100%", maxHeight: "88vh", overflow: "auto", padding: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="prefs-modal-header" style={{ marginBottom: 10, alignItems: "flex-start" }}>
              <p id="adv-file-title" className="section-label" style={{ marginBottom: 0, flex: "1 1 auto", minWidth: 0, paddingRight: 8 }}>
                File &amp; Meet summaries - advanced
              </p>
              <button
                type="button"
                className="prefs-modal-close-btn"
                onClick={() => setAdvFileOpen(false)}
                aria-label="Close"
                style={{ flexShrink: 0, marginTop: -2 }}
              >
                <svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <button
                type="button"
                className={advFileSubTab === "file" ? "btn btn-primary btn-small" : "btn btn-secondary btn-small"}
                onClick={() => setAdvFileSubTab("file")}
              >
                File summarization
              </button>
              <button
                type="button"
                className={advFileSubTab === "meet" ? "btn btn-primary btn-small" : "btn btn-secondary btn-small"}
                onClick={() => setAdvFileSubTab("meet")}
              >
                Google Meet
              </button>
              <button
                type="button"
                className={advFileSubTab === "chrome" ? "btn btn-primary btn-small" : "btn btn-secondary btn-small"}
                onClick={() => setAdvFileSubTab("chrome")}
              >
                Chrome extension
              </button>
            </div>
            {advFileSubTab === "file" ? (
              <>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="adv-pdf-warn-threshold">
                    Large file warning threshold
                    <InfoTooltip>
                      {
                        "Show a confirmation before processing when both the document and the selected page count exceed this number. Above this threshold, a master summary will also be automatically generated from all page summaries. Set to 1 to always warn and always generate a master summary."
                      }
                    </InfoTooltip>
                  </label>
                  <div className="settings-input-row">
                    <input
                      id="adv-pdf-warn-threshold"
                      type="number"
                      className="settings-input"
                      style={{ maxWidth: 70 }}
                      min={1}
                      value={pdfWarnThreshold}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        if (!isNaN(n) && n >= 1) setPdfWarnThreshold(n);
                      }}
                    />
                    <span className="settings-hint" style={{ margin: 0 }}>pages</span>
                  </div>
                </div>
                <div className="settings-field" style={{ marginTop: 16 }}>
                  <label className="settings-label" htmlFor="adv-pdf-summary-lang">
                    Summary language
                    <InfoTooltip>
                      {"Language used for all summaries (per-page and master summary). \"Document language\" detects the language from the text and falls back to English if unclear."}
                    </InfoTooltip>
                  </label>
                  <select
                    id="adv-pdf-summary-lang"
                    className="settings-input"
                    value={pdfSummaryLang}
                    onChange={(e) => setPdfSummaryLang(e.target.value)}
                    style={{ cursor: "pointer" }}
                  >
                    <option value="document">Document language</option>
                    <option value="fr">Français</option>
                    <option value="en">English</option>
                    <option value="es">Español</option>
                    <option value="de">Deutsch</option>
                    <option value="it">Italiano</option>
                    <option value="pt">Português</option>
                    <option value="nl">Nederlands</option>
                    <option value="ja">日本語</option>
                    <option value="zh">中文</option>
                    <option value="ar">العربية</option>
                  </select>
                </div>
                <div className="settings-field" style={{ marginTop: 16 }}>
                  <p className="settings-label" style={{ marginBottom: 8 }}>
                    Pages to summarize per file
                    <InfoTooltip>
                      {"Choose a fixed number of pages or a percentage of the document. Each file produces one combined note."}
                    </InfoTooltip>
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="radio"
                        name="adv-pdf-pages-mode"
                        value="count"
                        checked={pdfPagesMode === "count"}
                        onChange={() => setPdfPagesMode("count")}
                        style={{ cursor: "pointer" }}
                      />
                      Fixed number
                    </label>
                    <input
                      type="number"
                      className="settings-input"
                      style={{ maxWidth: 70, opacity: pdfPagesMode === "count" ? 1 : 0.4 }}
                      min={1}
                      value={pdfPagesCount}
                      disabled={pdfPagesMode !== "count"}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        if (!isNaN(n) && n >= 1) setPdfPagesCount(n);
                      }}
                    />
                    <span className="settings-hint" style={{ margin: 0 }}>pages</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="radio"
                        name="adv-pdf-pages-mode"
                        value="percent"
                        checked={pdfPagesMode === "percent"}
                        onChange={() => setPdfPagesMode("percent")}
                        style={{ cursor: "pointer" }}
                      />
                      Percentage
                    </label>
                    <select
                      className="settings-input"
                      style={{ maxWidth: 110, opacity: pdfPagesMode === "percent" ? 1 : 0.4 }}
                      value={pdfPagesPercent}
                      disabled={pdfPagesMode !== "percent"}
                      onChange={(e) => setPdfPagesPercent(parseInt(e.target.value, 10) || 100)}
                    >
                      <option value={10}>10%</option>
                      <option value={25}>25%</option>
                      <option value={50}>50%</option>
                      <option value={100}>100% (full)</option>
                    </select>
                    <span className="settings-hint" style={{ margin: 0 }}>of document</span>
                  </div>
                </div>
                <div className="settings-field" style={{ marginTop: 16 }}>
                  <label className="settings-label" htmlFor="adv-pdf-parallelism">
                    Parallel pages
                    <InfoTooltip>
                      {"Number of pages to summarize simultaneously. 1 = sequential (safer for slow machines). Higher values speed up large documents but use more CPU. Meta-summary batches always run in parallel."}
                    </InfoTooltip>
                  </label>
                  <div className="settings-input-row">
                    <input
                      id="adv-pdf-parallelism"
                      type="number"
                      className="settings-input"
                      style={{ maxWidth: 70 }}
                      min={1}
                      max={8}
                      value={pdfParallelism}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        if (!isNaN(n) && n >= 1) setPdfParallelism(Math.min(8, n));
                      }}
                    />
                    <span className="settings-hint" style={{ margin: 0 }}>
                      {pdfParallelism === 1 ? "sequential" : "pages at once"}
                    </span>
                  </div>
                </div>
                <div className="settings-field" style={{ marginTop: 16 }}>
                  <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={defaultIndexDocContent}
                      onChange={(e) => setDefaultIndexDocContent(e.target.checked)}
                      style={{ marginTop: 3, flexShrink: 0 }}
                    />
                    <span>
                      Index document content by default
                      <InfoTooltip>
                        {"When on, the raw text extracted from new documents is added to your local knowledge index. You can still change this for each capture in the Captures tab."}
                      </InfoTooltip>
                    </span>
                  </label>
                  <p className="settings-hint" style={{ marginTop: 6 }}>
                    Default is off. When off, only the generated summary is indexed.
                  </p>
                </div>
              </>
            ) : advFileSubTab === "meet" ? (
              <>
                <p className="settings-hint" style={{ marginBottom: 14, lineHeight: 1.55 }}>
                  Use <strong>live captions (CC)</strong> in Google Meet. Meeting notes use the model from the main list;
                  summarization runs automatically when the extension sends a transcript.
                </p>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="adv-google-meet-summary-lang" style={{ display: "block", marginBottom: 6 }}>
                    Language of the meeting note
                    <InfoTooltip>
                      {
                        "Controls the written language of the generated meeting note (all Markdown sections). Pick a fixed locale."
                      }
                    </InfoTooltip>
                  </label>
                  <select
                    id="adv-google-meet-summary-lang"
                    className="settings-input"
                    value={googleMeetSummaryLang}
                    onChange={(e) => setGoogleMeetSummaryLang(e.target.value)}
                    style={{ cursor: "pointer" }}
                  >
                    {OUTPUT_LANGUAGE_OPTIONS.map((option) => (
                      <option key={`adv-meet-lang-${option.code}`} value={option.code}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-field" style={{ marginTop: 16 }}>
                  <label className="settings-label" htmlFor="adv-google-meet-summary-prompt" style={{ display: "block", marginBottom: 6 }}>
                    Extra instructions for the summary and to-dos (optional)
                  </label>
                  <textarea
                    id="adv-google-meet-summary-prompt"
                    className="settings-input"
                    rows={6}
                    spellCheck
                    placeholder="Example: Focus on decisions, owners, and dates. Ignore small talk."
                    value={googleMeetSummaryPrompt}
                    onChange={(e) => setGoogleMeetSummaryPrompt(e.target.value)}
                    style={{ width: "100%", resize: "vertical", minHeight: 100, fontFamily: "inherit", fontSize: 13 }}
                  />
                </div>
                <div className="settings-field" style={{ marginTop: 16 }}>
                  <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={defaultIndexMeetTranscript}
                      onChange={(e) => setDefaultIndexMeetTranscript(e.target.checked)}
                      style={{ marginTop: 3, flexShrink: 0 }}
                    />
                    <span>
                      Index raw transcript by default
                      <InfoTooltip>
                        {"When on, the full meeting transcript is added to your local knowledge index for each new Google Meet capture. You can still change this for each capture in the Captures tab."}
                      </InfoTooltip>
                    </span>
                  </label>
                  <p className="settings-hint" style={{ marginTop: 6 }}>
                    Default is off. When off, only the generated summary is indexed.
                  </p>
                </div>
              </>
            ) : (
              <>
                <p className="settings-hint" id="settings-chrome-extension-meet" style={{ marginBottom: 14, lineHeight: 1.55 }}>
                  Meet runs in Chrome; Kety listens on this computer only (127.0.0.1). The link code is a local shared secret. If you start Kety from a terminal,{" "}
                  <code style={{ fontSize: "0.85em" }}>KETY_MEET_BRIDGE_TOKEN</code> and <code style={{ fontSize: "0.85em" }}>KETY_MEET_BRIDGE_PORT</code> override values saved here.
                </p>
                <div
                  style={{
                    border: "1px solid var(--glass-border, rgba(0,0,0,0.1))",
                    borderRadius: 12,
                    padding: "16px 16px 14px",
                    marginBottom: 18,
                    background: "var(--glass-bg, rgba(255,255,255,0.04))",
                  }}
                >
                  <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                    1 · Install in Chrome
                  </p>
                  <p className="settings-hint" style={{ marginBottom: 12, lineHeight: 1.5 }}>
                    Download the ZIP (usually to Downloads), unzip the folder, then in Chrome use <strong>Load unpacked</strong> on that folder. The pack already includes your link to Kety-do not share it.
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-small"
                      onClick={() => {
                        setChromeExtZipExportMessage(null);
                        void invoke<{ path: string; bridgeToken: string; bridgePort: number }>(
                          "export_chrome_extension_zip_cmd"
                        )
                          .then((r) => {
                            setMeetBridgeToken(r.bridgeToken);
                            setMeetBridgePort(r.bridgePort);
                            setChromeExtZipExportMessage(`Saved: ${r.path}`);
                          })
                          .catch((e: unknown) => {
                            setChromeExtZipExportMessage(
                              typeof e === "string" ? e : e instanceof Error ? e.message : "Export failed."
                            );
                          });
                      }}
                    >
                      Download extension (ZIP)
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => setShowChromeExtensionInstallPopup(true)}
                    >
                      Step-by-step guide
                    </button>
                  </div>
                  {chromeExtZipExportMessage ? (
                    <p
                      className="settings-hint"
                      style={{
                        marginTop: 10,
                        marginBottom: 0,
                        color: chromeExtZipExportMessage.startsWith("Saved:")
                          ? "var(--color-text-muted, #94a3b8)"
                          : "var(--destructive, #c2410c)",
                      }}
                    >
                      {chromeExtZipExportMessage}
                    </p>
                  ) : null}
                  <p className="settings-hint" style={{ marginTop: 10, marginBottom: 0, fontSize: "0.78rem", opacity: 0.9 }}>
                    Tip: open <code style={{ fontSize: "0.85em" }}>chrome://extensions</code>, turn on <strong>Developer mode</strong>, then{" "}
                    <strong>Load unpacked</strong>.
                  </p>
                </div>

                <div
                  style={{
                    border: "1px solid var(--glass-border, rgba(0,0,0,0.1))",
                    borderRadius: 12,
                    padding: "16px 16px 14px",
                    marginBottom: 18,
                    background: "var(--glass-bg, rgba(255,255,255,0.04))",
                  }}
                >
                  <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: "0.95rem", color: "var(--text-primary)" }}>
                    2 · Link code &amp; port
                  </p>
                  <p className="settings-hint" style={{ marginBottom: 12, lineHeight: 1.5 }}>
                    The ZIP matches these values. You rarely need to change them unless you reset the link or use a custom port.
                  </p>
                  <p className="settings-label" style={{ marginBottom: 8 }}>
                    Link code
                    <InfoTooltip>
                      {
                        "Same secret the extension uses to talk to Kety on this machine. Kety can create one for you on first launch. Generate a new code if you think it was exposed. Changes apply right away for new requests."
                      }
                    </InfoTooltip>
                  </p>
                  <input
                    id="adv-meet-bridge-token"
                    className="settings-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Filled automatically, or paste from the extension"
                    value={meetBridgeToken}
                    onChange={(e) => setMeetBridgeToken(e.target.value)}
                    style={{ marginBottom: 10, fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => {
                        const next =
                          typeof crypto !== "undefined" && crypto.randomUUID
                            ? crypto.randomUUID()
                            : `kty-${Date.now()}`;
                        setMeetBridgeToken(next);
                        void invoke("copy_text_to_clipboard", { text: next })
                          .then(() => {
                            setMeetBridgeNewCodeNotice({
                              variant: "success",
                              message:
                                "A new code was generated and copied to your clipboard. Paste it into your Chrome extension settings.",
                            });
                          })
                          .catch(() => {
                            setMeetBridgeNewCodeNotice({
                              variant: "error",
                              message:
                                "A new code was generated, but copying to the clipboard failed. Use Copy code, then paste it into your Chrome extension settings.",
                            });
                          });
                      }}
                    >
                      Generate new code
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => {
                        void invoke("copy_text_to_clipboard", { text: meetBridgeToken }).catch(console.error);
                      }}
                      disabled={!meetBridgeToken.trim()}
                    >
                      Copy code
                    </button>
                  </div>
                  {meetBridgeNewCodeNotice ? (
                    <div
                      className="settings-hint"
                      role="status"
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        marginTop: 0,
                        marginBottom: 12,
                        lineHeight: 1.5,
                        color:
                          meetBridgeNewCodeNotice.variant === "success"
                            ? "var(--color-text-muted, #64748b)"
                            : "var(--destructive, #c2410c)",
                      }}
                    >
                      {meetBridgeNewCodeNotice.variant === "success" ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            flexShrink: 0,
                            marginTop: 2,
                            color: "var(--color-success, #22c55e)",
                          }}
                          aria-hidden
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </span>
                      ) : null}
                      <span style={{ flex: "1 1 auto", minWidth: 0 }}>{meetBridgeNewCodeNotice.message}</span>
                    </div>
                  ) : null}
                  <label className="settings-label" htmlFor="adv-meet-bridge-port" style={{ display: "block", marginBottom: 4 }}>
                    Port
                    <InfoTooltip>
                      {
                        "Default 17171. Change only if you know you need a different port. After changing the port, fully quit and reopen Kety for it to take effect. The secret can still be updated anytime without restarting."
                      }
                    </InfoTooltip>
                  </label>
                  <input
                    id="adv-meet-bridge-port"
                    className="settings-input"
                    type="number"
                    min={1}
                    max={65535}
                    inputMode="numeric"
                    value={meetBridgePort}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!Number.isNaN(n)) setMeetBridgePort(Math.min(65535, Math.max(1, n)));
                    }}
                    style={{ maxWidth: 140 }}
                  />
                </div>

                <label className="settings-label" htmlFor="adv-chrome-extension-auto-meet">
                  <input
                    id="adv-chrome-extension-auto-meet"
                    type="checkbox"
                    checked={chromeExtensionAutoMeetCaptures}
                    onChange={(e) => setChromeExtensionAutoMeetCaptures(e.target.checked)}
                    style={{ marginRight: 8, verticalAlign: "middle" }}
                  />
                  Send transcript to Kety when I close the Meet tab
                  <InfoTooltip>
                    {
                      "When on (default), closing the Google Meet tab tells the extension to send the stored transcript to Kety if the app is running-the same data as Sync with app, without the extra click. When off, use Sync with app in the extension after each meeting."
                    }
                  </InfoTooltip>
                </label>
                <p className="settings-hint" style={{ marginTop: 8 }}>
                  Captions stay in the extension until you close the Meet tab or tap <strong>Sync with app</strong>.
                </p>
              </>
            )}
            <button type="button" className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => setAdvFileOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {advDictOpen ? (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setAdvDictOpen(false)}
        >
          <div
            role="dialog"
            aria-labelledby="adv-dict-title"
            className="glass-card"
            style={{ maxWidth: 480, width: "100%", maxHeight: "88vh", overflow: "auto", padding: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <p id="adv-dict-title" className="section-label" style={{ marginBottom: 12 }}>
              Transcripts - advanced
            </p>
            <div className="settings-field">
              <label className="settings-label" htmlFor="adv-dictation-lang">
                Transcription language
                <InfoTooltip>{"Passed to whisper-cli -l when using local Whisper. Auto-detect may be less accurate."}</InfoTooltip>
              </label>
              <select
                id="adv-dictation-lang"
                className="settings-input"
                value={dictationLang}
                onChange={(e) => setDictationLang(e.target.value)}
                style={{ cursor: "pointer" }}
              >
                <option value="auto">Auto-detect</option>
                <option value="fr">Français</option>
                <option value="en">English</option>
                <option value="es">Español</option>
                <option value="de">Deutsch</option>
                <option value="it">Italiano</option>
                <option value="pt">Português</option>
                <option value="nl">Nederlands</option>
                <option value="ja">日本語</option>
                <option value="zh">中文</option>
                <option value="ar">العربية</option>
              </select>
            </div>
            <div className="settings-field" style={{ marginTop: 14 }}>
              <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={keepDictationHistory}
                  onChange={(e) => setKeepDictationHistory(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  Dictation history
                  <InfoTooltip>
                    {
                      "Same as Dictation under Capture context history: when on, Fn and Custom dictation (⌘⌥E) can use that list; turning it off stops both. \"Dictation (capture)\" (⌘⌥D) only adds to captures, not this history."
                    }
                  </InfoTooltip>
                </span>
              </label>
            </div>
            <div className="settings-field" style={{ marginTop: 10 }}>
              <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={keepCopyHistory}
                  onChange={(e) => setKeepCopyHistory(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  {copyHistoryCheckboxTitle()}
                  <InfoTooltip>
                    {"Same as Copy history in main Settings: copies go to the history list, not into captures unless you send one from there."}
                  </InfoTooltip>
                </span>
              </label>
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => setAdvDictOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {advDictCustomOpen ? (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setAdvDictCustomOpen(false)}
        >
          <div
            role="dialog"
            aria-labelledby="adv-dict-custom-title"
            className="glass-card"
            style={{ maxWidth: 560, width: "100%", maxHeight: "88vh", overflow: "auto", padding: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <p id="adv-dict-custom-title" className="section-label" style={{ marginBottom: 10 }}>
              Custom dictation - edit prompt
            </p>
            <p className="settings-hint" style={{ marginBottom: 12, lineHeight: 1.5 }}>
              After {formatMacHotkeyDisplay(hotkeyKeyLetters.customDictation)}, the raw transcript is post-processed with your chosen model. If you had
              text selected when dictation started, Kety uses the <strong>with selection context</strong> prompt and fills{" "}
              <code style={{ fontSize: "0.92em" }}>{"{{HIGHLIGHTS}}"}</code>; otherwise it uses the <strong>without selection</strong> prompt. The two
              templates are stored separately—switch below to edit each. The app then tries to paste the result into the focused field (with Copy History
              fallback) and, when Dictation history is enabled, can add the line to Capture history for reuse.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                className={dictCustomPromptTab === "highlight" ? "btn btn-primary btn-small" : "btn btn-secondary btn-small"}
                onClick={() => setDictCustomPromptTab("highlight")}
              >
                With selection context
              </button>
              <button
                type="button"
                className={dictCustomPromptTab === "noHighlight" ? "btn btn-primary btn-small" : "btn btn-secondary btn-small"}
                onClick={() => setDictCustomPromptTab("noHighlight")}
              >
                Without selection context
              </button>
            </div>
            <label className="settings-label" htmlFor="adv-dict-custom-prompt-body" style={{ display: "block", marginBottom: 6 }}>
              Prompt template
            </label>
            <textarea
              id="adv-dict-custom-prompt-body"
              className="settings-input"
              spellCheck={false}
              rows={10}
              value={dictCustomPromptTab === "highlight" ? dictationCustomPromptHighlight : dictationCustomPromptNoHighlight}
              onChange={(e) => {
                const next = e.target.value;
                if (dictCustomPromptTab === "highlight") setDictationCustomPromptHighlight(next);
                else setDictationCustomPromptNoHighlight(next);
              }}
              style={{
                width: "100%",
                resize: "vertical",
                minHeight: 140,
                fontFamily: "ui-monospace, monospace",
                fontSize: 12,
              }}
            />
            <p className="settings-hint" style={{ marginTop: 10, lineHeight: 1.5 }}>
              Placeholders: <code style={{ fontSize: "0.92em" }}>{"{{DICTATION_TEXT}}"}</code> (transcript, required),{" "}
              <code style={{ fontSize: "0.92em" }}>{"{{HIGHLIGHTS}}"}</code> (selected text at start; only in the selection-context prompt).
            </p>
            <button type="button" className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => setAdvDictCustomOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {advTagsOpen ? (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setAdvTagsOpen(false)}
        >
          <div
            role="dialog"
            aria-labelledby="adv-tags-title"
            className="glass-card"
            style={{ maxWidth: 640, width: "100%", maxHeight: "88vh", overflow: "auto", padding: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <p id="adv-tags-title" className="section-label" style={{ marginBottom: 10 }}>
              Tags &amp; sensitive - advanced
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <button
                type="button"
                className={advTagsSubTab === "tags" ? "btn btn-primary btn-small" : "btn btn-secondary btn-small"}
                onClick={() => setAdvTagsSubTab("tags")}
              >
                Tags
              </button>
              <button
                type="button"
                className={advTagsSubTab === "sensitive" ? "btn btn-primary btn-small" : "btn btn-secondary btn-small"}
                onClick={() => setAdvTagsSubTab("sensitive")}
              >
                Sensitive
              </button>
            </div>
            {advTagsSubTab === "tags" ? (
              <>
                <div className="settings-field">
                  <label className="settings-label" style={{ display: "block", marginBottom: 6 }}>
                    Auto-tag text limit
                    <InfoTooltip>
                      {
                        "Max characters of the capture content sent in the Content section of the prompt. Tag names and instructions are added on top."
                      }
                    </InfoTooltip>
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="number"
                      className="settings-input"
                      style={{ width: 100 }}
                      min={1000}
                      max={10000}
                      step={100}
                      value={autoTagTextLimit}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v) && v >= 1000 && v <= 10000) setAutoTagTextLimit(v);
                      }}
                    />
                    <span className="settings-hint" style={{ margin: 0 }}>
                      chars (1 000 - 10 000)
                    </span>
                  </div>
                </div>
                <div className="settings-field" style={{ marginTop: 16 }}>
                  <label className="settings-label" htmlFor="adv-batch-parallel" style={{ display: "block", marginBottom: 6 }}>
                    Parallel LLM calls (batch sensitive scan &amp; tagging)
                    <InfoTooltip>
                      {
                        "How many local llama-cli inferences can run at once when you run a full sensitive scan or AI tag assignment on many items in Process, if the shared model above is a local Qwen file. Lower if the machine becomes slow."
                      }
                    </InfoTooltip>
                  </label>
                  <div className="settings-input-row">
                    <select
                      id="adv-batch-parallel"
                      className="settings-input"
                      style={{ maxWidth: 100 }}
                      value={localLlmParallelCalls}
                      onChange={(e) =>
                        setLocalLlmParallelCalls(
                          Math.min(8, Math.max(1, parseInt(e.target.value, 10) || 1)),
                        )
                      }
                    >
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={4}>4</option>
                      <option value={5}>5</option>
                      <option value={6}>6</option>
                      <option value={7}>7</option>
                      <option value={8}>8</option>
                    </select>
                  </div>
                </div>
                <div className="settings-field" style={{ marginTop: 18 }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowTagsManager(true)}>
                    Manage tags
                  </button>
                  <p className="settings-hint" style={{ marginTop: 8, lineHeight: 1.45 }}>
                    Create and edit tag names, colors, descriptions, and app-based auto-assign rules.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="settings-field">
                  <label
                    className="settings-label"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      cursor:
                        sensitiveScanModel === "disabled" || !autoScanSensitive ? "not-allowed" : "pointer",
                      opacity: sensitiveScanModel === "disabled" || !autoScanSensitive ? 0.45 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={meetSensitiveScanIncludeRawTranscript}
                      disabled={sensitiveScanModel === "disabled" || !autoScanSensitive}
                      onChange={(e) => setMeetSensitiveScanIncludeRawTranscript(e.target.checked)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      Google Meet: also scan full raw transcript for sensitive data
                      <InfoTooltip>
                        {
                          "Off by default: for Meet captures the scan uses only the summary + to-dos field. Turn on to send the entire transcript through the sensitive-scan model as well."
                        }
                      </InfoTooltip>
                    </span>
                  </label>
                </div>
                <div className="settings-field" style={{ marginTop: 20 }}>
                  <label className="settings-label" htmlFor="adv-sensitive-prompt-template">
                    Sensitive classification prompt (template file)
                    <InfoTooltip>
                      {
                        "Saved per user and pushed to kts/llm_sensitive_prompt_template.txt for the local LM. Reset restores the built-in default."
                      }
                    </InfoTooltip>
                  </label>
                  <SensitivePromptHelpText />
                  <textarea
                    id="adv-sensitive-prompt-template"
                    className="settings-input"
                    style={{
                      minHeight: 120,
                      width: "100%",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 12,
                      resize: "vertical",
                    }}
                    value={sensitivePromptTemplate}
                    onChange={(e) => setSensitivePromptTemplate(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="controls-row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={sensitivePromptSaveBusy}
                      onClick={() => {
                        setSensitivePromptSaveBusy(true);
                        const body = sensitivePromptTemplate;
                        const uid = userIdRef.current;
                        void invoke("set_sensitive_prompt_template_cmd", { body })
                          .then(async () => {
                            if (uid) {
                              await store.set(sessionStoreKeyForUser(uid, "sensitivePromptTemplate"), body);
                              await store.save();
                            }
                            return invoke<string>("get_sensitive_prompt_template_cmd");
                          })
                          .then(setSensitivePromptTemplate)
                          .catch(console.error)
                          .finally(() => setSensitivePromptSaveBusy(false));
                      }}
                    >
                      {sensitivePromptSaveBusy ? "Saving…" : "Save prompt"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        const uid = userIdRef.current;
                        void invoke("set_sensitive_prompt_template_cmd", { body: "" })
                          .then(async () => {
                            if (uid) {
                              await store.delete(sessionStoreKeyForUser(uid, "sensitivePromptTemplate"));
                              await store.save();
                            }
                            return invoke<string>("get_sensitive_prompt_template_cmd");
                          })
                          .then(setSensitivePromptTemplate)
                          .catch(console.error);
                      }}
                    >
                      Reset to default
                    </button>
                  </div>
                </div>
              </>
            )}
            <button type="button" className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => setAdvTagsOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {advEmbedOpen ? (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => setAdvEmbedOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setAdvEmbedOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-labelledby="adv-embed-title"
            className="glass-card"
            style={{ maxWidth: 440, width: "100%", maxHeight: "88vh", overflow: "auto", padding: 20 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="prefs-modal-header" style={{ marginBottom: 16, alignItems: "flex-start" }}>
              <p id="adv-embed-title" className="section-label" style={{ marginBottom: 0, flex: "1 1 auto", minWidth: 0, paddingRight: 8 }}>
                Capture indexing - advanced
              </p>
              <button
                type="button"
                className="prefs-modal-close-btn"
                onClick={() => setAdvEmbedOpen(false)}
                aria-label="Close"
                style={{ flexShrink: 0, marginTop: -2 }}
              >
                <svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {!activeEmbedModelId?.startsWith("openai:") ? (
              <div className="settings-field">
                <label className="settings-label" htmlFor="adv-embed-threads">
                  CPU threads
                </label>
                <input
                  id="adv-embed-threads"
                  type="number"
                  className="settings-input"
                  style={{ maxWidth: 80 }}
                  min={1}
                  max={16}
                  step={1}
                  value={embedThreads}
                  onChange={(e) => setEmbedThreads(Math.min(16, Math.max(1, parseInt(e.target.value, 10) || 4)))}
                />
                <p className="settings-hint" style={{ marginTop: 4 }}>
                  Controls how many CPU cores llama.cpp uses per embedding call. Higher = faster but more CPU usage. Default: 4.
                </p>
              </div>
            ) : (
              <>
                <div className="settings-field">
                  <label className="settings-label" htmlFor="adv-embed-batch-size">
                    Batch size
                  </label>
                  <input
                    id="adv-embed-batch-size"
                    type="number"
                    className="settings-input"
                    style={{ maxWidth: 100 }}
                    min={1}
                    max={2048}
                    step={8}
                    value={embedOpenAiBatchSize}
                    onChange={(e) => setEmbedOpenAiBatchSize(Math.min(2048, Math.max(1, parseInt(e.target.value, 10) || 128)))}
                  />
                  <p className="settings-hint" style={{ marginTop: 4 }}>
                    Number of text chunks sent to OpenAI in a single API call. Higher = fewer calls, faster indexing. Default: 128.
                  </p>
                </div>
                <div className="settings-field" style={{ marginTop: 14 }}>
                  <label className="settings-label" htmlFor="adv-embed-parallel">
                    Parallel requests
                  </label>
                  <input
                    id="adv-embed-parallel"
                    type="number"
                    className="settings-input"
                    style={{ maxWidth: 80 }}
                    min={1}
                    max={8}
                    step={1}
                    value={embedOpenAiParallel}
                    onChange={(e) => setEmbedOpenAiParallel(Math.min(8, Math.max(1, parseInt(e.target.value, 10) || 3)))}
                  />
                  <p className="settings-hint" style={{ marginTop: 4 }}>
                    Number of simultaneous OpenAI batch requests. Default: 3.
                  </p>
                </div>
              </>
            )}
            <div className="settings-field" style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--glass-border, rgba(0,0,0,0.08))" }}>
              <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={autoIndexEnabled}
                  onChange={(e) => setAutoIndexEnabled(e.target.checked)}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>Index captures automatically</span>
              </label>
              <p className="settings-hint" style={{ marginTop: 6 }}>
                New captures become searchable by the assistant as soon as they are saved. Turn this off to pause
                indexing; captures will queue up and index when you turn it back on.
              </p>
            </div>
            <div className="settings-field" style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--glass-border, rgba(0,0,0,0.08))" }}>
              <p className="settings-label" style={{ marginBottom: 10 }}>Indexing defaults for new captures</p>
              <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 10 }}>
                <input
                  type="checkbox"
                  checked={defaultIndexDocContent}
                  onChange={(e) => setDefaultIndexDocContent(e.target.checked)}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  Index document content by default
                  <InfoTooltip>
                    {"When on, the raw text extracted from new documents is added to the local index. You can still change this per capture in the Captures tab."}
                  </InfoTooltip>
                </span>
              </label>
              <label className="settings-label" style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={defaultIndexMeetTranscript}
                  onChange={(e) => setDefaultIndexMeetTranscript(e.target.checked)}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  Index Google Meet transcript by default
                  <InfoTooltip>
                    {"When on, the full meeting transcript is added to the local index for each new Google Meet capture. You can still change this per capture in the Captures tab."}
                  </InfoTooltip>
                </span>
              </label>
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => setAdvEmbedOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

    </InfoTooltipProvider>
  );
}
