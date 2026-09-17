import type { SVGProps } from "react";
import type { ContextNoteSource } from "./contextNoteTypes";

const common: SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

/** Surlignage / sélection - marqueur surligneur. */
function IconHighlight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...common} aria-hidden className="context-source-icon" {...props}>
      <rect x={5} y={14} width={14} height={6} rx={2} />
      <path d="M8 14V8a4 4 0 0 1 8 0v6" />
    </svg>
  );
}

/** Presse-papiers. */
function IconClipboard(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...common} aria-hidden className="context-source-icon" {...props}>
      <path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-2M8 7h8" />
    </svg>
  );
}

/** Saisie manuelle - crayon sur ligne. */
function IconManual(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...common} aria-hidden className="context-source-icon" {...props}>
      <path d="M12 20h9" />
      <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
    </svg>
  );
}

/** Dictée vocale - microphone. */
function IconMicrophone(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...common} aria-hidden className="context-source-icon" {...props}>
      <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" />
      <path d="M19 10a7 7 0 0 1-14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}

/** Enregistrement d'écran - pellicule vidéo. */
function IconVideo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...common} aria-hidden className="context-source-icon" {...props}>
      <rect x={2} y={6} width={15} height={12} rx={2} />
      <path d="M17 10l5-3v10l-5-3V10z" />
    </svg>
  );
}

/** Google Meet - caméra / réunion (sous-titres). */
function IconMeet(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...common} aria-hidden className="context-source-icon" {...props}>
      <rect x={3} y={5} width={14} height={12} rx={2} />
      <circle cx={10} cy={10} r={2.25} />
      <path d="M17 9v6l3-2.5V11.5L17 9z" />
    </svg>
  );
}

/** Document joint (résumé) - icône fichier avec coin plié. */
export function IconPdf(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...common} aria-hidden className="context-source-icon" {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  );
}

const LABELS: Record<ContextNoteSource, string> = {
  highlight: "Copied from selection (Accessibility)",
  clipboard: "Pasted from clipboard",
  copyHistory: "Copy history (when enabled in Settings)",
  manual: "Manual entry",
  dictation: "Voice dictation (⌃D)",
  screenRecording: "Screen recording (⌃S)",
  googleMeet: "Google Meet captions",
  textTransform: "Text action",
  link: "Link",
};

const DOC_TITLE = "Document (summary + file)";

/** Icône document (timeline `kind: "document"` ou note hors session avec pièce jointe). */
export function DocumentContextIcon({
  className,
}: {
  className?: string;
}) {
  const cn = className ? `context-source-icon-wrap ${className}` : "context-source-icon-wrap";
  return (
    <span className={cn} title={DOC_TITLE} role="img" aria-label={DOC_TITLE}>
      <IconPdf />
    </span>
  );
}

export function ContextSourceIcon({
  source,
  className,
}: {
  source: ContextNoteSource;
  className?: string;
}) {
  const title = LABELS[source];
  const cn = className ? `context-source-icon-wrap ${className}` : "context-source-icon-wrap";
  switch (source) {
    case "highlight":
      return (
        <span className={cn} title={title} role="img" aria-label={title}>
          <IconHighlight />
        </span>
      );
    case "clipboard":
    case "copyHistory":
      return (
        <span className={cn} title={title} role="img" aria-label={title}>
          <IconClipboard />
        </span>
      );
    case "dictation":
      return (
        <span className={cn} title={title} role="img" aria-label={title}>
          <IconMicrophone />
        </span>
      );
    case "screenRecording":
      return (
        <span className={cn} title={title} role="img" aria-label={title}>
          <IconVideo />
        </span>
      );
    case "googleMeet":
      return (
        <span className={cn} title={title} role="img" aria-label={title}>
          <IconMeet />
        </span>
      );
    case "link":
      return (
        <span className={cn} title={title} role="img" aria-label={title}>
          <svg {...common} aria-hidden className="context-source-icon">
            <path d="M10 13.5a5 5 0 0 0 7.07 0l1.77-1.77a5 5 0 0 0-7.07-7.07l-.94.93" />
            <path d="M14 10.5a5 5 0 0 0-7.07 0L5.16 12.27a5 5 0 0 0 7.07 7.07l.94-.93" />
          </svg>
        </span>
      );
    case "manual":
    default:
      return (
        <span className={cn} title={title} role="img" aria-label={title}>
          <IconManual />
        </span>
      );
  }
}
