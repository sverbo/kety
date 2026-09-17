/**
 * Shared copy for Settings → Process and Process → Prepare → “Show prompt”.
 * Must match parsing in `local_llm.rs` (`parse_sensitivity_token`).
 */
export function SensitivePromptHelpText({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className="settings-hint"
      style={{
        marginBottom: compact ? 8 : 10,
        fontSize: compact ? 11 : 13,
        lineHeight: 1.45,
      }}
    >
      <p style={{ margin: "0 0 8px 0" }}>
        Placeholders: <code>{"{{APP}}"}</code>, <code>{"{{WINDOW}}"}</code>,{" "}
        <code>{"{{TEXT}}"}</code> - replaced with the application name, window title, and the text (or one
        chunk of it) for each call.
      </p>
      <p style={{ margin: 0 }}>
        The model must answer with <code>-1</code>, <code>0</code>, or <code>1</code>. The app
        reads : <code>-1</code> sensitive, <code>0</code> maybe,{" "}
        <code>1</code> not sensitive.
      </p>
    </div>
  );
}
