import type { SVGProps } from "react";

/**
 * Document with a horizontal scan line - use for local sensitive/LLM scan, not for search (magnifier).
 */
export function ScanDocumentGlyph({
  className,
  width = 24,
  height = 24,
  ...rest
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...rest}
    >
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="15" x2="13" y2="15" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </svg>
  );
}
