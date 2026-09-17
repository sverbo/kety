import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type TableData = {
  columns: string[];
  rows: Array<Array<string | null>>;
};

type ExecuteResult = {
  columns: string[];
  rows: Array<Array<string | null>>;
  rowsAffected: number;
};

const CELL_MAX = 120;
let warnCollapsedPersisted = false;

function truncate(v: string | null): string {
  if (v == null) return "NULL";
  if (v.length > CELL_MAX) return v.slice(0, CELL_MAX) + "…";
  return v;
}

function CellValue({ v }: { v: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (v == null) return <span style={{ opacity: 0.35, fontStyle: "italic" }}>NULL</span>;
  if (v.length <= CELL_MAX) return <span>{v}</span>;
  return (
    <span
      style={{ cursor: "pointer", textDecoration: "underline dotted" }}
      title={expanded ? "Click to collapse" : "Click to expand"}
      onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }}
    >
      {expanded ? v : truncate(v)}
    </span>
  );
}

export function SqliteInspectorModal({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const [tables, setTables] = useState<string[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [data, setData] = useState<TableData | null>(null);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sqlInput, setSqlInput] = useState("");
  const [sqlResult, setSqlResult] = useState<ExecuteResult | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlBusy, setSqlBusy] = useState(false);
  const [warnCollapsed, setWarnCollapsed] = useState(warnCollapsedPersisted);
  const sqlRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    invoke<string[]>("sqlite_list_tables_cmd", { userId })
      .then((t) => { setTables(t); if (t.length > 0) setActiveTable(t[0]); })
      .catch((e) => setError(String(e)));
  }, [userId]);

  const loadTable = useCallback(
    async (table: string, col: string | null, desc: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<TableData>("sqlite_query_table_cmd", {
          userId,
          table,
          sortCol: col ?? null,
          sortDesc: desc,
          limit: 500,
        });
        setData(result);
      } catch (e) {
        setError(String(e));
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [userId]
  );

  useEffect(() => {
    if (activeTable) {
      setSearch("");
      setSortCol(null);
      setSortDesc(false);
      void loadTable(activeTable, null, false);
    }
  }, [activeTable, loadTable]);

  function handleSort(col: string) {
    const newDesc = sortCol === col ? !sortDesc : false;
    setSortCol(col);
    setSortDesc(newDesc);
    if (activeTable) void loadTable(activeTable, col, newDesc);
  }

  async function runSql() {
    const q = sqlInput.trim();
    if (!q) return;
    setSqlBusy(true);
    setSqlError(null);
    setSqlResult(null);
    try {
      const res = await invoke<ExecuteResult>("sqlite_execute_cmd", { userId, sql: q });
      setSqlResult(res);
      // Refresh table view if it was a write query.
      if (res.columns.length === 0 && activeTable) {
        void loadTable(activeTable, sortCol, sortDesc);
      }
    } catch (e) {
      setSqlError(String(e));
    } finally {
      setSqlBusy(false);
    }
  }

  const filteredRows = data
    ? search.trim()
      ? data.rows.filter((row) =>
          row.some((cell) => cell?.toLowerCase().includes(search.toLowerCase()))
        )
      : data.rows
    : [];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "stretch",
      }}
      onClick={onClose}
    >
      <div
        style={{
          margin: "24px",
          flex: 1,
          background: "var(--color-surface, #1a1a2e)",
          border: "1px solid var(--color-border, rgba(255,255,255,0.12))",
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontFamily: "monospace",
          fontSize: 12,
          color: "#fff",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "10px 16px",
            borderBottom: "1px solid var(--color-border, rgba(255,255,255,0.1))",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 13, fontFamily: "inherit", opacity: 0.9 }}>
            SQLite Inspector
          </span>
          <span style={{ opacity: 0.4, fontSize: 11 }}>{userId.slice(0, 8)}…</span>
          <div style={{ flex: 1 }} />
          <input
            type="search"
            placeholder="Filter rows…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              color: "inherit",
              fontFamily: "monospace",
              fontSize: 11,
              padding: "3px 8px",
              width: 160,
              outline: "none",
            }}
          />
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              opacity: 0.5,
              fontSize: 16,
              padding: "0 4px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Developer mode warning */}
        <div
          onClick={() => setWarnCollapsed((x) => { warnCollapsedPersisted = !x; return !x; })}
          style={{
            padding: warnCollapsed ? "5px 14px" : "8px 14px",
            borderBottom: "1px solid rgba(239,68,68,0.3)",
            background: "rgba(239,68,68,0.08)",
            flexShrink: 0,
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <div style={{ color: "#ef4444", fontWeight: 700, fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
            ⚠ Developer mode
            <span style={{ opacity: 0.5, fontSize: 9, marginLeft: "auto" }}>{warnCollapsed ? "▼" : "▲"}</span>
          </div>
          {!warnCollapsed && (
            <>
              <div style={{ color: "#fca5a5", fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>
                You are entering developer mode. Any query run here — including <code style={{ background: "rgba(239,68,68,0.2)", borderRadius: 3, padding: "0 3px" }}>UPDATE</code>, <code style={{ background: "rgba(239,68,68,0.2)", borderRadius: 3, padding: "0 3px" }}>DELETE</code>, or <code style={{ background: "rgba(239,68,68,0.2)", borderRadius: 3, padding: "0 3px" }}>DROP</code> — runs directly against your local knowledge base and may corrupt it or make it incompatible with future versions of the app. Proceed with caution.
              </div>
              <div style={{ color: "#fca5a5", fontSize: 11, marginTop: 5, opacity: 0.75 }}>
                <strong>Note:</strong> Tables whose names end in <code style={{ background: "rgba(239,68,68,0.2)", borderRadius: 3, padding: "0 3px" }}>_fts</code> (e.g. <code style={{ background: "rgba(239,68,68,0.2)", borderRadius: 3, padding: "0 3px" }}>captures_fts</code>) are internal full-text search indexes. Their content looks unreadable by design — this is expected and normal.
              </div>
            </>
          )}
        </div>

        {/* SQL input */}
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--color-border, rgba(255,255,255,0.1))",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              ref={sqlRef}
              value={sqlInput}
              onChange={(e) => setSqlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void runSql();
                }
              }}
              placeholder="SELECT * FROM captures LIMIT 10   (Cmd+Enter to run)"
              rows={2}
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                color: "inherit",
                fontFamily: "monospace",
                fontSize: 11,
                padding: "5px 8px",
                resize: "vertical",
                outline: "none",
                minHeight: 38,
              }}
            />
            <button
              onClick={() => void runSql()}
              disabled={sqlBusy || !sqlInput.trim()}
              style={{
                background: "var(--accent, #6366f1)",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                cursor: sqlBusy || !sqlInput.trim() ? "not-allowed" : "pointer",
                fontFamily: "monospace",
                fontSize: 11,
                padding: "6px 14px",
                opacity: sqlBusy || !sqlInput.trim() ? 0.5 : 1,
                flexShrink: 0,
                alignSelf: "flex-end",
              }}
            >
              {sqlBusy ? "…" : "Run"}
            </button>
          </div>
          {sqlError && (
            <div style={{ color: "#ef4444", fontSize: 11 }}>{sqlError}</div>
          )}
          {sqlResult && sqlResult.columns.length === 0 && !sqlError && (
            <div style={{ color: "#4ade80", fontSize: 11 }}>
              OK — {sqlResult.rowsAffected} row{sqlResult.rowsAffected !== 1 ? "s" : ""} affected
            </div>
          )}
          {sqlResult && sqlResult.columns.length > 0 && (
            <div style={{ overflowX: "auto", maxHeight: 180 }}>
              <table style={{ borderCollapse: "collapse", width: "max-content", fontSize: 11 }}>
                <thead>
                  <tr>
                    {sqlResult.columns.map((c) => (
                      <th key={c} style={{ padding: "3px 8px", borderBottom: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", whiteSpace: "nowrap", fontWeight: 600, opacity: 0.7, textAlign: "left" }}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sqlResult.rows.map((row, ri) => (
                    <tr key={ri} style={{ background: ri % 2 === 0 ? "transparent" : "rgba(255,255,255,0.025)" }}>
                      {row.map((cell, ci) => (
                        <td key={ci} style={{ padding: "3px 8px", borderBottom: "1px solid rgba(255,255,255,0.05)", verticalAlign: "top" }}>
                          <CellValue v={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {sqlResult.rows.length === 0 && (
                    <tr>
                      <td colSpan={sqlResult.columns.length} style={{ padding: "8px", opacity: 0.4, textAlign: "center" }}>
                        0 rows
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Sidebar — table list */}
          <div
            style={{
              width: 160,
              flexShrink: 0,
              borderRight: "1px solid var(--color-border, rgba(255,255,255,0.1))",
              overflowY: "auto",
              padding: "8px 0",
            }}
          >
            {tables.map((t) => (
              <button
                key={t}
                onClick={() => setActiveTable(t)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: activeTable === t ? "rgba(99,102,241,0.18)" : "none",
                  border: "none",
                  borderLeft: activeTable === t ? "3px solid var(--accent, #6366f1)" : "3px solid transparent",
                  color: activeTable === t ? "var(--accent, #6366f1)" : "inherit",
                  cursor: "pointer",
                  fontFamily: "monospace",
                  fontSize: 11,
                  padding: "6px 10px 6px 12px",
                  opacity: activeTable === t ? 1 : 0.65,
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Main — table data */}
          <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
            {loading && (
              <div style={{ padding: 16, opacity: 0.5 }}>Loading…</div>
            )}
            {error && (
              <div style={{ padding: 16, color: "#ef4444" }}>{error}</div>
            )}
            {!loading && !error && data && (
              <>
                <div style={{ padding: "6px 12px 4px", opacity: 0.45, fontSize: 11, flexShrink: 0 }}>
                  {filteredRows.length}{search ? ` / ${data.rows.length}` : ""} row{filteredRows.length !== 1 ? "s" : ""}
                  {data.rows.length === 500 ? " (limit 500)" : ""}
                  {" · "}{data.columns.length} col{data.columns.length !== 1 ? "s" : ""}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      borderCollapse: "collapse",
                      width: "max-content",
                      minWidth: "100%",
                    }}
                  >
                    <thead>
                      <tr>
                        {data.columns.map((col) => (
                          <th
                            key={col}
                            onClick={() => handleSort(col)}
                            style={{
                              padding: "5px 10px",
                              textAlign: "left",
                              cursor: "pointer",
                              borderBottom: "1px solid rgba(255,255,255,0.12)",
                              background: "rgba(255,255,255,0.04)",
                              whiteSpace: "nowrap",
                              userSelect: "none",
                              color: sortCol === col ? "var(--accent, #6366f1)" : undefined,
                              opacity: sortCol === col ? 1 : 0.7,
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            {col}
                            {sortCol === col && (
                              <span style={{ marginLeft: 4, fontSize: 9 }}>
                                {sortDesc ? "▼" : "▲"}
                              </span>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map((row, ri) => (
                        <tr
                          key={ri}
                          style={{
                            background: ri % 2 === 0 ? "transparent" : "rgba(255,255,255,0.025)",
                          }}
                        >
                          {row.map((cell, ci) => (
                            <td
                              key={ci}
                              style={{
                                padding: "4px 10px",
                                borderBottom: "1px solid rgba(255,255,255,0.05)",
                                maxWidth: 300,
                                verticalAlign: "top",
                                wordBreak: "break-word",
                              }}
                            >
                              <CellValue v={cell} />
                            </td>
                          ))}
                        </tr>
                      ))}
                      {filteredRows.length === 0 && (
                        <tr>
                          <td
                            colSpan={data.columns.length}
                            style={{ padding: 16, opacity: 0.4, textAlign: "center" }}
                          >
                            {search ? "No rows match filter" : "Empty table"}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
