import {
  useState,
  useRef,
  useEffect,
  useMemo,
} from "react";
import { SettingsModelPicker, type SettingsModelPickerOption } from "./SettingsModelPicker";
import type { ChatPreference } from "./assistantChatTypes";
import type { AssistantChatContextTab } from "./assistantChatTypes";
import { IconX } from "./AppIcons";

export type PrefsEditState = {
  id: string | "new";
  name: string;
  text: string;
  scope: "all" | string[];
};

function PrefsEditForm({
  value,
  contextTabs,
  otherPrefs,
  maxPrefsChars,
  onChange,
  onApply,
  onCancel,
}: {
  value: PrefsEditState;
  contextTabs: AssistantChatContextTab[];
  /** All preferences in the current draft excluding the one being edited. */
  otherPrefs: ChatPreference[];
  maxPrefsChars: number;
  onChange: (v: PrefsEditState) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  // Remaining budget = MAX minus chars already consumed by other applicable prefs.
  // For "all" scope: worst-case assistant (max combined usage across all specific scopes).
  // For string[] scope: worst-case among the selected contexts.
  const usedByOthers = (() => {
    const applies = (p: ChatPreference, ctx: string) =>
      !p.disabled && (p.scope === "all" || (Array.isArray(p.scope) && p.scope.includes(ctx)));

    if (value.scope === "all") {
      const allOnlySum = otherPrefs
        .filter((p) => p.scope === "all")
        .reduce((sum, p) => sum + p.text.length, 0);
      const specificScopes = new Set<string>(
        otherPrefs
          .filter((p) => Array.isArray(p.scope))
          .flatMap((p) => p.scope as string[]),
      );
      if (specificScopes.size === 0) return allOnlySum;
      let maxUsed = allOnlySum;
      for (const s of specificScopes) {
        const used = otherPrefs.filter((p) => applies(p, s)).reduce((sum, p) => sum + p.text.length, 0);
        maxUsed = Math.max(maxUsed, used);
      }
      return maxUsed;
    }
    // string[] - worst case across selected contexts
    if (value.scope.length === 0) return 0;
    let maxUsed = 0;
    for (const s of value.scope) {
      const used = otherPrefs.filter((p) => applies(p, s)).reduce((sum, p) => sum + p.text.length, 0);
      maxUsed = Math.max(maxUsed, used);
    }
    return maxUsed;
  })();
  const effectiveMax = maxPrefsChars - usedByOthers;
  const charsOver = value.text.length > effectiveMax;
  const scopeValid = value.scope === "all" || value.scope.length > 0;

  // Smart "All assistants" dropdown
  const isAll = value.scope === "all";
  const selectedIds: string[] = isAll ? contextTabs.map((t) => t.contextId) : (value.scope as string[]);
  const allFullyChecked = isAll;
  const someChecked = !isAll && selectedIds.length > 0 && selectedIds.length < contextTabs.length;
  const allCheckRef = useRef<HTMLInputElement>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (allCheckRef.current) allCheckRef.current.indeterminate = someChecked;
  }, [someChecked]);

  useEffect(() => {
    if (!scopeOpen) return;
    function handler(e: MouseEvent) {
      if (scopeDropdownRef.current && !scopeDropdownRef.current.contains(e.target as Node)) {
        setScopeOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [scopeOpen]);

  const scopeTriggerLabel = isAll
    ? "All assistants"
    : selectedIds.length === 0
      ? "None"
      : selectedIds
          .map((id) => contextTabs.find((t) => t.contextId === id)?.label ?? id.slice(0, 8))
          .join(", ");

  function handleAllChange(checked: boolean) {
    onChange({ ...value, scope: checked ? "all" : [] });
  }

  function handleIndividualChange(contextId: string, checked: boolean) {
    let next: string[];
    if (isAll) {
      next = contextTabs.map((t) => t.contextId).filter((id) => id !== contextId);
    } else {
      next = checked
        ? [...selectedIds, contextId]
        : selectedIds.filter((id) => id !== contextId);
    }
    onChange({ ...value, scope: next.length === contextTabs.length ? "all" : next });
  }

  return (
    <div className="prefs-edit-form">
      <div className="prefs-edit-top-row">
        <input
          type="text"
          className="prefs-edit-name"
          placeholder="Name (optional)"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          maxLength={50}
        />
        <div className="prefs-edit-scope-dropdown" ref={scopeDropdownRef}>
          <button
            type="button"
            className="prefs-edit-scope-trigger"
            onClick={() => setScopeOpen((o) => !o)}
          >
            <span>{scopeTriggerLabel}</span>
            <span className="prefs-edit-scope-arrow">▾</span>
          </button>
          {scopeOpen && (
            <div className="prefs-edit-scope-menu">
              <label className="prefs-edit-scope-option prefs-edit-scope-option--all">
                <input
                  type="checkbox"
                  ref={allCheckRef}
                  checked={allFullyChecked}
                  onChange={(e) => handleAllChange(e.target.checked)}
                />
                <span>All assistants</span>
              </label>
              {contextTabs.map((t) => (
                <label key={t.contextId} className="prefs-edit-scope-option prefs-edit-scope-option--item">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(t.contextId)}
                    onChange={(e) => handleIndividualChange(t.contextId, e.target.checked)}
                  />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
      <textarea
        className="prefs-edit-text"
        placeholder="Enter your preference or context…"
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        rows={4}
        autoFocus
      />
      <div className="prefs-edit-footer">
        <span className={`prefs-edit-chars${charsOver ? " prefs-edit-chars--over" : ""}`}>
          {value.text.length.toLocaleString()} / {effectiveMax.toLocaleString()}
          {usedByOthers > 0 && (
            <span className="prefs-edit-chars-hint"> (−{usedByOthers.toLocaleString()} used by other prefs)</span>
          )}
        </span>
        <div className="prefs-edit-btns">
          <button type="button" className="modal-btn modal-btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn modal-btn--primary"
            onClick={onApply}
            disabled={!value.text.trim() || charsOver || !scopeValid}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

export type AssistantPrefsModalTab = "prompts" | "model";

export type AssistantKbMode = "cloud" | "local";

export type AssistantKbSettings = {
  mode: AssistantKbMode;
};

export const DEFAULT_KB_SETTINGS: AssistantKbSettings = { mode: "local" };

export function PreferencesModal({
  preferences,
  contextTabs,
  maxPrefsChars,
  onSave,
  assistantModel,
  assistantModelPickerOptions,
  onAssistantModelChange,
  initialTab,
}: {
  preferences: ChatPreference[];
  contextTabs: AssistantChatContextTab[];
  maxPrefsChars: number;
  onSave: (prefs: ChatPreference[]) => void;
  assistantModel: string;
  assistantModelPickerOptions: SettingsModelPickerOption[];
  onAssistantModelChange: (model: string) => void;
  initialTab?: AssistantPrefsModalTab;
}) {
  const [sectionTab, setSectionTab] = useState<AssistantPrefsModalTab>(initialTab ?? "model");
  const [draft, setDraft] = useState<ChatPreference[]>(() => [...preferences]);
  const [editing, setEditing] = useState<PrefsEditState | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);
  const enableErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  // Always-fresh close function - solves the stale-closure problem for Escape
  const closeModalFnRef = useRef<() => void>(() => {});
  closeModalFnRef.current = () => {
    // Auto-apply any in-progress edit with content before closing.
    //
    // The same two conditions the Apply button enforces, and for the same
    // reasons — closing the modal must not save something Apply would have
    // refused. Text is the older of the two; scope is the one that mattered:
    // unticking "All assistants" leaves `scope: []`, Apply goes grey, and Escape
    // used to write it anyway. An edit failing either test is dropped, exactly as
    // an edit with no text always has been.
    const scopeValid = editing == null || editing.scope === "all" || editing.scope.length > 0;
    let finalDraft = draft;
    if (editing && editing.text.trim() && scopeValid) {
      if (editing.id === "new") {
        finalDraft = [
          ...draft,
          {
            id: crypto.randomUUID(),
            name: editing.name.trim() || "Preference",
            text: editing.text,
            scope: editing.scope,
            disabled: false,
          },
        ];
      } else {
        finalDraft = draft.map((p) =>
          p.id === editing.id
            ? { ...p, name: editing.name.trim() || p.name, text: editing.text, scope: editing.scope }
            : p,
        );
      }
    }
    onSave(finalDraft);
  };
  function closeModal() { closeModalFnRef.current(); }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModalFnRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // intentionally empty - always calls latest via ref

  const contextLabelById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of contextTabs) m[t.contextId] = t.label;
    return m;
  }, [contextTabs]);

  function scopeLabel(scope: "all" | string[]) {
    if (scope === "all") return "All";
    // An empty list is not "All" — it applies to nothing. Saying "All" here was
    // the same escalation the store's reader used to make, only on screen: it
    // showed a preference as covering everything while it covered nothing, so
    // the one row that would have told the user something was wrong agreed with
    // the bug instead. The edit form's own trigger already calls this "None".
    if (scope.length === 0) return "None";
    if (scope.length === contextTabs.length) return "All";
    return scope.map((s) => contextLabelById[s] ?? s.slice(0, 8) + "…").join(", ");
  }

  function startNew() {
    setEditing({ id: "new", name: "", text: "", scope: "all" });
    setPendingDeleteId(null);
  }

  function startEdit(p: ChatPreference) {
    setEditing({ id: p.id, name: p.name, text: p.text, scope: p.scope });
    setPendingDeleteId(null);
  }

  function cancelEdit() {
    setEditing(null);
  }

  function applyEdit() {
    if (!editing || !editing.text.trim()) return;
    // The Apply button is already disabled for this, but the rule belongs on the
    // write and not only on the control: an empty scope is the one value of this
    // field that must never reach the draft, and the sibling writer above is
    // what happened last time it was only enforced on the button.
    if (editing.scope !== "all" && editing.scope.length === 0) return;
    if (editing.id === "new") {
      setDraft((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: editing.name.trim() || "Preference",
          text: editing.text,
          scope: editing.scope,
          disabled: false,
        },
      ]);
    } else {
      setDraft((prev) =>
        prev.map((p) =>
          p.id === editing.id
            ? { ...p, name: editing.name.trim() || p.name, text: editing.text, scope: editing.scope }
            : p,
        ),
      );
    }
    setEditing(null);
  }

  function tryToggleEnable(pref: ChatPreference) {
    if (!pref.disabled) {
      // Disabling is always allowed
      setDraft((prev) => prev.map((p) => p.id === pref.id ? { ...p, disabled: true } : p));
      setEnableError(null);
      return;
    }
    // Enabling: check that no affected context would exceed the quota
    const ctxs = contextTabs.length > 0
      ? contextTabs
      : [{ contextId: "self", label: "Me", aiAssistantUserId: "" }];
    const affected = ctxs.filter(
      (t) => pref.scope === "all" || (Array.isArray(pref.scope) && pref.scope.includes(t.contextId)),
    );
    const over: string[] = [];
    for (const tab of affected) {
      const currentChars = draft
        .filter((p) => p.id !== pref.id && !p.disabled &&
          (p.scope === "all" || (Array.isArray(p.scope) && p.scope.includes(tab.contextId))))
        .reduce((sum, p) => sum + p.text.length, 0);
      const total = currentChars + pref.text.length;
      if (total > maxPrefsChars) {
        over.push(`"${tab.label}" (${total.toLocaleString()}/${maxPrefsChars.toLocaleString()})`);
      }
    }
    if (over.length > 0) {
      const msg = `Cannot enable: quota exceeded for ${over.join(", ")}. Reduce the preference text first.`;
      setEnableError(msg);
      if (enableErrorTimer.current) clearTimeout(enableErrorTimer.current);
      enableErrorTimer.current = setTimeout(() => setEnableError(null), 5_000);
      return;
    }
    setDraft((prev) => prev.map((p) => p.id === pref.id ? { ...p, disabled: false } : p));
    setEnableError(null);
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    setDraft((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }

  function moveDown(idx: number) {
    setDraft((prev) => {
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }

  function deletePref(id: string) {
    setPendingDeleteId(id);
  }

  function confirmDelete(id: string) {
    setDraft((prev) => prev.filter((p) => p.id !== id));
    if (editing?.id === id) setEditing(null);
    setPendingDeleteId(null);
  }

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="prefs-modal-card prefs-modal-card--wide" onClick={(e) => e.stopPropagation()}>
        <div className="prefs-modal-header">
          <h3 className="modal-title">Chat preferences</h3>
          <button
            type="button"
            className="prefs-modal-close-btn"
            onClick={closeModal}
            aria-label="Close"
          >
            <IconX />
          </button>
        </div>

        <div className="prefs-modal-tabs" role="tablist" aria-label="Chat preference sections">
          <button
            type="button"
            role="tab"
            aria-selected={sectionTab === "model"}
            className={`prefs-modal-tab${sectionTab === "model" ? " prefs-modal-tab--active" : ""}`}
            onClick={() => setSectionTab("model")}
          >
            Model
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sectionTab === "prompts"}
            className={`prefs-modal-tab${sectionTab === "prompts" ? " prefs-modal-tab--active" : ""}`}
            onClick={() => setSectionTab("prompts")}
          >
            Prompt preferences
          </button>
        </div>

        {sectionTab === "model" ? (
          <div className="prefs-modal-model-section">
            <p className="prefs-modal-note">
              Choose the AI model for the assistant. This is the same setting as Settings → Assistant.
            </p>
            <SettingsModelPicker
              id="prefs-modal-assistant-model"
              className="settings-input"
              aria-label="Assistant model"
              value={assistantModel}
              options={assistantModelPickerOptions}
              onChange={onAssistantModelChange}
            />
          </div>
        ) : (
          <>
        <p className="prefs-modal-note">
          Preferences are appended to every message as user context. Keep them concise  avoid
          too long context to stay within the chat limit.{" "}
          <span className="prefs-modal-note-limit">
            Max: {maxPrefsChars.toLocaleString()} chars per assistant.
          </span>
        </p>

        <div className="prefs-modal-list">
          {draft.length === 0 && !editing && (
            <p className="prefs-modal-empty">No preferences yet. Add one below.</p>
          )}
          {draft.map((pref, idx) =>
            editing?.id === pref.id ? (
              <PrefsEditForm
                key={pref.id}
                value={editing}
                contextTabs={contextTabs}
                otherPrefs={draft.filter((p) => p.id !== pref.id)}
                maxPrefsChars={maxPrefsChars}
                onChange={setEditing}
                onApply={applyEdit}
                onCancel={cancelEdit}
              />
            ) : pendingDeleteId === pref.id ? (
              <div key={pref.id} className="prefs-modal-row prefs-modal-row--confirm">
                <span className="prefs-delete-confirm-text">Delete "{pref.name}"?</span>
                <div className="prefs-delete-confirm-btns">
                  <button
                    type="button"
                    className="modal-btn modal-btn--cancel"
                    onClick={() => setPendingDeleteId(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="modal-btn modal-btn--delete"
                    onClick={() => confirmDelete(pref.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <div key={pref.id} className={`prefs-modal-row${pref.disabled ? " prefs-modal-row--disabled" : ""}`}>
                <div className="prefs-modal-reorder">
                  <button
                    type="button"
                    className="prefs-reorder-btn"
                    onClick={() => moveUp(idx)}
                    disabled={idx === 0}
                    aria-label="Move up"
                  >▲</button>
                  <button
                    type="button"
                    className="prefs-reorder-btn"
                    onClick={() => moveDown(idx)}
                    disabled={idx === draft.length - 1}
                    aria-label="Move down"
                  >▼</button>
                </div>
                <div className="prefs-modal-row-body">
                  <div className="prefs-modal-row-meta">
                    <span className="prefs-modal-row-name">{pref.name}</span>
                    <span className="prefs-modal-row-scope">{scopeLabel(pref.scope)}</span>
                  </div>
                  <p className="prefs-modal-row-preview">
                    {pref.text.length > 100 ? pref.text.slice(0, 100) + "…" : pref.text}
                  </p>
                </div>
                <div className="prefs-modal-row-actions">
                  <button
                    type="button"
                    className={`prefs-toggle-btn${pref.disabled ? " prefs-toggle-btn--off" : ""}`}
                    onClick={() => tryToggleEnable(pref)}
                    aria-label={pref.disabled ? "Enable" : "Disable"}
                    title={pref.disabled ? "Enable" : "Disable"}
                  />
                  <button
                    type="button"
                    className="prefs-action-btn"
                    onClick={() => startEdit(pref)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="prefs-action-btn prefs-action-btn--delete"
                    onClick={() => deletePref(pref.id)}
                    aria-label="Delete"
                  >
                    <IconX />
                  </button>
                </div>
              </div>
            ),
          )}
          {editing?.id === "new" && (
            <PrefsEditForm
              value={editing}
              contextTabs={contextTabs}
              otherPrefs={draft}
              maxPrefsChars={maxPrefsChars}
              onChange={setEditing}
              onApply={applyEdit}
              onCancel={cancelEdit}
            />
          )}
        </div>

        {!editing && !pendingDeleteId && (
          <button type="button" className="prefs-modal-add-btn" onClick={startNew}>
            + Add preference
          </button>
        )}

        {enableError && (
          <div className="prefs-enable-error" role="alert" onClick={() => setEnableError(null)}>
            {enableError}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}
