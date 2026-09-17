import { useEffect, useRef, useState } from "react";
import { localClearEmbedErrors, localEmbedMissing, type ModelCoverage } from "./localIndex";

/** Friendly name for an embedding model id (e.g. "qwen3-embed-0.6b-q8", "openai:text-embedding-3-small"). */
function embedModelLabel(embedModel: string): string {
  if (embedModel === "qwen3-embed-0.6b-q8") return "Qwen3-Embedding 0.6B (Q8)";
  if (embedModel === "qwen3-embed-4b-q4km") return "Qwen3-Embedding 4B (Q4_K_M)";
  if (embedModel.startsWith("openai:")) {
    const rest = embedModel.slice("openai:".length);
    return rest ? `OpenAI ${rest}` : "OpenAI";
  }
  return embedModel;
}

function errorMessageFrom(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong while indexing. Please try again.";
}

/**
 * Turn a raw backend failure into something a user can act on. Anything we don't
 * recognise is passed through rather than swallowed — a puzzling message still
 * beats a run that ends in silence.
 */
function friendlyReason(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes("api key") || r.includes("401") || r.includes("invalid_api_key")) {
    return "your OpenAI key is missing or no longer valid.";
  }
  if (r.includes("429") || r.includes("rate limit") || r.includes("quota")) {
    return "OpenAI turned the requests away for now. Wait a moment and try again.";
  }
  if (r.includes("embed model not found") || r.includes("unknown embed model")) {
    return "the model isn't installed on this computer yet. You can download it in Settings.";
  }
  if (r.includes("llama-embedding not found")) {
    return "the local indexing tool is missing from this installation.";
  }
  if (r.includes("dim mismatch")) {
    return "the model gave back results of an unexpected size.";
  }
  const trimmed = raw.trim();
  if (!trimmed) return "an unexpected problem stopped it.";
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

/** One row of the "use a different model" picker. */
type ModelChoice = {
  embedModel: string;
  /** Captures already searchable with this model *in this index* — 0 when it was never used here. */
  covered: number;
  total: number;
  /** Can this computer actually run the model right now? `null` when we don't know yet. */
  usable: boolean | null;
  /** Short reason it can't be used, for the row. Null when it can. */
  unusableTag: string | null;
};

export function AssistantCoverageBanner({
  userId,
  assistantId,
  embedModel,
  modelUnresolved = false,
  coverage,
  allCoverage,
  availableModels,
  openAiApiKey,
  onModelChange,
  onCoverageRefresh,
  onGoToSettings,
}: {
  userId: string;
  /**
   * Which index the two actions below work on: `null` is the profile's own,
   * anything else an imported assistant's. `coverage` and `allCoverage` are
   * already measured against it by the caller, so indexing must be aimed at the
   * same place — otherwise the button reports one index's gap and fills another's.
   */
  assistantId: string | null;
  embedModel: string;
  /**
   * The caller has not finished working out which model this index is searched
   * with, so `embedModel` is empty for want of an answer rather than for want of
   * a model. Say nothing while it is true: the two look identical here, and the
   * message for the second ("No embedding model is set up yet", with a link into
   * Settings) sends a user to fix something that is not broken.
   *
   * Silence and not a spinner on purpose. This banner already shows nothing until
   * its coverage arrives, so a placeholder here would be a new element flashing in
   * and out on every tab switch, one local query long, to report a wait nobody
   * noticed.
   */
  modelUnresolved?: boolean;
  coverage: ModelCoverage | null;
  allCoverage: ModelCoverage[];
  /**
   * Embedding models this computer has (the `models` list of the embed status the
   * chat surface already holds). `allCoverage` only knows models that left vectors
   * *in this index* — for a freshly imported assistant that is the sender's model
   * and nothing else, so on its own it can offer a model the recipient cannot run.
   * These fill the gap: they have no vectors here yet, but the chunk text travelled
   * in the archive, so the indexing action can give them some. `null` when unknown,
   * in which case nothing is claimed about availability.
   */
  availableModels?: ReadonlyArray<{ id: string; installed: boolean; isOpenAi: boolean }> | null;
  openAiApiKey?: string | null;
  onModelChange: (model: string) => void;
  onCoverageRefresh: () => void;
  /** Opens Settings, optionally scrolled to a section (e.g. the capture indexing model row). */
  onGoToSettings?: (scrollToId?: string) => void;
}) {
  const [showModelList, setShowModelList] = useState(false);
  const [indexing, setIndexing] = useState(false);
  // Captures left to index, in a single unit (captures — not chunks). Recomputed from
  // freshly refreshed coverage below; null until we have a trustworthy number to show.
  const [remaining, setRemaining] = useState<number | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  // Set when a run ends with at least one chunk it couldn't embed. Holds the reason
  // so the banner can explain itself instead of quietly returning to idle, and gates
  // the "Try again" action (retrying is deliberately never automatic — it can cost money).
  const [failedReason, setFailedReason] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Guards against a stale run continuing to update state after the model changes
  // or the component unmounts (the underlying indexing call itself is fire-and-forget;
  // this only stops us from reacting to its result).
  const runGenRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A new model — or a new index, when the user switches assistant tab — means any
  // in-flight run is no longer relevant: drop its state. Without the `assistantId`
  // here, a run started on one index would keep reporting its progress and its
  // failures against another index's numbers.
  useEffect(() => {
    runGenRef.current += 1;
    setShowModelList(false);
    setIndexing(false);
    setRemaining(null);
    setIndexError(null);
    setFailedReason(null);
    setRetrying(false);
  }, [embedModel, assistantId]);

  // While indexing, reflect the latest refreshed coverage as a single honest count of
  // captures left (the same unit as the denominator), instead of mixing it with the
  // chunk count that localEmbedMissing returns. Guarded to the current model so a
  // coverage value for a model we've since switched away from can't be shown.
  useEffect(() => {
    if (!indexing) return;
    if (!coverage || coverage.embedModel !== embedModel) return;
    setRemaining(Math.max(coverage.total - coverage.covered, 0));
  }, [indexing, coverage, embedModel]);

  // ── What this computer can actually run ─────────────────────────────────────
  // `null` means "we weren't told" (no embed status yet): claim nothing, behave as
  // before rather than greying out models on a guess.
  const hasOpenAiKey = Boolean((openAiApiKey ?? "").trim());
  const modelUsable = (id: string): boolean | null => {
    if (!availableModels || availableModels.length === 0) return null;
    const m = availableModels.find((x) => x.id === id);
    if (!m || !m.installed) return false;
    if (m.isOpenAi && !hasOpenAiKey) return false;
    return true;
  };
  /** Short reason for a picker row, e.g. "not on this computer". */
  const unusableTag = (id: string): string => {
    const m = availableModels?.find((x) => x.id === id);
    return m?.isOpenAi ? "needs your OpenAI key" : "not on this computer";
  };
  /** Same reason as a clause inside a sentence ("…, which <this>."). */
  const unusableClause = (id: string): string => {
    const m = availableModels?.find((x) => x.id === id);
    return m?.isOpenAi ? "needs your OpenAI key" : "isn't installed on this computer";
  };
  const currentModelUnavailable = modelUsable(embedModel) === false;

  const handleIndex = async () => {
    if (!coverage || indexing || currentModelUnavailable) return;
    const myGen = ++runGenRef.current;
    setRemaining(null);
    setIndexError(null);
    setFailedReason(null);
    setIndexing(true);
    try {
      // Terminate on `attempted === 0` — nothing left to try — never on `succeeded === 0`,
      // which is also what a batch where every chunk failed looks like. Each failed chunk
      // is marked and skipped by the backend, so the pool always shrinks and this ends.
      let failures = 0;
      let lastError: string | null = null;
      for (;;) {
        const res = await localEmbedMissing(userId, embedModel, openAiApiKey ?? null, 25, assistantId);
        if (runGenRef.current !== myGen) return;
        if (res.attempted === 0) break;
        failures += res.attempted - res.succeeded;
        if (res.lastError) lastError = res.lastError;
        onCoverageRefresh();
      }
      if (runGenRef.current !== myGen || !mountedRef.current) return;
      // Always refresh once more: a run that only produced failures left coverage
      // untouched, and the count shown next to the message has to be the real one.
      onCoverageRefresh();
      if (failures > 0) setFailedReason(friendlyReason(lastError ?? ""));
      setIndexing(false);
    } catch (err) {
      if (runGenRef.current === myGen && mountedRef.current) {
        setIndexError(errorMessageFrom(err));
        setIndexing(false);
      }
    }
  };

  // Explicit retry: clear this model's failure markers (which removes no capture and
  // nothing belonging to another model), then run the pass again.
  const handleRetry = async () => {
    if (indexing || retrying) return;
    setRetrying(true);
    setIndexError(null);
    try {
      await localClearEmbedErrors(userId, embedModel, assistantId);
    } catch (err) {
      if (mountedRef.current) {
        setIndexError(errorMessageFrom(err));
        setRetrying(false);
      }
      return;
    }
    if (mountedRef.current) {
      setRetrying(false);
      setFailedReason(null);
      await handleIndex();
    }
  };

  if (modelUnresolved) return null;

  if (!embedModel) {
    return (
      <div className="assistant-coverage-banner" role="status">
        <p className="assistant-coverage-banner__msg">No embedding model is set up yet.</p>
        {onGoToSettings && (
          <button
            type="button"
            className="assistant-coverage-banner__link"
            onClick={() => onGoToSettings("capture-indexing-model-row")}
          >
            Go to Settings
          </button>
        )}
      </div>
    );
  }

  if (!coverage || coverage.total === 0) return null;
  const isComplete = coverage.covered >= coverage.total;
  // Never hide a run that ended in failure: that is exactly the silence this banner exists to break.
  // Nor a model this computer can't run: "fully covered" by a model we cannot embed a
  // question with means nothing can be found at all — the one case that must not be silent.
  if (isComplete && allCoverage.length <= 1 && !failedReason && !indexError && !currentModelUnavailable) {
    return null;
  }

  const label = embedModelLabel(embedModel);
  const missing = Math.max(coverage.total - coverage.covered, 0);
  const nothingIndexed = coverage.covered === 0;

  // The picker: models with search data in this index (with their counts) *plus* models
  // this computer can run that simply haven't been used here yet. The second group is
  // what rescues an imported assistant whose only indexed model is the sender's.
  const choices: ModelChoice[] = allCoverage.map((entry) => {
    const usable = modelUsable(entry.embedModel);
    return {
      embedModel: entry.embedModel,
      covered: entry.covered,
      total: entry.total,
      usable,
      unusableTag: usable === false ? unusableTag(entry.embedModel) : null,
    };
  });
  for (const m of availableModels ?? []) {
    if (choices.some((c) => c.embedModel === m.id)) continue;
    if (modelUsable(m.id) !== true) continue;
    choices.push({ embedModel: m.id, covered: 0, total: coverage.total, usable: true, unusableTag: null });
  }
  const hasUnindexedChoice = choices.some((c) => c.covered === 0);
  // Nothing on this computer can search this index and nothing can be indexed either:
  // point at the one place that fixes it instead of offering an empty list.
  const noUsableChoice = currentModelUnavailable && !choices.some((c) => c.usable === true);

  const leadMessage = noUsableChoice
    ? `This knowledge was indexed with ${label}, which ${unusableClause(embedModel)}. Set up a model in Settings, then index this knowledge with it.`
    : currentModelUnavailable
    ? `This knowledge was indexed with ${label}, which ${unusableClause(embedModel)}. Pick a model you have below, then index this knowledge with it.`
    : nothingIndexed
      ? `Nothing here is indexed with ${label} yet, so this assistant can't answer from it. Index it with this model to make it searchable.`
      : isComplete
        ? "Your index uses more than one embedding model."
        : missing === 1
          ? `${label} can't find 1 capture by meaning — only by keyword.`
          : `${label} can't find ${missing} captures by meaning — only by keyword.`;

  return (
    <div className="assistant-coverage-banner" role="status">
      <p className="assistant-coverage-banner__msg">{leadMessage}</p>
      <div className="assistant-coverage-banner__actions">
        {!isComplete && !currentModelUnavailable && (
          <button
            type="button"
            className="assistant-coverage-banner__btn assistant-coverage-banner__btn--primary"
            onClick={() => void handleIndex()}
            disabled={indexing}
          >
            {indexing
              ? remaining === null
                ? "Indexing…"
                : remaining === 1
                  ? "Indexing… 1 capture left"
                  : `Indexing… ${remaining} captures left`
              : nothingIndexed
                ? "Index everything with this model"
                : "Index them with this model"}
          </button>
        )}
        {failedReason && !indexing && (
          <button
            type="button"
            className="assistant-coverage-banner__btn assistant-coverage-banner__btn--secondary"
            onClick={() => void handleRetry()}
            disabled={retrying}
          >
            {retrying ? "Trying again…" : "Try again"}
          </button>
        )}
        <button
          type="button"
          className={`assistant-coverage-banner__btn ${
            currentModelUnavailable && !noUsableChoice
              ? "assistant-coverage-banner__btn--primary"
              : "assistant-coverage-banner__btn--secondary"
          }`}
          onClick={() => setShowModelList((v) => !v)}
        >
          {currentModelUnavailable && !noUsableChoice ? "Choose a model you have" : "Use a different model"}
        </button>
        {noUsableChoice && onGoToSettings && (
          <button
            type="button"
            className="assistant-coverage-banner__btn assistant-coverage-banner__btn--primary"
            onClick={() => onGoToSettings("capture-indexing-model-row")}
          >
            Set up a model in Settings
          </button>
        )}
      </div>
      {failedReason && !indexing && (
        <p className="assistant-coverage-banner__error" role="alert">
          {missing === 0
            ? // A capture counts as covered once any of its parts is indexed, so a
              // partly-failed run can leave this at 0. Don't claim a count we can't stand behind.
              `Couldn't finish indexing everything: ${failedReason}`
            : missing === 1
              ? `Couldn't index 1 capture: ${failedReason}`
              : `Couldn't index ${missing} captures: ${failedReason}`}
        </p>
      )}
      {indexError && (
        <p className="assistant-coverage-banner__error" role="alert">
          {indexError}
        </p>
      )}
      {showModelList && (
        <div className="assistant-coverage-banner__model-list">
          {choices.map((choice) => (
            <button
              key={choice.embedModel}
              type="button"
              className={`assistant-coverage-banner__model-item${
                choice.embedModel === embedModel ? " assistant-coverage-banner__model-item--active" : ""
              }`}
              disabled={choice.usable === false}
              onClick={() => {
                onModelChange(choice.embedModel);
                setShowModelList(false);
              }}
            >
              <span>{embedModelLabel(choice.embedModel)}</span>
              <span className="assistant-coverage-banner__model-item-count">
                {choice.covered === 0
                  ? "Not indexed yet"
                  : `${choice.covered} of ${choice.total} captures`}
                {choice.unusableTag ? ` · ${choice.unusableTag}` : ""}
              </span>
            </button>
          ))}
          {hasUnindexedChoice && (
            <p className="assistant-coverage-banner__model-list-hint">
              “Not indexed yet” means this model has nothing stored here so far. Pick it, then index
              this knowledge with it — nothing is lost, it just needs indexing on this computer.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
