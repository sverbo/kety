/** Prefix for cloud text models stored in pdf / sensitive / auto-tag state. */
export const OPENAI_MODEL_PREFIX = "openai:" as const;

export type OpenAiTextModelOption = { value: string; label: string; recommended?: boolean };

/** Unicode star for “recommended” in native `<option>` text and compact labels. */
export const MODEL_RECOMMENDED_STAR = "\u2605";

/** Space + star, appended to recommended model labels in `<select>` options. */
export const MODEL_RECOMMENDED_OPTION_SUFFIX = ` ${MODEL_RECOMMENDED_STAR}`;

/** Default pick for cost/latency; marked with ★ in UI. */
export const OPENAI_TEXT_MODEL_OPTIONS: ReadonlyArray<OpenAiTextModelOption> = [
  { value: `${OPENAI_MODEL_PREFIX}gpt-4o-mini`, label: "GPT-4o mini", recommended: true },
  { value: `${OPENAI_MODEL_PREFIX}gpt-4o`, label: "GPT-4o" },
  { value: `${OPENAI_MODEL_PREFIX}gpt-5.2`, label: "GPT-5.2" },
];

const CLOUD_MARK = "\u2601";

/** Label text only (no cloud prefix). Use with `SettingsModelPicker` so the cloud shows as an icon in the menu. */
export function openAiCloudSelectOptionPlainLabel(m: { label: string; recommended?: boolean }): string {
  return m.recommended ? `${m.label}${MODEL_RECOMMENDED_OPTION_SUFFIX}` : m.label;
}

/** Cloud prefix for native `<option>` text only (options cannot render icons). */
export function openAiCloudSelectOptionLabel(m: { label: string; recommended?: boolean }): string {
  const base = openAiCloudSelectOptionPlainLabel(m);
  return `${CLOUD_MARK} ${base}`;
}

export function defaultOpenAiTextModelValue(): string {
  const rec = OPENAI_TEXT_MODEL_OPTIONS.find((m) => m.recommended);
  return rec?.value ?? OPENAI_TEXT_MODEL_OPTIONS[0]!.value;
}

export function getOpenAiTextModelLabel(value: string): string | null {
  const match = OPENAI_TEXT_MODEL_OPTIONS.find((m) => m.value === value);
  if (!match) return null;
  return match.recommended ? `${match.label}${MODEL_RECOMMENDED_OPTION_SUFFIX}` : match.label;
}
