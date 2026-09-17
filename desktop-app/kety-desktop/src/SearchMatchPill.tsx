type Props = {
  /** When set and positive, shown like sensitive rollup counts (app / window rows). */
  count?: number;
  title?: string;
};

const DEFAULT_TITLE = "Search match";

/** Blue magnifying-glass pill, aligned with SensitiveWarningPill (segment + scope rows). */
export function SearchMatchPill({ count, title }: Props) {
  const showCount = count != null && count > 0;
  return (
    <span
      className="upload-focus-search-match-pill upload-focus-search-match-pill--search"
      title={title ?? (showCount ? `${count} segment(s) match search` : DEFAULT_TITLE)}
      aria-label={title ?? (showCount ? `${count} segment(s) match search` : DEFAULT_TITLE)}
    >
      <svg
        className="upload-focus-search-match-glyph"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="16.65" y1="16.65" x2="21" y2="21" />
      </svg>
      {showCount ? <span className="upload-focus-search-match-pill-count">{count}</span> : null}
    </span>
  );
}
