import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { allZones, visitorZone, zoneOffset } from "../time";
import { adminApi, type AdminCalendar, type ServiceInput, type WeeklyDay } from "./api";
import { cleanSlug, SLUG_HINT, SLUG_RE, useSlugCheck } from "./slug";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hosted accounts start with a working booking page; the owner changes both later.
const DEFAULT_WEEK: WeeklyDay[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: weekday >= 1 && weekday <= 5, start_min: 540, end_min: 1020, breaks: [] }));
const FIRST_SERVICE: ServiceInput = {
  name: "Consultation", description: "", duration_min: 30, price_cents: 0, color: "#4f46e5",
  location_type: "phone", location_text: "", hidden: false, is_call_default: false,
};

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** First run: name the business, pick the booking link and the time zone. */
export function Setup({ onCreated }: { onCreated: (calendar: AdminCalendar) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [zone, setZone] = useState(visitorZone);
  const [ownerEmail, setOwnerEmail] = useState("");
  const emailOk = !ownerEmail.trim() || EMAIL_RE.test(ownerEmail.trim());
  const slugState = useSlugCheck(slug);
  // The server said it was taken on save, after the live check passed.
  const [takenOnSave, setTakenOnSave] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hosted, setHosted] = useState(false);

  useEffect(() => {
    // Hosted accounts only: pre-fill the email; host-app and standalone first runs are unchanged.
    adminApi.account().then(
      (a) => {
        setHosted(true);
        setOwnerEmail((e) => e || a.email);
      },
      () => {},
    );
  }, []);

  // Built once: labelling ~400 zones on every keystroke is slow.
  const zones = useMemo(() => {
    const all = allZones();
    return (all.includes(zone) ? all : [zone, ...all]).map((z) => ({ value: z, label: `${z.replace(/_/g, " ")} (${zoneOffset(z)})` }));
  }, [zone]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim() || !SLUG_RE.test(slug) || shownState === "taken" || !emailOk) return;
    setBusy(true);
    setError("");
    try {
      const created = await adminApi.createCalendar({ slug, time_zone: zone });
      // The name is cosmetic; if saving it fails the owner can set it under Branding.
      // Checked above, so a bad address can't make this fail and lose the name too.
      const email = ownerEmail.trim();
      const named = await adminApi
        .updateCalendar({ branding: { business_name: name.trim() }, ...(email && { notifications: { owner_email: email } }) })
        .catch(() => created);
      // A working booking page from the start. Failures don't block: the owner can add both later.
      if (hosted) await Promise.allSettled([adminApi.saveWeekly(DEFAULT_WEEK), adminApi.createService(FIRST_SERVICE)]);
      onCreated(named);
    } catch (err) {
      const code = err instanceof ApiError ? err.error : "";
      if (code === "slug_taken") setTakenOnSave(slug);
      else if (code === "calendar_exists") return window.location.reload();
      else if (code === "invalid_input") setError("That booking link can't be used. Try a different one.");
      else if (code !== "unauthorized") setError("We couldn't set up your calendar. Check your connection and try again.");
      setBusy(false);
    }
  }

  const shownState = takenOnSave === slug ? "taken" : slugState;
  const slugBad = shownState === "invalid" || shownState === "taken";

  return (
    <div className="admin-center">
      <main className="admin-card">
        <form className="form" onSubmit={submit}>
          <div>
            <h1 className="title">Set up your calendar</h1>
            <p className="lede">Three quick things and you can start taking bookings.</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="setup-name">
              Business name
            </label>
            <input
              id="setup-name"
              className="input"
              autoFocus
              maxLength={100}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) setSlug(slugify(e.target.value));
              }}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="setup-slug">
              Booking link
            </label>
            <input
              id="setup-slug"
              className="input"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={40}
              value={slug}
              aria-invalid={slugBad}
              aria-describedby="setup-slug-hint"
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(cleanSlug(e.target.value));
              }}
            />
            <p
              id="setup-slug-hint"
              className={slugBad ? "field-error" : shownState === "available" ? "slug-ok" : "hint"}
              aria-live="polite"
            >
              {SLUG_HINT[shownState]}
            </p>
            <p className="slug-preview">
              {window.location.origin}/book/<strong>{slug || "your-business"}</strong>
            </p>
          </div>

          <div className="field">
            <label className="label" htmlFor="setup-zone">
              Time zone
            </label>
            <select id="setup-zone" className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
              {zones.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </select>
            <p className="hint">Your open hours and appointments use this time zone.</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="setup-email">
              Your email <span className="opt">(optional)</span>
            </label>
            <input
              id="setup-email"
              className="input"
              type="email"
              autoComplete="email"
              maxLength={254}
              value={ownerEmail}
              aria-invalid={!emailOk}
              aria-describedby="setup-email-hint"
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
            <p id="setup-email-hint" className={emailOk ? "hint" : "field-error"}>
              {emailOk ? "For booking notifications. You can change it later." : "That doesn't look like an email address."}
            </p>
          </div>

          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || !name.trim() || !SLUG_RE.test(slug) || shownState === "taken" || !emailOk}
          >
            {busy ? "Setting up…" : "Create my calendar"}
          </button>
        </form>
      </main>
    </div>
  );
}
