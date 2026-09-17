import type { SVGProps } from "react";
import {
  type DictationProvider,
  DICTATION_PROVIDER_LOCAL,
  DICTATION_PROVIDER_OPENAI_WHISPER_1,
} from "./appTypes";

// ── Google Meet ───────────────────────────────────────────────────────────────

export const MAX_MEET_TRANSCRIPT_CHARS_FOR_PROMPT = 120_000;

/** Hard-coded capture context for Meet captions (extension → bridge), regardless of frontmost app. */
export const GOOGLE_MEET_CAPTURE_APP_NAME = "Google Chrome";
export const GOOGLE_MEET_CAPTURE_WINDOW_NAME = "Google Meet";

/** Stored in plugin-store: Meet summary language tracks Settings → Preferred output language. */
export const GOOGLE_MEET_SUMMARY_LANG_SAME_AS_ACCOUNT = "same_as_account";

// ── Legacy focus session (app/window segments, not screen capture) ────────────
/** When false: no new session from UI/tray, no resume of `currentSessionId` from store, and macOS does not register ⌘⌥+recording-toggle (`REGISTER_RECORDING_TOGGLE_SHORTCUT` in `src-tauri/src/shortcuts.rs`). Set true to revive the feature; implementation left in place. */
export const LEGACY_FOCUS_SESSION_START_ENABLED = false;

// ── Output language ───────────────────────────────────────────────────────────

export const OUTPUT_LANGUAGE_OPTIONS = [
  { code: "fr", label: "Français" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "nl", label: "Nederlands" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "ar", label: "العربية" },
] as const;

const OUTPUT_LANGUAGE_LABEL_BY_CODE: Record<string, string> =
  OUTPUT_LANGUAGE_OPTIONS.reduce(
    (acc, option) => {
      acc[option.code] = option.label;
      return acc;
    },
    {} as Record<string, string>
  );

export function isKnownOutputLanguageCode(code: string): boolean {
  return !!OUTPUT_LANGUAGE_LABEL_BY_CODE[code];
}

export function getOutputLanguageLabel(code: string): string {
  if (code === "auto") return "Auto-detect";
  if (code === "document") return "Document language";
  return OUTPUT_LANGUAGE_LABEL_BY_CODE[code] ?? code;
}

export function resolveGoogleMeetSummaryOutputLangForApi(
  meetLangSetting: string,
  accountPreferredCode: string
): string {
  if (meetLangSetting.trim() === GOOGLE_MEET_SUMMARY_LANG_SAME_AS_ACCOUNT) {
    const acc = accountPreferredCode.trim().toLowerCase();
    if (OUTPUT_LANGUAGE_LABEL_BY_CODE[acc]) return acc;
    return "en";
  }
  return (meetLangSetting.trim() || "document").trim() || "document";
}

export function buildGoogleMeetSummaryUserPrompt(
  transcript: string,
  extraUser: string,
  outputLangCode: string
): string {
  const clip = transcript.slice(0, MAX_MEET_TRANSCRIPT_CHARS_FOR_PROMPT);
  const extra = extraUser.trim();
  const extraBlock = extra
    ? `\n\nAdditional instructions from the user:\n${extra}\n`
    : "";
  const code = outputLangCode.trim().toLowerCase();
  const langLine =
    code === "" || code === "document" || code === "auto"
      ? "Match the language of the transcript unless the user instructions say otherwise.\n"
      : `Write every section in ${getOutputLanguageLabel(outputLangCode)} (app output language setting).\n`;
  return (
    "You are turning a Google Meet live-caption transcript into a rich meeting note. " +
    "The transcript may be messy (speaker labels, fragments, errors). Preserve useful facts: " +
    "decisions, numbers, dates, names, URLs, and technical detail-do not omit them for brevity.\n" +
    "Use these **exact** Markdown headings (including the ##). Write as much as each section needs; " +
    "if a section truly does not apply, write exactly **None** as the only line under that heading.\n\n" +
    "## Key points\n" +
    "Bullet list (- …) of the most important takeaways: decisions, open questions, risks, commitments.\n\n" +
    "## Sections by topic\n" +
    "Organize the meeting into coherent sections (### subheadings). Under each, summarize what was discussed " +
    "with enough detail that someone who missed the call can follow. Mirror the flow of the meeting when possible.\n\n" +
    "## Technical summary\n" +
    "If the conversation included engineering, IT, architecture, APIs, data, security, code, infrastructure, or similar: " +
    "summarize those parts with enough precision to be actionable (terms, constraints, trade-offs, versions if stated). " +
    "If there was nothing technical, write exactly: None\n\n" +
    "## Action items / To-dos\n" +
    "Numbered list (1. … 2. …) of concrete follow-ups with owner or deadline when mentioned. If there are none, write exactly: None.\n\n" +
    langLine +
    "Be thorough and long when the transcript warrants it. Do not paste the raw transcript.\n" +
    extraBlock +
    `\nTranscript:\n${clip}\n`
  );
}

// ── OpenAI / assistant model ──────────────────────────────────────────────────

/** Cloud in native `<option>` text (options cannot render SVG). */
export const OPENAI_CLOUD_OPTION_MARK = "\u2601";

/** Available GPT models for the AI assistant (direct client-side OpenAI call). */
export const ASSISTANT_MODEL_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  recommended?: boolean;
}> = [
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "gpt-5.2", label: "GPT-5.2", recommended: true },
];

/** Assistant is off: no Kety route and no client-side OpenAI chat until the user picks a model again. */
export const ASSISTANT_MODEL_DISABLED = "disabled";

export function isAssistantDirectOpenAiModel(model: string | undefined | null): boolean {
  const m = model ?? "kts";
  return (
    m !== "kts" &&
    m !== ASSISTANT_MODEL_DISABLED &&
    !m.startsWith("local:") &&
    ASSISTANT_MODEL_OPTIONS.some((o) => o.value === m)
  );
}

/** Returns true if the selected assistant model is a local Qwen model (prefixed "local:"). */
export function isAssistantLocalQwenModel(model: string | undefined | null): boolean {
  return (model ?? "").startsWith("local:");
}

/** Extracts the Qwen filename from a "local:{filename}" assistant model value. */
export function assistantLocalQwenFilename(model: string): string {
  return model.startsWith("local:") ? model.slice("local:".length) : "";
}

export function maskOpenAiApiKeyForDisplay(secret: string): string {
  const s = secret;
  if (!s) return "";
  const tailN = 4;
  if (s.length <= tailN) {
    if (s.length <= 1) return "*";
    return "*".repeat(s.length - tailN) + s.slice(-tailN);
  }
  const tail = s.slice(-tailN);
  const minMid = 2;
  const maxPrefix = 9;
  const prefixLen = Math.min(maxPrefix, Math.max(1, s.length - tailN - minMid));
  const prefix = s.slice(0, prefixLen);
  const midLen = s.length - prefix.length - tailN;
  const mid = "*".repeat(Math.min(20, Math.max(minMid, midLen)));
  return `${prefix}${mid}${tail}`;
}

// ── Dictation ─────────────────────────────────────────────────────────────────

export const DICTATION_PROVIDER_OPTIONS: ReadonlyArray<{
  value: DictationProvider;
  label: string;
  cloud?: boolean;
}> = [
  { value: DICTATION_PROVIDER_LOCAL, label: "Local (Whisper)" },
  { value: DICTATION_PROVIDER_OPENAI_WHISPER_1, label: "OpenAI Whisper-1", cloud: true },
];

// ── Capture context history (tray / popup: dictation injects + passive copy history) ─

export type CaptureHistoryRetention = "1h" | "24h" | "7d" | "30d" | "never";

export const CAPTURE_HISTORY_RETENTION_DEFAULT: CaptureHistoryRetention = "24h";

export const CAPTURE_HISTORY_RETENTION_OPTIONS: ReadonlyArray<{ value: CaptureHistoryRetention; label: string }> = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "1 month" },
  { value: "never", label: "Never (manual only)" },
];

export function isCaptureHistoryRetention(v: string): v is CaptureHistoryRetention {
  return v === "1h" || v === "24h" || v === "7d" || v === "30d" || v === "never";
}

/** Max age in ms; `null` = do not auto-drop by age. */
export function captureHistoryRetentionMs(r: CaptureHistoryRetention): number | null {
  switch (r) {
    case "1h":
      return 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "never":
      return null;
    default:
      return null;
  }
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export const CAPTURE_TAG_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#06b6d4",
];

export function pickTagColor(usedColors: string[]): string {
  const free = CAPTURE_TAG_COLORS.find((c) => !usedColors.includes(c));
  if (free) return free;
  const counts = new Map<string, number>();
  for (const c of CAPTURE_TAG_COLORS) counts.set(c, 0);
  for (const c of usedColors) counts.set(c, (counts.get(c) ?? 0) + 1);
  let min = Infinity;
  let least = CAPTURE_TAG_COLORS[0];
  for (const [c, n] of counts) {
    if (n < min) { min = n; least = c; }
  }
  return least;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

/** Small cloud glyph when an OpenAI cloud model is selected in settings. */
export function IconCloudModel(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  );
}

/** Clock glyph: same shape as the Capture history toolbar button on the Captures tab. */
export function IconCaptureHistoryClock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 5v3.5l2 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
