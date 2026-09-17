import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { useCloseOnOutsidePress } from "./useCloseOnOutsidePress";
import { PdfDropZone, type PdfDropZoneHandle } from "./PdfDropZone";
import "./App.css";

const TRAY_NOTE_WIDTH = 380;

/** Aligné sur `TRAY_NOTE_FOCUS_EVENT` dans `src-tauri/src/lib.rs`. */
const TRAY_NOTE_FOCUS_EVENT = "kts:tray-note/focus";

type MicMode = "idle" | "recording" | "paused" | "processing";
type DictationTarget = "context" | "explanation";

type PdfSettings = {
  modelFilename: string;
  openaiApiKey: string;
  summaryLang: string;
  pagesMode: "count" | "percent";
  pagesCount: number;
  pagesPercent: number;
  warnThreshold: number;
  parallelism: number;
};

function InfoTooltip({ children }: { children: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useCloseOnOutsidePress(wrapRef, open, () => setOpen(false));
  return (
    <span ref={wrapRef} className="info-tooltip-wrap">
      <button
        type="button"
        className="info-tooltip-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="More information"
      >
        ⓘ
      </button>
      {open && (
        <span className="info-tooltip-content">
          {children}
        </span>
      )}
    </span>
  );
}

export default function TrayNotePanel() {
  const [context, setContext] = useState("");
  const [explanation, setExplanation] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const explanationRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  // Which textarea receives dictation results.
  const [dictTarget, setDictTarget] = useState<DictationTarget>("context");

  // ── PDF drop zone ─────────────────────────────────────────────────────────
  const [pdfSettings, setPdfSettings] = useState<PdfSettings | null>(null);
  const [pdfFilePath, setPdfFilePath] = useState<string | null>(null);
  const [pdfFileSize, setPdfFileSize] = useState<number | null>(null);
  const [pdfIsBusy, setPdfIsBusy] = useState(false);
  const pdfDropZoneRef = useRef<PdfDropZoneHandle>(null);

  // ── Inline mic ────────────────────────────────────────────────────────────
  const [micMode, setMicMode] = useState<MicMode>("idle");
  const [micElapsed, setMicElapsed] = useState(0);
  const micIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevMicModeRef = useRef<MicMode>("idle");

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
  const fmtTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  useEffect(() => {
    const prev = prevMicModeRef.current;
    prevMicModeRef.current = micMode;
    if (micMode === "recording") {
      if (prev !== "paused") setMicElapsed(0);
      if (micIntervalRef.current) clearInterval(micIntervalRef.current);
      micIntervalRef.current = setInterval(() => setMicElapsed((s) => s + 1), 1000);
    } else {
      clearMicTimer();
      if (micMode === "idle") setMicElapsed(0);
    }
    return () => {
      clearMicTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micMode]);

  // ── Auto-resize window to content ────────────────────────────────────────
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    // #root has `height: 100%` (fills the Tauri window), which makes shell.offsetHeight
    // equal to the window height instead of the content height.
    // Switching #root to fit-content lets it shrink to content size.
    // body keeps height:100% so it still fills the window with the right background.
    const root = document.getElementById("root");
    if (root) root.style.height = "fit-content";

    const win = getCurrentWindow();
    let rafId = 0;
    const sync = () => {
      const h = shell.offsetHeight;
      if (h > 0) {
        void win.setSize(new LogicalSize(TRAY_NOTE_WIDTH, h));
      }
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(sync);
    });
    ro.observe(shell);
    // Double-RAF: first frame settles the fit-content layout, second measures it.
    requestAnimationFrame(() => requestAnimationFrame(sync));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, []);

  // ── PDF settings: request from main window on mount ───────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const promise = listen<PdfSettings>("kts:tray-note/pdf-settings", ({ payload }) => {
      setPdfSettings(payload);
    }).then((fn) => { unlisten = fn; });

    // Request current settings from the main window.
    void emit("kts:tray-note/request-pdf-settings");

    return () => { void promise.then(() => { unlisten?.(); }); };
  }, []);

  useEffect(() => {
    const subs = [
      listen<string>("kts:tray-note/mic-mode", ({ payload }) => {
        setMicMode(payload as MicMode);
      }),
      listen<string>("kts:tray-note/dictation-result", ({ payload }) => {
        if (payload) {
          if (dictTarget === "explanation") {
            setExplanation((prev) => {
              const sep = prev.trim() ? "\n\n" : "";
              return prev.trimEnd() + sep + payload;
            });
          } else {
            setContext((prev) => {
              const sep = prev.trim() ? "\n\n" : "";
              return prev.trimEnd() + sep + payload;
            });
          }
        }
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((f) => f()));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictTarget]);

  const handleMicStart = async () => {
    try {
      await invoke("start_tray_dictation_cmd");
      startMicInterval();
      setMicMode("recording");
    } catch (e) {
      console.error("[TrayNote] mic start:", e);
      setErr(typeof e === "string" ? e : "Could not start the microphone.");
    }
  };

  const handleMicPause = async () => {
    clearMicTimer();
    setMicMode("paused");
    try {
      await invoke("pause_dictation_cmd");
    } catch (e) {
      console.error("[TrayNote] mic pause:", e);
    }
  };

  const handleMicResume = async () => {
    startMicInterval();
    setMicMode("recording");
    try {
      await invoke("resume_dictation_cmd");
    } catch (e) {
      console.error("[TrayNote] mic resume:", e);
      clearMicTimer();
      setMicMode("paused");
    }
  };

  const handleMicStop = async () => {
    clearMicTimer();
    setMicMode("processing");
    try {
      await invoke("stop_dictation_cmd");
    } catch (e) {
      console.error("[TrayNote] mic stop:", e);
      setMicMode("idle");
    }
  };

  // ── Focus / init ──────────────────────────────────────────────────────────

  useEffect(() => {
    document.title = "Capture note";
  }, []);

  useEffect(() => {
    setContext("");
    setExplanation("");
    setErr(null);
    setDictTarget("context");
    setPdfFilePath(null);
    setPdfFileSize(null);
    requestAnimationFrame(() => {
      contextRef.current?.focus();
    });

    let unlisten: (() => void) | undefined;
    const promise = listen<{ selection?: string | null }>(
      TRAY_NOTE_FOCUS_EVENT,
      ({ payload }) => {
        const sel = payload?.selection ?? null;
        setErr(null);
        setPdfFilePath(null);
        setPdfFileSize(null);
        // Re-request PDF settings in case they changed since last open.
        void emit("kts:tray-note/request-pdf-settings");
        if (sel) {
          setContext(sel);
          setExplanation("");
          setDictTarget("explanation");
          requestAnimationFrame(() => {
            const ta = explanationRef.current;
            if (!ta) return;
            ta.focus();
            ta.setSelectionRange(0, 0);
          });
        } else {
          setContext("");
          setExplanation("");
          setDictTarget("context");
          requestAnimationFrame(() => {
            contextRef.current?.focus();
          });
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });

    return () => {
      void promise.then(() => {
        unlisten?.();
      });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setContext("");
      setExplanation("");
      setErr(null);
      void invoke("hide_tray_note_window_cmd");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hide = useCallback(() => {
    void invoke("hide_tray_note_window_cmd");
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────

  const submit = async () => {
    setErr(null);
    const t = context.trim();
    if (!t) {
      setErr("Enter some context text.");
      return;
    }
    const exp = explanation.trim() || undefined;
    const langArg = pdfSettings?.summaryLang?.trim() || undefined;
    try {
      if (pdfFilePath) {
        await invoke("append_segment_document", {
          summary: t,
          filePath: pdfFilePath,
          explanation: exp,
          lang: langArg,
          fileSize: pdfFileSize ?? undefined,
        });
      } else {
        await invoke("append_segment_context", {
          text: t,
          explanation: exp,
          source: "manual",
          lang: langArg,
        });
      }
      setContext("");
      setExplanation("");
      setPdfFilePath(null);
      setPdfFileSize(null);
      hide();
    } catch (e) {
      const msg =
        typeof e === "string"
          ? e
          : e != null &&
              typeof e === "object" &&
              "message" in e &&
              typeof (e as { message: unknown }).message === "string"
            ? (e as { message: string }).message
            : String(e);
      setErr(msg);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="tray-note-shell" ref={shellRef}>
      <div className="tray-note-header">
        <img
          src="/kts-icon.png"
          alt=""
          className="tray-note-kts-icon"
          draggable={false}
        />
        <div className="tray-note-header-main">
          <p className="tray-note-title">Capture note</p>
          <InfoTooltip>
            {`Open this window with ⌘⌥X. If you have text selected when opening, it will pre-fill the context field and focus the explanation field. Use the mic button to dictate into the focused field.`}
          </InfoTooltip>
        </div>
      </div>

      <div className="tray-note-field-group">
        <label className="tray-note-field-label" htmlFor="tray-note-context">
          Context
        </label>

        {/* Drop zone OU chip fichier attaché - jamais les deux en même temps */}
        {pdfFilePath ? (
          <div className="tray-note-pdf-attachment">
            <span className="tray-note-pdf-attachment-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </span>
            <span className="tray-note-pdf-attachment-name" title={pdfFilePath}>
              {pdfFilePath.split("/").pop()}
            </span>
            <button
              type="button"
              className="tray-note-pdf-attachment-remove"
              onClick={() => { setPdfFilePath(null); setPdfFileSize(null); }}
              aria-label="Remove attached file"
              title="Remove file attachment"
            >
              ✕
            </button>
          </div>
        ) : pdfSettings ? (
          <PdfDropZone
            ref={pdfDropZoneRef}
            pagesMode={pdfSettings.pagesMode}
            pagesCount={pdfSettings.pagesCount}
            pagesPercent={pdfSettings.pagesPercent}
            warnThreshold={pdfSettings.warnThreshold}
            modelFilename={pdfSettings.modelFilename}
            openaiApiKey={pdfSettings.openaiApiKey}
            summaryLang={pdfSettings.summaryLang}
            parallelism={pdfSettings.parallelism}
            onBusyChange={setPdfIsBusy}
            onSummaryReady={(text, docName, filePath, fileSize, _rawContent) => {
              void (async () => {
                const sourcePath = filePath.trim();
                let persistedPath: string | null = null;
                if (sourcePath) {
                  try {
                    persistedPath = await invoke<string>("persist_context_source_file_cmd", {
                      path: sourcePath,
                    });
                  } catch (error) {
                    console.error("[TrayNote] unable to persist source file in app storage:", error);
                  }
                }
                const effectivePath = persistedPath || sourcePath || null;
                setContext((prev) => {
                  const sep = prev.trim() ? "\n\n" : "";
                  return prev.trimEnd() + sep + text;
                });
                setExplanation((prev) => {
                  const entry = `Summary of: ${docName}`;
                  const sep = prev.trim() ? "\n\n" : "";
                  return prev.trimEnd() + sep + entry;
                });
                setPdfFilePath(effectivePath);
                setPdfFileSize(fileSize > 0 ? fileSize : null);
              })();
            }}
          />
        ) : null}

        <textarea
          id="tray-note-context"
          ref={contextRef}
          className="tray-note-textarea"
          rows={3}
          value={context}
          onChange={(e) => setContext(e.target.value)}
          onFocus={() => setDictTarget("context")}
          placeholder="Highlighted text, link, detail…"
          aria-label="Context"
        />
      </div>

      <div className="tray-note-field-group">
        <label className="tray-note-field-label" htmlFor="tray-note-explanation">
          Explanation <span className="tray-note-field-optional">(optional)</span>
        </label>
        <textarea
          id="tray-note-explanation"
          ref={explanationRef}
          className="tray-note-textarea"
          rows={3}
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          onFocus={() => setDictTarget("explanation")}
          placeholder="Your note or dictation…"
          aria-label="Explanation"
        />
      </div>

      {err && (
        <p className="tray-note-error" role="alert">
          {err}
        </p>
      )}

      {/* ── Inline mic recorder ── */}
      <div className="tray-note-mic-row">
        {micMode === "idle" && (
          <button
            type="button"
            className="tray-note-mic-btn"
            onClick={handleMicStart}
            aria-label="Record voice note"
            title={`Dictate into ${dictTarget === "explanation" ? "explanation" : "context"}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="17" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </button>
        )}
        {(micMode === "recording" || micMode === "paused") && (
          <div className="tray-note-mic-controls">
            <span
              className={`tray-note-mic-dot tray-note-mic-dot--${micMode}`}
            />
            <span className="tray-note-mic-timer">{fmtTime(micElapsed)}</span>
            {micMode === "recording" ? (
              <button
                type="button"
                className="tray-note-mic-action tray-note-mic-pause"
                onClick={handleMicPause}
              >
                ⏸
              </button>
            ) : (
              <button
                type="button"
                className="tray-note-mic-action tray-note-mic-resume"
                onClick={handleMicResume}
              >
                ▶
              </button>
            )}
            <button
              type="button"
              className="tray-note-mic-action tray-note-mic-stop"
              onClick={handleMicStop}
            >
              Stop
            </button>
          </div>
        )}
        {micMode === "processing" && (
          <div className="tray-note-mic-controls">
            <span className="tray-note-mic-dot tray-note-mic-dot--processing" />
            <span className="tray-note-mic-timer">Processing…</span>
          </div>
        )}
      </div>


      <div className="tray-note-actions">
        <button type="button" className="btn btn-secondary" onClick={hide} disabled={pdfIsBusy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={pdfIsBusy}
        >
          OK
        </button>
      </div>
    </div>
  );
}
