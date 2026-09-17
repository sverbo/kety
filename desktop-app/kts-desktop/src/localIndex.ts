import { invoke } from "@tauri-apps/api/core";
import type {
  EmbedModelsStatus,
  LocalIndexStats,
  LocalSearchHit,
  IndexCaptureRequest,
} from "./appTypes";

export async function checkEmbedModels(userId?: string | null): Promise<EmbedModelsStatus> {
  return invoke<EmbedModelsStatus>("check_embed_models_cmd", { userId: userId ?? null });
}

export async function downloadEmbedModel(modelId: string): Promise<void> {
  return invoke("download_embed_model_cmd", { modelId });
}

export async function cancelEmbedDownload(): Promise<void> {
  return invoke("cancel_embed_download_cmd");
}

export async function removeEmbedModel(filename: string): Promise<void> {
  return invoke("remove_embed_model_cmd", { filename });
}

export async function setActiveEmbedModel(modelId: string, userId: string): Promise<void> {
  return invoke("set_active_embed_model_cmd", { modelId, userId });
}

export type LocalCaptureRow = {
  id: string;
  userId: string | null;
  rawText: string | null;
  explanation: string | null;
  title: string | null;
  kind: string;
  subKind: string | null;
  localPath: string | null;
  tagIds: string | null; // JSON array string e.g. '["id1","id2"]'
  sensitiveState: string;
  createdAt: string | null;
  meta: string | null; // JSON blob: { contextFocus, lang, thumbnailPath, fileSize, summary, ... }
  rawContent: string | null; // JSON array of strings (pages for docs, segments for Meet)
  appName: string | null;
  windowName: string | null;
  sizeKb: number | null;
  sizeMediaKb: number | null;
  processDocIndexDoc: boolean | null;
  indexMeetRawTranscript: boolean | null;
  ketyServerPath: string | null;
  indexState: string;
  indexError: string | null;
};

export type LocalSaveCaptureReq = {
  id: string;
  userId?: string | null;
  rawText?: string | null;
  explanation?: string | null;
  title?: string | null;
  kind: string;
  subKind?: string | null;
  localPath?: string | null;
  tagIds?: string[] | null;
  sensitiveState?: string | null;
  createdAt?: string | null;
  meta?: string | null;
  rawContent?: string[] | null;
  appName?: string | null;
  windowName?: string | null;
  sizeKb?: number | null;
  processDocIndexDoc?: boolean | null;
  indexMeetRawTranscript?: boolean | null;
  ketyServerPath?: string | null;
};

export async function localSaveCapture(userId: string, req: LocalSaveCaptureReq): Promise<void> {
  const meta = req.meta ? (() => { try { return JSON.parse(req.meta!) as Record<string, unknown>; } catch { return null; } })() : null;
  console.log(`[db:save] START id=${req.id} kind=${req.kind} sizeKb=${req.sizeKb ?? "null"} meta.fileSize=${meta?.fileSize ?? "null"} userId=${userId.slice(0, 8)}…`);
  try {
    const result = await invoke("local_save_capture_cmd", { userId, req });
    console.log(`[db:save] OK    id=${req.id} kind=${req.kind}`);
    return result as void;
  } catch (err) {
    console.error(`[db:save] FAIL  id=${req.id} kind=${req.kind}`, err);
    throw err;
  }
}

/**
 * Read side: `assistantId` picks the index. Omit it (or pass null) for the
 * profile's own index; pass an id to read one imported from someone else.
 *
 * Only the reading wrappers below take it. The ones that save, delete, index or
 * export deliberately do not, which is what makes an imported index read-only:
 * they have no way to name one. Adding the argument to one of them would remove
 * that guarantee without anything failing.
 */
export async function localListCaptures(
  userId: string,
  assistantId?: string | null,
): Promise<LocalCaptureRow[]> {
  return invoke<LocalCaptureRow[]>("local_list_captures_cmd", { userId, assistantId: assistantId ?? null });
}

export async function localIndexCapture(userId: string, req: IndexCaptureRequest): Promise<void> {
  return invoke("local_index_capture_cmd", { userId, req });
}

/** Hard-deletes a single capture. Returns local_path if any. */
export async function localHardDeleteCapture(userId: string, captureId: string): Promise<string | null> {
  return invoke<string | null>("local_hard_delete_capture_cmd", { userId, captureId });
}

export async function localIndexStats(
  userId: string,
  assistantId?: string | null,
): Promise<LocalIndexStats> {
  return invoke<LocalIndexStats>("local_index_stats_cmd", { userId, assistantId: assistantId ?? null });
}

export async function copyLocalFileToDownloads(srcPath: string): Promise<string> {
  return invoke<string>("copy_local_file_to_downloads_cmd", { srcPath });
}

export type ChatHistoryMessage = { role: string; content: string };

/** Embed query + run hybrid search. mode: "local" | "api"
 *  In API mode, chatHistory is forwarded to gpt-4o-mini router which decides
 *  whether retrieval is needed and reformulates the query. */
export async function localSearch(
  userId: string,
  query: string,
  mode: "local" | "api",
  openaiApiKey?: string | null,
  tagIds?: string[] | null,
  chatHistory?: ChatHistoryMessage[] | null,
  embedModel?: string | null,
  assistantId?: string | null,
): Promise<LocalSearchHit[]> {
  return invoke<LocalSearchHit[]>("local_search_cmd", {
    userId,
    query,
    mode,
    openaiApiKey: openaiApiKey ?? null,
    tagIds: tagIds ?? null,
    chatHistory: chatHistory ?? null,
    embedModel: embedModel ?? null,
    assistantId: assistantId ?? null,
  });
}

export type TagRow = {
  id: string;
  userId: string | null;
  name: string;
  description: string;
  color: string;
  autoAssignApps: string; // JSON array string
  createdAt: string;
};

export type LocalSaveTagReq = {
  id: string;
  name: string;
  description: string;
  color: string;
  autoAssignApps: string[];
  createdAt: string;
};

export async function localSaveTag(userId: string, req: LocalSaveTagReq): Promise<void> {
  return invoke("local_save_tag_cmd", { userId, req });
}

export async function localListTags(
  userId: string,
  assistantId?: string | null,
): Promise<TagRow[]> {
  return invoke<TagRow[]>("local_list_tags_cmd", { userId, assistantId: assistantId ?? null });
}

export async function localDeleteTag(userId: string, tagId: string): Promise<void> {
  return invoke("local_delete_tag_cmd", { userId, tagId });
}

/** Pack search hits into a context string within the token budget for the given mode. */
export async function localPackContext(
  hits: LocalSearchHit[],
  mode: "local" | "api",
): Promise<string> {
  return invoke<string>("local_pack_context_cmd", { hits, mode });
}

export type IndexDiag = {
  metaEmbedModel: string;
  metaEmbedDim: number;
  storedModels: [string, number][];
  totalChunkEmbeddings: number;
  totalChunks: number;
  validChunkEmbeddings: number;
  capturesWithEmbeddings: number;
  capturesMissingEmbeddings: number;
  capturesWithTags: number;
  capturesWithoutTags: number;
  sampleTagIds: string[];
};

export async function localIndexDiag(
  userId: string,
  assistantId?: string | null,
): Promise<IndexDiag> {
  return invoke<IndexDiag>("local_index_diag_cmd", { userId, assistantId: assistantId ?? null });
}


export type IndexStateCounts = {
  pending: number;
  /**
   * Captures a background pass is working on right now. Counted apart from
   * `pending` so a row can show a spinner rather than "waiting" — but it is still
   * un-indexed work, so anything totalling these has to include it or the captures
   * in flight quietly drop out of the total.
   */
  indexing: number;
  indexed: number;
  failed: number;
  excluded: number;
};

/**
 * Fired by the background indexing pass each time one capture changes state, so a
 * row can follow along without polling. Nothing is emitted while there is nothing
 * to index.
 */
export const INDEX_STATE_EVENT = "kts:index/capture-state";

export type IndexStateChanged = {
  captureId: string;
  /** "indexing" when the pass picks it up, then "indexed" or "failed". */
  state: string;
};

/** Index up to `limit` pending captures. Returns how many were indexed. */
export async function localIndexPending(
  userId: string,
  openaiApiKey?: string | null,
  limit?: number,
): Promise<number> {
  return invoke<number>("local_index_pending_cmd", { userId, openaiApiKey, limit });
}

/** Remove captures from the assistant. Sticky: they are never auto-indexed again. */
export async function localUnindexCaptures(userId: string, captureIds: string[]): Promise<void> {
  return invoke("local_unindex_captures_cmd", { userId, captureIds });
}

/** Put captures back in the indexing queue (undo unindex, or retry a failure). */
export async function localReindexCaptures(userId: string, captureIds: string[]): Promise<void> {
  return invoke("local_reindex_captures_cmd", { userId, captureIds });
}

export async function localIndexStateCounts(
  userId: string,
  assistantId?: string | null,
): Promise<IndexStateCounts> {
  return invoke<IndexStateCounts>("local_index_state_counts_cmd", { userId, assistantId: assistantId ?? null });
}

export type ModelCoverage = {
  embedModel: string;
  covered: number;
  total: number;
};

export async function localModelCoverage(
  userId: string,
  embedModel: string,
  assistantId?: string | null,
): Promise<ModelCoverage> {
  return invoke<ModelCoverage>("local_model_coverage_cmd", { userId, embedModel, assistantId: assistantId ?? null });
}

export async function localCoverageByModel(
  userId: string,
  assistantId?: string | null,
): Promise<ModelCoverage[]> {
  return invoke<ModelCoverage[]>("local_coverage_by_model_cmd", { userId, assistantId: assistantId ?? null });
}

export type EmbedMissingResult = {
  /** Chunks this pass picked up (successes + failures). 0 means nothing left to try. */
  attempted: number;
  /** Chunks that got a usable vector. */
  succeeded: number;
  /** Message from the last failure in this pass, if any. */
  lastError: string | null;
};

/**
 * Embed chunks missing a vector for `embedModel`.
 * Callers must loop on `attempted`, not `succeeded`: a pass where everything
 * failed also returns `succeeded: 0`, and treating that as "finished" would hide
 * the failures completely.
 *
 * Takes an `assistantId` despite writing rows: it only ever adds vectors, which
 * is how an imported index becomes searchable when you do not run the sender's
 * embedding model. It adds no capture and changes no content.
 */
export async function localEmbedMissing(
  userId: string,
  embedModel: string,
  openaiApiKey?: string | null,
  limit?: number,
  assistantId?: string | null,
): Promise<EmbedMissingResult> {
  return invoke<EmbedMissingResult>("local_embed_missing_cmd", {
    userId,
    embedModel,
    openaiApiKey: openaiApiKey ?? null,
    limit: limit ?? null,
    assistantId: assistantId ?? null,
  });
}

/** What an export actually produced. Mirrors the Rust `ExportResult`. */
export type IndexExportResult = {
  /** Where the finished archive is. */
  path: string;
  /** Screenshots and recordings that made it into the archive. */
  mediaWritten: number;
  /**
   * Files that were meant to travel but could not — deleted, moved, or a name
   * the archive refuses. A skip is never fatal to the export, so the caller has
   * to report this: otherwise someone ticks "include files", ships an archive
   * with none of them, and is told it all went fine.
   */
  mediaSkipped: number;
};

/**
 * Build a shareable index archive from `captureIds`.
 *
 * `selectedTagIds` are the tags the user left ticked. A capture travels if it
 * carries any of them, but it travels carrying only those: a tag the user
 * unticked keeps neither its id on the capture nor its name and description in
 * the file. Pass the same list the on-screen count was computed from.
 *
 * `includeWindowTitles` ships the window title of every capture, which routinely
 * names the sender's account, machine and folders — the curation UI defaults it
 * to off.
 *
 * The archive is left in a temp file, named after `name`, which the caller owns
 * and must delete once it has been sent or abandoned. That name matters beyond
 * the temp folder: saving the file to Downloads copies it under the same
 * basename, so it is what the recipient ends up with.
 */
export async function localBuildIndexExport(
  userId: string,
  captureIds: string[],
  selectedTagIds: string[],
  name: string,
  includeMedia: boolean,
  includeWindowTitles: boolean,
): Promise<IndexExportResult> {
  return invoke<IndexExportResult>("build_index_export_cmd", {
    userId,
    captureIds,
    selectedTagIds,
    name,
    includeMedia,
    includeWindowTitles,
  });
}

/**
 * One knowledge index imported from someone else, as the Rust side describes it.
 * Mirrors `index_import::ImportedAssistant` field for field.
 *
 * `assistantId` is the handle: every reading wrapper above takes it, and it is
 * the directory name under `local-index/{userId}/assistants/`.
 */
export type ImportedAssistant = {
  assistantId: string;
  name: string;
  exportId: string;
  captureCount: number;
  embedModel: string;
  importedAt: string;
};

/**
 * Validate a shared archive and adopt it as a new read-only assistant.
 *
 * `source` is either an http(s) link (`isUrl`) or a path to an archive already on
 * this machine. `name` overrides the name the sender gave the export.
 *
 * On success the index is on disk but **nothing lists it yet** — use
 * `addImportedAssistant` in `importedAssistants.ts`, which registers it and takes
 * it back off disk if that registration fails. Calling this directly leaves an
 * assistant the app cannot see.
 */
export async function localImportSharedIndex(
  userId: string,
  source: string,
  isUrl: boolean,
  name?: string | null,
): Promise<ImportedAssistant> {
  return invoke<ImportedAssistant>("import_shared_index_cmd", {
    userId,
    source,
    isUrl,
    name: name ?? null,
  });
}

/**
 * Delete one imported assistant: its database, its media, its whole directory.
 * Irreversible, and touches nothing but that one assistant.
 *
 * Deleting one that is not on disk succeeds — the files and the registry entry
 * are separate state, and a stale entry has to stay clearable.
 *
 * The empty-id check below is a courtesy, not the guard: `delete_assistant` in
 * `index_import.rs` refuses it too, and that is the refusal that matters, since
 * an empty id resolves to the profile's own directory. Both exist because this
 * is the one call in the app that can destroy a user's entire knowledge index.
 */
export async function localDeleteAssistant(userId: string, assistantId: string): Promise<void> {
  if (!assistantId.trim()) {
    throw new Error("We cannot remove an assistant without knowing which one, so nothing was deleted.");
  }
  return invoke("delete_assistant_cmd", { userId, assistantId });
}

/**
 * One imported-knowledge folder on disk that the app's own list does not know
 * about. Mirrors `index_import::OrphanAssistant`.
 */
export type OrphanAssistant = {
  /** The handle `localDeleteAssistant` takes. */
  assistantId: string;
  /** How much the folder occupies, so the user can judge whether to bother. */
  sizeBytes: number;
};

/**
 * Imported-knowledge folders of this profile that `knownAssistantIds` does not
 * account for.
 *
 * The list in the store is the only thing that names an imported index, so any
 * way of losing an entry while the files survive leaves a folder nothing can
 * open, offer or remove. This is how such a folder is found again — it reports,
 * and removes nothing. Deleting one is a separate, deliberate call.
 */
export async function localListOrphanAssistants(
  userId: string,
  knownAssistantIds: string[],
): Promise<OrphanAssistant[]> {
  return invoke<OrphanAssistant[]>("list_orphan_assistants_cmd", { userId, knownAssistantIds });
}

/**
 * Clear the failure markers left by a previous indexing pass for `embedModel`, so
 * those chunks are tried again on the next pass. Returns how many were cleared.
 * Removes only this model's failed rows — no capture, and no other model's work.
 * That is why it pairs with `localEmbedMissing` and may name an `assistantId`.
 */
export async function localClearEmbedErrors(
  userId: string,
  embedModel: string,
  assistantId?: string | null,
): Promise<number> {
  return invoke<number>("local_clear_embed_errors_cmd", { userId, embedModel, assistantId: assistantId ?? null });
}
