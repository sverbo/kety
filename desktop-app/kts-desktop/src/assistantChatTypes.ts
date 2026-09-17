import {
  ASSISTANT_CHAT_LEGACY_KEY,
} from "./sessionStoreUser";
import type { IndexDiag } from "./localIndex";

export const UNTAGGED_SEGMENT_TAG_ID = "00000000-0000-0000-0000-000000000000";

export function safeInvokeUnlisten(unlisten: (() => void) | undefined | null): void {
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
        console.warn("assistant unlisten failed:", err);
      });
    }
  } catch (err) {
    if (isKnownListenerRaceError(err)) return;
    console.warn("assistant unlisten failed:", err);
  }
}

export const CHAT_GENERIC_SUPPORT_ERROR =
  "An unexpected error occurred. Please contact support.";

/** @deprecated clé legacy non scopée ; préférer `sessionStoreKeyForUser` + `ASSISTANT_CHAT_LEGACY_KEY` */
export const ASSISTANT_CHAT_STORE_KEY = ASSISTANT_CHAT_LEGACY_KEY;

/**
 * Taille de « page » côté UI et GCS :
 * - Affichage : par défaut seuls les N derniers messages sont rendus ; en scrollant vers le haut,
 *   on ajoute N messages plus anciens à chaque fois (historique complet reste en mémoire / API).
 * - GCS : sign automatique pour les N derniers messages ; au-delà, bouton « Charger ».
 * Surcharge : `VITE_CHAT_GCS_AUTO_SIGN_LAST_MESSAGES` (entier ≥ 0 ; 0 = tout en manuel côté GCS,
 * affichage initial 0 messages visibles puis expansion au scroll - éviter si possible).
 */
export const CHAT_GCS_AUTO_SIGN_LAST_MESSAGES = (() => {
  const raw = import.meta.env.VITE_CHAT_GCS_AUTO_SIGN_LAST_MESSAGES as
    | string
    | undefined;
  const n =
    raw != null && String(raw).trim() !== ""
      ? Number(raw)
      : 50;
  if (!Number.isFinite(n) || n < 0) return 50;
  return Math.floor(n);
})();

export type DebugPrompt = {
  model: string;
  messages: { role: string; content: string }[];
  ragHitCount?: number;
  ragEmbedModel?: string;
  ragTagFilter?: string[] | null;
  ragError?: string;
  indexDiag?: IndexDiag;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant-only: super-admin LLM cost details emitted at end of stream. */
  llmCost?: Record<string, unknown>;
  /** Present only for user messages that were truncated before send. */
  truncated?: boolean;
  /** Super-admin only: exact prompt sent to the model (local RAG / direct calls). */
  debugPrompt?: DebugPrompt;
};

export function parseAssistantLlmCost(raw: unknown): Record<string, unknown> | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (obj.summary != null && typeof obj.summary === "object" && !Array.isArray(obj.summary)) {
    out.summary = obj.summary;
  }
  if (Array.isArray(obj.calls)) {
    out.calls = obj.calls.filter(
      (entry): entry is Record<string, unknown> =>
        entry != null && typeof entry === "object" && !Array.isArray(entry),
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseStoredMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const row of raw) {
    if (row == null || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    if (
      typeof o.id !== "string" ||
      (o.role !== "user" && o.role !== "assistant") ||
      typeof o.content !== "string"
    ) {
      continue;
    }
    const truncated = o.truncated === true;
    const llmCost = o.role === "assistant" ? parseAssistantLlmCost(o.llmCost) : undefined;
    out.push({
      id: o.id,
      role: o.role,
      content: o.content,
      ...(llmCost ? { llmCost } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
  }
  return out;
}

export type ConversationEntry = {
  /**
   * Stable client-generated UUID, set at creation and never changed.
   * Used as React key and local identifier regardless of backend state.
   */
  clientId: string;
  /** Backend-assigned UUID. null until the first message is sent. */
  id: string | null;
  name: string;
  /**
   * True when the user explicitly typed a name. When set, the backend-generated
   * name from the SSE meta event is discarded in favour of this one.
   */
  manualName?: true;
  messages: ChatMessage[];
  /**
   * "Me" assistant only: inclusive OR tag filter for retrieval on this conversation.
   * null/undefined = all tags (same default as querying a shared assistant).
   */
  selfQueryTagIds?: string[] | null;
  /** Which KB section the tag filter targets. null = no filter (ALL). */
  selfQueryKbSource?: "local" | "cloud" | null;
};

export type ChatPreference = {
  id: string;
  name: string;
  text: string;
  /** "all" = every assistant context; string[] = specific contextIds from the current tabs. */
  scope: "all" | string[];
  disabled: boolean;
};

export function parseStoredPreferences(raw: unknown): ChatPreference[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatPreference[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.text !== "string") continue;
    let scope: "all" | string[];
    if (o.scope === "all") {
      scope = "all";
    } else if (Array.isArray(o.scope)) {
      // An empty list stays an empty list. It used to be promoted to "all", and
      // that promotion is a silent escalation: a scope of `[]` applies to nothing
      // while the app is running, so a preference written about one person's
      // shared knowledge sits there harmless until the next restart, at which
      // point this line would widen it to *every* conversation — the user's own
      // chats and every assistant they have imported — with nothing said and
      // nothing shown. "Applies to nobody" is the safe reading of an empty list
      // and the only one that matches what the running app already does; a
      // missing `scope` field is the case that legitimately means "all", and it
      // is handled below.
      scope = (o.scope as unknown[]).filter((s): s is string => typeof s === "string");
    } else if (typeof o.scope === "string" && o.scope !== "") {
      scope = [o.scope]; // legacy single-string migration
    } else {
      scope = "all";
    }
    out.push({
      id: o.id,
      name: typeof o.name === "string" && o.name.length > 0 ? o.name : "Preference",
      text: o.text,
      scope,
      disabled: o.disabled === true,
    });
  }
  return out;
}

export function parseStoredConversations(raw: unknown): ConversationEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ConversationEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    let selfQueryTagIds: string[] | null | undefined;
    if (o.selfQueryTagIds === null) {
      selfQueryTagIds = null;
    } else if (Array.isArray(o.selfQueryTagIds)) {
      const ids = (o.selfQueryTagIds as unknown[]).filter((x): x is string => typeof x === "string");
      selfQueryTagIds = ids.length > 0 ? ids : null;
    }
    const selfQueryKbSource =
      o.selfQueryKbSource === "local" || o.selfQueryKbSource === "cloud" ? o.selfQueryKbSource : null;
    out.push({
      clientId: typeof o.clientId === "string" ? o.clientId : crypto.randomUUID(),
      id: typeof o.id === "string" ? o.id : null,
      name: typeof o.name === "string" && o.name.length > 0 ? o.name : "Untitled",
      ...(o.manualName === true ? { manualName: true as const } : {}),
      messages: parseStoredMessages(o.messages),
      ...(selfQueryTagIds !== undefined ? { selfQueryTagIds } : {}),
      selfQueryKbSource,
    });
  }
  return out;
}

export function newConversationEntry(): ConversationEntry {
  return {
    clientId: crypto.randomUUID(),
    id: null,
    name: "Untitled",
    messages: [],
    selfQueryTagIds: null,
    selfQueryKbSource: null,
  };
}

export type OpenAIUsage = { prompt_tokens: number; completion_tokens: number };

export type AssistantChatContextTab = {
  contextId: string;
  label: string;
  aiAssistantUserId: string;
};
