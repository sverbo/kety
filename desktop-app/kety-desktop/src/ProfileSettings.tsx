import { useCallback, useState } from "react";
import type { LocalProfile } from "./profileContext";

export type ProfileSettingsProps = {
  activeProfile: LocalProfile | null;
  profiles: LocalProfile[];
  createProfile: (name: string) => Promise<LocalProfile>;
  switchProfile: (id: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  updateProfileName: (id: string, name: string) => Promise<void>;
};

export function ProfileSettings({
  activeProfile,
  profiles,
  createProfile,
  switchProfile,
  deleteProfile,
  updateProfileName,
}: ProfileSettingsProps) {
  const [newProfileName, setNewProfileName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    const name = newProfileName.trim();
    if (!name) return;
    setCreating(true);
    setErr(null);
    try {
      await createProfile(name);
      setNewProfileName("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [newProfileName, createProfile]);

  const handleSwitch = useCallback(
    async (id: string) => {
      setBusyId(id);
      setErr(null);
      try {
        await switchProfile(id);
        // Full reload rather than a live in-place switch: captures, knowledge,
        // and every other piece of profile-scoped state are keyed by profile
        // id across many components — a fresh load is what actually guarantees
        // none of it stays stale, rather than auditing every effect for it.
        window.location.reload();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setBusyId(null);
      }
    },
    [switchProfile]
  );

  const handleDelete = useCallback(
    async (profile: LocalProfile) => {
      if (
        !window.confirm(
          `Remove profile "${profile.name}" from this list? Its captures and knowledge stay on disk but become inaccessible unless you recreate a profile that points at the same data.`
        )
      ) {
        return;
      }
      setBusyId(profile.id);
      setErr(null);
      try {
        await deleteProfile(profile.id);
        if (profile.id === activeProfile?.id) {
          window.location.reload();
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [deleteProfile, activeProfile]
  );

  const startRename = useCallback((profile: LocalProfile) => {
    setRenamingId(profile.id);
    setRenameValue(profile.name);
  }, []);

  const commitRename = useCallback(
    async (id: string) => {
      const name = renameValue.trim();
      setRenamingId(null);
      if (!name) return;
      try {
        await updateProfileName(id, name);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [renameValue, updateProfileName]
  );

  return (
    <div className="settings-section">
      <div className="settings-section-title">Profiles</div>
      <p style={{ fontSize: 12, opacity: 0.7, marginTop: 4, marginBottom: 10 }}>
        Each profile has its own captures, knowledge, and settings — no account or password
        required.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {profiles.map((p) => {
          const isActive = p.id === activeProfile?.id;
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                background: isActive ? "var(--color-accent-soft, rgba(99,102,241,0.12))" : "transparent",
              }}
            >
              {renamingId === p.id ? (
                <input
                  type="text"
                  className="settings-input"
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => void commitRename(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(p.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  style={{ flex: 1, fontSize: 13 }}
                />
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  style={{ flex: 1, textAlign: "left", fontWeight: isActive ? 600 : 400 }}
                  onClick={() => startRename(p)}
                  title="Click to rename"
                >
                  {p.name}
                  {isActive ? " (active)" : ""}
                </button>
              )}
              {!isActive && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={busyId === p.id}
                  onClick={() => void handleSwitch(p.id)}
                >
                  {busyId === p.id ? "Switching…" : "Switch"}
                </button>
              )}
              {profiles.length > 1 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={busyId === p.id}
                  onClick={() => void handleDelete(p)}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          className="settings-input"
          placeholder="New profile name"
          value={newProfileName}
          onChange={(e) => setNewProfileName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
          disabled={creating}
          style={{ flex: 1, fontSize: 13 }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => void handleCreate()}
          disabled={creating || !newProfileName.trim()}
        >
          {creating ? "Creating…" : "New profile"}
        </button>
      </div>
      {err ? (
        <p style={{ fontSize: 12, color: "var(--color-red, #ef4444)", marginTop: 8 }} role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
