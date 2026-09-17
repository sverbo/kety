/**
 * Préfixe les clés du session store par utilisateur Supabase pour isoler
 * chat assistant, partages et sync Historique (dumps) entre comptes sur la même machine.
 *
 * Legacy : clés sans préfixe → au login, si la clé scopée n’existe pas encore,
 * copie vers `u:<userId>:<clé>` puis suppression de la clé globale.
 */

import type { Store } from "@tauri-apps/plugin-store";

export const SESSION_STORE_FILE = "kts/kts-session-store.json";

/** Bump this when the store layout changes incompatibly. Old stores get wiped. */
const STORE_SCHEMA_VERSION = 2;

/**
 * If the persisted schema version doesn't match, wipe the entire store so
 * stale global keys (pre-userId era) don't accumulate.
 */
export async function clearStoreIfOutdated(store: Store): Promise<void> {
  const v = await store.get<number>("_storeSchemaV");
  if (v === STORE_SCHEMA_VERSION) return;
  await store.clear();
  await store.set("_storeSchemaV", STORE_SCHEMA_VERSION);
  await store.save();
}

/** Legacy single transcript (migré vers `assistantChatMessagesByContext`). */
export const ASSISTANT_CHAT_LEGACY_KEY = "assistantChatMessages";

/** `Record<contextId, ChatMessage[]>` - contextId est `self` ou UUID propriétaire. */
export const ASSISTANT_CHAT_BY_CONTEXT_KEY = "assistantChatMessagesByContext";

export const ASSISTANT_CHAT_LAST_CONTEXT_KEY = "assistantChatLastContextId";

/** `ConversationEntry[]` - liste des conversations de l'assistant avec leurs messages. */
export const ASSISTANT_CONVERSATIONS_KEY = "assistantConversations";

export const ASSISTANT_SHARE_SELECTED_KEY = "assistantShareSelectedOwnerIds";

export const ASSISTANT_SHARE_PSEUDOS_KEY = "assistantSharePseudos";

/** Sync état des dumps côté onglet Historique. */

/** `ChatPreference[]` - user prompt preferences for the AI assistant. */
export const ASSISTANT_PREFERENCES_KEY = "assistantChatPreferences";

/** `AssistantKbSettings` - which knowledge base + generation model the assistant uses. */
export const ASSISTANT_KB_SETTINGS_KEY = "assistantKbSettings";

/** `{ kbSource, tagIds }` - default KB source + tag filter applied to new conversations. */
export const ASSISTANT_DEFAULT_TAG_FILTER_KEY = "assistantDefaultTagFilter";

/** `Record<contextId, string>` - embedding model each assistant context searches with. */
export const ASSISTANT_EMBED_MODEL_KEY = "assistantEmbedModel";

/**
 * `ImportedAssistant[]` - the knowledge indexes this profile has imported from
 * someone else. This list is the only thing that *names* them: the files live
 * under `local-index/{userId}/assistants/{assistantId}/`, and an entry lost here
 * is an index the app neither opens nor offers, which is why
 * `importedAssistants.ts` writes it before it is trusted, removes the files
 * before it removes the entry, and refuses to write over a stored value it could
 * not read. The one way back is `listOrphanImportedAssistants`, which walks that
 * folder and reports what this list does not account for.
 *
 * Versioned in the name (`V1`) because the shape is persisted: a later change
 * can move to `V2` and leave old installations' data readable rather than
 * silently mis-parsed.
 */
export const IMPORTED_ASSISTANTS_KEY = "importedAssistantsV1";

/** Segment-level state per server dump id (tag edits, soft-deletes). */

const LEGACY_GLOBAL_KEYS_TO_SCOPE = [
  ASSISTANT_CHAT_BY_CONTEXT_KEY,
  ASSISTANT_CHAT_LEGACY_KEY,
  ASSISTANT_CHAT_LAST_CONTEXT_KEY,
  ASSISTANT_SHARE_SELECTED_KEY,
  ASSISTANT_SHARE_PSEUDOS_KEY,
] as const;

export function sessionStoreKeyForUser(userId: string, baseKey: string): string {
  return `u:${userId}:${baseKey}`;
}

/**
 * Pour chaque clé métier : si aucune valeur scopée pour cet utilisateur mais une valeur
 * globale (legacy) existe, copie vers la clé scopée et supprime la globale.
 */
export async function migrateLegacyGlobalKeysToCurrentUser(
  store: Store,
  userId: string,
): Promise<void> {
  let touched = false;
  for (const baseKey of LEGACY_GLOBAL_KEYS_TO_SCOPE) {
    const scoped = sessionStoreKeyForUser(userId, baseKey);
    if (await store.has(scoped)) continue;
    const globalVal = await store.get<unknown>(baseKey);
    if (globalVal === undefined) continue;
    await store.set(scoped, globalVal);
    await store.delete(baseKey);
    touched = true;
  }
  if (touched) await store.save();
}

/**
 * Migre les sessions, contenus hors session et préférences depuis les clés globales
 * vers les clés scopées utilisateur au premier login.
 */
const SESSION_AND_SETTINGS_KEYS_TO_SCOPE = [
  "sessions",
  "currentSessionId",
  "offSessionNotes",
  "offSessionImages",
  "offSessionVideos",
  "copyHistoryNotes",
  "ocrTextByPath",
  "offSessionBlockExpanded",
  "sessionBlockExpandedById",
  "dictationLang",
  "whisperModel",
  "qwenLocalModel",
  "dictationProvider",
  "fnDictationShortcutEnabled",
  "hotkeyKeyLetters",
  "attachOffSessionFocus",
  "screenRecordQuality",
  "dictationAutoStopMinutes",
  "screenRecordAutoStopMinutes",
  "autoProcessUploadBatch",
  "keepCopyHistory",
  "keepDictationHistory",
  "localLlmParallelCalls",
  "openAiApiKey",
  "assistantModel",
  "sensitiveScanModel",
  "sensitivePromptTemplate",
  "pdfWarnThreshold",
  "pdfSummaryLang",
  "pdfPagesMode",
  "pdfPagesCount",
  "pdfPagesPercent",
  "pdfModelFilename",
  "dictationCustomModel",
  "dictationCustomPromptHighlight",
  "dictationCustomPromptNoHighlight",
  "pdfParallelism",
  "testUploadPreserveLocalState",
  "autoScanSensitive",
  "autoAssignTags",
  "autoTagModel",
  "captureHistoryRetention",
  "autoTagTextLimit",
  "isRecording",
  "recordingPaused",
] as const;

export async function migrateSessionAndSettingsToUser(
  store: Store,
  userId: string,
): Promise<void> {
  let touched = false;
  for (const baseKey of SESSION_AND_SETTINGS_KEYS_TO_SCOPE) {
    const scoped = sessionStoreKeyForUser(userId, baseKey);
    if (await store.has(scoped)) continue;
    const globalVal = await store.get<unknown>(baseKey);
    if (globalVal === undefined) continue;
    await store.set(scoped, globalVal);
    await store.delete(baseKey);
    touched = true;
  }
  if (touched) await store.save();
}
