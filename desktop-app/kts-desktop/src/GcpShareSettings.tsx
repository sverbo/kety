import { useCallback, useEffect, useState } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import {
  getGcpShareConfig,
  removeGcpShareConfig,
  setGcpShareConfig,
  testGcpShareConnection,
  type GcpShareConfigInfo,
} from "./gcpShareService";

export type GcpShareSettingsProps = {
  profileId: string;
};

export function GcpShareSettings({ profileId }: GcpShareSettingsProps) {
  const [config, setConfig] = useState<GcpShareConfigInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [bucketNameInput, setBucketNameInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    setErr(null);
    try {
      const c = await getGcpShareConfig(profileId);
      setConfig(c);
      setBucketNameInput(c?.bucketName ?? "");
    } catch (e) {
      // A rejected promise here means the config file exists but is broken (e.g. a corrupted
      // or hand-edited service account JSON) — distinct from the resolved `null` case, which
      // means sharing genuinely isn't set up yet. Surface the error instead of silently
      // falling back to the empty "not set up" form, so a broken profile isn't indistinguishable
      // from one that was never configured.
      setConfig(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChooseFile = useCallback(async () => {
    if (!bucketNameInput.trim()) {
      setErr("Enter a bucket name first.");
      return;
    }
    setErr(null);
    setTestStatus("idle");
    try {
      const result = await openFilePicker({
        multiple: false,
        filters: [{ name: "Service account key", extensions: ["json"] }],
      });
      if (!result) return;
      const filePath = typeof result === "string" ? result : (result as { path: string }).path;
      setSaving(true);
      const updated = await setGcpShareConfig(profileId, bucketNameInput.trim(), filePath);
      setConfig(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [profileId, bucketNameInput]);

  const handleTestConnection = useCallback(async () => {
    setTestStatus("testing");
    setErr(null);
    try {
      await testGcpShareConnection(profileId);
      setTestStatus("ok");
    } catch (e) {
      setTestStatus("error");
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [profileId]);

  const handleRemove = useCallback(async () => {
    if (!window.confirm("Remove this bucket configuration? You won't be able to revoke any share links you've created afterward — they'll keep working until they expire on their own (up to 7 days).")) {
      return;
    }
    setSaving(true);
    try {
      await removeGcpShareConfig(profileId);
      setConfig(null);
      setBucketNameInput("");
      setTestStatus("idle");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [profileId]);

  if (loading) return null;

  return (
    <div className="settings-section">
      <div className="settings-section-title">Sharing</div>
      <p style={{ fontSize: 12, opacity: 0.7, marginTop: 4, marginBottom: 12 }}>
        Connect a Google Cloud Storage bucket you own to share individual files or exports as
        time-limited download links (up to 7 days). See the FAQ for setup help.
      </p>

      {config ? (
        <div>
          <div style={{ fontSize: 13 }}>
            Bucket: <strong>{config.bucketName}</strong>
          </div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
            Service account: {config.clientEmail}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void handleTestConnection()} disabled={testStatus === "testing"}>
              {testStatus === "testing" ? "Testing…" : "Test connection"}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void handleRemove()} disabled={saving}>
              Remove
            </button>
          </div>
          {testStatus === "ok" ? (
            <p style={{ fontSize: 12, color: "var(--color-green, #22c55e)", marginTop: 8 }}>
              Connection works — upload and delete succeeded.
            </p>
          ) : null}
        </div>
      ) : (
        <div>
          <label className="settings-label" htmlFor="gcp-share-bucket-name">
            Bucket name
          </label>
          <input
            id="gcp-share-bucket-name"
            type="text"
            className="settings-input"
            value={bucketNameInput}
            onChange={(e) => setBucketNameInput(e.target.value)}
            placeholder="my-kety-bucket"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn btn-secondary btn-small"
            style={{ marginTop: 8 }}
            onClick={() => void handleChooseFile()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Choose service account JSON…"}
          </button>
        </div>
      )}

      {err ? (
        <p style={{ fontSize: 12, color: "var(--color-red, #ef4444)", marginTop: 8 }} role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
