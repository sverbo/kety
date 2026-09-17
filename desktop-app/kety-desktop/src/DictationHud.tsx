import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import "./DictationHud.css";

const HUD_DEFAULT_WIDTH = 268;
const HUD_DEFAULT_HEIGHT = 44;

// Size of the result box. Must stay in sync with HUD_RESULT_WIDTH / HUD_RESULT_HEIGHT
// in hud_commands.rs, which pre-sizes the window before placing it on screen.
const HUD_RESULT_WIDTH = 320;
const HUD_RESULT_HEIGHT = 68;

// Size of the follow-up chat. The width stays the result box's: macOS resizes a window around
// its bottom-left corner, so keeping it lets the chat grow upwards from exactly where the bubble
// was. Growing upwards is only safe as long as there is room above — see setHudSize, which has
// the backend pull the window back onto the display once every resize has landed.
const HUD_CHAT_WIDTH = HUD_RESULT_WIDTH;

/** About a third of the display — the height the chat aims for. */
const HUD_CHAT_SCREEN_FRACTION = 1 / 3;
/** Never smaller than this, or the conversation stops being readable on a short display. */
const HUD_CHAT_MIN_HEIGHT = 240;
/** Never larger than this, so the chat stays a panel rather than taking over a big display. */
const HUD_CHAT_MAX_HEIGHT = 680;
/** Gap left above the chat so it never reaches the top edge of the work area. */
const HUD_CHAT_TOP_GAP = 24;
/** Gap the HUD keeps below itself — HUD_BOTTOM_MARGIN_PX in hud_commands.rs. */
const HUD_BOTTOM_MARGIN = 14;
/** Used only if the display reports no size at all. */
const HUD_CHAT_FALLBACK_HEIGHT = 244;

/**
 * How tall the chat should be on the display it is currently on.
 *
 * Read from `window.screen` rather than Tauri's `currentMonitor()`: it is synchronous (so the
 * window is resized in the same tick the mode changes, with no frame at the wrong size), it is
 * already in the logical pixels `LogicalSize` expects instead of physical ones that would have
 * to be divided by a scale factor, and it exposes `availHeight` — the work area minus the menu
 * bar and the Dock — which is exactly what the HUD has to fit inside and which the JS monitor
 * API does not give. Both follow the window, so a HUD on a second monitor is measured against
 * that monitor and not the primary one.
 */
function hudChatHeight(): number {
  const screenHeight = window.screen?.height ?? 0;
  if (!screenHeight) return HUD_CHAT_FALLBACK_HEIGHT;
  const workHeight = window.screen?.availHeight || screenHeight;
  const wanted = Math.min(
    Math.max(screenHeight * HUD_CHAT_SCREEN_FRACTION, HUD_CHAT_MIN_HEIGHT),
    HUD_CHAT_MAX_HEIGHT,
  );
  const fits = workHeight - HUD_BOTTOM_MARGIN - HUD_CHAT_TOP_GAP;
  return Math.round(Math.max(HUD_DEFAULT_HEIGHT, Math.min(wanted, fits)));
}

/** How long the result box stays on screen while the pointer is away from it. */
const RESULT_AUTO_HIDE_MS = 8000;
/** How long the copy button shows its "Copied" confirmation. */
const COPIED_FEEDBACK_MS = 1600;

/** Même ressource que la landing (`HomePage`) : PNG à fond transparent. */
const HUD_ICON_SRC = "/kts-icon.png";

// ── Sound wave indicator ───────────────────────────────────────────────────────
function SoundWave() {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const mutedRef   = useRef<HTMLSpanElement>(null);
  const animRef    = useRef<number>(0);
  const hasSndRef  = useRef(false);

  // Toggle between canvas bars and muted-mic icon without React re-renders
  const applyState = (hasSound: boolean) => {
    if (hasSndRef.current === hasSound) return;
    hasSndRef.current = hasSound;
    if (canvasRef.current) canvasRef.current.style.display = hasSound ? "block" : "none";
    if (mutedRef.current)  mutedRef.current.style.display  = hasSound ? "none"  : "flex";
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let stopped = false;
    let stream:   MediaStream  | null = null;
    let audioCtx: AudioContext | null = null;

    const BARS  = 5;
    const BAR_W = 2;
    const GAP   = 2;
    const CSS_W = 20;
    const CSS_H = 14;
    const dpr   = window.devicePixelRatio || 1;
    canvas.width  = CSS_W * dpr;
    canvas.height = CSS_H * dpr;
    canvas.style.width  = `${CSS_W}px`;
    canvas.style.height = `${CSS_H}px`;

    const c = canvas.getContext("2d")!;
    c.scale(dpr, dpr);

    const totalW = BARS * BAR_W + (BARS - 1) * GAP;
    const startX = (CSS_W - totalW) / 2;

    const drawBars = (data: Uint8Array) => {
      c.clearRect(0, 0, CSS_W, CSS_H);
      for (let i = 0; i < BARS; i++) {
        const x  = startX + i * (BAR_W + GAP);
        const bi = Math.floor((i / BARS) * data.length);
        const h  = Math.max(2, Math.round((data[bi] / 255) * (CSS_H - 2)));
        const y  = Math.round((CSS_H - h) / 2);
        c.fillStyle = "rgba(48,209,88,0.9)";
        c.fillRect(x, y, BAR_W, h);
      }
    };

    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        stream   = s;
        audioCtx = new AudioContext();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 32;
        audioCtx.createMediaStreamSource(s).connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          if (stopped) return;
          analyser.getByteFrequencyData(buf);
          let sum = 0;
          for (let j = 0; j < buf.length; j++) sum += buf[j];
          const hasSound = sum / buf.length > 10;
          applyState(hasSound);
          if (hasSound) drawBars(buf);
          animRef.current = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => { /* mic denied - muted icon stays visible */ });

    return () => {
      stopped = true;
      cancelAnimationFrame(animRef.current);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => {});
    };
  }, []);

  return (
    <>
      {/* canvas: hidden until sound is detected */}
      <canvas ref={canvasRef} className="hud-wave" style={{ display: "none" }} />
      {/* muted-mic icon: visible by default until sound kicks in */}
      <span ref={mutedRef} className="hud-mic-muted" aria-label="No audio" style={{ display: "flex" }}>
        <svg width="11" height="13" viewBox="0 0 11 13" fill="none" aria-hidden="true">
          {/* mic body */}
          <rect x="3.25" y="0.5" width="4.5" height="6.5" rx="2.25" fill="rgba(210,40,30,0.72)" />
          {/* arc + stem + base */}
          <path
            d="M1.5 6C1.5 8.76 3.24 11 5.5 11s4-2.24 4-5"
            stroke="rgba(210,40,30,0.72)" strokeWidth="1.25" strokeLinecap="round" fill="none"
          />
          <line x1="5.5" y1="11" x2="5.5" y2="12.5" stroke="rgba(210,40,30,0.72)" strokeWidth="1.25" strokeLinecap="round"/>
          <line x1="3"   y1="12.5" x2="8" y2="12.5"  stroke="rgba(210,40,30,0.72)" strokeWidth="1.25" strokeLinecap="round"/>
          {/* slash */}
          <line x1="0.5" y1="1" x2="10.5" y2="12" stroke="rgba(190,20,10,0.85)" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
      </span>
    </>
  );
}

// ── Copy button icons ──────────────────────────────────────────────────────────
function IconCopy() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** The microphone the follow-up chat offers instead of typing. */
function IconMic() {
  return (
    <svg width="12" height="13" viewBox="0 0 12 13" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="1" width="4" height="7" rx="2" fill="currentColor" stroke="none" />
      <path d="M2 6.2a4 4 0 0 0 8 0" />
      <line x1="6" y1="10.2" x2="6" y2="12" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * The HUD often has no keyboard focus, and the web clipboard API refuses to write from an
 * unfocused document — the backend writes the clipboard directly when that happens.
 */
async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    await invoke("copy_text_to_clipboard", { text });
  }
}

type HudMode =
  | "dictation"
  | "dictation-paused"
  | "screen-ready"
  | "screen"
  | "screen-paused"
  | "processing"
  | "preparing"
  | "text-actions"
  | "text-actions-processing"
  | "result"
  | "chat"
  | "idle";

interface TextAction {
  id: string;
  title: string;
  prompt: string;
}

interface TextActionsPayload {
  selectedText: string;
  actions: TextAction[];
  saveToHistory: boolean;
}

/** Text that was just dictated or transformed, shown in the HUD whatever happened to it. */
interface ResultPayload {
  text: string;
  source: string;
  /**
   * The request a model already answered to produce `text`. Present only when a model was
   * involved — that is what makes the result something the user can argue with, so it is also
   * what decides whether the HUD offers to carry on the conversation.
   */
  chatPrompt?: string | null;
}

/** One turn of the follow-up conversation. `error` turns are shown but never sent to the model. */
interface ChatMessage {
  role: "user" | "assistant" | "error";
  text: string;
}

/**
 * What the chat's microphone is doing.
 *
 * `transcribing` is its own state rather than a spinner over `recording`: the recording has
 * already stopped by then, and a button that still says "stop" would invite a second click that
 * has nothing left to stop.
 */
type ChatMicState = "idle" | "recording" | "transcribing";

/** What the microphone button says it will do, in each of its three states. */
const CHAT_MIC_LABEL: Record<ChatMicState, string> = {
  idle: "Speak instead of typing",
  recording: "Stop and add what you said",
  transcribing: "Writing down what you said…",
};

/**
 * Makes an element a handle the whole window can be dragged by.
 *
 * Tauri only starts a drag when the element directly under the pointer carries the attribute, so
 * this goes on the chrome: the bar the app icon and the label sit in. Both of those are
 * `pointer-events: none`, so the bar itself receives the click and the whole width of it drags.
 * Never on the conversation, which has to scroll, on the input, which has to select text, or on
 * a button.
 *
 * The same mousedown tells the backend the user is taking over: from then on nothing moves the
 * HUD for them.
 */
const dragHandleProps = {
  "data-tauri-drag-region": true,
  onMouseDown: () => {
    void invoke("mark_hud_moved_by_user_cmd").catch((e) =>
      console.error("[DictationHud] drag notice failed:", e),
    );
  },
} as const;

/**
 * `run_text_action_cmd` takes a single prompt, not a list of messages, so the exchange is
 * written out as plain text: the request the model already answered, then every turn since,
 * then what it is being asked to do now.
 */
function composeChatPrompt(request: string, messages: ChatMessage[]): string {
  const parts: string[] = [
    "You and someone are working on a piece of text together.",
    "",
    "This is what they asked you for to begin with:",
    "",
    request.trim(),
    "",
    "This is how it has gone so far:",
    "",
  ];
  for (const message of messages) {
    if (message.role === "assistant") {
      parts.push("You wrote:", message.text, "");
    } else if (message.role === "user") {
      parts.push("They replied:", message.text, "");
    }
  }
  // No "and nothing else" here: `run_text_action_cmd` appends the output-only rule to every
  // prompt it runs, and saying it twice in slightly different words helps no model.
  parts.push("Answer their last reply with the new version of the text.");
  return parts.join("\n");
}

export default function DictationHud() {
  const [mode, setMode] = useState<HudMode>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [briefWarning, setBriefWarning] = useState<string | null>(null);
  const [textActionsPayload, setTextActionsPayload] = useState<TextActionsPayload | null>(null);
  const [textActionsError, setTextActionsError] = useState<string | null>(null);
  const [customActionOpen, setCustomActionOpen] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [resultHovered, setResultHovered] = useState(false);
  /** Which copy button is showing its confirmation: "result", or "chat-<index>". */
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  /** Whether speech-to-text is set up. False until asked, so the button is never offered blind. */
  const [chatMicAvailable, setChatMicAvailable] = useState(false);
  const [chatMicState, setChatMicState] = useState<ChatMicState>("idle");

  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevModeRef    = useRef<HudMode>("idle");
  const briefWarnRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultHideRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Milliseconds left before the result box hides itself; hovering freezes this value. */
  const resultLeftRef  = useRef(RESULT_AUTO_HIDE_MS);
  /** The result the current countdown belongs to, so a new one starts a fresh countdown. */
  const resultShownRef = useRef<ResultPayload | null>(null);
  /** True while a text action is running: its result will re-show the HUD, so don't hide it. */
  const resultPendingRef = useRef(false);
  /** The request the model already answered; the follow-up conversation is appended to it. */
  const chatPromptRef = useRef("");
  const chatLogRef    = useRef<HTMLDivElement>(null);
  const chatInputRef  = useRef<HTMLInputElement>(null);
  /**
   * True from the moment the chat's microphone is asked to record until its transcript is back.
   *
   * The recording it starts is the same one a dictation uses, so it raises the same
   * `kts:dictation/started` event — and the handler for that event starts the recording timer and
   * clears the stopping state, neither of which the chat has any use for.
   */
  const chatMicActiveRef = useRef(false);
  /** Where the caret goes once a dictated transcript has been written into the input. */
  const chatCaretRef = useRef<number | null>(null);
  /** True dès que le backend a ouvert le micro (`kts:dictation/started` ou HUD remonté en dictée active). */
  const dictationMicLiveRef = useRef(false);

  const fmt = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // ── Timer piloté par mode ─────────────────────────────────────────────────
  // On dérive le comportement du timer directement depuis l'état `mode`,
  // sans jamais appeler de fonctions timer dans des state updaters.

  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;

    if (mode !== "dictation" && mode !== "dictation-paused") {
      dictationMicLiveRef.current = false;
    }

    if (mode === "screen") {
      const isResume = prev === "screen-paused";
      if (!isResume) setElapsed(0);
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else if (mode === "dictation") {
      const isResume = prev === "dictation-paused";
      if (isResume) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      } else {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
        setElapsed(0);
        // Micro déjà actif (ex. `get_hud_state` = dictation après `started`) → chrono tout de suite.
        if (dictationMicLiveRef.current) {
          intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
        }
      }
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (mode === "idle" || mode === "screen-ready") setElapsed(0);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [mode]);

  // Arrête l'interval immédiatement (synchrone, pas d'attente d'effet)
  const clearTimer = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  // Démarre ou redémarre l'interval immédiatement
  const startInterval = () => {
    clearTimer();
    intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  };

  /**
   * Says something short across the top of the HUD and takes it away again.
   *
   * The one place the HUD has to tell the user something that is not a mode: a microphone that
   * would not start, a transcription that came back with nothing. Only touches refs and setters,
   * so it is safe to call from listeners registered once.
   */
  const showBriefWarning = (message: string, ms = 3200) => {
    if (briefWarnRef.current) clearTimeout(briefWarnRef.current);
    setBriefWarning(message);
    briefWarnRef.current = setTimeout(() => setBriefWarning(null), ms);
  };

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    invoke<HudMode>("get_hud_state_cmd")
      .then((m) => {
        if (m === "dictation") {
          dictationMicLiveRef.current = true;
        }
        setMode(m);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Listeners (layout : avant peinture pour recevoir `dictation/started` sans course) ──

  useLayoutEffect(() => {
    const onDictationMicLive = () => {
      // The chat's microphone opens the same recording, and the conversation has neither a timer
      // to run nor a Stop button to re-enable — leave the HUD exactly as the user left it.
      if (chatMicActiveRef.current) return;
      setStopping(false);
      dictationMicLiveRef.current = true;
      clearTimer();
      setElapsed(0);
      startInterval();
    };
    const onScreenCaptureLive = () => {
      setStopping(false);
      clearTimer();
      setElapsed(0);
      startInterval();
    };
    const subs = [
      listen<string>("kts:hud/mode", ({ payload }) => {
        setStopping(false);
        setConfirming(false);
        setMode(payload as HudMode);
      }),
      listen("kts:dictation/started", onDictationMicLive),
      listen("kts:screenrecord/started", onScreenCaptureLive),
      listen("kts:dictation/stopped",      () => setStopping(false)),
      listen("kts:dictation/error",        () => setStopping(false)),
      listen("kts:screenrecord/stopped",   () => setStopping(false)),
      listen<string>("kts:screenrecord/error", ({ payload }) => {
        setStopping(false);
        showBriefWarning(payload.length > 180 ? `${payload.slice(0, 180)}…` : payload, 8000);
      }),
      listen<string>("kts:hud/brief-warning", ({ payload }) => {
        showBriefWarning(payload);
      }),
      listen<TextActionsPayload>("kts:hud/text-actions", ({ payload }) => {
        setStopping(false);
        setConfirming(false);
        setTextActionsPayload(payload);
        setTextActionsError(null);
        setCustomActionOpen(false);
        setCustomInstruction("");
        setMode("text-actions");
      }),
      listen<ResultPayload>("kts:hud/result", ({ payload }) => {
        setStopping(false);
        setConfirming(false);
        setCopiedKey(null);
        resultPendingRef.current = false;
        setResult(payload);
        setMode("result");
      }),
    ];
    return () => {
      if (briefWarnRef.current) clearTimeout(briefWarnRef.current);
      if (copiedRef.current) clearTimeout(copiedRef.current);
      subs.forEach((p) => p.then((f) => f()));
    };
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleStop = async () => {
    if (stopping) return;
    const wasScreen = mode === "screen" || mode === "screen-paused";
    clearTimer(); // synchrone
    setStopping(true);
    setMode("processing");
    try {
      await invoke(wasScreen ? "stop_screen_record_cmd" : "stop_dictation_cmd");
    } catch (e) {
      console.error("[DictationHud] stop error:", e);
      setStopping(false);
      startInterval();
      setMode(wasScreen ? "screen" : "dictation");
    }
  };

  const handlePause = async () => {
    const isScreen = mode === "screen";
    clearTimer(); // synchrone - le timer s'arrête immédiatement
    setMode(isScreen ? "screen-paused" : "dictation-paused");
    try {
      await invoke(isScreen ? "pause_screen_record_cmd" : "pause_dictation_cmd");
    } catch (e) {
      console.error("[DictationHud] pause error:", e);
      // Pas de revert : le timer est déjà arrêté, on reste en paused
    }
  };

  const handleResume = async () => {
    const isScreen = mode === "screen-paused";
    startInterval(); // synchrone - le timer reprend immédiatement
    setMode(isScreen ? "screen" : "dictation");
    try {
      await invoke(isScreen ? "resume_screen_record_cmd" : "resume_dictation_cmd");
    } catch (e) {
      console.error("[DictationHud] resume error:", e);
      clearTimer();
      setMode(isScreen ? "screen-paused" : "dictation-paused");
    }
  };

  const handleStart = async () => {
    try { await invoke("start_screen_record_cmd"); }
    catch (e) { console.error("[DictationHud] start error:", e); }
  };

  // Resize window for text-actions / restore to default.
  // The text-actions height formula must match show_text_actions_hud() in lib.rs, which
  // pre-sizes that popup before placing it. Result mode mirrors HUD_RESULT_* in hud_commands.rs
  // for the same reason. Chat mode has no counterpart in Rust — it is entered on a window that
  // is already visible and already placed — so its height is free to depend on the display.
  //
  // setSize needs `core:window:allow-set-size` in capabilities/hud.json: `core:default` grants
  // only the window getters. Without it every call here is rejected, and because each of the
  // other modes is also pre-sized from Rust the loss shows up on chat alone. Report the failure
  // rather than dropping it — a silently unresized window looks like a layout bug for a long
  // time before anyone suspects the ACL.
  //
  // Every resize is followed by `clamp_hud_on_screen_cmd`. macOS resizes a window around its
  // bottom-left corner, so anything taller than what it replaces grows upwards — and the chat is
  // several times taller than the bubble it opens from. Anchored beside a selection near the top
  // of the display it would grow straight off the edge. Clamping at placement time cannot cover
  // this: the new size is only known once the resize has landed.
  const setHudSize = (w: number, h: number) => {
    getCurrentWebviewWindow()
      .setSize(new LogicalSize(w, h))
      .then(() => invoke("place_hud_after_resize_cmd"))
      .catch((e) => console.error("[DictationHud] resize refused:", e));
  };

  useEffect(() => {
    if (mode === "text-actions" && customActionOpen) {
      setHudSize(220, 170 + (textActionsError ? 28 : 0));
    } else if (mode === "text-actions" && textActionsPayload) {
      const actionCount = textActionsPayload.actions.length + 1; // +1 for the always-present "Custom…" row
      // preview row ~24px + 3px padding, each action 30px, error 24px, 6px bottom pad
      const h = 32 + actionCount * 30 + (textActionsError ? 28 : 0) + 6 + 6;
      setHudSize(220, Math.max(60, Math.min(h, 280)));
    } else if (mode === "text-actions-processing") {
      setHudSize(220, 44);
    } else if (mode === "result") {
      setHudSize(HUD_RESULT_WIDTH, HUD_RESULT_HEIGHT);
    } else if (mode === "chat") {
      // Measured every time the chat opens, so moving the HUD to another display between two
      // dictations gives a chat sized for the display it actually appears on.
      setHudSize(HUD_CHAT_WIDTH, hudChatHeight());
    } else {
      setHudSize(HUD_DEFAULT_WIDTH, HUD_DEFAULT_HEIGHT);
    }
  }, [mode, textActionsPayload, textActionsError, customActionOpen]);

  // Close on click-outside (window blur) when showing text-actions popup.
  // The result box is deliberately not part of this: it exists to be read while the focus
  // is back in the app the text went to.
  useEffect(() => {
    if (mode !== "text-actions" && mode !== "text-actions-processing") return;
    const onBlur = () => {
      // Running an action moves the focus away on purpose (the result is pasted into the
      // other app), and the HUD comes straight back with that result - don't fight it.
      if (resultPendingRef.current) return;
      void invoke("hide_hud_cmd");
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [mode]);

  // ── Result box ────────────────────────────────────────────────────────────

  /** Hides the result box. A later HUD state may already have arrived - never clobber it. */
  const dismissResult = () => {
    if (resultHideRef.current) {
      clearTimeout(resultHideRef.current);
      resultHideRef.current = null;
    }
    void invoke("hide_hud_cmd")
      .catch((e) => console.error("[DictationHud] hide error:", e))
      .then(() => {
        setResultHovered(false);
        setMode((m) => (m === "result" ? "idle" : m));
      });
  };

  // Auto-hide: the box waits RESULT_AUTO_HIDE_MS, and hovering it freezes what is left of
  // that wait instead of restarting it. Cleanup covers both unmount and any mode change,
  // so no timer outlives the box and hides whatever the HUD shows next.
  useEffect(() => {
    if (mode !== "result") {
      resultShownRef.current = null;
      return;
    }
    if (resultShownRef.current !== result) {
      resultShownRef.current = result;
      resultLeftRef.current = RESULT_AUTO_HIDE_MS;
    }
    if (resultHovered) return;

    const startedAt = Date.now();
    const runFor = resultLeftRef.current;
    resultHideRef.current = setTimeout(dismissResult, runFor);
    return () => {
      if (resultHideRef.current) {
        clearTimeout(resultHideRef.current);
        resultHideRef.current = null;
      }
      resultLeftRef.current = Math.max(0, runFor - (Date.now() - startedAt));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, result, resultHovered]);

  const copyWithFeedback = (key: string, text: string) => {
    void copyTextToClipboard(text)
      .then(() => {
        setCopiedKey(key);
        if (copiedRef.current) clearTimeout(copiedRef.current);
        copiedRef.current = setTimeout(() => setCopiedKey(null), COPIED_FEEDBACK_MS);
      })
      .catch((e) => console.error("[DictationHud] copy error:", e));
  };

  const handleCopyResult = () => {
    if (!result) return;
    copyWithFeedback("result", result.text);
  };

  // ── Follow-up chat ────────────────────────────────────────────────────────

  /**
   * Opens the result box into a conversation. Killing the countdown is the first thing that
   * happens: a box that vanishes after eight seconds while someone types into it would be the
   * worst possible outcome. The mode change below also tears the timer down through the
   * auto-hide effect's cleanup, and nothing re-arms it — that effect only ever runs in `result`.
   */
  const openChat = () => {
    const request = result?.chatPrompt?.trim();
    if (!result || !request) return;
    if (resultHideRef.current) {
      clearTimeout(resultHideRef.current);
      resultHideRef.current = null;
    }
    resultShownRef.current = null;
    chatPromptRef.current = request;
    setChatMessages([{ role: "assistant", text: result.text }]);
    setChatInput("");
    setChatBusy(false);
    setCopiedKey(null);
    setResultHovered(false);
    setChatMicState("idle");
    // Asked every time the chat opens rather than once at start-up: the HUD window outlives every
    // trip through Settings, and somebody who has just installed a speech model should find the
    // microphone there the next time they open a conversation.
    void invoke<boolean>("hud_chat_mic_available_cmd")
      .then(setChatMicAvailable)
      .catch((e) => {
        console.error("[DictationHud] mic availability failed:", e);
        setChatMicAvailable(false);
      });
    setMode("chat");
    // The HUD holds no keyboard focus in any other state; a conversation needs it.
    void invoke("focus_hud_cmd").catch((e) =>
      console.error("[DictationHud] focus error:", e),
    );
  };

  /** Leaving the chat closes the HUD, which hands the keyboard back to the app underneath. */
  const closeChat = () => {
    // A microphone left open would stay open behind a window nobody can see any more, and would
    // refuse every dictation afterwards. Closing ends the recording; what was said is dropped,
    // which is what leaving a box you were about to type into means.
    if (chatMicActiveRef.current) {
      chatMicActiveRef.current = false;
      void invoke<string>("stop_hud_chat_mic_cmd").catch((e) =>
        console.error("[DictationHud] mic stop on close failed:", e),
      );
    }
    setChatMicState("idle");
    void invoke("hide_hud_cmd")
      .catch((e) => console.error("[DictationHud] hide error:", e))
      .then(() => {
        setMode((m) => (m === "chat" ? "idle" : m));
        setChatMessages([]);
        setChatInput("");
        setChatBusy(false);
      });
  };

  /**
   * Writes a transcript into the chat's input box, after whatever is already in it.
   *
   * Appended, never substituted: half a typed sentence is a sentence the user meant to keep. A
   * single space joins the two, and the caret lands at the very end — the next keystroke carries
   * on from the dictated words, and Enter sends the whole thing.
   */
  const appendToChatInput = (transcript: string) => {
    const spoken = transcript.trim();
    if (!spoken) return;
    setChatInput((current) => {
      const typed = current.trimEnd();
      const next = typed ? `${typed} ${spoken}` : spoken;
      chatCaretRef.current = next.length;
      return next;
    });
  };

  // Putting the caret at the end has to wait for the input to hold the new text, so it happens
  // here rather than beside the `setChatInput` that asked for it.
  useEffect(() => {
    const caret = chatCaretRef.current;
    if (caret === null) return;
    chatCaretRef.current = null;
    const input = chatInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(caret, caret);
  }, [chatInput]);

  /**
   * The microphone button: one click starts recording, the next stops it and drops the transcript
   * into the input box. Nothing is pasted anywhere else and nothing is saved — sending it is still
   * the user's own Enter.
   */
  const handleChatMicClick = () => {
    if (chatMicState === "transcribing") return;

    if (chatMicState === "recording") {
      setChatMicState("transcribing");
      void invoke<string>("stop_hud_chat_mic_cmd")
        .then((transcript) => {
          if (transcript.trim()) {
            appendToChatInput(transcript);
          } else {
            showBriefWarning("Nothing was picked up. Try again.");
          }
        })
        .catch((e) => {
          console.error("[DictationHud] mic stop error:", e);
          showBriefWarning(
            typeof e === "string" ? e : "That did not come through. Try again.",
          );
        })
        .then(() => {
          chatMicActiveRef.current = false;
          setChatMicState("idle");
          chatInputRef.current?.focus();
        });
      return;
    }

    // Claimed before the call so the `kts:dictation/started` event, which can arrive before this
    // promise settles, already finds the recording spoken for.
    chatMicActiveRef.current = true;
    setChatMicState("recording");
    void invoke("start_hud_chat_mic_cmd").catch((e) => {
      chatMicActiveRef.current = false;
      setChatMicState("idle");
      console.error("[DictationHud] mic start error:", e);
      showBriefWarning(
        typeof e === "string" ? e : "The microphone would not start. Try again.",
      );
    });
  };

  const handleChatSend = () => {
    const question = chatInput.trim();
    if (!question || chatBusy) return;
    const history: ChatMessage[] = [...chatMessages, { role: "user", text: question }];
    setChatMessages(history);
    setChatInput("");
    setChatBusy(true);
    void invoke<string>("run_text_action_cmd", {
      prompt: composeChatPrompt(chatPromptRef.current, history),
    })
      .then((answer) => {
        const text = answer.trim();
        // A failed turn is added to the conversation, never substituted for it: everything
        // said so far stays on screen and can still be copied.
        setChatMessages((m) => [
          ...m,
          text
            ? { role: "assistant", text }
            : { role: "error", text: "That came back empty. Try asking again." },
        ]);
      })
      .catch((e) => {
        const msg =
          typeof e === "string"
            ? e
            : (e as Error)?.message ?? "That didn't work. Try asking again.";
        setChatMessages((m) => [...m, { role: "error", text: msg }]);
      })
      .then(() => setChatBusy(false));
  };

  // Bring the newest message into view, so a new answer never leaves the user to go and find it.
  // Two cases, and they want opposite things: a short turn is best seen with the bottom of the
  // log in view, but an answer taller than the box would then show its *end*, and reading starts
  // at the beginning — so a long one is scrolled to put its first line at the top instead.
  // Runs before paint so the log is never seen at the previous scroll position.
  useLayoutEffect(() => {
    if (mode !== "chat") return;
    const log = chatLogRef.current;
    if (!log) return;
    const last = log.lastElementChild;
    if (!chatBusy && last && last.clientHeight > log.clientHeight) {
      // Measured against the live boxes rather than offsetTop, which depends on whichever
      // ancestor happens to be positioned.
      log.scrollTop += last.getBoundingClientRect().top - log.getBoundingClientRect().top;
    } else {
      log.scrollTop = log.scrollHeight;
    }
  }, [mode, chatMessages, chatBusy]);

  // Put the caret in the box the moment the window is given the keyboard, and again whenever it
  // gets it back — after a click elsewhere the user should be able to just carry on typing.
  useEffect(() => {
    if (mode !== "chat") return;
    const focusInput = () => chatInputRef.current?.focus();
    focusInput();
    window.addEventListener("focus", focusInput);
    return () => window.removeEventListener("focus", focusInput);
  }, [mode]);

  const handleTextAction = async (action: TextAction) => {
    if (!textActionsPayload) return;
    const { selectedText, saveToHistory } = textActionsPayload;
    const filledPrompt = action.prompt.replace(/\{context\}/g, selectedText);
    setTextActionsError(null);
    setMode("text-actions-processing");
    resultPendingRef.current = true;
    try {
      const transformed = await invoke<string>("run_text_action_cmd", { prompt: filledPrompt });
      // Pastes into the focused field (and saves to history if asked). Unchanged.
      await invoke("insert_text_result_cmd", {
        resultText: transformed,
        actionTitle: action.title,
        saveToHistory,
      });
      // …and the text comes back in the HUD, to be read and copied whatever the paste did.
      // Nothing worth showing: behave as before and just close.
      if (transformed.trim()) {
        // Painted before the window is shown again, so the box is there from the first frame;
        // the backend echoes the same payload back and the box simply stays as it is.
        // The prompt travels with the result so the user can carry on from it, exactly as a
        // dictation transform can: "make concise" is as worth arguing with as anything dictated.
        setResult({ text: transformed, source: action.title, chatPrompt: filledPrompt });
        setMode("result");
        await invoke("show_hud_result_cmd", {
          text: transformed,
          source: action.title,
          chatPrompt: filledPrompt,
        });
        resultPendingRef.current = false;
      } else {
        resultPendingRef.current = false;
        void invoke("hide_hud_cmd");
      }
    } catch (e) {
      resultPendingRef.current = false;
      const msg = typeof e === "string" ? e : (e as Error)?.message ?? "Unknown error";
      setTextActionsError(msg);
      setMode("text-actions");
    }
  };

  const handleCustomRun = () => {
    const instruction = customInstruction.trim();
    if (!instruction) return;
    void handleTextAction({
      id: "__custom__",
      title: "Custom",
      prompt: `${instruction}:\n\n{context}`,
    });
  };

  const handleCloseRequest = () => {
    if (mode === "result") {
      dismissResult();
      return;
    }
    if (mode === "chat") {
      closeChat();
      return;
    }
    const isActive =
      mode === "dictation" || mode === "screen" ||
      mode === "dictation-paused" || mode === "screen-paused";
    if (isActive && elapsed > 0) {
      setConfirming(true);
    } else {
      void invoke("hide_hud_cmd");
    }
  };

  const handleDiscard = async () => {
    setConfirming(false);
    clearTimer();
    setElapsed(0);
    try {
      await invoke("discard_hud_cmd");
    } catch (e) {
      console.error("[DictationHud] discard error:", e);
      void invoke<HudMode>("get_hud_state_cmd")
        .then((m) => setMode(m))
        .catch(() => {});
    }
  };

  // ── Rendu ─────────────────────────────────────────────────────────────────

  const CloseBtn = () => (
    <button type="button" className="hud-close" aria-label="Close" onClick={handleCloseRequest}>
      ×
    </button>
  );

  const AppIcon = () => (
    <img src={HUD_ICON_SRC} alt="" className="hud-kts-icon" width={18} height={18} draggable={false} />
  );

  const isDictationPlacement =
    mode === "dictation" || mode === "dictation-paused";
  // In screen-ready/preparing modes the user positions the HUD manually — enable drag.
  // In all other modes Rust controls the position (bottom-center).
  const isUserPositioned = mode === "screen-ready" || mode === "preparing";
  const hudDragRegionProps = isUserPositioned ? dragHandleProps : {};

  const hudShell = (body: ReactNode, shellProps: HTMLAttributes<HTMLDivElement> = {}) => (
    <div
      className={
        `hud-shell${isDictationPlacement ? " hud-shell--dictation" : ""}` +
        `${mode === "result" ? " hud-shell--result" : ""}` +
        `${mode === "chat" ? " hud-shell--chat" : ""}`
      }
      {...shellProps}
    >
      {briefWarning && <div className="hud-brief-warning" role="status">{briefWarning}</div>}
      {body}
    </div>
  );

  // Confirmation de discard
  if (confirming) {
    return hudShell(
      <div className="hud-root hud-confirm">
        <span className="hud-confirm-msg">Discard and close?</span>
        <button className="hud-btn hud-btn-stop" onClick={handleDiscard}>Discard</button>
        <button className="hud-btn hud-btn-cancel" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    );
  }

  if (mode === "processing") {
    return hudShell(
      <div className="hud-root">
        <div className="hud-drag" {...hudDragRegionProps}>
          <AppIcon />
          <span className="hud-mode-dot hud-mode-dot--processing" />
          <span className="hud-label">Processing…</span>
        </div>
      </div>
    );
  }

  if (mode === "preparing") {
    return hudShell(
      <>
        <div className="hud-root">
          <div className="hud-drag" {...hudDragRegionProps}>
            <AppIcon />
            <span className="hud-mode-dot hud-mode-dot--processing" />
            <span className="hud-label">Preparing…</span>
          </div>
        </div>
        <CloseBtn />
      </>
    );
  }

  if (mode === "screen-ready") {
    return hudShell(
      <>
        <div className="hud-root">
          <div className="hud-drag" {...hudDragRegionProps}>
            <AppIcon />
            <span className="hud-label">Place on screen…</span>
          </div>
          <button className="hud-btn hud-btn-start" onClick={handleStart}>Start</button>
        </div>
        <CloseBtn />
      </>
    );
  }

  if (mode === "text-actions-processing") {
    return (
      <div className="ta-popup">
        <div className="ta-spinner">
          <span className="hud-mode-dot hud-mode-dot--processing" />
          Running…
        </div>
      </div>
    );
  }

  if (mode === "text-actions" && textActionsPayload) {
    const preview = textActionsPayload.selectedText.length > 50
      ? textActionsPayload.selectedText.slice(0, 50) + "…"
      : textActionsPayload.selectedText;

    if (customActionOpen) {
      return (
        <div className="ta-popup">
          <div className="ta-preview" title={textActionsPayload.selectedText}>
            "{preview}"
          </div>
          {textActionsError && (
            <div className="ta-error">{textActionsError}</div>
          )}
          <textarea
            className="ta-custom-input"
            placeholder="What do you want to do with this text?"
            value={customInstruction}
            onChange={(e) => setCustomInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setCustomActionOpen(false);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleCustomRun();
              }
            }}
            rows={3}
            autoFocus
          />
          <div className="ta-custom-actions">
            <button
              type="button"
              className="ta-custom-btn ta-custom-btn--cancel"
              onClick={() => setCustomActionOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ta-custom-btn ta-custom-btn--run"
              disabled={!customInstruction.trim()}
              onClick={handleCustomRun}
            >
              Run
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="ta-popup">
        <div className="ta-preview" title={textActionsPayload.selectedText}>
          "{preview}"
        </div>
        {textActionsError && (
          <div className="ta-error">{textActionsError}</div>
        )}
        <div className="ta-list">
          {textActionsPayload.actions.map((action) => (
            <button
              key={action.id}
              className="ta-item"
              onClick={() => void handleTextAction(action)}
            >
              {action.title}
            </button>
          ))}
          <button
            key="__custom__"
            className="ta-item"
            onClick={() => setCustomActionOpen(true)}
          >
            Custom…
          </button>
        </div>
      </div>
    );
  }

  if (mode === "result" && result) {
    const resultCopied = copiedKey === "result";
    const canChat = !!result.chatPrompt?.trim();
    return hudShell(
      <>
        <div className="hud-result">
          <div className="hud-result-head" {...dragHandleProps}>
            <AppIcon />
            <span className="hud-label">{result.source}</span>
            {canChat && (
              <button type="button" className="hud-result-chat" onClick={openChat}>
                Ask for changes
              </button>
            )}
            <button
              type="button"
              className="hud-result-copy"
              onClick={handleCopyResult}
              title={resultCopied ? "Copied" : "Copy text"}
              aria-label={resultCopied ? "Copied" : "Copy text"}
            >
              {resultCopied ? <IconCheck /> : <IconCopy />}
            </button>
          </div>
          <div className="hud-result-text">{result.text}</div>
        </div>
        <CloseBtn />
      </>,
      {
        onMouseEnter: () => setResultHovered(true),
        onMouseLeave: () => setResultHovered(false),
      },
    );
  }

  if (mode === "chat") {
    return hudShell(
      <>
        <div className="hud-chat">
          <div className="hud-result-head" {...dragHandleProps}>
            <AppIcon />
            <span className="hud-label">{result?.source ?? "Dictation"}</span>
          </div>
          <div className="hud-chat-log" ref={chatLogRef}>
            {chatMessages.map((message, i) => {
              const key = `chat-${i}`;
              const messageCopied = copiedKey === key;
              return (
                <div key={key} className={`hud-chat-msg hud-chat-msg--${message.role}`}>
                  <div className="hud-chat-msg-text">{message.text}</div>
                  {message.role === "assistant" && (
                    <button
                      type="button"
                      className="hud-result-copy hud-chat-copy"
                      // Keep the caret where it is, so the next thing typed still goes
                      // into the box rather than nowhere.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => copyWithFeedback(key, message.text)}
                      title={messageCopied ? "Copied" : "Copy text"}
                      aria-label={messageCopied ? "Copied" : "Copy text"}
                    >
                      {messageCopied ? <IconCheck /> : <IconCopy />}
                    </button>
                  )}
                </div>
              );
            })}
            {chatBusy && (
              <div className="hud-chat-busy" role="status">
                <span className="hud-mode-dot hud-mode-dot--processing" />
                Working on it…
              </div>
            )}
          </div>
          <div className="hud-chat-ask">
            {chatMicAvailable && (
              <button
                type="button"
                className={`hud-chat-mic hud-chat-mic--${chatMicState}`}
                // Keep the caret in the input: the transcript is about to be written there, and
                // the user should be able to carry on typing the moment it lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleChatMicClick}
                disabled={chatMicState === "transcribing"}
                title={CHAT_MIC_LABEL[chatMicState]}
                aria-label={CHAT_MIC_LABEL[chatMicState]}
                aria-pressed={chatMicState === "recording"}
              >
                {chatMicState === "recording" ? (
                  // The same level meter the dictation HUD shows, so "it is listening" and "it is
                  // hearing nothing" look the same here as they do there.
                  <SoundWave />
                ) : chatMicState === "transcribing" ? (
                  <span className="hud-mode-dot hud-mode-dot--processing" />
                ) : (
                  <IconMic />
                )}
              </button>
            )}
            <input
              ref={chatInputRef}
              type="text"
              className="hud-chat-input"
              placeholder="Ask for a different version…"
              aria-label="Ask for a different version"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleChatSend();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeChat();
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="hud-chat-send"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleChatSend}
              disabled={chatBusy || !chatInput.trim()}
            >
              Send
            </button>
          </div>
        </div>
        <CloseBtn />
      </>
    );
  }

  if (mode === "idle") {
    return hudShell(
      <>
        <div className="hud-root">
          <div className="hud-drag" {...hudDragRegionProps}>
            <AppIcon />
            <span className="hud-label">Ready</span>
          </div>
        </div>
        <CloseBtn />
      </>
    );
  }

  if (mode === "dictation-paused" || mode === "screen-paused") {
    const label = mode === "dictation-paused" ? "Dictation" : "Screen";
    return hudShell(
      <>
        <div className="hud-root">
          <div className="hud-drag" {...hudDragRegionProps}>
            <AppIcon />
            <span className="hud-mode-dot hud-mode-dot--paused" />
            <span className="hud-label">{label} {fmt(elapsed)} ⏸</span>
          </div>
          <button className="hud-btn hud-btn-resume" onClick={handleResume}>Resume</button>
        </div>
        <CloseBtn />
      </>
    );
  }

  // dictation | screen
  const isDictation = mode === "dictation";
  return hudShell(
    <>
      <div className="hud-root">
        <div className="hud-drag" {...hudDragRegionProps}>
          <AppIcon />
          <span className={`hud-mode-dot hud-mode-dot--${isDictation ? "dictation" : "screen"}`} />
          <span className="hud-label">{isDictation ? "Dictation" : "Screen"} {fmt(elapsed)}</span>
          <SoundWave />
        </div>
        <button className="hud-btn hud-btn-pause" onClick={handlePause}>⏸</button>
        <button className="hud-btn hud-btn-stop" onClick={handleStop} disabled={stopping}>
          {stopping ? "…" : "Stop"}
        </button>
      </div>
      <CloseBtn />
    </>
  );
}
