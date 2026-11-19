import { useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { PasswordInput } from "../components/PasswordInput";
import { adminApi, adminErrorText, type AccountInfo } from "./api";
import { refreshHostedToken } from "./session";
import type { Notify } from "./Toast";

/** The signed-in person's own settings: password and devices. Never about a client the agency is viewing. */
export function Account({ account, notify, onAccount }: { account: AccountInfo; notify: Notify; onAccount: (a: AccountInfo) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if ([...next.normalize("NFC")].length < 15) return setError("Use at least 15 characters. A short sentence works well.");
    setBusy(true);
    setError("");
    try {
      const s = await adminApi.setPassword({ password: next, ...(current && { current_password: current }) });
      // Same sign-in, new token: this tab keeps working while other devices are signed out.
      refreshHostedToken(s.token);
      setCurrent("");
      setNext("");
      onAccount({ ...account, has_password: true });
      notify({ text: account.has_password ? "Password changed. Your other devices are signed out." : "Password set." });
    } catch (err) {
      // Without a password there's no current one to enter: the only way is a fresh sign-in.
      if (err instanceof ApiError && err.error === "reauth_required" && !account.has_password) {
        setError("For safety, sign out and sign in again with an emailed link, then set your password within 15 minutes.");
      } else setError(adminErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function everywhere() {
    try {
      refreshHostedToken((await adminApi.signOutEverywhere()).token);
      notify({ text: "Signed out of all other devices." });
    } catch (err) {
      notify({ text: adminErrorText(err), error: true });
    }
  }

  return (
    <>
      <header className="admin-band">
        <h1 className="admin-title">Account</h1>
        <p className="muted">Signed in as {account.email}</p>
      </header>
      <section className="card settings" aria-labelledby="acct-password">
        <h2 className="card-title" id="acct-password">
          {account.has_password ? "Change password" : "Set a password"}
        </h2>
        <p className="muted small">
          {account.has_password ? "Changing it signs out your other devices." : "Then you can sign in with your email and password as well."}
        </p>
        <form className="form" onSubmit={save} noValidate>
          <input type="email" autoComplete="username" value={account.email} readOnly hidden />
          {account.has_password && (
            <div className="field">
              <label className="label" htmlFor="acct-current">
                Current password
              </label>
              <PasswordInput id="acct-current" value={current} onChange={setCurrent} autoComplete="current-password" />
              <p className="hint">Not needed if you signed in within the last 15 minutes (for example with an emailed link).</p>
            </div>
          )}
          <div className="field">
            <label className="label" htmlFor="acct-new">
              New password
            </label>
            <PasswordInput id="acct-new" value={next} onChange={setNext} autoComplete="new-password" invalid={!!error} />
            <p className="hint">At least 15 characters. A short sentence you'll remember works well.</p>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-auto" disabled={busy}>
            {busy ? "Saving…" : "Save password"}
          </button>
        </form>
      </section>
      <section className="card settings" aria-labelledby="acct-devices">
        <h2 className="card-title" id="acct-devices">
          Devices
        </h2>
        <p className="muted small">Signs out every other phone and computer. This one stays signed in.</p>
        <button type="button" className="btn btn-secondary btn-auto" onClick={everywhere}>
          Sign out of all devices
        </button>
      </section>
    </>
  );
}
