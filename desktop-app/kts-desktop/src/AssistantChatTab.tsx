import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { displayAssistantAnswerForUser } from "./assistantChatDisplay";
import type { SettingsModelPickerOption } from "./SettingsModelPicker";
import { localSearch, localPackContext, localIndexDiag, localCoverageByModel, localModelCoverage, type ModelCoverage } from "./localIndex";
import { AssistantCoverageBanner } from "./AssistantCoverageBanner";
import type { CaptureTag, EmbedModelsStatus, LocalIndexStats, QwenModelsStatus } from "./appTypes";
import {
  ASSISTANT_CHAT_BY_CONTEXT_KEY,
  ASSISTANT_CHAT_LEGACY_KEY,
  ASSISTANT_CONVERSATIONS_KEY,
  ASSISTANT_DEFAULT_TAG_FILTER_KEY,
  ASSISTANT_EMBED_MODEL_KEY,
  ASSISTANT_KB_SETTINGS_KEY,
  ASSISTANT_PREFERENCES_KEY,
  SESSION_STORE_FILE,
  sessionStoreKeyForUser,
} from "./sessionStoreUser";
import {
  ASSISTANT_MODEL_OPTIONS,
  ASSISTANT_MODEL_DISABLED,
  isAssistantDirectOpenAiModel,
  isAssistantLocalQwenModel,
} from "./appConstants";
import {
  UNTAGGED_SEGMENT_TAG_ID,
  safeInvokeUnlisten,
  newConversationEntry,
  parseStoredMessages,
  parseStoredConversations,
  parseStoredPreferences,
  type ChatMessage,
  type DebugPrompt,
  type OpenAIUsage,
  type AssistantChatContextTab,
} from "./assistantChatTypes";
// Re-export for external consumers
export {
  ASSISTANT_CHAT_STORE_KEY,
  CHAT_GCS_AUTO_SIGN_LAST_MESSAGES,
  parseStoredMessages,
  parseStoredPreferences,
  parseStoredConversations,
} from "./assistantChatTypes";
export type {
  ConversationEntry,
  ChatPreference,
  AssistantChatContextTab,
} from "./assistantChatTypes";
export type {
  AssistantKbMode,
  AssistantKbSettings,
} from "./AssistantPreferencesModal";
import {
  DEFAULT_KB_SETTINGS,
  PreferencesModal,
  type AssistantPrefsModalTab,
  type AssistantKbSettings,
} from "./AssistantPreferencesModal";
import {
  DeleteConversationModal,
  ConversationSidebar,
} from "./AssistantConversationSidebar";
import { CHAT_GCS_AUTO_SIGN_LAST_MESSAGES } from "./assistantChatTypes";
import {
  UserMessageBubble,
  AssistantMessageBlock,
} from "./assistantMessageDisplay";
import {
  IconKbLocal,
  IconKbCloud,
  IconMic,
  IconMicRecording,
  IconSliders,
  IconX,
} from "./AppIcons";
import { ImportAssistantModal } from "./ImportAssistantModal";
import { FilesDeletedButStillListedError, removeImportedAssistant } from "./importedAssistants";
import { friendlyMessage } from "./friendlyMessage";

/**
 * Shown when the index behind the active tab could not be read and the backend
 * had no sentence of its own to offer.
 *
 * Deliberately says nothing about where the knowledge came from: the same read
 * serves the profile's own index and every imported one, and the specific
 * messages — "We could not open this shared knowledge. Nothing was removed…",
 * "We could not find this shared knowledge on your computer…" — already arrive
 * finished from the backend and are shown as written. This is the last resort,
 * so it has to be true on either tab.
 */
const INDEX_UNREADABLE_FALLBACK =
  "We could not read this knowledge, so this assistant may not be able to answer from it. Close the app, reopen it and try again.";

async function streamFromOpenAI(
  apiKey: string,
  model: string,
  messages: unknown[],
  onChunk: (text: string) => void,
): Promise<OpenAIUsage | null> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${text}`);
  }
  if (!response.body) {
    throw new Error("OpenAI API returned no response body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let usageStats: OpenAIUsage | null = null;
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed.startsWith("data: ")) continue;
      const rawPayload = trimmed.slice(6);
      if (rawPayload === "[DONE]") break outer;
      try {
        const chunk = JSON.parse(rawPayload) as Record<string, unknown>;
        // Capture usage stats (sent in the final chunk before [DONE])
        const usage = chunk.usage;
        if (usage != null && typeof usage === "object" && !Array.isArray(usage)) {
          const u = usage as Record<string, unknown>;
          if (typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
            usageStats = {
              prompt_tokens: u.prompt_tokens,
              completion_tokens: u.completion_tokens,
            };
          }
        }
        const choices = chunk.choices;
        if (!Array.isArray(choices) || choices.length === 0) continue;
        const delta = (choices[0] as Record<string, unknown>).delta;
        if (delta == null || typeof delta !== "object") continue;
        const content = (delta as Record<string, unknown>).content;
        if (typeof content === "string" && content.length > 0) {
          onChunk(content);
        }
      } catch {
        // ignore malformed chunks
      }
    }
  }
  return usageStats;
}

export function AssistantChatTab({
  sessionUserId,
  contextTabs,
  contextTabsError = null,
  activeContextId,
  onActiveContextChange,
  focusNonce,
  /** Increment from Settings → Assistant Advanced to open chat preferences. */
  assistantPreferencesOpenNonce = 0,
  chatResetNonce,
  /** Increment after parent removes a context from disk so state reloads from store. */
  externalStoreRevision,
  premiumAssistantLocked = false,
  isSuperAdmin = false,
  openAiApiKey,
  assistantModel,
  onGoToSettings,
  captureTags = [],
  embedStatus = null,
  localIndexStats: _localIndexStats = null,
  qwenStatus = null,
  onAssistantModelChange,
  onImportedAssistantsChanged,
}: {
  sessionUserId: string;
  contextTabs: AssistantChatContextTab[];
  /**
   * Why `contextTabs` is short, when it is short because reading the registry
   * failed rather than because there is nothing to list. The two produce the
   * same tab strip, so without this the second is shown while the first is true.
   * Already a finished sentence for the user — rendered as given.
   */
  contextTabsError?: string | null;
  activeContextId: string;
  onActiveContextChange: (contextId: string) => void;
  focusNonce: number;
  /** From Settings: open the preferences modal once limits are loaded. */
  assistantPreferencesOpenNonce?: number;
  /** Increment (e.g. super-admin purge) to clear all context transcripts. */
  chatResetNonce: number;
  externalStoreRevision: number;
  premiumAssistantLocked?: boolean;
  isSuperAdmin?: boolean;
  /** OpenAI API key for direct client-side calls when assistantModel is a local Qwen or GPT model. */
  openAiApiKey?: string;
  /** "disabled" (chat off), "local:{filename}" for on-device Qwen, or a GPT model id for direct OpenAI calls. */
  assistantModel?: string;
  /**
   * Open Settings and scroll to a section (`settings-ai-tasks` = AI tasks,
   * `settings-llm-api-key` = LLM API key). Defaults to Assistant when omitted.
   */
  onGoToSettings?: (scrollToId?: string) => void;
  captureTags?: CaptureTag[];
  embedStatus?: EmbedModelsStatus | null;
  localIndexStats?: LocalIndexStats | null;
  qwenStatus?: QwenModelsStatus | null;
  onAssistantModelChange?: (model: string) => void;
  /**
   * The list of imported assistants changed on disk — re-read it, which is what
   * rebuilds `contextTabs`. `activateContextId`, when given, is the assistant
   * that was just added and should end up the visible tab.
   *
   * This component owns neither the list nor the tabs, so an import or a delete
   * shows up on screen only because the parent is told here.
   *
   * Required, not optional. It is the sole route from this component back to the
   * registry, and omitting it does not disable a feature — it breaks two in ways
   * that look like data loss: an import writes an index to disk and no tab ever
   * appears for it, and a delete destroys the files while the tab it belonged to
   * stays on screen for the rest of the session.
   */
  onImportedAssistantsChanged: (activateContextId?: string) => void | Promise<void>;
}) {
  /** All conversations keyed by contextId (e.g. "self" or shared assistant user UUID). */
  const [conversationsByContext, setConversationsByContext] = useState<
    Record<string, import("./assistantChatTypes").ConversationEntry[]>
  >({});
  /** Active conversation index per contextId. */
  const [activeConvIdxByContext, setActiveConvIdxByContext] = useState<
    Record<string, number>
  >({});
  /** Embedding model to query against per contextId (e.g. "self" or shared assistant user UUID). */
  const [assistantEmbedModelByContext, setAssistantEmbedModelByContext] = useState<
    Record<string, string>
  >({});
  /** Model covering the most local captures, used as the default when a context has none stored. */
  const [majorityEmbedModel, setMajorityEmbedModel] = useState<string | null>(null);
  /**
   * How the one read that describes the active index ended.
   *
   * Three states and not two, because "we have not asked yet" and "we asked and
   * the index would not open" are different things to be in front of, and
   * collapsing them tells one of the two users a lie: someone whose shared
   * knowledge is still loading would be told it is broken, or someone whose
   * index will not open would be left watching a spinner that never resolves.
   *
   * `"loading"` is also the state the model fallback below refuses to guess in.
   */
  const [indexFactsStatus, setIndexFactsStatus] = useState<"loading" | "ready" | "failed">("loading");
  /**
   * Why the active index could not be read, as a finished sentence for the user.
   * Non-null exactly when `indexFactsStatus` is `"failed"`.
   *
   * Without this the failure had nowhere to go: the read swallowed it into
   * `null`, the coverage banner renders nothing when it has no coverage, and an
   * imported assistant whose index will not open showed its tab, "Hello! Send a
   * message to get started.", and no other sign that anything was wrong. Typing
   * did not necessarily help either — the send path that surfaces the error
   * needs a local or OpenAI model, so a user with neither got the generic "Cloud
   * assistant is not available in local mode…" instead of the real reason.
   */
  const [indexError, setIndexError] = useState<string | null>(null);
  /** Coverage of the resolved assistant embed model, for the coverage banner above the message list. */
  const [assistantModelCoverage, setAssistantModelCoverage] = useState<ModelCoverage | null>(null);
  /** Coverage broken down by every embedding model present in the local index. */
  const [assistantAllModelCoverage, setAssistantAllModelCoverage] = useState<ModelCoverage[]>([]);
  /** Bumped to force a coverage re-fetch (e.g. after an indexing pass). */
  const [coverageRefreshNonce, setCoverageRefreshNonce] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<{ idx: number; name: string } | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  /** The imported assistant the user asked to delete, while they confirm it. */
  const [assistantToDelete, setAssistantToDelete] = useState<
    { contextId: string; label: string } | null
  >(null);
  const [assistantDeleteBusy, setAssistantDeleteBusy] = useState(false);
  const [assistantDeleteErr, setAssistantDeleteErr] = useState<string | null>(null);
  const [storeHydrated, setStoreHydrated] = useState(false);
  const [preferences, setPreferences] = useState<import("./assistantChatTypes").ChatPreference[]>([]);
  const [showPrefsModal, setShowPrefsModal] = useState(false);
  const [prefsModalInitialTab, setPrefsModalInitialTab] = useState<AssistantPrefsModalTab>("model");
  const [kbSettings, setKbSettings] = useState<AssistantKbSettings>(DEFAULT_KB_SETTINGS);
  const [savedDefaultTagFilter, setSavedDefaultTagFilter] = useState<{ kbSource: "local" | "cloud"; tagIds: string[] | null } | null>(null);
  const [localTagIds, setLocalTagIds] = useState<string[] | null>(null);
  const activeContextIdRef = useRef(activeContextId);
  activeContextIdRef.current = activeContextId;

  /**
   * Which local index every read on this tab goes to: `null` is the profile's own
   * (`local-index/{user}/index.db`), anything else is an imported assistant's
   * (`local-index/{user}/assistants/{id}/index.db`).
   *
   * The sentinel must be translated here and not passed through: the backend takes
   * `Option<String>`, so the literal string "self" would be sanitised into a
   * directory called `self`, and reads would quietly succeed against an empty
   * database rather than fail.
   */
  const activeAssistantId = activeContextId === "self" ? null : activeContextId;

  /**
   * Which index the four facts below were read from.
   *
   * `majorityEmbedModel`, `assistantModelCoverage`, `assistantAllModelCoverage`
   * and `localTagIds` all describe one index, and the effects that fill them are
   * async. None of them cleared on the way *in*, so between a context switch and
   * those effects resolving the screen carried the previous index's facts as if
   * they were this one's. Two things followed, and both were visible:
   *
   * - `resolvedAssistantEmbedModel` fell back to the *previous* index's majority
   *   model, the coverage effect asked how much of the new index that model
   *   covers, got zero, and the banner announced "Nothing here is indexed … so
   *   this assistant can't answer from it" — as the very first thing after a
   *   successful import, since the new tab is activated immediately;
   * - a Send in that window searched the right index with the wrong model, so
   *   `vector_search`'s `WHERE embed_model = ?` matched nothing and the answer
   *   quietly degraded to keyword-only, with nothing on screen to say so.
   *
   * Cleared during render rather than in an effect: an effect would let one
   * painted frame through carrying the old numbers, and the banner above is
   * exactly the sort of thing a user reads in one frame. This is React's
   * documented "adjusting state when a prop changes" — the setters below run only
   * when the marker disagrees and React re-renders immediately without painting.
   *
   * Clearing them is not on its own enough, and it is worth being exact about
   * why. A null `majorityEmbedModel` does *not* read as "loading" at
   * `resolvedAssistantEmbedModel` below: that chain falls through to the
   * profile's globally active model, which for an imported index is a model it
   * has no vectors for. Both failures above then happen again, with the global
   * model in place of the previous tab's. `indexFactsStatus` is what actually
   * holds them off, by making "not asked yet" a state the fallback declines to
   * guess in.
   */
  const [factsBelongToContext, setFactsBelongToContext] = useState(activeContextId);
  if (factsBelongToContext !== activeContextId) {
    setFactsBelongToContext(activeContextId);
    setMajorityEmbedModel(null);
    setAssistantModelCoverage(null);
    setAssistantAllModelCoverage([]);
    setLocalTagIds(null);
    // Both halves of the new context's story, reset together: nothing is known
    // about this index yet, and the previous index's failure is not this one's.
    setIndexFactsStatus("loading");
    setIndexError(null);
  }

  /**
   * Stable fallback entries per context (not stored until first message sent).
   * Ensures each context always has at least one conversation with a stable clientId,
   * even before any messages have been exchanged.
   */
  const defaultConvPerCtxRef = useRef<Record<string, import("./assistantChatTypes").ConversationEntry>>({});

  const conversations: import("./assistantChatTypes").ConversationEntry[] = useMemo(() => {
    const stored = conversationsByContext[activeContextId];
    if (stored && stored.length > 0) return stored;
    if (!defaultConvPerCtxRef.current[activeContextId]) {
      defaultConvPerCtxRef.current[activeContextId] = newConversationEntry();
    }
    return [defaultConvPerCtxRef.current[activeContextId]];
  }, [conversationsByContext, activeContextId]);

  const activeConvIdx = activeConvIdxByContext[activeContextId] ?? 0;
  const activeConvIdxRef = useRef(activeConvIdx);
  activeConvIdxRef.current = activeConvIdx;

  const setMessages = useCallback(
    (updater: SetStateAction<ChatMessage[]>) => {
      const ctxId = activeContextIdRef.current;
      const idx = activeConvIdxRef.current;
      setConversationsByContext((prev) => {
        const ctxConvs = prev[ctxId] ?? [newConversationEntry()];
        const next = [...ctxConvs];
        const cur = next[idx] ?? newConversationEntry();
        const msgs =
          typeof updater === "function"
            ? (updater as (x: ChatMessage[]) => ChatMessage[])(cur.messages)
            : updater;
        next[idx] = { ...cur, messages: msgs };
        return { ...prev, [ctxId]: next };
      });
    },
    [],
  );

  const updateActiveTagFilter = useCallback((ids: string[] | null, source: "local" | "cloud" | null) => {
    const ctxId = activeContextIdRef.current;
    const idx = activeConvIdxRef.current;
    setConversationsByContext((prev) => {
      const ctxConvs = prev[ctxId] ?? [newConversationEntry()];
      const next = [...ctxConvs];
      const cur = next[idx] ?? newConversationEntry();
      next[idx] = { ...cur, selfQueryTagIds: ids && ids.length > 0 ? ids : null, selfQueryKbSource: source };
      return { ...prev, [ctxId]: next };
    });
  }, []);

  /** Switches the embedding model this context queries against (from the coverage banner). */
  const handleAssistantEmbedModelChange = useCallback((model: string) => {
    const ctxId = activeContextIdRef.current;
    setAssistantEmbedModelByContext((prev) => ({ ...prev, [ctxId]: model }));
  }, []);

  /** Re-fetches coverage after an indexing pass or on demand (from the coverage banner). */
  const handleCoverageRefresh = useCallback(() => {
    setCoverageRefreshNonce((n) => n + 1);
  }, []);

  const messages = conversations[activeConvIdx]?.messages ?? [];
  const selfQueryTagIdsForComposer =
    conversations[activeConvIdx]?.selfQueryTagIds ?? null;
  const selfQueryKbSourceForComposer =
    conversations[activeConvIdx]?.selfQueryKbSource ?? null;
  // For new conversations (no explicit selection), fall back to the saved default.
  // Legacy "cloud" defaults (pre local-only) always fall back to local All.
  const _resolvedDefault = savedDefaultTagFilter
    ? (savedDefaultTagFilter.kbSource === "cloud"
        ? { kbSource: "local" as const, tagIds: null }
        : savedDefaultTagFilter)
    : null;
  const isConvDefaultState = selfQueryKbSourceForComposer === null;
  const effectiveTagIds: string[] | null =
    isConvDefaultState ? (_resolvedDefault?.tagIds ?? null) : selfQueryTagIdsForComposer;

  /**
   * Embedding model this assistant queries with: explicit per-context choice, else
   * the model covering the most captures *in this index*, else the globally active
   * one.
   *
   * `null` until the middle term is known. The last term is the profile's own
   * model, which is the right guess for the profile's own index and the wrong one
   * for an index somebody else built: `vector_search` matches on
   * `WHERE embed_model = ?`, so guessing it means a search that silently finds
   * nothing by meaning, and a coverage banner announcing that nothing here is
   * indexed — as the first thing on screen after a successful import, since the
   * new tab is activated immediately. Neither is recoverable by the user, and
   * both are gone a moment later when the real model arrives, so the honest state
   * in between is "we do not know yet" rather than a guess.
   *
   * Consumers must treat `null` as "not resolved", never as "none" — the coverage
   * banner is told so explicitly, and the send path waits for it.
   */
  const resolvedAssistantEmbedModel: string | null =
    assistantEmbedModelByContext[activeContextId] ??
    (indexFactsStatus === "ready" ? (majorityEmbedModel ?? embedStatus?.activeModel ?? null) : null);

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  // ── Tag filter popover ──────────────────────────────────────────────────────
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [tagPopoverAnchor, setTagPopoverAnchor] = useState<{ bottom: number; right: number } | null>(null);
  const tagBtnRef = useRef<HTMLButtonElement>(null);
  const tagPopoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tagPopoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        tagBtnRef.current?.contains(e.target as Node) ||
        tagPopoverRef.current?.contains(e.target as Node)
      ) return;
      setTagPopoverOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tagPopoverOpen]);

  // ── Inline mic ─────────────────────────────────────────────────────────────
  const [whisperEnabled, setWhisperEnabled] = useState(false);
  const [micMode, setMicMode] = useState<"idle" | "recording" | "processing">("idle");
  const [micElapsed, setMicElapsed] = useState(0);
  const micIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Position curseur dans le textarea au moment du clic sur le micro. */
  const micInsertPosRef = useRef<number | null>(null);

  const clearMicTimer = () => {
    if (micIntervalRef.current) {
      clearInterval(micIntervalRef.current);
      micIntervalRef.current = null;
    }
  };
  const startMicInterval = () => {
    clearMicTimer();
    micIntervalRef.current = setInterval(() => setMicElapsed((s) => s + 1), 1000);
  };
  const fmtMicTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const [isThinking, setIsThinking] = useState(false);
  /** null = limits not loaded or failed (see limitsError). */
  const [maxMessageChars, setMaxMessageChars] = useState<number | null>(null);
  const [maxHistoryMessages, setMaxHistoryMessages] = useState<number | null>(
    null,
  );
  const [maxPreferenceChars, setMaxPreferenceChars] = useState<number | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [truncateBanner, setTruncateBanner] = useState(false);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesInnerRef = useRef<HTMLDivElement>(null);
  const chatRootRef = useRef<HTMLDivElement>(null);
  const composerPaneRef = useRef<HTMLDivElement>(null);
  /** null = hauteur naturelle ; sinon hauteur fixe de la zone saisie (bannières + barre). */
  const [composerHeightPx, setComposerHeightPx] = useState<number | null>(null);
  /** Free tier: ignore stored resize height so the pane stays content-sized (no empty band under the bar). */
  const effectiveComposerHeightPx = premiumAssistantLocked ? null : composerHeightPx;
  /** Dernière hauteur « auto » mesurée ; sert à repasser en auto en rétractant la poignée. */
  const lastNaturalComposerHeightRef = useRef(0);
  /** En haut du fil rendu : déclenche le chargement des messages plus anciens (IO, pas seulement scroll). */
  const loadOlderSentinelRef = useRef<HTMLDivElement | null>(null);
  /** false dès que l'utilisateur remonte dans l'historique ; true s'il est proche du bas. */
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Combien de messages (depuis la fin) sont rendus dans le DOM ; le reste existe seulement en state. */
  const uiMessagePageSize = Math.max(1, CHAT_GCS_AUTO_SIGN_LAST_MESSAGES);
  const [visibleTailCount, setVisibleTailCount] = useState(uiMessagePageSize);
  /** Après expansion vers le haut, conserve la position visuelle du fil. */
  const scrollExpandPreserveRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const messagesLengthRef = useRef(0);
  messagesLengthRef.current = messages.length;

  /** Distance max (px) au bas pour considérer qu'on « suit » le fil. */
  const SCROLL_BOTTOM_SLACK_PX = 96;
  /**
   * Marge (px) au-dessus du viewport de scroll : le sentinelle est considéré visible un peu avant
   * le bord haut, pour charger sans « coller » au stop scroll (où scrollTop ne bouge plus).
   */
  const LOAD_OLDER_ROOT_MARGIN_TOP_PX = 96;

  const updateStickToBottomFromScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = dist <= SCROLL_BOTTOM_SLACK_PX;
  }, []);

  const handleMessagesScroll = useCallback(() => {
    updateStickToBottomFromScroll();
  }, [updateStickToBottomFromScroll]);

  useLayoutEffect(() => {
    if (effectiveComposerHeightPx != null) return;
    const pane = composerPaneRef.current;
    if (!pane) return;
    const h = Math.round(pane.getBoundingClientRect().height);
    if (h > 0) lastNaturalComposerHeightRef.current = h;
  }, [effectiveComposerHeightPx, limitsError, truncateBanner, storeHydrated]);

  const onComposerResizePointerDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const pane = composerPaneRef.current;
      const rootEl = chatRootRef.current;
      if (!pane || !rootEl) return;
      const handleH = 6;
      const minMessages = 72;
      const floorComposer = 52;
      const resetSlackPx = 12;
      const wasSizedAtStart = composerHeightPx !== null;
      const startH =
        composerHeightPx !== null
          ? composerHeightPx
          : pane.getBoundingClientRect().height;

      const move = (ev: MouseEvent) => {
        const tabsEl = rootEl.querySelector(".chat-tab-row");
        const tabsH = tabsEl?.getBoundingClientRect().height ?? 0;
        const maxComposer = Math.max(
          floorComposer,
          rootEl.getBoundingClientRect().height -
            tabsH -
            minMessages -
            handleH,
        );
        const delta = startY - ev.clientY;
        let next = startH + delta;
        next = Math.min(maxComposer, next);
        const natural = lastNaturalComposerHeightRef.current;
        // Reset to auto if dragged near natural height, OR if dragged down ≥60% of start height
        // (the second condition ensures reset is reachable even from very tall sizes)
        if (
          wasSizedAtStart &&
          (
            (natural > 0 && next <= natural + resetSlackPx) ||
            delta <= -(startH * 0.6)
          )
        ) {
          setComposerHeightPx(null);
          return;
        }
        setComposerHeightPx(Math.max(floorComposer, next));
      };
      const up = () => {
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [composerHeightPx],
  );

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const st = await load(SESSION_STORE_FILE);
      const convsKey = sessionStoreKeyForUser(sessionUserId, ASSISTANT_CONVERSATIONS_KEY);
      const convsRaw = await st.get<unknown>(convsKey);
      let initialByCtx: Record<string, import("./assistantChatTypes").ConversationEntry[]> = {};
      if (
        convsRaw != null &&
        typeof convsRaw === "object" &&
        !Array.isArray(convsRaw)
      ) {
        for (const [ctxId, val] of Object.entries(convsRaw as Record<string, unknown>)) {
          const parsed = parseStoredConversations(val);
          if (parsed.length > 0) initialByCtx[ctxId] = parsed;
        }
      }
      // Migration: if nothing stored under the new key, pull from old messagesByContext
      if (Object.keys(initialByCtx).length === 0) {
        const byCtxKey = sessionStoreKeyForUser(sessionUserId, ASSISTANT_CHAT_BY_CONTEXT_KEY);
        const legacyKey = sessionStoreKeyForUser(sessionUserId, ASSISTANT_CHAT_LEGACY_KEY);
        const byCtxRaw = await st.get<unknown>(byCtxKey);
        if (byCtxRaw != null && typeof byCtxRaw === "object" && !Array.isArray(byCtxRaw)) {
          for (const [ctxId, val] of Object.entries(byCtxRaw as Record<string, unknown>)) {
            const msgs = parseStoredMessages(val);
            if (msgs.length > 0) {
              initialByCtx[ctxId] = [{ ...newConversationEntry(), messages: msgs }];
            }
          }
        } else {
          const legacyMsgs = parseStoredMessages(await st.get<unknown>(legacyKey));
          if (legacyMsgs.length > 0) {
            initialByCtx["self"] = [{ ...newConversationEntry(), messages: legacyMsgs }];
          }
        }
      }
      const prefsKey = sessionStoreKeyForUser(sessionUserId, ASSISTANT_PREFERENCES_KEY);
      const prefsRaw = await st.get<unknown>(prefsKey);
      const initialPrefs = parseStoredPreferences(prefsRaw);

      const kbKey = sessionStoreKeyForUser(sessionUserId, ASSISTANT_KB_SETTINGS_KEY);
      const kbRaw = await st.get<unknown>(kbKey);
      const initialKb: AssistantKbSettings =
        kbRaw && typeof kbRaw === "object" && "mode" in kbRaw
          ? { ...DEFAULT_KB_SETTINGS, ...(kbRaw as Partial<AssistantKbSettings>) }
          : DEFAULT_KB_SETTINGS;

      const dtfKey = sessionStoreKeyForUser(sessionUserId, ASSISTANT_DEFAULT_TAG_FILTER_KEY);
      const dtfRaw = await st.get<unknown>(dtfKey);
      let initialDefaultTagFilter: { kbSource: "local" | "cloud"; tagIds: string[] | null } | null = null;
      if (dtfRaw && typeof dtfRaw === "object" && !Array.isArray(dtfRaw)) {
        const d = dtfRaw as Record<string, unknown>;
        if (d.kbSource === "local" || d.kbSource === "cloud") {
          initialDefaultTagFilter = {
            kbSource: d.kbSource,
            tagIds: Array.isArray(d.tagIds) ? (d.tagIds as unknown[]).filter((x): x is string => typeof x === "string") : null,
          };
        }
      }

      const embedModelKey = sessionStoreKeyForUser(sessionUserId, ASSISTANT_EMBED_MODEL_KEY);
      const embedModelRaw = await st.get<unknown>(embedModelKey);
      let initialEmbedModelByContext: Record<string, string> = {};
      if (embedModelRaw && typeof embedModelRaw === "object" && !Array.isArray(embedModelRaw)) {
        for (const [ctxId, val] of Object.entries(embedModelRaw as Record<string, unknown>)) {
          if (typeof val === "string" && val) initialEmbedModelByContext[ctxId] = val;
        }
      }

      if (cancelled) return;
      setConversationsByContext(initialByCtx);
      // Keep the conversation the user had open in each context.
      //
      // This re-runs whenever `externalStoreRevision` changes, and that is bumped
      // by the set of *tabs* changing — an import, a delete. Wiping the map sent
      // every context, including the ones the user was not even looking at, back
      // to its first conversation: import knowledge from a colleague and the
      // thread you were in the middle of on "Me" is no longer the one on screen.
      // It also made the careful per-context cleanup in `performDeleteAssistant`
      // dead work, clobbered by the re-hydration it triggers moments later.
      //
      // Clamped to what was actually re-read, so a context whose transcripts
      // shrank cannot keep an index pointing past the end, and a context that no
      // longer has any is dropped rather than kept at zero.
      setActiveConvIdxByContext((prev) => {
        const kept: Record<string, number> = {};
        for (const [ctxId, idx] of Object.entries(prev)) {
          const count = initialByCtx[ctxId]?.length ?? 0;
          const clamped = Math.min(idx, count - 1);
          if (clamped > 0) kept[ctxId] = clamped;
        }
        return kept;
      });
      setPreferences(initialPrefs);
      setKbSettings(initialKb);
      setSavedDefaultTagFilter(initialDefaultTagFilter);
      setAssistantEmbedModelByContext(initialEmbedModelByContext);
      setStoreHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [externalStoreRevision, sessionUserId]);

  useEffect(() => {
    if (!storeHydrated) return;
    void (async () => {
      const st = await load(SESSION_STORE_FILE);
      await st.set(
        sessionStoreKeyForUser(sessionUserId, ASSISTANT_PREFERENCES_KEY),
        preferences,
      );
      await st.save();
    })();
  }, [preferences, storeHydrated, sessionUserId]);

  useEffect(() => {
    if (!storeHydrated) return;
    void (async () => {
      const st = await load(SESSION_STORE_FILE);
      await st.set(sessionStoreKeyForUser(sessionUserId, ASSISTANT_KB_SETTINGS_KEY), kbSettings);
      await st.save();
    })();
  }, [kbSettings, storeHydrated, sessionUserId]);

  useEffect(() => {
    if (!storeHydrated) return;
    void (async () => {
      const st = await load(SESSION_STORE_FILE);
      await st.set(sessionStoreKeyForUser(sessionUserId, ASSISTANT_DEFAULT_TAG_FILTER_KEY), savedDefaultTagFilter);
      await st.save();
    })();
  }, [savedDefaultTagFilter, storeHydrated, sessionUserId]);

  useEffect(() => {
    if (!storeHydrated) return;
    void (async () => {
      const st = await load(SESSION_STORE_FILE);
      await st.set(
        sessionStoreKeyForUser(sessionUserId, ASSISTANT_EMBED_MODEL_KEY),
        assistantEmbedModelByContext,
      );
      await st.save();
    })();
  }, [assistantEmbedModelByContext, storeHydrated, sessionUserId]);

  // Default embed model per context: the model covering the most local captures.
  // Also feeds the coverage banner's "Use a different model" list.
  // Refreshed on mount, on context change, and via onCoverageRefresh (coverageRefreshNonce).
  //
  // This is the read that opens the index, so it is also the one that finds out
  // the index will not open — and the only one whose failure the user is told
  // about. The coverage read below goes to the same database through the same
  // `get_for`, so it cannot fail on its own; leaving `indexError` to a single
  // owner keeps two async effects from racing to set and clear one sentence.
  useEffect(() => {
    if (!storeHydrated || !sessionUserId) return;
    let cancelled = false;
    void localCoverageByModel(sessionUserId, activeAssistantId)
      .then((list) => {
        if (cancelled) return;
        setMajorityEmbedModel(list.length > 0 ? list[0].embedModel : null);
        setAssistantAllModelCoverage(list);
        setIndexError(null);
        setIndexFactsStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setMajorityEmbedModel(null);
        setAssistantAllModelCoverage([]);
        setIndexError(friendlyMessage(e, INDEX_UNREADABLE_FALLBACK));
        // Not "ready": there is no model for this index, and the fallback must
        // not fill the gap with the profile's own. Not "loading" either — that
        // would leave the coverage banner waiting on a read that already came
        // back. The banner stays quiet and the sentence above does the talking.
        setIndexFactsStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [storeHydrated, sessionUserId, activeAssistantId, coverageRefreshNonce]);

  // Coverage of the model this context actually queries with, for the coverage banner.
  // Refreshed on mount, on context change, on model change, and via onCoverageRefresh.
  useEffect(() => {
    if (!storeHydrated || !sessionUserId || !resolvedAssistantEmbedModel) {
      setAssistantModelCoverage(null);
      return;
    }
    let cancelled = false;
    void localModelCoverage(sessionUserId, resolvedAssistantEmbedModel, activeAssistantId)
      .then((c) => {
        if (!cancelled) setAssistantModelCoverage(c);
      })
      .catch(() => {
        if (!cancelled) setAssistantModelCoverage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [storeHydrated, sessionUserId, activeAssistantId, resolvedAssistantEmbedModel, coverageRefreshNonce]);

  // Distinct tag IDs present in the local index, narrowed to the model this context
  // actually searches with — not the global one. Offering tags from another model's
  // vectors would show choices that return nothing, with no way to tell why.
  //
  // "Me" only. `localTagIds` has exactly one consumer, the tag popover, which is
  // rendered inside the `activeContextId === "self"` block — so on an imported tab
  // this was a backend round trip on every switch whose result nothing read. It
  // could not have been made useful there either: it would intersect the sender's
  // tag ids with `captureTags`, which are the recipient's own, and two profiles do
  // not share tag UUIDs. Filtering an imported index by tag is a feature someone
  // would have to design, not a call to leave running.
  useEffect(() => {
    if (!storeHydrated || !sessionUserId || activeAssistantId !== null) return;
    if (resolvedAssistantEmbedModel) {
      void invoke<string[]>("local_distinct_tag_ids_for_model_cmd", {
        userId: sessionUserId,
        embedModel: resolvedAssistantEmbedModel,
        assistantId: null,
      })
        .then(setLocalTagIds)
        .catch(() => setLocalTagIds([]));
    } else {
      void invoke<string[]>("local_distinct_tag_ids_cmd", {
        userId: sessionUserId,
        assistantId: null,
      })
        .then(setLocalTagIds)
        .catch(() => setLocalTagIds([]));
    }
  }, [storeHydrated, sessionUserId, activeAssistantId, resolvedAssistantEmbedModel]);

  useEffect(() => {
    if (!storeHydrated) return;
    setVisibleTailCount(uiMessagePageSize);
    scrollExpandPreserveRef.current = null;
  }, [storeHydrated, uiMessagePageSize]);

  useEffect(() => {
    setVisibleTailCount(uiMessagePageSize);
    scrollExpandPreserveRef.current = null;
    stickToBottomRef.current = true;
  }, [activeContextId, activeConvIdx, uiMessagePageSize]);

  useEffect(() => {
    if (chatResetNonce <= 0) return;
    setConversationsByContext({});
    setActiveConvIdxByContext({});
    setVisibleTailCount(uiMessagePageSize);
    scrollExpandPreserveRef.current = null;
    void (async () => {
      const st = await load(SESSION_STORE_FILE);
      await st.set(
        sessionStoreKeyForUser(sessionUserId, ASSISTANT_CONVERSATIONS_KEY),
        {},
      );
      await st.save();
    })();
  }, [chatResetNonce, uiMessagePageSize, sessionUserId]);

  useEffect(() => {
    if (!storeHydrated) return;
    void (async () => {
      const st = await load(SESSION_STORE_FILE);
      await st.set(
        sessionStoreKeyForUser(sessionUserId, ASSISTANT_CONVERSATIONS_KEY),
        conversationsByContext,
      );
      await st.save();
    })();
  }, [conversationsByContext, storeHydrated, sessionUserId]);

  /**
   * Delete an imported assistant, then forget everything this tab kept about it.
   *
   * Order matters and is not the obvious one:
   *
   * 1. `removeImportedAssistant` first — the files, then the registry entry. If
   *    it fails *before* touching the files, nothing below runs and the tab is
   *    still there to try again; the reverse order would throw away a transcript
   *    belonging to an assistant the user still has. (Failing *after* them is the
   *    third outcome described below.)
   * 2. The per-context state is written **straight to the store and awaited**,
   *    not left to the save effects above. Step 3 makes the parent re-read the
   *    registry, which bumps `externalStoreRevision` and re-hydrates this
   *    component from disk; a transcript still on its way there would be read
   *    back in and reattached to an assistant that no longer exists.
   * 3. Off the deleted tab before the parent hears anything, so no render can
   *    happen with `activeContextId` pointing at a directory that is gone —
   *    every local read on this tab addresses the index by exactly that id.
   *
   * `removeImportedAssistant` is not atomic and is not treated as though it
   * were. It deletes the files first and the registry entry second, so there is
   * a third outcome between success and failure: the captures and media are
   * gone and the list still names them. That case throws
   * `FilesDeletedButStillListedError`, and everything below step 1 still has to
   * run — the transcript is about an assistant that no longer exists, and the
   * user must not be left standing on its tab. What changes is only that the
   * modal stays open carrying a message that says what really happened and that
   * deleting again clears it.
   */
  const performDeleteAssistant = useCallback(
    async (assistantId: string) => {
      if (assistantDeleteBusy) return;
      // Nothing here may run before the store has been read. The three keys
      // written below are rebuilt from `conversationsByContext`, `preferences`
      // and `assistantEmbedModelByContext`, which are `{}`, `[]` and `{}` until
      // hydration finishes — writing them then would replace every conversation,
      // every preference and every embedding-model choice in the profile with
      // nothing. The save effects above all open with this same guard; this path
      // writes to the store directly and so bypassed it. Refusing the delete
      // costs the user one more click and the alternative costs them their
      // history, so this is not a close call.
      if (!storeHydrated) {
        setAssistantDeleteErr("Your chats are still loading. Please try again in a moment.");
        return;
      }
      setAssistantDeleteBusy(true);
      setAssistantDeleteErr(null);
      let filesGoneButStillListed = false;
      try {
        await removeImportedAssistant(sessionUserId, assistantId);
      } catch (e) {
        if (e instanceof FilesDeletedButStillListedError) {
          // The files are gone. Fall through — the cleanup below is about state
          // describing an assistant that no longer has anything behind it.
          console.error("[chat] delete left the registry entry behind:", e.reason);
          filesGoneButStillListed = true;
          setAssistantDeleteErr(e.message);
        } else {
          setAssistantDeleteErr(
            friendlyMessage(e, "We could not delete this shared knowledge. Please try again."),
          );
          setAssistantDeleteBusy(false);
          return;
        }
      }

      const nextConversations = { ...conversationsByContext };
      delete nextConversations[assistantId];
      const nextEmbedModels = { ...assistantEmbedModelByContext };
      delete nextEmbedModels[assistantId];
      delete defaultConvPerCtxRef.current[assistantId];

      // A preference aimed at this assistant and nothing else goes with it.
      // Leaving the id in place would show a fragment of a UUID in the scope
      // picker, and leaving the preference behind with an emptied scope would
      // leave a row that applies to nothing and cannot be made to apply to
      // anything without being edited — the note was about knowledge that is no
      // longer on this computer.
      const nextPreferences = preferences
        .map((p) =>
          Array.isArray(p.scope)
            ? { ...p, scope: p.scope.filter((id) => id !== assistantId) }
            : p,
        )
        .filter((p) => p.scope === "all" || p.scope.length > 0);

      try {
        const st = await load(SESSION_STORE_FILE);
        await st.set(
          sessionStoreKeyForUser(sessionUserId, ASSISTANT_CONVERSATIONS_KEY),
          nextConversations,
        );
        await st.set(
          sessionStoreKeyForUser(sessionUserId, ASSISTANT_EMBED_MODEL_KEY),
          nextEmbedModels,
        );
        await st.set(
          sessionStoreKeyForUser(sessionUserId, ASSISTANT_PREFERENCES_KEY),
          nextPreferences,
        );
        await st.save();
      } catch (err) {
        // The assistant is already gone; a transcript left behind is a stale
        // entry in a file, not something the user can reach or be answered from.
        // Saying so would be alarming and unactionable, so it is logged instead.
        console.error("[chat] clear deleted assistant state:", err);
      }

      setConversationsByContext(nextConversations);
      setAssistantEmbedModelByContext(nextEmbedModels);
      setPreferences(nextPreferences);
      setActiveConvIdxByContext((prev) => {
        if (!(assistantId in prev)) return prev;
        const next = { ...prev };
        delete next[assistantId];
        return next;
      });

      // Off the tab either way. On the partial failure the entry survives, so the
      // tab comes back when the parent re-reads the registry — but it is a tab
      // over an empty folder, and leaving the user looking at it is how they find
      // out by asking it a question.
      if (activeContextIdRef.current === assistantId) onActiveContextChange("self");
      // The modal closes on a clean delete and stays open on the partial one,
      // because it is the only thing on screen carrying the message that says
      // what happened and that deleting again finishes the job.
      if (!filesGoneButStillListed) setAssistantToDelete(null);
      setAssistantDeleteBusy(false);
      await onImportedAssistantsChanged();
    },
    [
      assistantDeleteBusy,
      storeHydrated,
      sessionUserId,
      conversationsByContext,
      assistantEmbedModelByContext,
      preferences,
      onActiveContextChange,
      onImportedAssistantsChanged,
    ],
  );

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const id = requestAnimationFrame(() => {
      scrollChatToBottom(isThinking || isStreaming ? "smooth" : "auto");
    });
    return () => cancelAnimationFrame(id);
  }, [messages, isThinking, isStreaming, scrollChatToBottom]);

  useLayoutEffect(() => {
    const snap = scrollExpandPreserveRef.current;
    if (snap) {
      const el = messagesScrollRef.current;
      if (el) {
        el.scrollTop = snap.scrollTop + (el.scrollHeight - snap.scrollHeight);
      }
      scrollExpandPreserveRef.current = null;
    }
  }, [visibleTailCount]);

  useLayoutEffect(() => {
    const root = messagesScrollRef.current;
    const sentinel = loadOlderSentinelRef.current;
    if (!root || !storeHydrated || !sentinel) return;

    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e?.isIntersecting) return;
        const len = messagesLengthRef.current;
        const el = messagesScrollRef.current;
        if (!el) return;
        setVisibleTailCount((c) => {
          if (c >= len) return c;
          scrollExpandPreserveRef.current = {
            scrollHeight: el.scrollHeight,
            scrollTop: el.scrollTop,
          };
          return Math.min(len, c + uiMessagePageSize);
        });
      },
      {
        root,
        rootMargin: `${LOAD_OLDER_ROOT_MARGIN_TOP_PX}px 0px 0px 0px`,
        threshold: 0,
      },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [storeHydrated, uiMessagePageSize, messages.length, visibleTailCount]);

  useEffect(() => {
    if (messages.length === 0) return;
    setVisibleTailCount((c) => Math.min(c, messages.length));
  }, [messages.length]);

  useLayoutEffect(() => {
    const scrollEl = messagesScrollRef.current;
    const inner = messagesInnerRef.current;
    if (!scrollEl || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      requestAnimationFrame(() => {
        const s = messagesScrollRef.current;
        if (s && stickToBottomRef.current) {
          s.scrollTop = s.scrollHeight;
        }
      });
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Timer piloté par micMode
  useEffect(() => {
    if (micMode === "recording") {
      setMicElapsed(0);
      startMicInterval();
    } else {
      clearMicTimer();
      if (micMode === "idle") setMicElapsed(0);
    }
    return () => { clearMicTimer(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micMode]);

  // Whisper : même clé scopée que Réglages (`u:<userId>:whisperModel`), pas la clé globale legacy.
  useEffect(() => {
    const refreshWhisperEnabled = async () => {
      try {
        const st = await load(SESSION_STORE_FILE);
        const wKey = sessionStoreKeyForUser(sessionUserId, "whisperModel");
        const model = await st.get<string | null>(wKey);
        setWhisperEnabled(typeof model === "string" && model !== "");
      } catch {
        /* ignore */
      }
    };
    void refreshWhisperEnabled();
    const p1 = listen("kts:whisper/not-installed", () =>
      setWhisperEnabled(false),
    );
    const p2 = listen("kts:whisper/download-done", () => {
      void refreshWhisperEnabled();
    });
    return () => {
      void Promise.all([p1, p2])
        .then((fns) => fns.forEach((f) => safeInvokeUnlisten(f)))
        .catch(() => {
          /* ignore subscription teardown race */
        });
    };
  }, [sessionUserId]);

  // Écoute le résultat de transcription et l'insère à la position curseur mémorisée
  useEffect(() => {
    const unsub = listen<string>("kts:tray-note/dictation-result", ({ payload }) => {
      setMicMode("idle");
      if (payload) {
        setInput((prev) => {
          const pos = micInsertPosRef.current ?? prev.length;
          const before = prev.slice(0, pos);
          const after = prev.slice(pos);
          // Ajoute un espace de séparation si nécessaire
          const sepBefore = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
          const sepAfter = after.length > 0 && !after.startsWith(" ") && !after.startsWith("\n") ? " " : "";
          return before + sepBefore + payload + sepAfter + after;
        });
      }
      micInsertPosRef.current = null;
    });
    return () => {
      void unsub
        .then((f) => safeInvokeUnlisten(f))
        .catch(() => {
          /* ignore subscription teardown race */
        });
    };
  }, []);

  useEffect(() => {
    if (focusNonce <= 0) return;
    stickToBottomRef.current = true;
    const t = window.setTimeout(() => {
      textareaRef.current?.focus();
      scrollChatToBottom("auto");
    }, 0);
    return () => window.clearTimeout(t);
  }, [focusNonce, scrollChatToBottom]);

  const pendingAssistantPrefsModalRef = useRef(false);

  useEffect(() => {
    if (!assistantPreferencesOpenNonce) return;
    if (premiumAssistantLocked) {
      pendingAssistantPrefsModalRef.current = false;
      return;
    }
    pendingAssistantPrefsModalRef.current = true;
  }, [assistantPreferencesOpenNonce, premiumAssistantLocked]);

  useEffect(() => {
    if (!pendingAssistantPrefsModalRef.current) return;
    const isDirectModel = isAssistantLocalQwenModel(assistantModel) || isAssistantDirectOpenAiModel(assistantModel);
    if (premiumAssistantLocked || (!isDirectModel && maxPreferenceChars == null)) return;
    pendingAssistantPrefsModalRef.current = false;
    setPrefsModalInitialTab("model");
    setShowPrefsModal(true);
  }, [maxPreferenceChars, premiumAssistantLocked, assistantPreferencesOpenNonce, assistantModel]);

  useEffect(() => {
    if (premiumAssistantLocked) {
      setMaxMessageChars(null);
      setMaxHistoryMessages(null);
      setMaxPreferenceChars(null);
      setLimitsError(null);
      return;
    }
    setMaxMessageChars(100000);
    setMaxHistoryMessages(200);
    setMaxPreferenceChars(10000);
    setLimitsError(null);
  }, [premiumAssistantLocked, assistantModel, focusNonce, chatResetNonce]);

  function appendSsePayload(payload: string, assistantMsgId: string) {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === assistantMsgId);
      if (idx === -1) return prev;
      const updated = { ...prev[idx], content: prev[idx].content + payload };
      return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
    });
  }

  const handleMicClick = async () => {
    if (premiumAssistantLocked) return;
    if (micMode === "idle") {
      // micInsertPosRef est déjà renseigné depuis onMouseDown
      try {
        setMicElapsed(0);
        setMicMode("recording");
        await invoke("start_tray_dictation_cmd");
      } catch (e) {
        console.error("[Chat] mic start:", e);
        setMicMode("idle");
      }
    } else if (micMode === "recording") {
      clearMicTimer();
      setMicMode("processing");
      try {
        await invoke("stop_dictation_cmd");
      } catch (e) {
        console.error("[Chat] mic stop:", e);
        setMicMode("idle");
      }
    }
  };

  async function sendMessage() {
    const text = input.trim();
    const isDirectModelForSend = isAssistantLocalQwenModel(assistantModel) || isAssistantDirectOpenAiModel(assistantModel);
    // Direct/local models have null limits (no server bootstrap needed); use generous defaults.
    const effectiveMaxChars = isDirectModelForSend ? (maxMessageChars ?? 50_000) : maxMessageChars;
    const effectiveMaxHistory = isDirectModelForSend ? (maxHistoryMessages ?? 20) : maxHistoryMessages;
    if (
      !text ||
      isStreaming ||
      effectiveMaxChars == null ||
      effectiveMaxHistory == null
    ) {
      return;
    }

    const hasOpenAiForSend = (openAiApiKey ?? "").trim().length > 0;
    const isPromptOnly = hasOpenAiForSend && isAssistantDirectOpenAiModel(assistantModel);
    const wasTruncated = text.length > effectiveMaxChars;
    const payloadText = wasTruncated ? text.slice(0, effectiveMaxChars) : text;

    if (wasTruncated) {
      setTruncateBanner(true);
      window.setTimeout(() => setTruncateBanner(false), 8000);
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: payloadText,
      ...(wasTruncated ? { truncated: true } : {}),
    };

    stickToBottomRef.current = true;
    const historyToSend = messages.slice(-effectiveMaxHistory);
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsThinking(true);
    setIsStreaming(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollChatToBottom("auto");
        textareaRef.current?.focus();
      });
    });

    const currentTab = contextTabs.find((t) => t.contextId === activeContextId);
    const targetOwnerId = currentTab?.aiAssistantUserId ?? sessionUserId;
    const activeConv = conversations[activeConvIdxRef.current];
    const applicablePrefsText = preferences
      .filter((p) => !p.disabled && (p.scope === "all" || (Array.isArray(p.scope) && p.scope.includes(activeContextId))))
      .map((p) => {
        const name = p.name.trim();
        const text = p.text.trim();
        return name ? `${name}\n\n${text}` : text;
      })
      .filter(Boolean)
      .join("\n\n");

    const bodyPayload: {
      message: string;
      history: { role: string; content: string }[];
      ai_assistant_user_id?: string;
      conversation_id?: string;
      user_preferences?: string;
      response_mode?: string;
      me_query_tag_source?: "conversation";
      me_segment_tag_ids?: string[] | null;
    } = {
      message: payloadText,
      history: historyToSend.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(applicablePrefsText ? { user_preferences: applicablePrefsText } : {}),
      ...(isPromptOnly ? { response_mode: "prompt_only" } : {}),
    };
    if (targetOwnerId !== sessionUserId) {
      bodyPayload.ai_assistant_user_id = targetOwnerId;
    }
    if (activeConv?.id != null) {
      bodyPayload.conversation_id = activeConv.id;
    }
    // Resolve effective KB source + tag filter, applying the saved default for new conversations.
    const _isConvDefault = activeConv?.selfQueryKbSource == null;
    const _savedDefault = savedDefaultTagFilter
      ? (savedDefaultTagFilter.kbSource === "cloud"
          ? { kbSource: "local" as const, tagIds: null }
          : savedDefaultTagFilter)
      : null;
    const _dataDefaultKbSource: "local" | "cloud" = "local";
    const kbSourceForSend: "local" | "cloud" =
      activeConv?.selfQueryKbSource ?? _savedDefault?.kbSource ?? _dataDefaultKbSource;
    const effectiveTagIdsForSend: string[] | null =
      _isConvDefault ? (_savedDefault?.tagIds ?? null) : (activeConv?.selfQueryTagIds ?? null);

    if (targetOwnerId === sessionUserId) {
      bodyPayload.me_query_tag_source = "conversation";
      bodyPayload.me_segment_tag_ids = effectiveTagIdsForSend;
    }

    // ── Local RAG path ─────────────────────────────────────────────────────────
    const useLocalRag = isDirectModelForSend && kbSourceForSend === "local";
    if (useLocalRag) {
      const ragMode = isAssistantLocalQwenModel(assistantModel) ? "local" : "api";
      // Read from the index this tab is for. Taken from the ref so it is the context
      // the user was on when they pressed send, matching the `sendTab` guard above.
      const sendAssistantId =
        activeContextIdRef.current === "self" ? null : activeContextIdRef.current;
      // Tag filtering is a "Me"-only control (the picker is hidden on every other tab),
      // and the ids in it belong to the profile's own tags. Applying them to an imported
      // index would filter on ids that are not in it and return nothing, with nothing
      // on screen to explain why.
      const tagFilter = sendAssistantId === null ? effectiveTagIdsForSend : null;
      // `null` means the read that resolves this index's model has not come back
      // yet and the user pressed send inside that window — which, right after an
      // import, is the most likely moment for them to press anything. Filled in
      // by waiting for that read below; declared out here so the failure path can
      // still report which model it got as far as.
      let embedModelForSend = resolvedAssistantEmbedModel;
      try {
        // Wait for it rather than guess. Sending with the profile's global model
        // would search this index for vectors it does not have: `vector_search`
        // filters on `WHERE embed_model = ?`, the match count drops to zero, and
        // the answer quietly degrades to keyword-only with nothing on screen to
        // say so. One extra local query is the cheaper mistake — and if that
        // query is what discovers the index will not open, the failure lands in
        // the catch below, where the user is told.
        if (embedModelForSend === null) {
          const list = await localCoverageByModel(sessionUserId, sendAssistantId);
          embedModelForSend = list.length > 0 ? list[0].embedModel : embedStatus?.activeModel ?? null;
        }
        const [hits, indexDiag] = await Promise.all([
          localSearch(sessionUserId, payloadText, ragMode, openAiApiKey, tagFilter,
            ragMode === "api" ? historyToSend.map((m) => ({ role: m.role, content: m.content })) : null,
            embedModelForSend, sendAssistantId),
          // Same index as the search: this feeds the panel opened when RAG comes back
          // empty, so it has to describe the database that was actually queried.
          localIndexDiag(sessionUserId, sendAssistantId).catch(() => undefined),
        ]);
        const context = await localPackContext(hits, ragMode);
        const systemContent = context.trim()
          ? `You are a helpful assistant. Use the following context retrieved from the user's local knowledge base to answer their questions. If the context doesn't contain relevant information, say so.\n\nYou may format your response using Markdown (headers, bold, lists, code blocks, etc.). When the context includes a media file path (prefixed with [media: file://...]), you may reference it as a Markdown image or link in your response — for example ![title](file:///path/to/image.jpg) for images or [title](file:///path/to/video.mp4) for videos.\n\nContext:\n${context}`
          : "You are a helpful assistant. You may format your response using Markdown.";
        const chatMessages = [
          { role: "system" as const, content: systemContent },
          ...historyToSend.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
          { role: "user" as const, content: payloadText },
        ];
        const assistantMsgId = crypto.randomUUID();
        const debugPrompt: DebugPrompt = {
          model: assistantModel ?? "",
          messages: chatMessages,
          ragHitCount: hits.length,
          // The model the search above actually used — not the global one, and not
          // the unresolved null it may have started from. This panel is what gets
          // opened when RAG comes back empty, so it has to name the real model.
          ragEmbedModel: embedModelForSend ?? ragMode,
          ragTagFilter: tagFilter,
          indexDiag,
        };
        setIsThinking(false);
        setMessages((prev) => [...prev, { id: assistantMsgId, role: "assistant" as const, content: "", debugPrompt }]);
        if (isAssistantDirectOpenAiModel(assistantModel)) {
          const usage = await streamFromOpenAI(
            (openAiApiKey ?? ""),
            assistantModel ?? "",
            chatMessages,
            (chunk) => appendSsePayload(chunk, assistantMsgId),
          );
          if (usage) {
            setMessages((prev) => prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, llmCost: { calls: 1, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, usd: null } }
                : m
            ));
          }
        } else {
          // Local Qwen: non-streaming, build a single prompt string
          const promptLines = chatMessages.map((m) => {
            if (m.role === "system") return `[System]\n${m.content}`;
            if (m.role === "user") return `User: ${m.content}`;
            return `Assistant: ${m.content}`;
          });
          const fullPrompt = promptLines.join("\n\n") + "\n\nAssistant:";
          const response = await invoke<string>("run_prompt_cmd", {
            modelSelection: assistantModel,
            prompt: fullPrompt,
            maxTokens: 1024,
            openaiApiKey: null,
          });
          setMessages((prev) => prev.map((m) =>
            m.id === assistantMsgId ? { ...m, content: response.trim() } : m
          ));
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const errDebugPrompt: DebugPrompt = {
          model: assistantModel ?? "",
          messages: [{ role: "system", content: "(error before prompt was built)" }],
          ragError: errMsg,
          ragEmbedModel: embedModelForSend ?? ragMode,
        };
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant" as const, content: `Error: ${errMsg}`, debugPrompt: errDebugPrompt },
        ]);
      } finally {
        setIsThinking(false);
        setIsStreaming(false);
      }
      return;
    }
    // ── End local RAG path ─────────────────────────────────────────────────────
    // Local mode: cloud assistant is not available.
    setIsThinking(false);
    setIsStreaming(false);
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content: "Cloud assistant is not available in local mode. Please configure an OpenAI API key or use a local model.",
      },
    ]);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      if (stickToBottomRef.current) {
        scrollChatToBottom("auto");
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  function startNewConversation() {
    const ctxId = activeContextId;
    const current = conversations[activeConvIdx];
    // Reuse current conversation if it has no messages yet
    if (!current || current.messages.length > 0) {
      const newIdx = (conversationsByContext[ctxId] ?? []).length;
      setConversationsByContext((prev) => ({
        ...prev,
        [ctxId]: [...(prev[ctxId] ?? []), newConversationEntry()],
      }));
      setActiveConvIdxByContext((prev) => ({ ...prev, [ctxId]: newIdx }));
    }
  }

  function performDeleteConversation(idx: number) {
    const ctxId = activeContextId;
    const ctxConvs = conversationsByContext[ctxId] ?? [];
    const next = ctxConvs.filter((_, i) => i !== idx);
    setConversationsByContext((prev) => ({ ...prev, [ctxId]: next }));
    const currentActive = activeConvIdxByContext[ctxId] ?? 0;
    let newActive = currentActive;
    if (idx < currentActive) {
      newActive = currentActive - 1;
    } else if (idx === currentActive) {
      newActive = Math.max(0, Math.min(currentActive, next.length - 1));
    }
    setActiveConvIdxByContext((prev) => ({ ...prev, [ctxId]: newActive }));
  }

  function renameConversation(idx: number, newName: string) {
    const ctxId = activeContextId;
    setConversationsByContext((prev) => {
      const ctxConvs = prev[ctxId] ?? [];
      if (idx >= ctxConvs.length) return prev;
      const next = [...ctxConvs];
      next[idx] = { ...next[idx], name: newName, manualName: true };
      return { ...prev, [ctxId]: next };
    });
  }

  function handleDeleteConversation(idx: number) {
    const conv = conversations[idx];
    if (!conv || conv.messages.length === 0) {
      performDeleteConversation(idx);
      return;
    }
    setDeleteConfirm({ idx, name: conv.name });
  }

  function handleDownloadConversations() {
    const data = conversations.map((conv) => ({
      id: conv.id,
      name: conv.name,
      messages: conv.messages.map((msg) => ({
        role: msg.role,
        content:
          msg.role === "assistant"
            ? displayAssistantAnswerForUser(msg.content)
            : msg.content,
      })),
    }));
    const json = JSON.stringify(data, null, 2);
    const activeTab = contextTabs.find((t) => t.contextId === activeContextId);
    const rawLabel = activeTab?.label ?? "conversations";
    const safeLabel = rawLabel.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "conversations";
    const date = new Date().toISOString().split("T")[0];
    const filename = `conversations-${safeLabel}-${date}.json`;
    void invoke<string>("export_recordings_context_json_cmd", { content: json, filename }).catch(
      (err) => console.error("Download conversations failed:", err)
    );
  }

  const uiShownCount = Math.min(visibleTailCount, messages.length);
  const uiRenderStart = Math.max(0, messages.length - uiShownCount);
  const uiRenderedMessages = messages.slice(uiRenderStart);

  const hasOpenAiKey = (openAiApiKey ?? "").trim().length > 0;

  const assistantModelPickerOptions = useMemo((): SettingsModelPickerOption[] => {
    const rec = () => " ★";
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
        label: `${m.label}${m.recommended ? rec() : ""}${!hasOpenAiKey ? " — add API key" : ""}`,
        disabled: !hasOpenAiKey,
        kind: "openai",
      });
    }
    return opts;
  }, [hasOpenAiKey, qwenStatus?.models]);

  /** User turned the assistant off in Settings. */
  const assistantExplicitlyDisabled =
    !premiumAssistantLocked && (assistantModel ?? "") === ASSISTANT_MODEL_DISABLED;

  const assistantRouteBlocked = assistantExplicitlyDisabled;

  // Users with a direct model (local Qwen or OpenAI key) don't need server limits.
  const usesDirectModel =
    isAssistantLocalQwenModel(assistantModel) || isAssistantDirectOpenAiModel(assistantModel);

  // Missing-config blockers — apply to all users.
  const noAssistantModel = !assistantModel || assistantModel === ASSISTANT_MODEL_DISABLED;
  const noEmbedModel = !embedStatus?.activeModel;
  const notConfiguredBlocked = noAssistantModel || noEmbedModel;

  // No-content blocker: model configured but nothing indexed locally.
  // `_localIndexStats` counts the profile's own captures only — nothing measures an
  // imported index here — so this check can only speak for the "Me" tab. Left global,
  // a user whose own index is empty would find the composer disabled on the assistant
  // they had just imported, which is exactly the index that does have content.
  const localCaptureCount = _localIndexStats?.totalCaptures ?? null;
  const noLocalCaptures = localCaptureCount !== null && localCaptureCount === 0;
  const noCapturesBlocked =
    activeAssistantId === null && !notConfiguredBlocked && noLocalCaptures;

  const composerDisabled =
    premiumAssistantLocked ||
    notConfiguredBlocked ||
    noCapturesBlocked ||
    assistantRouteBlocked ||
    (!usesDirectModel && (maxMessageChars == null || maxHistoryMessages == null));
  const sendDisabled = composerDisabled || isStreaming || !input.trim();

  const assistantRouteBlockedPlaceholder = assistantExplicitlyDisabled
    ? "AI Assistant is off - choose a model under Settings → Assistant…"
    : !hasOpenAiKey
      ? "Add an OpenAI API key in Settings (LLM API key)…"
      : (assistantModel ?? "") === ASSISTANT_MODEL_DISABLED
        ? "AI Assistant is off - enable it under Settings → Assistant…"
        : "Choose a GPT model under Settings → Assistant…";

  return (
    <div
      ref={chatRootRef}
      className={`chat-root${effectiveComposerHeightPx != null ? " chat-root--composer-sized" : ""}`}
      style={
        effectiveComposerHeightPx != null
          ? ({
              "--chat-composer-height": `${effectiveComposerHeightPx}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      {deleteConfirm !== null && (
        <DeleteConversationModal
          conversationName={deleteConfirm.name}
          onConfirm={() => {
            performDeleteConversation(deleteConfirm.idx);
            setDeleteConfirm(null);
          }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
      {showImportModal && (
        <ImportAssistantModal
          userId={sessionUserId}
          onClose={() => setShowImportModal(false)}
          onImported={(assistantId) => onImportedAssistantsChanged(assistantId)}
        />
      )}
      {assistantToDelete !== null && (
        <div className="modal-overlay" onClick={assistantDeleteBusy ? undefined : () => setAssistantToDelete(null)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="Delete shared knowledge"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="modal-title">Delete “{assistantToDelete.label}”?</h3>
            <p className="modal-body">
              This removes its captures, its files and every chat you have had with it from your
              computer. It cannot be undone — you would need the original link or file to get it
              back.
            </p>
            {assistantDeleteErr ? (
              <p className="delete-assistant-modal__err" role="alert">
                {assistantDeleteErr}
              </p>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn modal-btn--cancel"
                onClick={() => setAssistantToDelete(null)}
                disabled={assistantDeleteBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn modal-btn--delete"
                onClick={() => void performDeleteAssistant(assistantToDelete.contextId)}
                disabled={assistantDeleteBusy}
              >
                {assistantDeleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showPrefsModal && (
        <PreferencesModal
          preferences={preferences}
          contextTabs={contextTabs}
          maxPrefsChars={maxPreferenceChars ?? 4000}
          initialTab={prefsModalInitialTab}
          onSave={(updated) => {
            setPreferences(updated);
            setShowPrefsModal(false);
          }}
          assistantModel={assistantModel ?? ASSISTANT_MODEL_DISABLED}
          assistantModelPickerOptions={assistantModelPickerOptions}
          onAssistantModelChange={onAssistantModelChange ?? (() => {})}
        />
      )}
      <div className="chat-tab-row">
        {contextTabs.length > 0 ? (
          <div className="chat-context-tabs">
            <div role="tablist" aria-label="Assistant context" className="chat-context-tablist">
              {contextTabs.map((tab) => {
                const active = activeContextId === tab.contextId;
                // Every tab but "Me" is knowledge imported from someone else, so
                // every tab but "Me" can be removed. "Me" is the profile's own
                // index and has no remove of any kind.
                const removable = tab.contextId !== "self";
                return (
                  <span
                    key={tab.contextId}
                    // Presentational so the tabs stay the tablist's own children
                    // for assistive tech, the way `display: contents` keeps them
                    // its children for layout.
                    role="presentation"
                    className="chat-context-tab-wrap"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`chat-context-tab${active ? " chat-context-tab--active" : ""}${removable ? " chat-context-tab--removable" : ""}`}
                      onClick={() => onActiveContextChange(tab.contextId)}
                    >
                      {tab.label}
                    </button>
                    {removable ? (
                      <button
                        type="button"
                        className="chat-context-tab-remove"
                        title={`Delete ${tab.label}`}
                        aria-label={`Delete ${tab.label}`}
                        onClick={() => {
                          setAssistantDeleteErr(null);
                          setAssistantToDelete({ contextId: tab.contextId, label: tab.label });
                        }}
                      >
                        <IconX />
                      </button>
                    ) : null}
                  </span>
                );
              })}
            </div>
            <button
              type="button"
              className="chat-context-add"
              title="Add knowledge someone shared with you"
              aria-label="Add knowledge someone shared with you"
              onClick={() => setShowImportModal(true)}
            >
              +
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className={`chat-prefs-btn${preferences.length > 0 ? " chat-prefs-btn--active" : ""}`}
          onClick={() => { setPrefsModalInitialTab("model"); setShowPrefsModal(true); }}
          disabled={!usesDirectModel && maxPreferenceChars === null}
          title={
            !usesDirectModel && maxPreferenceChars === null
              ? "Loading…"
              : "Chat preferences: prompt context and assistant sharing"
          }
          aria-label="Chat preferences: prompt context and assistant sharing"
        >
          <IconSliders />
          {preferences.length > 0 && (
            <span className="chat-prefs-btn-badge">{preferences.length}</span>
          )}
        </button>
      </div>
      {/* Directly under the tab strip, because the tab strip is what is wrong
          with the screen: the tabs this user expects are missing from it. */}
      {contextTabsError ? (
        <div className="chat-light-locked-banner" role="alert">
          <p className="chat-light-locked-banner__msg">{contextTabsError}</p>
        </div>
      ) : null}
      {/* The other way this screen can be wrong: the tab is there, and the
          knowledge behind it will not open. Said here rather than left to the
          coverage banner, which renders nothing when it has no coverage to
          describe, and rather than left to the reply — the send path that
          surfaces this needs a local or OpenAI model, so the user least likely
          to have one is the user who would otherwise never be told. */}
      {indexError ? (
        <div className="chat-light-locked-banner" role="alert">
          <p className="chat-light-locked-banner__msg">{indexError}</p>
        </div>
      ) : null}
      <div className="chat-with-sidebar">
        <ConversationSidebar
          conversations={conversations}
          activeIdx={activeConvIdx}
          onSelect={(idx) =>
            setActiveConvIdxByContext((prev) => ({ ...prev, [activeContextId]: idx }))
          }
          onNew={startNewConversation}
          onDelete={handleDeleteConversation}
          onRename={renameConversation}
          onDownload={handleDownloadConversations}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
        />
        <div className="chat-main">
      <AssistantCoverageBanner
        userId={sessionUserId}
        assistantId={activeAssistantId}
        embedModel={resolvedAssistantEmbedModel ?? ""}
        // An empty `embedModel` has two causes and only one of them is "there is
        // no model". Without this the other one — we have not finished asking —
        // would render as "No embedding model is set up yet", pointing a user at
        // Settings to fix something that is already fine, for as long as a local
        // query takes.
        modelUnresolved={resolvedAssistantEmbedModel === null}
        coverage={assistantModelCoverage}
        allCoverage={assistantAllModelCoverage}
        availableModels={embedStatus?.models ?? null}
        openAiApiKey={openAiApiKey}
        onModelChange={handleAssistantEmbedModelChange}
        onCoverageRefresh={handleCoverageRefresh}
        onGoToSettings={onGoToSettings}
      />
      <div
        ref={messagesScrollRef}
        className="chat-messages"
        onScroll={handleMessagesScroll}
      >
        <div ref={messagesInnerRef} className="chat-messages-inner">
          {messages.length === 0 && (
            <p className="chat-empty">
              Hello! Send a message to get started.
            </p>
          )}
          {messages.length > 0 && uiRenderStart > 0 ? (
            <div
              ref={loadOlderSentinelRef}
              className="chat-load-older-sentinel"
              aria-hidden
            />
          ) : null}
          {uiRenderedMessages.map((msg) => {
            return (
              <div key={msg.id} className={`chat-row chat-row--${msg.role}`}>
                {msg.role === "user" ? (
                  <UserMessageBubble
                    content={msg.content}
                    truncated={msg.truncated === true}
                  />
                ) : (
                  <AssistantMessageBlock
                    content={msg.content}
                    llmCost={msg.llmCost}
                    isSuperAdmin={isSuperAdmin}
                    debugPrompt={msg.debugPrompt}
                  />
                )}
              </div>
            );
          })}
          {isThinking && (
            <div className="chat-row chat-row--assistant">
              <div className="chat-bubble chat-bubble--assistant chat-bubble--thinking">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        className={`chat-composer-resize-handle${premiumAssistantLocked ? " chat-composer-resize-handle--disabled" : ""}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer (double-click: auto height)"
        aria-disabled={premiumAssistantLocked}
        onMouseDown={
          premiumAssistantLocked ? undefined : onComposerResizePointerDown
        }
        onDoubleClick={
          premiumAssistantLocked
            ? undefined
            : (ev) => {
                ev.preventDefault();
                setComposerHeightPx(null);
              }
        }
      />

      <div ref={composerPaneRef} className="chat-composer-pane">
        {notConfiguredBlocked && !premiumAssistantLocked ? (
          <div className="chat-light-locked-banner" role="alert">
            <p className="chat-light-locked-banner__msg">
              {noAssistantModel && noEmbedModel
                ? "Set up an AI assistant model and a capture indexing model in Settings to start chatting."
                : noAssistantModel
                  ? "No AI assistant model selected. Go to Settings → AI assistant and pick a local Qwen model or add an OpenAI API key."
                  : "No capture indexing model configured. Go to Settings → Capture indexing, download an embedding model and select it."}
            </p>
            {onGoToSettings && (
              <div className="chat-light-locked-banner__actions">
                {noAssistantModel && (
                  <button
                    type="button"
                    className="chat-light-locked-banner__btn chat-light-locked-banner__btn--primary"
                    onClick={() => onGoToSettings("settings-ai-tasks")}
                  >
                    AI assistant
                  </button>
                )}
                {noEmbedModel && (
                  <button
                    type="button"
                    className="chat-light-locked-banner__btn chat-light-locked-banner__btn--primary"
                    onClick={() => onGoToSettings("capture-indexing-model-row")}
                  >
                    Capture indexing
                  </button>
                )}
              </div>
            )}
          </div>
        ) : null}

        {noCapturesBlocked ? (
          <div className="chat-light-locked-banner" role="alert">
            <p className="chat-light-locked-banner__msg">
              Nothing indexed locally yet. Take a capture in the Captures tab — it is indexed automatically — then come back here to start chatting.
            </p>
          </div>
        ) : null}

        {!assistantRouteBlocked && limitsError ? (
          <p className="chat-limits-error" role="alert">
            {limitsError}
          </p>
        ) : null}
        {truncateBanner ? (
          <p className="chat-truncate-banner" role="status">
            Your message was truncated.
          </p>
        ) : null}
        <div
          className={`chat-input-bar${composerDisabled ? " chat-input-bar--locked" : ""}`}
        >
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              premiumAssistantLocked
                ? "Premium account required to send messages…"
                : notConfiguredBlocked
                  ? noAssistantModel && noEmbedModel
                    ? "Configure an AI assistant model and a capture indexing model in Settings…"
                    : noAssistantModel
                      ? "Select an AI assistant model in Settings → AI assistant…"
                      : "Download and select an embedding model in Settings → Capture indexing…"
                  : assistantRouteBlocked
                    ? assistantRouteBlockedPlaceholder
                    : "Send a message… (Enter to send, Shift+Enter for new line)"
            }
            disabled={composerDisabled}
            rows={1}
          />
          {activeContextId === "self" && (
            <>
              <button
                ref={tagBtnRef}
                type="button"
                className="chat-mic-btn"
                style={{
                  alignSelf: "flex-end",
                  ...(Array.isArray(effectiveTagIds)
                    ? {
                        color: "var(--accent, #6366f1)",
                        borderColor: "var(--accent, #6366f1)",
                        background: "color-mix(in srgb, var(--accent, #6366f1) 12%, transparent)",
                      }
                    : {}),
                }}
                onClick={() => {
                  const rect = tagBtnRef.current?.getBoundingClientRect();
                  if (rect) {
                    setTagPopoverAnchor({
                      bottom: window.innerHeight - rect.top + 6,
                      right: window.innerWidth - rect.right,
                    });
                  }
                  setTagPopoverOpen((o) => !o);
                }}
                aria-label="Knowledge base and tag filter"
                title="Knowledge base and tag filter"
              >
                {(() => {
                  const src = selfQueryKbSourceForComposer ?? _resolvedDefault?.kbSource ?? "local";
                  return src === "cloud" ? <IconKbCloud /> : <IconKbLocal />;
                })()}
              </button>
              {tagPopoverOpen && tagPopoverAnchor && createPortal(
                (() => {
                  const localTags = localTagIds !== null
                    ? captureTags.filter((t) => localTagIds.includes(t.id))
                    : null; // null = still loading

                  const chipStyle = (active: boolean, color?: string): React.CSSProperties => ({
                    fontSize: 11, padding: "3px 9px", borderRadius: 99,
                    border: `1px solid ${active ? (color ?? "var(--accent, #6366f1)") : "var(--color-border, rgba(0,0,0,0.15))"}`,
                    background: active ? (color ?? "var(--accent, #6366f1)") : "transparent",
                    color: active ? "#fff" : "inherit",
                    cursor: "pointer",
                    fontWeight: active ? 600 : 400,
                  });

                  const effectiveKbSource: "local" | "cloud" =
                    selfQueryKbSourceForComposer ?? _resolvedDefault?.kbSource ?? "local";

                  const toggleLocalTag = (id: string) => {
                    const cur = effectiveKbSource === "local" && Array.isArray(effectiveTagIds) ? effectiveTagIds : [];
                    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
                    updateActiveTagFilter(next.length === 0 ? null : next, "local");
                  };

                  const sectionLabelStyle: React.CSSProperties = {
                    fontSize: 10, fontWeight: 700, opacity: 0.45,
                    textTransform: "uppercase", letterSpacing: "0.06em",
                    margin: "4px 0 2px",
                  };

                  const renderTagChips = (tags: typeof localTags, onToggle: (id: string) => void, thisSource: "local" | "cloud") => {
                    if (tags === null) return <span style={{ fontSize: 11, opacity: 0.5 }}>Loading…</span>;
                    if (tags.length === 0) return null;
                    return tags.map((t) => {
                      const active = effectiveKbSource === thisSource && Array.isArray(effectiveTagIds) && effectiveTagIds.includes(t.id);
                      return <button key={t.id} type="button" onClick={() => onToggle(t.id)} style={chipStyle(active, t.color)}>{t.name}</button>;
                    });
                  };

                  // Default toggle
                  const tagIdsEqual = (a: string[] | null, b: string[] | null) => {
                    if (a === null && b === null) return true;
                    if (a === null || b === null) return false;
                    if (a.length !== b.length) return false;
                    const sa = [...a].sort(), sb = [...b].sort();
                    return sa.every((v, i) => v === sb[i]);
                  };
                  const isCurrentDefault = savedDefaultTagFilter !== null
                    && savedDefaultTagFilter.kbSource === effectiveKbSource
                    && tagIdsEqual(savedDefaultTagFilter.tagIds, effectiveTagIds);
                  const toggleSetDefault = () => {
                    if (isCurrentDefault) {
                      setSavedDefaultTagFilter(null);
                    } else {
                      setSavedDefaultTagFilter({ kbSource: effectiveKbSource, tagIds: effectiveTagIds });
                    }
                  };

                  return (
                    <div
                      ref={tagPopoverRef}
                      style={{
                        position: "fixed",
                        bottom: tagPopoverAnchor.bottom,
                        right: tagPopoverAnchor.right,
                        background: "var(--color-surface, #fff)",
                        border: "1px solid var(--color-border, rgba(0,0,0,0.12))",
                        borderRadius: 10, padding: "10px 14px",
                        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
                        display: "flex", flexDirection: "column", gap: 6,
                        minWidth: 200, maxWidth: 300, zIndex: 9999,
                      }}
                    >
                      <p style={{ margin: "0 0 2px", fontSize: 11, opacity: 0.6, fontStyle: "italic" }}>
                        Select one knowledge base to query. Only one section can be active at a time.
                      </p>

                      {/* ── Local section ──────────────────────────────── */}
                      <p style={sectionLabelStyle}>Local index{_localIndexStats ? ` — ${_localIndexStats.totalCaptures} capture${_localIndexStats.totalCaptures === 1 ? "" : "s"}` : ""}</p>
                      {!embedStatus?.activeModel ? (
                        <p style={{ margin: 0, fontSize: 11, opacity: 0.5 }}>
                          No embed model configured. Set one under Settings → Models by task.
                        </p>
                      ) : (_localIndexStats?.totalCaptures ?? 0) === 0 ? (
                        <p style={{ margin: 0, fontSize: 11, opacity: 0.5 }}>
                          Nothing indexed locally yet. Take a capture in the Captures tab — it is indexed automatically.
                        </p>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          <button
                            type="button"
                            onClick={() => updateActiveTagFilter(null, "local")}
                            style={chipStyle(effectiveKbSource === "local" && effectiveTagIds === null)}
                          >All</button>
                          <button
                            type="button"
                            onClick={() => toggleLocalTag(UNTAGGED_SEGMENT_TAG_ID)}
                            style={chipStyle(effectiveKbSource === "local" && Array.isArray(effectiveTagIds) && effectiveTagIds.includes(UNTAGGED_SEGMENT_TAG_ID), "#94a3b8")}
                          >Untagged</button>
                          {renderTagChips(localTags, toggleLocalTag, "local")}
                        </div>
                      )}

                      {/* ── Set default toggle ─────────────────────────── */}
                      <div style={{ borderTop: "1px solid var(--color-border, rgba(0,0,0,0.08))", paddingTop: 8, marginTop: 2, display: "flex", alignItems: "center", gap: 7 }}>
                        <input
                          type="checkbox"
                          id="kb-set-default"
                          checked={isCurrentDefault}
                          onChange={toggleSetDefault}
                          style={{ cursor: "pointer", margin: 0 }}
                        />
                        <label htmlFor="kb-set-default" style={{ fontSize: 11, cursor: "pointer", userSelect: "none", margin: 0 }}>
                          Set as default for new conversations
                        </label>
                      </div>
                    </div>
                  );
                })(),
                document.body
              )}
            </>
          )}
          {whisperEnabled && (
            <button
              type="button"
              className={`chat-mic-btn${micMode === "recording" ? " chat-mic-btn--recording" : ""}${micMode === "processing" ? " chat-mic-btn--processing" : ""}${premiumAssistantLocked ? " chat-mic-btn--locked" : ""}`}
              onMouseDown={() => {
                if (premiumAssistantLocked) return;
                // Capturer la position curseur avant que le click fasse perdre le focus au textarea
                micInsertPosRef.current = textareaRef.current?.selectionStart ?? null;
              }}
              onClick={() => void handleMicClick()}
              disabled={premiumAssistantLocked || micMode === "processing"}
              aria-label={
                premiumAssistantLocked
                  ? "Voice input (premium only)"
                  : micMode === "recording"
                    ? "Stop recording"
                    : "Start voice input"
              }
              title={
                premiumAssistantLocked
                  ? "Voice input requires a premium account"
                  : micMode === "recording"
                    ? "Stop recording"
                    : "Dictate into message"
              }
            >
              {micMode === "recording" ? (
                <IconMicRecording />
              ) : (
                <IconMic />
              )}
              {micMode === "recording" && (
                <span className="chat-mic-elapsed">{fmtMicTime(micElapsed)}</span>
              )}
              {micMode === "processing" && (
                <span className="chat-mic-elapsed">…</span>
              )}
            </button>
          )}
          <button
            className="chat-send"
            onClick={() => void sendMessage()}
            disabled={sendDisabled}
            aria-label="Send"
          >
            ↑
          </button>
        </div>
      </div>
        </div>{/* end chat-main */}
      </div>{/* end chat-with-sidebar */}
    </div>
  );
}
