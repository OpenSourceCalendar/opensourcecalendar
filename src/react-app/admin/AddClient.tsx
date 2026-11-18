import { useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { allZones, zoneOffset } from "../time";
import { adminApi, adminErrorText, type AdminCalendar } from "./api";
import { Dialog } from "./Dialog";
import { setClientId } from "./session";
import { DEFAULT_WEEK, FIRST_SERVICE, slugify } from "./Setup";
import { cleanSlug, SLUG_HINT, SLUG_RE, useSlugCheck } from "./slug";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** White-label: add a client business. It starts like a new hosted calendar: weekdays 9–5 and one service. */
export function AddClient({ zone: startZone, onClose, onAdded }: { zone: string; onClose: () => void; onAdded: (calendar: AdminCalendar) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [zone, setZone] = useState(startZone);
  const [email, setEmail] = useState("");
  const slugState = useSlugCheck(slug);
  // The server said it was taken on save, after the live check passed.
  const [takenOnSave, setTakenOnSave] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Built once: labelling ~400 zones on every keystroke is slow.
  const zones = useMemo(() => {
    const all = allZones();
    return (all.includes(zone) ? all : [zone, ...all]).map((z) => ({ value: z, label: `${z.replace(/_/g, " ")} (${zoneOffset(z)})` }));
  }, [zone]);

  const shownState = takenOnSave === slug ? "taken" : slugState;
  const slugBad = shownState === "invalid" || shownState === "taken";
  const emailOk = EMAIL_RE.test(email.trim());
  const ready = !busy && !!name.trim() && SLUG_RE.test(slug) && !slugBad && emailOk;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const created = await adminApi.addClient({ business_name: name.trim(), slug, time_zone: zone, owner_email: email.trim() });
      // From here on, calls are about the new client. A working booking page from the start; failures don't block.
      setClientId(created.id);
      await Promise.allSettled([adminApi.saveWeekly(DEFAULT_WEEK), adminApi.createService(FIRST_SERVICE)]);
      onAdded(created);
    } catch (err) {
      if (err instanceof ApiError && err.error === "slug_taken") setTakenOnSave(slug);
      else setError(adminErrorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog kind="modal" title="Add a client" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="client-name">
            Business name
          </label>
          <input
            id="client-name"
            className="input"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugEdited) setSlug(slugify(e.target.value));
            }}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="client-slug">
            Booking address
          </label>
          <input
            id="client-slug"
            className="input"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={40}
            value={slug}
            aria-invalid={slugBad}
            aria-describedby="client-slug-hint"
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(cleanSlug(e.target.value));
            }}
          />
          <p id="client-slug-hint" className={slugBad ? "field-error" : shownState === "available" ? "slug-ok" : "hint"} aria-live="polite">
            {SLUG_HINT[shownState]}
          </p>
          <p className="slug-preview">
            {window.location.origin}/book/<strong>{slug || "client-business"}</strong>
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="client-zone">
            Time zone
          </label>
          <select id="client-zone" className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label" htmlFor="client-email">
            Notification email
          </label>
          <input
            id="client-email"
            className="input"
            type="email"
            maxLength={254}
            value={email}
            aria-invalid={!!email.trim() && !emailOk}
            aria-describedby="client-email-hint"
            onChange={(e) => setEmail(e.target.value)}
          />
          <p id="client-email-hint" className={!email.trim() || emailOk ? "hint" : "field-error"}>
            {!email.trim() || emailOk ? "This business's booking notifications go here." : "That doesn't look like an email address."}
          </p>
        </div>

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={!ready}>
          {busy ? "Adding…" : "Add client"}
        </button>
      </form>
    </Dialog>
  );
}
