import { useState } from "react";
import { useProfile } from "./profileContext";

export function ProfileSetupScreen() {
  const { profiles, createProfile, switchProfile } = useProfile();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    await createProfile(trimmed);
    setBusy(false);
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg, #0f0f0f)",
        color: "var(--text-primary, #e8e8e8)",
        fontFamily: "inherit",
        zIndex: 9999,
        gap: 20,
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700 }}>Create a profile</div>
      <div style={{ fontSize: 13, opacity: 0.5 }}>A name is enough — stored locally only.</div>

      <form
        onSubmit={(e) => void handleCreate(e)}
        style={{ display: "flex", flexDirection: "column", gap: 10, width: 260 }}
      >
        <input
          type="text"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          maxLength={64}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(255,255,255,0.08)",
            color: "inherit",
            fontSize: 14,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!name.trim() || busy}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "none",
            background: "rgba(255,255,255,0.9)",
            color: "#111",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            opacity: !name.trim() || busy ? 0.4 : 1,
          }}
        >
          {busy ? "Creating…" : "Create profile"}
        </button>
      </form>

      {profiles.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 260, marginTop: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.4, textAlign: "center" }}>
            or switch to an existing profile
          </div>
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => void switchProfile(p.id)}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 13,
                opacity: 0.7,
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
