import type { SVGProps } from "react";
import { OUTPUT_LANGUAGE_OPTIONS } from "./appConstants";
import { InfoTooltip, InfoTooltipProvider } from "./InfoTooltip";

/** Whisper.cpp catalog id for ~1.5 GB transcription model. */
export const ONBOARDING_WHISPER_MODEL_ID = "medium";
/** Qwen catalog id for ~2.6 GB general local model. */
export const ONBOARDING_QWEN_MODEL_ID = "qwen25-3b-q6k";

function IconOnboarding(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c0 1 3 3 6 3s6-2 6-3v-5" />
    </svg>
  );
}

export { IconOnboarding };

export type SetupOnboardingSource = "auto" | "manual";

type Props = {
  open: boolean;
  source: SetupOnboardingSource;
  onClose: () => void;
  onDismissForever: () => void;
  /** Opens Settings → AI tasks and scrolls to API key or Local models as needed. */
  onSetupNow: () => void;
  /** Opens Settings → AI tasks → File & Meet → Advanced → Google Meet (extension). */
  onConfigureMeetExtension: () => void;
  /** Same as Settings → Download extension (ZIP). */
  onDownloadExtensionZip: () => Promise<void>;
  /** While ZIP export runs. */
  downloadBusy: boolean;
  /** Success or error line from the last ZIP export (same state as Settings). */
  zipExportMessage: string | null;
  /** Account preferred output language (Settings → Account). */
  preferredOutputLang: string;
  preferredOutputLangSaving: boolean;
  preferredOutputLangError: string | null;
  onPreferredOutputLanguageChange: (code: string) => void;
};

/**
 * Shown when there is no OpenAI API key yet or local Whisper/Qwen models are not both installed.
 * Actions jump into Settings.
 */
const SETUP_SUMMARY =
  "Add your OpenAI API key under AI tasks so the Assistant can answer, draft, and brainstorm beside you. That same key turns on other OpenAI-powered features you choose in the app. Finish the optional local setup for fast, private dictation on this device.";

export default function SetupOnboardingModal({
  open,
  source: _source,
  onClose,
  onDismissForever,
  onSetupNow,
  onConfigureMeetExtension,
  onDownloadExtensionZip,
  downloadBusy,
  zipExportMessage,
  preferredOutputLang,
  preferredOutputLangSaving,
  preferredOutputLangError,
  onPreferredOutputLanguageChange,
}: Props) {
  void _source;

  if (!open) return null;

  return (
    <div
      className="history-error-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-onboarding-title"
      onClick={onClose}
    >
      <div
        className="history-error-dialog glass-card setup-onboarding-simple"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 690, width: "calc(100vw - 28px)" }}
      >
        <h3 id="setup-onboarding-title" className="history-error-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <IconOnboarding style={{ flexShrink: 0, opacity: 0.9 }} />
          Finish setup
        </h3>
        <div className="settings-hint" style={{ marginBottom: 6, lineHeight: 1.55, fontSize: 13 }}>
          <p style={{ margin: "0 0 8px" }}>
            <strong>Kety</strong> uses AI where it helps most: <strong>dictation</strong>,{" "}
            <strong>transcripts from screen recordings</strong>, <strong>summaries</strong>, <strong>smart tags</strong>,{" "}
            <strong>sensitive-content checks</strong>, and <strong>scans</strong> of what you bring in. Less manual
            cleanup, more clarity.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            The product was built around <strong>local models</strong> you <strong>download and turn on</strong> from{" "}
            <strong>Settings</strong> when you are ready.
          </p>
          <p style={{ margin: 0 }}>
            Prefer the same kind of help <strong>from the cloud</strong>? Add <strong>your OpenAI API key</strong>{" "}
            under Settings instead.
          </p>
        </div>
        <div className="setup-onboarding-plan-tabs setup-onboarding-plan-tabs--compact">
          <div className="settings-hint setup-onboarding-plan-panel">
            {SETUP_SUMMARY}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, marginTop: 6 }}>
          <button type="button" className="btn btn-primary btn-small" onClick={onSetupNow}>
            Open settings
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
            I&apos;ll do it later
          </button>
        </div>
        <div
          style={{
            borderTop: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
            paddingTop: 12,
            marginBottom: 12,
          }}
        >
          <InfoTooltipProvider>
            <div className="settings-field" style={{ marginBottom: 0 }}>
              <label className="settings-label" htmlFor="setup-onboarding-preferred-output-language">
                Preferred output language
                <InfoTooltip>
                  {
                    "Saved in your profile. Used as the default written language for generated text. When you change it, Kety can align Dictation, File processing summary language, and (if set to follow the account) Google Meet summary language. You can set Meet language explicitly under AI tasks → File & Meet summaries → Advanced → Google Meet."
                  }
                </InfoTooltip>
              </label>
              <select
                id="setup-onboarding-preferred-output-language"
                className="settings-input"
                value={preferredOutputLang}
                disabled={preferredOutputLangSaving}
                onChange={(e) => {
                  void onPreferredOutputLanguageChange(e.target.value);
                }}
                style={{ cursor: preferredOutputLangSaving ? "wait" : "pointer", maxWidth: "100%" }}
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
                  style={{ color: "var(--color-error, #f87171)", marginTop: 8, marginBottom: 0 }}
                >
                  {preferredOutputLangError}
                </p>
              ) : null}
            </div>
          </InfoTooltipProvider>
        </div>
        <div
          style={{
            borderTop: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
            paddingTop: 12,
            marginBottom: 12,
          }}
        >
          <p className="settings-hint" style={{ margin: "0 0 10px", lineHeight: 1.45, fontSize: 12.5 }}>
            <strong>Google Meet</strong> - our <strong>Chrome extension</strong> sends <strong>live notes and a meeting
            recap</strong> straight into your <strong>captures</strong> in Kety.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => void onDownloadExtensionZip()}
              disabled={downloadBusy}
            >
              {downloadBusy ? "Preparing…" : "Download extension (ZIP)"}
            </button>
            <button type="button" className="btn btn-primary btn-small" onClick={onConfigureMeetExtension}>
              Configure extension…
            </button>
          </div>
          {zipExportMessage ? (
            <p
              className="settings-hint"
              style={{
                marginTop: 10,
                marginBottom: 0,
                fontSize: 12,
                color: zipExportMessage.startsWith("Saved:")
                  ? "var(--color-text-muted, #94a3b8)"
                  : "var(--destructive, #c2410c)",
              }}
            >
              {zipExportMessage}
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-secondary btn-small" onClick={onDismissForever}>
            Don&apos;t show this again
          </button>
        </div>
      </div>
    </div>
  );
}
