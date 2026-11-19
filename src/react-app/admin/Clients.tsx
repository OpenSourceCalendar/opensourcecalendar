import { useState, type FormEvent } from "react";
import { adminApi, adminErrorText, type ClientList } from "./api";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import type { Notify } from "./Toast";

type Client = ClientList["calendars"][number];

function statusText(c: Client): string {
  if (c.signin.status === "not_invited") return "Not invited";
  if (c.signin.status === "invited") return `Invited · ${c.signin.email}`;
  const when = c.signin.last_login_at ? new Date(c.signin.last_login_at).toLocaleDateString() : "";
  return `Signed in${when ? ` ${when}` : ""} · ${c.signin.email}`;
}

/** White-label: the agency's clients, with Open, invites and sign-in removal. */
export function Clients({
  clients,
  onOpen,
  onAdd,
  onChanged,
  notify,
}: {
  clients: ClientList;
  onOpen: (id: string) => void;
  /** Null when the plan can't add clients. */
  onAdd: (() => void) | null;
  onChanged: () => void;
  notify: Notify;
}) {
  const [inviting, setInviting] = useState<Client | null>(null);
  const [removing, setRemoving] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const list = clients.calendars.filter((c) => !c.home);
  const name = (c: Client) => c.business_name || c.slug;

  async function remove(c: Client) {
    setBusy(true);
    try {
      await adminApi.removeSignIn(c.id);
      notify({ text: `${name(c)} can no longer sign in` });
      setRemoving(null);
      onChanged();
    } catch (e) {
      notify({ text: adminErrorText(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-head admin-band">
        <div>
          <h1 className="admin-title">Clients</h1>
          <p className="muted">
            {clients.count} of {clients.limit} businesses, yours included.
          </p>
        </div>
        {onAdd && (
          <button type="button" className="btn btn-primary btn-auto" onClick={onAdd}>
            <Icon name="plus" />
            Add client
          </button>
        )}
      </header>
      {list.length === 0 ? (
        <div className="admin-empty">
          <p className="sub">No clients yet</p>
          <p className="muted small">Add a client to give them their own booking page and sign-in.</p>
        </div>
      ) : (
        <ul className="client-list">
          {list.map((c) => (
            <li key={c.id} className="client-row">
              <div className="client-main">
                <span>
                  <strong>{name(c)}</strong> {c.paused && <span className="badge">Paused</span>}
                </span>
                <a className="muted small" href={`/book/${c.slug}`} target="_blank" rel="noreferrer">
                  /book/{c.slug}
                </a>
                <span className="small">{statusText(c)}</span>
              </div>
              <div className="client-actions">
                <button type="button" className="btn btn-secondary btn-auto" onClick={() => onOpen(c.id)}>
                  Open
                </button>
                <button type="button" className="btn btn-secondary btn-auto" onClick={() => setInviting(c)}>
                  {c.signin.status === "not_invited" ? "Send invite" : "Resend"}
                </button>
                {c.signin.status !== "not_invited" && (
                  <button type="button" className="link small" onClick={() => setRemoving(c)}>
                    Remove sign-in
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {inviting && (
        <InviteDialog
          client={inviting}
          onClose={() => setInviting(null)}
          onSent={(email) => {
            setInviting(null);
            notify({ text: `Invite sent to ${email}` });
            onChanged();
          }}
        />
      )}
      {removing && (
        <Dialog kind="modal" title={`Remove ${name(removing)}'s sign-in?`} onClose={() => setRemoving(null)}>
          <p className="lede">
            They're signed out at once and can't sign in until you invite them again. Their calendar, bookings and booking page stay.
          </p>
          <div className="two">
            <button type="button" className="btn btn-secondary" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => remove(removing)}>
              Remove sign-in
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function InviteDialog({ client, onClose, onSent }: { client: Client; onClose: () => void; onSent: (email: string) => void }) {
  // The current sign-in email, else the one that gets booking notifications.
  const [email, setEmail] = useState(client.signin.email ?? client.notification_email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = client.business_name || client.slug;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await adminApi.inviteClient(client.id, email.trim());
      onSent(email.trim());
    } catch (err) {
      setError(adminErrorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog kind="modal" title={`Invite ${name} to sign in`} onClose={onClose}>
      <form className="form" onSubmit={submit} autoComplete="off" noValidate>
        <p className="lede">We'll email a link to set a password. It works once, for 7 days, and comes from {name}.</p>
        <div className="field">
          <label className="label" htmlFor="invite-email">
            Sign-in email
          </label>
          <input
            id="invite-email"
            className="input"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className="hint">Can be different from the email that gets booking notifications.</p>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="two">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Sending…" : "Send invite"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
