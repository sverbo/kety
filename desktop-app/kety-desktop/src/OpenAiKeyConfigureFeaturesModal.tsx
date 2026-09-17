import { useMemo, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsModelPicker, type SettingsModelPickerOption } from "./SettingsModelPicker";
import {
  OPENAI_TEXT_MODEL_OPTIONS,
  openAiCloudSelectOptionPlainLabel,
  MODEL_RECOMMENDED_OPTION_SUFFIX,
} from "./openaiTextModelOptions";
import {
  type DictationProvider,
  DICTATION_PROVIDER_LOCAL,
  DICTATION_PROVIDER_OPENAI_WHISPER_1,
  type WhisperStatus,
  type QwenModelsStatus,
} from "./appTypes";
import {
  ASSISTANT_MODEL_OPTIONS,
  ASSISTANT_MODEL_DISABLED,
} from "./appConstants";

type OpenAiNewKeyModalSections = {
  assistant: boolean;
  pdf: boolean;
  tagSensitive: boolean;
  dictation: boolean;
};

function isDictationDisabledOrMissingLocalWhisper(
  dictationProvider: DictationProvider,
  whisperStatus: WhisperStatus | null,
): boolean {
  if (dictationProvider !== DICTATION_PROVIDER_LOCAL) return false;
  if (whisperStatus == null) return false;
  const sel = whisperStatus.selectedModel?.trim() ?? "";
  if (sel === "") return true;
  return !whisperStatus.models.some((m) => m.installed && m.filename === sel);
}

export function openAiNewKeyModalSections(
  assistantModel: string,
  pdfModelFilename: string,
  sensitiveScanModel: string,
  dictationProvider: DictationProvider,
  whisperStatus: WhisperStatus | null,
): OpenAiNewKeyModalSections {
  return {
    assistant: assistantModel === ASSISTANT_MODEL_DISABLED,
    pdf: pdfModelFilename === "",
    tagSensitive: sensitiveScanModel === "disabled",
    dictation: isDictationDisabledOrMissingLocalWhisper(dictationProvider, whisperStatus),
  };
}

export function openAiNewKeyModalHasAnySection(s: OpenAiNewKeyModalSections): boolean {
  return s.assistant || s.pdf || s.tagSensitive || s.dictation;
}

type OpenAiKeyConfigureFeaturesModalProps = {
  onDismiss: () => void;
  onOpenSettingsToSection: (sectionId: string) => void;
  qwenStatus: QwenModelsStatus | null;
  assistantModel: string;
  setAssistantModel: Dispatch<SetStateAction<string>>;
  pdfModelFilename: string;
  setPdfModelFilename: Dispatch<SetStateAction<string>>;
  sensitiveScanModel: string;
  setSensitiveScanModel: Dispatch<SetStateAction<string>>;
  setQwenStatus: Dispatch<SetStateAction<QwenModelsStatus | null>>;
  dictationProvider: DictationProvider;
  setDictationProvider: Dispatch<SetStateAction<DictationProvider>>;
  whisperStatus: WhisperStatus | null;
};

export function OpenAiKeyConfigureFeaturesModal({
  onDismiss,
  onOpenSettingsToSection,
  qwenStatus,
  assistantModel,
  setAssistantModel,
  pdfModelFilename,
  setPdfModelFilename,
  sensitiveScanModel,
  setSensitiveScanModel,
  setQwenStatus,
  dictationProvider,
  setDictationProvider,
  whisperStatus,
}: OpenAiKeyConfigureFeaturesModalProps) {
  const sections = openAiNewKeyModalSections(
    assistantModel,
    pdfModelFilename,
    sensitiveScanModel,
    dictationProvider,
    whisperStatus,
  );
  const hasAnySection = openAiNewKeyModalHasAnySection(sections);

  const selectStyle: CSSProperties = {
    width: "100%",
    marginTop: 8,
    cursor: "pointer",
  };

  const configureAssistantOptions = useMemo((): SettingsModelPickerOption[] => {
    const opts: SettingsModelPickerOption[] = [
      { value: ASSISTANT_MODEL_DISABLED, label: "Disabled (AI assistant off)", kind: "none" },
    ];
    for (const m of ASSISTANT_MODEL_OPTIONS) {
      opts.push({
        value: m.value,
        label: `${m.label}${m.recommended ? MODEL_RECOMMENDED_OPTION_SUFFIX : ""}`,
        kind: "openai",
      });
    }
    return opts;
  }, []);

  const configurePdfOptions = useMemo((): SettingsModelPickerOption[] => {
    const opts: SettingsModelPickerOption[] = [
      { value: "", label: "None (file drop disabled)", kind: "none" },
    ];
    for (const m of (qwenStatus?.models ?? []).filter((x) => x.installed)) {
      opts.push({ value: m.filename, label: m.label, kind: "local" });
    }
    for (const m of OPENAI_TEXT_MODEL_OPTIONS) {
      opts.push({
        value: m.value,
        label: openAiCloudSelectOptionPlainLabel(m),
        kind: "openai",
      });
    }
    return opts;
  }, [qwenStatus?.models]);

  const configureTagSensitiveOptions = useMemo((): SettingsModelPickerOption[] => {
    const opts: SettingsModelPickerOption[] = [{ value: "disabled", label: "Disabled", kind: "none" }];
    for (const m of (qwenStatus?.models ?? []).filter((x) => x.installed)) {
      opts.push({ value: `local:${m.filename}`, label: m.label, kind: "local" });
    }
    for (const m of OPENAI_TEXT_MODEL_OPTIONS) {
      opts.push({
        value: m.value,
        label: openAiCloudSelectOptionPlainLabel(m),
        kind: "openai",
      });
    }
    return opts;
  }, [qwenStatus?.models]);

  const configureDictationMicOptions = useMemo(
    (): SettingsModelPickerOption[] => [
      {
        value: DICTATION_PROVIDER_LOCAL,
        label: "Local Whisper (choose a bundle in Settings)",
        kind: "local",
      },
      {
        value: DICTATION_PROVIDER_OPENAI_WHISPER_1,
        label: "OpenAI Whisper (uses your API key)",
        kind: "openai",
      },
    ],
    [],
  );

  const titleId = "openai-key-configure-title";

  return (
    <div
      className="history-error-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onDismiss}
    >
      <div
        className="history-error-dialog glass-card"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 540, width: "calc(100vw - 32px)" }}
      >
        <h3 id={titleId} className="history-error-title">
          OpenAI API key saved
        </h3>
        <p className="settings-hint" style={{ marginBottom: 14, lineHeight: 1.55 }}>
          Features below are still <strong>off</strong> or <strong>Disabled</strong>. They can use{" "}
          <strong>OpenAI cloud models</strong> from this device or <strong>local Qwen</strong> where
          installed. Pick a model only where you want to turn something on:
        </p>
        <div style={{ maxHeight: "min(58vh, 440px)", overflowY: "auto", paddingRight: 6 }}>
          {!hasAnySection ? (
            <p className="settings-hint" style={{ margin: 0, lineHeight: 1.5 }}>
              Nothing here still needs a change-you can close this dialog.
            </p>
          ) : null}
          {sections.assistant ? (
            <div style={{ marginBottom: 20 }}>
              <div className="settings-label" style={{ fontWeight: 600, marginBottom: 4 }}>
                AI Assistant (chat)
              </div>
              <p className="settings-hint" style={{ margin: 0, lineHeight: 1.45 }}>
                Assistant is off. Pick a GPT model (uses this key) or a local Qwen model.
              </p>
              <SettingsModelPicker
                id="openai-key-configure-assistant-model"
                className="settings-input"
                style={selectStyle}
                aria-label="Assistant model"
                value={assistantModel}
                options={configureAssistantOptions}
                onChange={(v) => {
                  setAssistantModel(v);
                }}
              />
            </div>
          ) : null}

          {sections.pdf ? (
            <div style={{ marginBottom: 20 }}>
              <div className="settings-label" style={{ fontWeight: 600, marginBottom: 4 }}>
                Document summary - file processing
              </div>
              <p className="settings-hint" style={{ margin: 0, lineHeight: 1.45 }}>
                No summary model is selected. In Captures, dropping or picking a PDF/document still
                starts the flow, but it <strong>stops with an error</strong> until you choose a model
                here (no summary is produced). Pick a model to enable summarization:
              </p>
              <SettingsModelPicker
                id="openai-key-configure-pdf-model"
                className="settings-input"
                style={selectStyle}
                aria-label="Document summary model"
                value={pdfModelFilename}
                options={configurePdfOptions}
                onChange={(next) => {
                  setPdfModelFilename(next);
                }}
              />
            </div>
          ) : null}

          {sections.tagSensitive ? (
            <div style={{ marginBottom: 20 }}>
              <div className="settings-label" style={{ fontWeight: 600, marginBottom: 4 }}>
                Tags &amp; sensitive scan
              </div>
              <p className="settings-hint" style={{ margin: 0, lineHeight: 1.45 }}>
                The model for automatic tagging and sensitive-content scan is disabled. Choose one model for both:
              </p>
              <SettingsModelPicker
                id="openai-key-configure-tag-sensitive-model"
                className="settings-input"
                style={selectStyle}
                aria-label="Tags and sensitive scan model"
                value={sensitiveScanModel}
                options={configureTagSensitiveOptions}
                onChange={(next) => {
                  setSensitiveScanModel(next);
                  if (next.startsWith("local:")) {
                    const filename = next.slice(6);
                    void invoke("set_qwen_local_model_cmd", { filename })
                      .then(() => invoke<QwenModelsStatus>("check_qwen_models_cmd"))
                      .then(setQwenStatus)
                      .catch(console.error);
                  }
                }}
              />
            </div>
          ) : null}

          {sections.dictation ? (
            <div style={{ marginBottom: 20 }}>
              <div className="settings-label" style={{ fontWeight: 600, marginBottom: 4 }}>
                Dictation & screen recording mic
              </div>
              <p className="settings-hint" style={{ margin: 0, lineHeight: 1.45 }}>
                Dictation is off: no on-device Whisper bundle is selected. Switch to OpenAI Whisper (this key) or pick a
                local bundle under <strong>AI tasks → Local models</strong>.
              </p>
              <SettingsModelPicker
                id="openai-key-configure-dictation-mic"
                className="settings-input"
                style={selectStyle}
                aria-label="Dictation microphone model"
                value={dictationProvider}
                options={configureDictationMicOptions}
                onChange={(v) => {
                  const next = v as DictationProvider;
                  setDictationProvider(
                    next === DICTATION_PROVIDER_OPENAI_WHISPER_1
                      ? DICTATION_PROVIDER_OPENAI_WHISPER_1
                      : DICTATION_PROVIDER_LOCAL,
                  );
                }}
              />
            </div>
          ) : null}
        </div>
        <div
          className="controls-row"
          style={{ flexWrap: "wrap", gap: 8, justifyContent: "flex-end", marginTop: 16 }}
        >
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              onDismiss();
              onOpenSettingsToSection("settings-llm-api-key");
            }}
          >
            Open Settings
          </button>
          <button type="button" className="btn btn-primary" onClick={onDismiss}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
