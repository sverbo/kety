import {
  memo,
  useState,
  useCallback,
  useMemo,
  isValidElement,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import { displayAssistantAnswerForUser } from "./assistantChatDisplay";
import type { DebugPrompt } from "./assistantChatTypes";
import { IconCopy, IconCheck, IconInfo } from "./AppIcons";

export const USER_TRUNCATED_FOOTER_EN =
  "Message sent truncated - exceeded maximum length.";

function textFromReactNode(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join("");
  if (isValidElement(node)) {
    const ch = (node.props as { children?: ReactNode }).children;
    return textFromReactNode(ch);
  }
  return "";
}

export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const raw = useMemo(() => textFromReactNode(children).replace(/\n$/, ""), [children]);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(raw).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [raw]);

  return (
    <div className="chat-md-pre-wrap">
      <button
        type="button"
        className="chat-md-pre-copy"
        onClick={copy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      <pre className="chat-md-pre">{children}</pre>
    </div>
  );
}

export const UserMessageBubble = memo(function UserMessageBubble({
  content,
  truncated,
}: {
  content: string;
  truncated?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [content]);

  return (
    <div className="chat-user-wrap">
      <div className="chat-bubble chat-bubble--user">
        {content}
        {truncated ? (
          <p className="chat-user-truncated-footer">{USER_TRUNCATED_FOOTER_EN}</p>
        ) : null}
      </div>
      <button
        type="button"
        className="chat-copy-msg"
        onClick={copy}
        title={copied ? "Copied" : "Copy message"}
        aria-label={copied ? "Copied" : "Copy message"}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
});

export function AssistantMarkdown({
  children,
}: {
  children: string;
}): ReactNode {
  return (
    <div className="chat-md">
      <Markdown
        components={{
          p: ({ children: c }) => <div className="chat-md-p">{c}</div>,
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {c}
            </a>
          ),
          img: ({ src, alt, ...rest }) => {
            if (!src) return null;
            return <img src={src} alt={alt ?? ""} {...rest} />;
          },
          code: ({ className, children: c, ...props }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) {
              return (
                <code className={className} {...props}>
                  {c}
                </code>
              );
            }
            return (
              <code className="chat-md-inline" {...props}>
                {c}
              </code>
            );
          },
          pre: ({ children: c }) => <MarkdownCodeBlock>{c}</MarkdownCodeBlock>,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

export const AssistantMessageBlock = memo(function AssistantMessageBlock({
  content,
  llmCost,
  isSuperAdmin,
  debugPrompt,
}: {
  content: string;
  llmCost?: Record<string, unknown>;
  isSuperAdmin?: boolean;
  debugPrompt?: DebugPrompt;
}) {
  const [copied, setCopied] = useState(false);
  const [llmCostOpen, setLlmCostOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const visibleMarkdown = useMemo(
    () => displayAssistantAnswerForUser(content),
    [content],
  );
  const llmCostJson = useMemo(
    () => (llmCost ? JSON.stringify(llmCost, null, 2) : ""),
    [llmCost],
  );
  const llmCostTotal = useMemo(() => {
    if (!llmCost) return null;
    // prompt_only mode: total_estimated_usd
    if (typeof llmCost.total_estimated_usd === "number" && Number.isFinite(llmCost.total_estimated_usd)) {
      return llmCost.total_estimated_usd;
    }
    // stream mode: summary.cost_usd.total
    const summary = llmCost.summary;
    if (summary == null || typeof summary !== "object") return null;
    const cost = (summary as Record<string, unknown>).cost_usd;
    if (cost == null || typeof cost !== "object") return null;
    const total = (cost as Record<string, unknown>).total;
    if (typeof total !== "number" || !Number.isFinite(total)) return null;
    return total;
  }, [llmCost]);

  const isEstimatedCost = llmCost?.mode === "prompt_only";

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [content]);

  return (
    <div className="chat-assistant-wrap">
      <div className="chat-bubble chat-bubble--assistant">
        {content ? (
          <AssistantMarkdown>{visibleMarkdown}</AssistantMarkdown>
        ) : null}
      </div>
      {content ? (
        <div className="chat-assistant-actions">
          <button
            type="button"
            className="chat-copy-msg"
            onClick={copy}
            title={copied ? "Copied" : "Copy response"}
            aria-label={copied ? "Copied" : "Copy response"}
          >
            {copied ? <IconCheck /> : <IconCopy />}
          </button>
          {llmCost ? (
            <button
              type="button"
              className="chat-copy-msg chat-info-msg"
              onClick={() => setLlmCostOpen(true)}
              title="LLM cost details"
              aria-label="LLM cost details"
            >
              <IconInfo />
            </button>
          ) : null}
          {isSuperAdmin && debugPrompt ? (
            <button
              type="button"
              className="chat-copy-msg chat-info-msg"
              onClick={() => setDebugOpen(true)}
              title="Debug: show exact prompt sent"
              aria-label="Debug prompt"
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
      {debugOpen && debugPrompt ? (
        <div className="modal-overlay" onClick={() => setDebugOpen(false)}>
          <div className="modal-card chat-llm-cost-modal" style={{ maxWidth: 640, width: "90vw" }} onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Debug — Prompt sent</h3>
            <div style={{ margin: "0 0 10px", fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
              <p style={{ margin: 0, opacity: 0.7 }}><strong>Model:</strong> {debugPrompt.model || "(none)"}</p>
              {debugPrompt.ragEmbedModel !== undefined && (
                <p style={{ margin: 0, opacity: 0.7 }}><strong>Embed model:</strong> {debugPrompt.ragEmbedModel}</p>
              )}
              {debugPrompt.ragHitCount !== undefined && (
                <p style={{ margin: 0, opacity: debugPrompt.ragHitCount === 0 ? 1 : 0.7, color: debugPrompt.ragHitCount === 0 ? "var(--color-warning, #f59e0b)" : undefined }}>
                  <strong>RAG hits:</strong> {debugPrompt.ragHitCount}
                  {debugPrompt.ragHitCount === 0 ? " ⚠️ no context injected" : ""}
                </p>
              )}
              {"ragTagFilter" in debugPrompt && (
                <p style={{ margin: 0, opacity: 0.7 }}>
                  <strong>Tag filter:</strong>{" "}
                  {debugPrompt.ragTagFilter == null
                    ? "none (all captures)"
                    : debugPrompt.ragTagFilter.length === 0
                    ? "[] (empty → all captures)"
                    : debugPrompt.ragTagFilter.join(", ")}
                </p>
              )}
              {debugPrompt.ragError && (
                <p style={{ margin: 0, color: "var(--color-error, #ef4444)" }}><strong>RAG error:</strong> {debugPrompt.ragError}</p>
              )}
              {debugPrompt.indexDiag && (
                <div style={{ marginTop: 6, padding: "6px 8px", borderRadius: 4, background: "var(--color-surface-2, rgba(0,0,0,0.05))", fontSize: 11 }}>
                  <p style={{ margin: "0 0 3px", fontWeight: 600, opacity: 0.6, textTransform: "uppercase", fontSize: 10 }}>Index state</p>
                  <p style={{ margin: 0, opacity: 0.7 }}>
                    meta model: <code>{debugPrompt.indexDiag.metaEmbedModel || "(empty)"}</code> dim={debugPrompt.indexDiag.metaEmbedDim}
                  </p>
                  <p style={{
                    margin: 0,
                    opacity: debugPrompt.indexDiag.validChunkEmbeddings === 0 && debugPrompt.indexDiag.totalChunkEmbeddings > 0 ? 1 : 0.7,
                    color: debugPrompt.indexDiag.validChunkEmbeddings === 0 && debugPrompt.indexDiag.totalChunkEmbeddings > 0 ? "var(--color-error, #ef4444)" : undefined,
                  }}>
                    chunks: {debugPrompt.indexDiag.totalChunks} &nbsp;|&nbsp; embeddings: {debugPrompt.indexDiag.totalChunkEmbeddings}
                    {" | "}valid (searchable): {debugPrompt.indexDiag.validChunkEmbeddings}
                    {debugPrompt.indexDiag.validChunkEmbeddings === 0 && debugPrompt.indexDiag.totalChunkEmbeddings > 0
                      ? " ⚠️ all orphaned — reindex needed"
                      : ""}
                  </p>
                  <p style={{ margin: 0, opacity: 0.7 }}>
                    captures indexed: {debugPrompt.indexDiag.capturesWithEmbeddings} &nbsp;|&nbsp;
                    not yet: {debugPrompt.indexDiag.capturesMissingEmbeddings}
                    {debugPrompt.indexDiag.capturesMissingEmbeddings > 0 ? " ⚠️" : ""}
                  </p>
                  <p style={{ margin: "2px 0 0", opacity: 0.7 }}>
                    visible captures: with tags {debugPrompt.indexDiag.capturesWithTags} / without {debugPrompt.indexDiag.capturesWithoutTags}
                    {debugPrompt.indexDiag.capturesWithoutTags > 0 && debugPrompt.ragTagFilter && debugPrompt.ragTagFilter.length > 0 && !debugPrompt.ragTagFilter.includes("00000000-0000-0000-0000-000000000000")
                      ? " ⚠️ untagged won't match"
                      : ""}
                  </p>
                  {debugPrompt.indexDiag.sampleTagIds.length > 0 && (
                    <p style={{ margin: "1px 0 0", opacity: 0.5, fontSize: 10 }}>
                      sample tag_ids: {debugPrompt.indexDiag.sampleTagIds.slice(0, 2).join(" | ")}
                    </p>
                  )}
                  {debugPrompt.indexDiag.storedModels.length === 0 ? (
                    <p style={{ margin: 0, color: "var(--color-error, #ef4444)" }}>No rows in chunk_embeddings!</p>
                  ) : (
                    <div>
                      <p style={{ margin: "2px 0 1px", opacity: 0.5 }}>Stored models:</p>
                      {debugPrompt.indexDiag.storedModels.map(([model, count]) => (
                        <p key={model} style={{ margin: 0, opacity: model === debugPrompt.indexDiag!.metaEmbedModel ? 1 : 0.5, color: model !== debugPrompt.indexDiag!.metaEmbedModel ? "var(--color-warning, #f59e0b)" : undefined }}>
                          <code>{model}</code> × {count}{model !== debugPrompt.indexDiag!.metaEmbedModel ? " ⚠️ mismatch" : " ✓"}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "60vh", overflowY: "auto" }}>
              {debugPrompt.messages.map((m, i) => (
                <div key={i} style={{ borderRadius: 6, padding: "8px 10px", background: m.role === "system" ? "var(--color-surface-2, rgba(0,0,0,0.05))" : m.role === "user" ? "var(--color-surface-3, rgba(99,102,241,0.08))" : "var(--color-surface-4, rgba(0,0,0,0.03))" }}>
                  <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", opacity: 0.5 }}>{m.role}</p>
                  <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}>{m.content}</pre>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => {
                  void navigator.clipboard.writeText(JSON.stringify(debugPrompt, null, 2));
                }}
              >
                Copy JSON
              </button>
              <button
                type="button"
                className="modal-btn modal-btn--cancel"
                onClick={() => setDebugOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {llmCostOpen && llmCost ? (
        <div className="modal-overlay" onClick={() => setLlmCostOpen(false)}>
          <div className="modal-card chat-llm-cost-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">LLM Cost Breakdown</h3>
            <p className="modal-body">
              {llmCostTotal != null
                ? `Total ${isEstimatedCost ? "estimated " : ""}cost: $${llmCostTotal.toFixed(6)}${isEstimatedCost ? " (router exact + frontend estimated)" : ""}`
                : "Raw cost breakdown for this assistant response."}
            </p>
            <pre className="chat-llm-cost-json">{llmCostJson}</pre>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn modal-btn--cancel"
                onClick={() => setLlmCostOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
