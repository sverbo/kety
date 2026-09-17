import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAuth } from "./authContext";

export async function openWebAppPath(path: string): Promise<void> {
  const raw = (import.meta.env.VITE_WEB_APP_URL as string | undefined)?.trim();
  if (!raw) {
    throw new Error(
      "VITE_WEB_APP_URL is not defined. Add it to .env.local or .env.production."
    );
  }
  const base = raw.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  await openUrl(`${base}${suffix}`);
}

export function AuthModal() {
  const { authModalOpen, closeAuthModal, signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authModalOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await signIn(email, password);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setEmail("");
    setPassword("");
    closeAuthModal();
  }

  return (
    <div
      className="auth-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) closeAuthModal();
      }}
    >
      <div className="auth-modal-card glass-card">
        <h2 id="auth-modal-title" className="auth-modal-title">
          Sign in
        </h2>
        <form className="auth-modal-form" onSubmit={handleSubmit}>
          <label className="auth-modal-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john.doe@company.com"
              required
            />
          </label>
          <label className="auth-modal-field">
            <span>Password</span>
            <div className="auth-modal-password-input">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
              />
              <button
                type="button"
                className="auth-modal-password-toggle"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                    <path
                      d="M3 3l18 18M10.58 10.58A2 2 0 0012 14a2 2 0 001.42-.58M9.88 5.09A10.94 10.94 0 0112 5c5 0 9.27 3.11 11 7-1.03 2.31-2.87 4.27-5.19 5.38M6.61 6.61C4.62 7.87 3.03 9.73 2 12c.66 1.48 1.69 2.86 3 4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                    <path
                      d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle
                      cx="12"
                      cy="12"
                      r="3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    />
                  </svg>
                )}
              </button>
            </div>
          </label>
          {error ? (
            <p className="auth-modal-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="auth-modal-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={closeAuthModal}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
        <p className="auth-modal-footer">
          <span className="auth-modal-footer-links">
            <button
              type="button"
              className="auth-create-account-link"
              disabled={busy}
              onClick={() => {
                void openWebAppPath("/create-account").catch((e) =>
                  setError(e instanceof Error ? e.message : String(e))
                );
              }}
            >
              Create account
            </button>
            <span className="auth-modal-footer-sep" aria-hidden>
              ·
            </span>
            <button
              type="button"
              className="auth-create-account-link"
              disabled={busy}
              onClick={() => {
                void openWebAppPath("/reset-password").catch((e) =>
                  setError(e instanceof Error ? e.message : String(e))
                );
              }}
            >
              Reset password
            </button>
          </span>
        </p>
      </div>
    </div>
  );
}

export function AuthRequiredGate({
  message,
}: {
  message: string;
}) {
  const { openAuthModal } = useAuth();
  const [webLinkError, setWebLinkError] = useState<string | null>(null);
  return (
    <div className="glass-card auth-required-gate">
      <p className="auth-required-message">{message}</p>
      <button type="button" className="btn btn-primary" onClick={openAuthModal}>
        Sign in
      </button>
      <p className="auth-required-footer">
        <span className="auth-modal-footer-links">
          <button
            type="button"
            className="auth-create-account-link"
            onClick={() => {
              setWebLinkError(null);
              void openWebAppPath("/create-account").catch((e) =>
                setWebLinkError(
                  e instanceof Error ? e.message : String(e)
                )
              );
            }}
          >
            Create account
          </button>
          <span className="auth-modal-footer-sep" aria-hidden>
            ·
          </span>
          <button
            type="button"
            className="auth-create-account-link"
            onClick={() => {
              setWebLinkError(null);
              void openWebAppPath("/reset-password").catch((e) =>
                setWebLinkError(
                  e instanceof Error ? e.message : String(e)
                )
              );
            }}
          >
            Reset password
          </button>
        </span>
      </p>
      {webLinkError ? (
        <p className="auth-modal-error auth-required-inline-error" role="alert">
          {webLinkError}
        </p>
      ) : null}
    </div>
  );
}
