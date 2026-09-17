import { useState, useEffect } from "react";
import { store } from "./appStore";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

function JsonNode({ value, depth = 0 }: { value: JsonValue; depth?: number }) {
  const [collapsed, setCollapsed] = useState(depth > 1);

  if (value === null) return <span style={{ color: "#94a3b8" }}>null</span>;
  if (typeof value === "boolean")
    return <span style={{ color: "#fb923c" }}>{String(value)}</span>;
  if (typeof value === "number")
    return <span style={{ color: "#34d399" }}>{value}</span>;
  if (typeof value === "string") {
    if (value.length > 120) {
      return (
        <LongString value={value} />
      );
    }
    return <span style={{ color: "#fbbf24" }}>&quot;{value}&quot;</span>;
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as JsonValue[]).map((v, i) => [String(i), v] as [string, JsonValue])
    : Object.entries(value as { [k: string]: JsonValue });

  if (entries.length === 0) {
    return <span style={{ opacity: 0.4 }}>{isArray ? "[]" : "{}"}</span>;
  }

  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  const label = `${open}${entries.length}${close}`;

  if (collapsed) {
    return (
      <span
        style={{ cursor: "pointer", color: "#818cf8", userSelect: "none" }}
        onClick={(e) => { e.stopPropagation(); setCollapsed(false); }}
        title="Expand"
      >
        {label}
      </span>
    );
  }

  return (
    <span>
      <span
        style={{ cursor: "pointer", color: "#818cf8", userSelect: "none" }}
        onClick={(e) => { e.stopPropagation(); setCollapsed(true); }}
        title="Collapse"
      >
        {open}
      </span>
      <div style={{ marginLeft: 16, borderLeft: "1px solid rgba(255,255,255,0.06)", paddingLeft: 8 }}>
        {entries.map(([k, v]) => (
          <div key={k} style={{ lineHeight: "1.7" }}>
            {!isArray && (
              <span style={{ color: "#a5b4fc", marginRight: 4 }}>
                &quot;{k}&quot;:
              </span>
            )}
            {isArray && (
              <span style={{ color: "rgba(255,255,255,0.25)", marginRight: 4, fontSize: 10 }}>
                {k}:
              </span>
            )}
            <JsonNode value={v} depth={depth + 1} />
          </div>
        ))}
      </div>
      <span style={{ color: "#818cf8", userSelect: "none" }}>{close}</span>
    </span>
  );
}

function LongString({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <span
      style={{ cursor: "pointer", color: "#fbbf24", textDecoration: "underline dotted" }}
      title={expanded ? "Collapse" : "Expand"}
      onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }}
    >
      &quot;{expanded ? value : value.slice(0, 120) + "…"}&quot;
    </span>
  );
}

export function StoreInspectorModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<[string, JsonValue][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const keys = await store.keys();
        const pairs = await Promise.all(
          keys.map(async (k) => {
            const v = await store.get<JsonValue>(k);
            return [k, v ?? null] as [string, JsonValue];
          })
        );
        pairs.sort((a, b) => a[0].localeCompare(b[0]));
        setEntries(pairs);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const filtered = search.trim()
    ? entries.filter(([k]) => k.toLowerCase().includes(search.toLowerCase()))
    : entries;

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
          <span style={{ fontWeight: 700, fontSize: 13, opacity: 0.9 }}>
            Store Inspector
          </span>
          <span style={{ opacity: 0.4, fontSize: 11 }}>
            kts-session-store.json
          </span>
          <div style={{ flex: 1 }} />
          <input
            type="search"
            placeholder="Filter keys…"
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
              width: 200,
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

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "8px 16px 16px" }}>
          {loading && <div style={{ padding: 16, opacity: 0.5 }}>Loading…</div>}
          {error && <div style={{ padding: 16, color: "#ef4444" }}>{error}</div>}
          {!loading && !error && (
            <>
              <div style={{ padding: "4px 0 8px", opacity: 0.4, fontSize: 11 }}>
                {filtered.length}{search ? ` / ${entries.length}` : ""} key{filtered.length !== 1 ? "s" : ""}
              </div>
              {filtered.map(([key, value]) => (
                <KeyRow key={key} storeKey={key} value={value} />
              ))}
              {filtered.length === 0 && (
                <div style={{ opacity: 0.4, padding: "8px 0" }}>
                  {search ? "No keys match filter" : "Store is empty"}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function KeyRow({ storeKey, value }: { storeKey: string; value: JsonValue }) {
  const [collapsed, setCollapsed] = useState(true);
  const isComplex =
    value !== null && typeof value === "object";

  return (
    <div
      style={{
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        padding: "6px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          cursor: isComplex ? "pointer" : "default",
          userSelect: "none",
        }}
        onClick={() => isComplex && setCollapsed((x) => !x)}
      >
        {isComplex && (
          <span style={{ opacity: 0.4, fontSize: 10, width: 10, textAlign: "center", flexShrink: 0 }}>
            {collapsed ? "▶" : "▼"}
          </span>
        )}
        {!isComplex && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ color: "#a5b4fc", fontWeight: 600 }}>{storeKey}</span>
        {collapsed && (
          <span style={{ opacity: 0.55 }}>
            <JsonNode value={value} depth={99} />
          </span>
        )}
      </div>
      {!collapsed && isComplex && (
        <div style={{ marginLeft: 18, marginTop: 4 }}>
          <JsonNode value={value} depth={0} />
        </div>
      )}
    </div>
  );
}
