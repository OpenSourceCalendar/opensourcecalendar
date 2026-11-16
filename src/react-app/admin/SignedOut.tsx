import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { adminApi } from "./api";
import { setToken } from "./session";

/**
 * Shown without a valid session. Standalone installs get a password form;
 * installs opened from a host app are told to open the calendar again from there.
 */
export function SignedOut({ ended, onSignedIn }: { ended: boolean; onSignedIn: () => void }) {
  const [mode, setMode] = useState<"checking" | "password" | "host">("checking");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    // An empty password is always refused: 401 means password login exists, 404 means it doesn't.
    adminApi.login("").then(
      () => live && setMode("password"),
      (e) => live && setMode(e instanceof ApiError && e.status === 404 ? "host" : "password"),
    );
    return () => {
      live = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const { token } = await adminApi.login(password);
      setToken(token, "password");
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That password isn't right."
          : "We couldn't sign you in. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="admin-center">
      <main className="admin-card">
        {mode === "checking" && <span className="skeleton block" aria-label="Loading" />}
        {mode === "host" && (
          <>
            <h1 className="title">{ended ? "Your session ended" : "Sign in from your app"}</h1>
            <p className="lede">Open the calendar again from your app to keep going.</p>
          </>
        )}
        {mode === "password" && (
          <form className="form" onSubmit={submit}>
            <h1 className="title">{ended ? "Your session ended" : "Sign in to your calendar"}</h1>
            {ended && <p className="lede">Sign in again to keep going.</p>}
            <div className="field">
              <label className="label" htmlFor="owner-password">
                Password
              </label>
              <input
                id="owner-password"
                className="input"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                aria-invalid={!!error}
                aria-describedby={error ? "owner-password-error" : undefined}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && (
                <p className="field-error" id="owner-password-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <button className="btn btn-primary" type="submit" disabled={!password || busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
