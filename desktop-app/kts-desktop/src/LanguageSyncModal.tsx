import { getOutputLanguageLabel } from "./appConstants";

export type LanguageSyncModalProps = {
  pendingCode: string | null;
  dictationLang: string;
  pdfSummaryLang: string;
  googleMeetSummaryLang: string;
  onClose: () => void;
  onAlign: (code: string) => void;
};

export function LanguageSyncModal({
  pendingCode,
  dictationLang,
  pdfSummaryLang,
  googleMeetSummaryLang,
  onClose,
  onAlign,
}: LanguageSyncModalProps) {
  if (!pendingCode) return null;
  return (
    <div
      className="history-error-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="language-sync-title"
      onClick={onClose}
    >
      <div className="history-error-dialog glass-card" onClick={(e) => e.stopPropagation()}>
        <h3 id="language-sync-title" className="history-error-title">
          Align dictation, file summary, and Meet language?
        </h3>
        <p className="settings-hint" style={{ marginBottom: 10 }}>
          Your preferred output language is now{" "}
          <strong>{getOutputLanguageLabel(pendingCode)}</strong>.
        </p>
        <p className="settings-hint" style={{ marginBottom: 6 }}>
          Dictation currently uses <strong>{getOutputLanguageLabel(dictationLang)}</strong>.
        </p>
        <p className="settings-hint" style={{ marginBottom: 16 }}>
          File summary currently uses <strong>{getOutputLanguageLabel(pdfSummaryLang)}</strong>.
        </p>
        <p className="settings-hint" style={{ marginBottom: 16 }}>
          Meeting summary and to-dos currently use{" "}
          <strong>{getOutputLanguageLabel(googleMeetSummaryLang)}</strong>.
        </p>
        <div className="controls-row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Keep current
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onAlign(pendingCode)}>
            Align dictation, files, and Meet
          </button>
        </div>
      </div>
    </div>
  );
}
