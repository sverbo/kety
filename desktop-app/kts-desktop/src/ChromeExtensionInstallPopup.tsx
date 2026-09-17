import type { Dispatch, SetStateAction } from "react";

export type ChromeExtensionInstallPopupProps = {
  open: boolean;
  onClose: Dispatch<SetStateAction<boolean>> | (() => void);
};

export function ChromeExtensionInstallPopup({ open, onClose }: ChromeExtensionInstallPopupProps) {
  if (!open) return null;
  const close = () => (onClose as () => void)();
  return (
    <div
      className="history-error-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chrome-ext-install-title"
      onClick={close}
    >
      <div
        className="history-popup-solid"
        style={{ maxWidth: 540, maxHeight: "85vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 id="chrome-ext-install-title" className="history-error-title" style={{ margin: 0 }}>
            Install the Meet extension
          </h3>
          <button type="button" className="btn btn-ghost btn-small" onClick={close}>✕</button>
        </div>
        <p className="settings-hint" style={{ marginBottom: 14, lineHeight: 1.55 }}>
          You use <strong>live captions</strong> in Google Meet; the extension reads what appears on screen and can
          send it to Kety on this computer. Keep Kety open while you work through the steps below.
        </p>
        <ol
          className="settings-hint"
          style={{ margin: "0 0 0 1.1rem", padding: 0, lineHeight: 1.55, fontSize: "0.9rem" }}
        >
          <li style={{ marginBottom: 12 }}>
            <strong>In Kety:</strong> open <strong>Settings → Captures → Chrome extension</strong>. Your{" "}
            <strong>link code</strong> (and port if you changed it) should already be there-Kety can create a code on
            first launch.
          </li>
          <li style={{ marginBottom: 12 }}>
            <strong>Download the ZIP</strong> on that same screen, then unzip the folder. Do not share the ZIP; it
            contains your link to Kety.
          </li>
          <li style={{ marginBottom: 12 }}>
            <strong>In Chrome:</strong> open <code style={{ fontSize: "0.85em" }}>chrome://extensions</code> (or
            Menu → Extensions → <strong>Manage extensions</strong>). Turn on <strong>Developer mode</strong>, click{" "}
            <strong>Load unpacked</strong>, and choose the unzipped folder.
          </li>
          <li style={{ marginBottom: 12 }}>
            <strong>Join a Meet</strong> on <code style={{ fontSize: "0.85em" }}>meet.google.com</code> and turn on{" "}
            <strong>captions (CC)</strong>. The extension only sees text when captions are on.
          </li>
          <li style={{ marginBottom: 12 }}>
            <strong>Send text to Kety:</strong> either turn on{" "}
            <strong>Send transcript to Kety when I close the Meet tab</strong> in Settings, or use{" "}
            <strong>Sync with app</strong> in the extension when you are ready. Kety must be running.
          </li>
        </ol>
        <details style={{ marginTop: 8, marginBottom: 4 }}>
          <summary className="settings-hint" style={{ cursor: "pointer", fontWeight: 600, userSelect: "none" }}>
            Advanced / developers
          </summary>
          <div className="settings-hint" style={{ marginTop: 10, lineHeight: 1.5, fontSize: "0.85rem", opacity: 0.95 }}>
            <p style={{ margin: "0 0 8px" }}>
              Instead of the ZIP, you can load the <code style={{ fontSize: "0.85em" }}>chrome-extension</code>{" "}
              folder from the Kety source tree, then paste the link code and port from Kety into the extension
              Options.
            </p>
            <p style={{ margin: 0 }}>
              Launching Kety from a terminal: <code style={{ fontSize: "0.85em" }}>KETY_MEET_BRIDGE_TOKEN</code> and{" "}
              <code style={{ fontSize: "0.85em" }}>KETY_MEET_BRIDGE_PORT</code> override the values saved in Settings.
              The bundled <code style={{ fontSize: "0.85em" }}>kety-bridge-preset.json</code> in the ZIP applies the
              same values without opening Options first.
            </p>
          </div>
        </details>
        <div className="controls-row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
