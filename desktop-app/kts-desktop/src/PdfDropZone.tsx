import { useEffect, useImperativeHandle, useRef, useState } from "react";

/** Cycles "..." → ".." → "." → "..." while active. Starts at "..." so the first frame is always three dots. */
function useAnimatedDots(active: boolean): string {
  const [dots, setDots] = useState("...");
  useEffect(() => {
    if (!active) return;
    setDots("...");
    const id = setInterval(() => {
      setDots((d) => (d === "..." ? ".." : d === ".." ? "." : "..."));
    }, 400);
    return () => clearInterval(id);
  }, [active]);
  return active ? dots : "";
}
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const META_BATCH = 10;
const ACCEPTED_EXTENSIONS = [".pdf", ".md", ".txt"] as const;
const ACCEPTED_LABEL = "PDF, MD, TXT";
const PLAINTEXT_PAGE_LINES = 30;
const PLAINTEXT_PAGE_CHARS = 2500;

/**
 * Count the total number of extra LLM calls needed for a recursive meta-summarisation.
 * Each level batches `n` summaries into groups of META_BATCH.
 * Batches of size 1 are passed through for free (no LLM call).
 */
function countMetaSteps(n: number): number {
  if (n <= 1) return 0;
  if (n <= META_BATCH) return 1;
  const fullBatches = Math.floor(n / META_BATCH);
  const remainder = n % META_BATCH;
  const callsThisLevel = fullBatches + (remainder > 1 ? 1 : 0);
  const groupsNextLevel = fullBatches + (remainder > 0 ? 1 : 0);
  return callsThisLevel + countMetaSteps(groupsNextLevel);
}

type Status =
  | "idle"
  | "extracting"
  | "summarizing"
  | "meta-summarizing"
  | "warning"
  | "error";

type Progress = { current: number; total: number };

type WarningState = {
  filePath: string;
  fileName: string;
  fileSize: number;
  totalPages: number;
  requestedPages: number;
  adjustedPages: number;
  /** Called when the user confirms processing; the drop zone takes over from here. */
  confirm: (pageCount: number, withMeta: boolean) => void;
};

/** Imperative handle so the parent can interrupt processing. */
export type PdfDropZoneHandle = {
  /** Stop at the next chunk boundary and call onSummaryReady with whatever is done. */
  stopAndSave: () => void;
  /** Stop at the next chunk boundary and discard all results. */
  discard: () => void;
};

type Props = {
  pagesMode: "count" | "percent";
  pagesCount: number;
  pagesPercent: number;
  /** Show the large-document warning when both totalPages and requestedPages exceed this. Default 10. */
  warnThreshold: number;
  modelFilename: string;
  /** OpenAI API key used when `modelFilename` starts with `openai:`. */
  openaiApiKey?: string;
  /** Language code ("en", "fr", …) or "document" to match input language. */
  summaryLang: string;
  /** Number of pages to process in parallel (1 = sequential). */
  parallelism: number;
  /** Called each time the busy state changes. */
  onBusyChange?: (busy: boolean) => void;
  /** Called when a summary (possibly partial) is ready to be saved. */
  onSummaryReady: (text: string, docName: string, filePath: string, fileSize: number, rawContent?: string[]) => void;
  /** React 19 ref forwarding. */
  ref?: React.Ref<PdfDropZoneHandle>;
};

function IconFilePdf() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  );
}

async function extractPageText(page: pdfjsLib.PDFPageProxy): Promise<string> {
  // pdfjs-dist v4+ implements getTextContent() with `for await...of` on a
  // ReadableStream internally, which JavaScriptCore (WKWebView) does not support.
  // streamTextContent() exposes the ReadableStream directly; we consume it
  // via reader.read() which WKWebView handles correctly.
  const stream = page.streamTextContent({ includeMarkedContent: false });
  const reader = stream.getReader();
  const items: Array<{ str?: string }> = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.items) items.push(...(value.items as Array<{ str?: string }>));
    }
  } finally {
    reader.releaseLock();
  }
  return items.map((it) => it.str ?? "").join(" ").trim();
}

/** Renders a PDF page to a canvas and returns a base64 PNG (no data-URL prefix). */
async function renderPageToPng(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not available");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({ canvasContext: ctx as any, canvas, viewport }).promise;
  return canvas.toDataURL("image/png").split(",")[1];
}

export function PdfDropZone({
  pagesMode,
  pagesCount,
  pagesPercent,
  warnThreshold,
  modelFilename,
  openaiApiKey,
  summaryLang,
  parallelism,
  onBusyChange,
  onSummaryReady,
  ref,
}: Props) {
  const normalizedOpenAiApiKey = (openaiApiKey ?? "").trim();
  const useOpenAi = modelFilename.startsWith("openai:");

  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [metaProgress, setMetaProgress] = useState<Progress | null>(null);
  const [warning, setWarning] = useState<WarningState | null>(null);
  const [doMetaSummary, setDoMetaSummary] = useState(true);
  const [showStopDialog, setShowStopDialog] = useState(false);

  // "none" | "save" | "discard" - set to interrupt the processing loop at the next chunk boundary
  const cancelActionRef = useRef<"none" | "save" | "discard">("none");
  // Synchronous guard preventing concurrent processFileFromPath calls (before busy state propagates)
  const processingRef = useRef(false);
  // Deduplication: ensure onSummaryReady is called at most once per processing session
  const savedRef = useRef(false);

  // Ref-based handler so the Tauri drag-drop effect never captures stale closures
  const onDropPathRef = useRef<((filePath: string) => void) | null>(null);

  const busy =
    status === "extracting" ||
    status === "summarizing" ||
    status === "meta-summarizing";

  const dots = useAnimatedDots(busy);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  // Expose imperative controls to parent
  useImperativeHandle(ref, () => ({
    stopAndSave: () => {
      if (processingRef.current) {
        cancelActionRef.current = "save";
        setShowStopDialog(false);
      }
    },
    discard: () => {
      if (processingRef.current) {
        cancelActionRef.current = "discard";
        setShowStopDialog(false);
      }
    },
  }));

  const reset = () => {
    setStatus("idle");
    setError(null);
    setProgress(null);
    setMetaProgress(null);
    setWarning(null);
    setDoMetaSummary(true);
    setShowStopDialog(false);
    cancelActionRef.current = "none";
    processingRef.current = false;
    savedRef.current = false;
  };

  const computeRequestedPages = (totalPages: number): number => {
    if (pagesMode === "count") return Math.min(pagesCount, totalPages);
    return Math.min(Math.ceil((totalPages * pagesPercent) / 100), totalPages);
  };

  // ── Recursive meta-summarisation (batches within a level run in parallel) ──
  const runMetaSummarization = async (summaries: string[]): Promise<string> => {
    const total = countMetaSteps(summaries.length);
    let stepsDone = 0;
    setMetaProgress({ current: 0, total });

    async function reduce(items: string[]): Promise<string> {
      if (items.length <= 1) return items[0] ?? "";

      const batches: string[][] = [];
      for (let i = 0; i < items.length; i += META_BATCH) {
        batches.push(items.slice(i, i + META_BATCH));
      }

      // All batches within the same level are independent - run them in parallel
      const reduced = await Promise.all(
        batches.map(async (batch) => {
          if (batch.length === 1) return batch[0];
          const meta = await invoke<string>("meta_summarize_cmd", {
            summaries: batch,
            modelFilename,
            lang: summaryLang,
            openaiApiKey: useOpenAi ? normalizedOpenAiApiKey : null,
          });
          stepsDone++;
          setMetaProgress({ current: stepsDone, total });
          return meta.trim();
        }),
      );

      return reduce(reduced);
    }

    return reduce(summaries);
  };

  /** Emit result (at most once per session) then reset. */
  const finishWithResult = (
    summaries: string[],
    fileName: string,
    filePath: string,
    fileSize: number,
    rawContent?: string[],
  ) => {
    if (savedRef.current) return;
    savedRef.current = true;
    const nonEmpty = summaries.flatMap((s, i) => (s ? [{ page: i + 1, text: s }] : []));
    if (nonEmpty.length === 0) return reset();
    const combined =
      nonEmpty.length === 1
        ? nonEmpty[0].text
        : nonEmpty.map((p) => `Page ${p.page}: ${p.text}`).join("\n\n");
    onSummaryReady(combined, fileName, filePath, fileSize, rawContent);
    reset();
  };

  // ── Core summarisation loop - page text supplied by caller via getPageText ──
  const runSummarizationCore = async (
    getPageText: (idx: number) => Promise<string>,
    fileName: string,
    filePath: string,
    fileSize: number,
    actualPages: number,
    withMeta: boolean,
    allRawContent?: string[], // all pages (may exceed actualPages for .md/.txt)
  ) => {
    const collectedRaw: string[] = [];
    setStatus("summarizing");
    setProgress({ current: 0, total: actualPages });
    setWarning(null);

    const rawContent = () => allRawContent ?? collectedRaw;

    const summaries: string[] = new Array(actualPages).fill("");
    let completedCount = 0;
    const P = Math.max(1, parallelism);

    for (let chunkStart = 0; chunkStart < actualPages; chunkStart += P) {
      if (cancelActionRef.current !== "none") {
        if (cancelActionRef.current === "save") finishWithResult(summaries, fileName, filePath, fileSize, rawContent());
        else reset();
        return;
      }

      const chunkEnd = Math.min(chunkStart + P, actualPages);
      const indices = Array.from({ length: chunkEnd - chunkStart }, (_, i) => chunkStart + i);

      let chunkResults: string[];
      try {
        chunkResults = await Promise.all(
          indices.map(async (idx) => {
            const pageNum = idx + 1;
            const text = await getPageText(idx);
            collectedRaw[idx] = text ?? "";

            if (!text) {
              return "[No text found on this page - may be blank or image rendering failed.]";
            }

            try {
              const summary = await invoke<string>("summarize_pdf_cmd", {
                text: text.slice(0, 4000),
                docName: fileName,
                modelFilename,
                lang: summaryLang,
                openaiApiKey: useOpenAi ? normalizedOpenAiApiKey : null,
              });
              return summary.trim();
            } catch (err) {
              throw new Error(
                typeof err === "string" ? err : `Summarization of page ${pageNum} failed.`,
              );
            }
          }),
        );
      } catch (err) {
        if (completedCount > 0) finishWithResult(summaries, fileName, filePath, fileSize, rawContent());
        else reset();
        setStatus("error");
        setError(err instanceof Error ? err.message : "Summarization failed.");
        setProgress(null);
        processingRef.current = false;
        console.error("[PdfDropZone] chunk:", err);
        return;
      }

      for (let i = 0; i < chunkResults.length; i++) {
        summaries[chunkStart + i] = chunkResults[i];
      }
      completedCount += indices.length;
      setProgress({ current: completedCount, total: actualPages });

      if (cancelActionRef.current !== "none") {
        if (cancelActionRef.current === "save") finishWithResult(summaries, fileName, filePath, fileSize, rawContent());
        else reset();
        return;
      }
    }

    // ── Meta-summarisation phase ──────────────────────────────────────────
    if (withMeta && summaries.length > 1) {
      setStatus("meta-summarizing");
      setProgress(null);
      try {
        const master = await runMetaSummarization(summaries);
        if (!savedRef.current) {
          savedRef.current = true;
          onSummaryReady(master, fileName, filePath, fileSize, rawContent());
        }
      } catch (err) {
        finishWithResult(summaries, fileName, filePath, fileSize, rawContent());
        return;
      }
    } else {
      finishWithResult(summaries, fileName, filePath, fileSize, rawContent());
      return;
    }

    reset();
  };

  // ── PDF: builds getPageText using pdfjs + OCR fallback ───────────────────
  const runPdfSummarization = async (
    pdf: pdfjsLib.PDFDocumentProxy,
    fileName: string,
    filePath: string,
    fileSize: number,
    actualPages: number,
    withMeta: boolean,
  ) => {
    const getPageText = async (idx: number): Promise<string> => {
      const pageNum = idx + 1;
      let pageProxy: pdfjsLib.PDFPageProxy;
      try {
        pageProxy = await pdf.getPage(pageNum);
      } catch {
        throw new Error(`Could not read page ${pageNum}.`);
      }
      let text = await extractPageText(pageProxy).catch(() => "");
      if (!text) {
        // No embedded text - try OCR via macOS Vision framework
        try {
          const pngBase64 = await renderPageToPng(pageProxy);
          const ocrText = await invoke<string>("ocr_pdf_page_cmd", { imageBase64: pngBase64 });
          text = ocrText.trim();
        } catch (ocrErr) {
          console.warn("[PdfDropZone] OCR failed for page", pageNum, ocrErr);
        }
      }
      return text;
    };

    await runSummarizationCore(
      getPageText,
      fileName,
      filePath,
      fileSize,
      actualPages,
      withMeta,
    );
  };

  // ── Process PDF from path ─────────────────────────────────────────────────
  const processPdfFromPath = async (filePath: string, fileName: string) => {
    let pdfBytes: number[];
    try {
      pdfBytes = await invoke<number[]>("read_pdf_bytes_cmd", { path: filePath });
    } catch (err) {
      setStatus("error");
      setError("Could not read the file.");
      processingRef.current = false;
      console.error("[PdfDropZone] read bytes:", err);
      return;
    }

    const fileSize = pdfBytes.length;

    let pdf: pdfjsLib.PDFDocumentProxy;
    try {
      const uint8 = new Uint8Array(pdfBytes);
      pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
    } catch (err) {
      setStatus("error");
      setError("Could not open the PDF file.");
      processingRef.current = false;
      console.error("[PdfDropZone] open:", err);
      return;
    }

    const totalPages = pdf.numPages;
    const requested = computeRequestedPages(totalPages);

    if (totalPages > warnThreshold && requested > warnThreshold) {
      setStatus("warning");
      setWarning({
        filePath, fileName, fileSize, totalPages,
        requestedPages: requested, adjustedPages: requested,
        confirm: (count, withMeta) => {
          void runPdfSummarization(pdf, fileName, filePath, fileSize, count, withMeta);
        },
      });
      return;
    }

    const withMeta = requested > warnThreshold;
    await runPdfSummarization(pdf, fileName, filePath, fileSize, requested, withMeta);
  };

  // ── Split plain text into pages (30 lines or 2500 chars, first wins) ────
  function splitPlaintextPages(text: string): string[] {
    const pages: string[] = [];
    const lines = text.split("\n");
    let pageLines: string[] = [];
    let pageChars = 0;
    for (const line of lines) {
      const lineLen = line.length + 1; // +1 for the newline
      if (
        pageLines.length > 0 &&
        (pageLines.length >= PLAINTEXT_PAGE_LINES || pageChars + lineLen > PLAINTEXT_PAGE_CHARS)
      ) {
        pages.push(pageLines.join("\n"));
        pageLines = [];
        pageChars = 0;
      }
      pageLines.push(line);
      pageChars += lineLen;
    }
    if (pageLines.length > 0) pages.push(pageLines.join("\n"));
    return pages.filter((p) => p.trim().length > 0);
  }

  // ── Process .md / .txt from path ─────────────────────────────────────────
  const processMdTxtFromPath = async (filePath: string, fileName: string) => {
    let bytes: number[];
    try {
      bytes = await invoke<number[]>("read_pdf_bytes_cmd", { path: filePath });
    } catch (err) {
      setStatus("error");
      setError("Could not read the file.");
      processingRef.current = false;
      console.error("[PdfDropZone] read text file:", err);
      return;
    }

    const fileSize = bytes.length;
    let text: string;
    try {
      text = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    } catch {
      setStatus("error");
      setError("File is not valid UTF-8 text.");
      processingRef.current = false;
      return;
    }

    const allPages = splitPlaintextPages(text);
    const totalPages = allPages.length;

    if (totalPages === 0) {
      setStatus("error");
      setError("The file has no readable text content.");
      processingRef.current = false;
      return;
    }

    const requested = computeRequestedPages(totalPages);

    if (totalPages > warnThreshold && requested > warnThreshold) {
      setStatus("warning");
      setWarning({
        filePath, fileName, fileSize, totalPages,
        requestedPages: requested, adjustedPages: requested,
        confirm: (count, withMeta) => {
          const pages = allPages.slice(0, count);
          void runSummarizationCore(
            async (idx) => pages[idx] ?? "",
            fileName, filePath, fileSize, pages.length, withMeta,
            allPages, // always pass ALL pages as raw_content
          );
        },
      });
      return;
    }

    const withMeta = requested > warnThreshold;
    const pages = allPages.slice(0, requested);
    await runSummarizationCore(
      async (idx) => pages[idx] ?? "",
      fileName, filePath, fileSize, pages.length, withMeta,
      allPages, // always pass ALL pages as raw_content
    );
  };

  // ── Process a file given its local path (entry point) ────────────────────
  const processFileFromPath = async (filePath: string) => {
    if (processingRef.current) return; // synchronous guard against concurrent calls
    processingRef.current = true;
    savedRef.current = false;
    cancelActionRef.current = "none";

    const fileName = filePath.split("/").pop() ?? "document";
    const lc = filePath.toLowerCase();
    const isMdTxt = lc.endsWith(".md") || lc.endsWith(".txt");

    if (!modelFilename) {
      setStatus("error");
      setError("No model selected. Choose one in Settings → File processing.");
      processingRef.current = false;
      return;
    }
    if (useOpenAi && !normalizedOpenAiApiKey) {
      setStatus("error");
      setError("OpenAI API key missing. Add it in Settings → Local LM.");
      processingRef.current = false;
      return;
    }
    setStatus("extracting");
    setError(null);
    setProgress(null);
    setWarning(null);

    // Yield to the event loop so React can paint the "Processing..." UI before
    // the Rust IPC call (which blocks until the file is fully read/parsed).
    await new Promise<void>((r) => setTimeout(r, 0));

    if (isMdTxt) {
      await processMdTxtFromPath(filePath, fileName);
    } else {
      await processPdfFromPath(filePath, fileName);
    }
  };

  // Always keep the ref pointing at the latest processFileFromPath closure
  onDropPathRef.current = (filePath: string) => {
    if (!processingRef.current) void processFileFromPath(filePath);
  };

  // ── Tauri window-level drag-drop events ──────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    getCurrentWindow()
      .onDragDropEvent((event) => {
        const type = event.payload.type;
        if (type === "enter" || type === "over") {
          if (!processingRef.current) setDragOver(true);
        } else if (type === "leave") {
          setDragOver(false);
        } else if (type === "drop") {
          setDragOver(false);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const paths: string[] = (event.payload as any).paths ?? [];
          const accepted = paths.find((p) =>
            ACCEPTED_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))
          );
          if (accepted) {
            onDropPathRef.current?.(accepted);
          } else if (paths.length > 0) {
            setStatus("error");
            setError(`Supported formats: ${ACCEPTED_LABEL}.`);
          }
        }
      })
      .then((fn) => {
        if (mounted) {
          unlisten = fn;
        } else {
          fn(); // component already unmounted - unlisten immediately
        }
      });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []); // registers once; stale-closure safety via onDropPathRef + processingRef

  // ── Click → native file picker ───────────────────────────────────────────
  const handleClick = async () => {
    if (processingRef.current || status === "warning") return;
    try {
      const result = await openFilePicker({
        multiple: false,
        filters: [{ name: "Documents", extensions: ["pdf", "md", "txt"] }],
      });
      if (!result) return;
      const filePath = typeof result === "string" ? result : (result as { path: string }).path;
      await processFileFromPath(filePath);
    } catch (err) {
      console.error("[PdfDropZone] file picker:", err);
    }
  };

  // For the page-level progress bar: fill at (current+0.5)/total so it's
  // always partially filled while pages are in progress.
  const pagePct = progress
    ? Math.min(100, Math.round(((progress.current + 0.5) / progress.total) * 100))
    : 0;

  const metaPct = metaProgress
    ? Math.min(100, Math.round(((metaProgress.current + 0.5) / metaProgress.total) * 100))
    : 0;

  // ── Large-document warning UI ─────────────────────────────────────────────
  if (status === "warning" && warning !== null) {
    const metaSteps = countMetaSteps(warning.adjustedPages);
    return (
      <div className="pdf-drop-zone pdf-drop-zone--warning">
        <span style={{ fontWeight: 600, fontSize: 12 }}>
          ⚠ This file has {warning.totalPages} pages.
        </span>
        <span style={{ fontSize: 11 }}>
          Processing {warning.requestedPages} page{warning.requestedPages !== 1 ? "s" : ""} may
          take a long time and produce a lot of text.
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11 }}>Pages to process:</span>
          <input
            type="number"
            min={1}
            max={warning.totalPages}
            value={warning.adjustedPages}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n) && n >= 1) {
                setWarning({ ...warning, adjustedPages: Math.min(n, warning.totalPages) });
              }
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 64,
              fontSize: 12,
              padding: "2px 4px",
              borderRadius: 4,
              border: "1px solid #999",
              background: "transparent",
            }}
          />
          <span style={{ fontSize: 11, opacity: 0.65 }}>of {warning.totalPages}</span>
        </div>

        <label
          style={{ display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer", marginTop: 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={doMetaSummary}
            onChange={(e) => setDoMetaSummary(e.target.checked)}
            style={{ marginTop: 1, cursor: "pointer", flexShrink: 0 }}
          />
          <span style={{ fontSize: 11 }}>
            Condense all summaries into one master summary
            <span style={{ opacity: 0.55 }}>
              {" "}(+{metaSteps} extra LLM call{metaSteps !== 1 ? "s" : ""})
            </span>
          </span>
        </label>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={(e) => {
              e.stopPropagation();
              reset();
            }}
            style={{ fontSize: 11 }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={(e) => {
              e.stopPropagation();
              const adjusted = Math.min(Math.max(1, warning.adjustedPages), warning.totalPages);
              warning.confirm(adjusted, doMetaSummary);
            }}
            style={{ fontSize: 11 }}
          >
            Process {warning.adjustedPages} {warning.adjustedPages === 1 ? "page" : "pages"}
            {doMetaSummary ? " + master summary" : ""}
          </button>
        </div>
      </div>
    );
  }

  // ── Inline stop confirmation dialog ──────────────────────────────────────
  if (showStopDialog) {
    return (
      <div className="pdf-drop-zone pdf-drop-zone--warning" onClick={(e) => e.stopPropagation()}>
        <span style={{ fontWeight: 600, fontSize: 12 }}>Stop processing?</span>
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          You can save what has been summarized so far, or discard everything.
        </span>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => setShowStopDialog(false)}
            style={{ fontSize: 11 }}
          >
            Keep processing
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => {
              cancelActionRef.current = "discard";
              setShowStopDialog(false);
            }}
            style={{ fontSize: 11 }}
          >
            Discard all
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              cancelActionRef.current = "save";
              setShowStopDialog(false);
            }}
            style={{ fontSize: 11 }}
          >
            Stop here &amp; save
          </button>
        </div>
      </div>
    );
  }

  // ── Normal drop zone ──────────────────────────────────────────────────────
  return (
    <div
      className={`pdf-drop-zone${dragOver ? " pdf-drop-zone--over" : ""}${busy ? " pdf-drop-zone--busy" : ""}${status === "error" ? " pdf-drop-zone--error" : ""}`}
      onClick={handleClick}
    >
      <span className="pdf-drop-zone-icon">
        <IconFilePdf />
      </span>

      <span className="pdf-drop-zone-text">
        {status === "idle" && `Drop or click to select a ${ACCEPTED_LABEL}`}

        {status === "extracting" && (
          <span className="pdf-progress">
            <span className="pdf-progress-title">Processing{dots}</span>
          </span>
        )}

        {status === "summarizing" && progress && (
          <span className="pdf-progress">
            <span className="pdf-progress-title">
              Processing{dots}
              {useOpenAi ? (
                <span
                  className="pdf-progress-backend"
                  style={{ display: "block", fontSize: 11, fontWeight: 400, opacity: 0.88, marginTop: 2 }}
                >
                  Summaries: OpenAI API (page text is still extracted on this device)
                </span>
              ) : (
                <span
                  className="pdf-progress-backend"
                  style={{ display: "block", fontSize: 11, fontWeight: 400, opacity: 0.88, marginTop: 2 }}
                >
                  Summaries: local model on this device
                </span>
              )}
            </span>
            <span className="pdf-progress-count">
              {progress.current} / {progress.total} pages
            </span>
            <span className="pdf-progress-track">
              <span className="pdf-progress-fill" style={{ width: `${pagePct}%` }} />
            </span>
          </span>
        )}

        {status === "meta-summarizing" && metaProgress && (
          <span className="pdf-progress">
            <span className="pdf-progress-title">
              Building master summary{dots}
              {useOpenAi ? (
                <span
                  className="pdf-progress-backend"
                  style={{ display: "block", fontSize: 11, fontWeight: 400, opacity: 0.88, marginTop: 2 }}
                >
                  Meta-summary: OpenAI API
                </span>
              ) : (
                <span
                  className="pdf-progress-backend"
                  style={{ display: "block", fontSize: 11, fontWeight: 400, opacity: 0.88, marginTop: 2 }}
                >
                  Meta-summary: local model on this device
                </span>
              )}
            </span>
            <span className="pdf-progress-count">
              Step {metaProgress.current} / {metaProgress.total}
            </span>
            <span className="pdf-progress-track">
              <span className="pdf-progress-fill" style={{ width: `${metaPct}%` }} />
            </span>
          </span>
        )}

        {status === "error" && (error ?? "Error")}
      </span>

      {/* Stop button - visible while processing */}
      {busy && (
        <button
          type="button"
          className="pdf-drop-zone-retry"
          title="Stop processing"
          onClick={(e) => {
            e.stopPropagation();
            setShowStopDialog(true);
          }}
          style={{ flexShrink: 0 }}
        >
          ■
        </button>
      )}

      {status === "error" && (
        <button
          type="button"
          className="pdf-drop-zone-retry"
          onClick={(e) => {
            e.stopPropagation();
            reset();
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
