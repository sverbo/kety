/**
 * Warning triangle badge for local sensitive scan (red = sensitive, orange = maybe).
 * Icon only when `count` is omitted; icon + count for aggregates.
 */

export type SensitiveVerdictVariant = "sensitive" | "maybe";

type Props = {
  variant: SensitiveVerdictVariant;
  /** When set and > 0, shown after the icon (summary / app / window). Omit for line-level chunks (icon only). */
  count?: number;
  title?: string;
};

export function SensitiveWarningPill({ variant, count, title }: Props) {
  const defaultTitle =
    variant === "sensitive" ? "Sensitive (local scan)" : "Maybe sensitive (local scan)";
  const showCount = count != null && count > 0;
  return (
    <span
      className={`upload-focus-sensitive-pill upload-focus-sensitive-pill--${variant} upload-focus-sensitive-pill--warn`}
      title={title ?? defaultTitle}
      aria-label={title ?? defaultTitle}
    >
      <svg
        className="upload-focus-sensitive-warn-glyph"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        aria-hidden
        fill="currentColor"
      >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.401 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z"
        />
      </svg>
      {showCount ? <span className="upload-focus-sensitive-pill-count">{count}</span> : null}
    </span>
  );
}
