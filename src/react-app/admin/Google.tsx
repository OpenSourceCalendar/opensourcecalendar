import { useEffect, useRef, useState } from "react";
import type { PageProps } from "./AdminApp";
import { adminApi, adminErrorText, onFree, type BillingInfo, type GoogleCalendarChoice, type GoogleStatus } from "./api";
import { Dialog } from "./Dialog";
import { Setting, Switch } from "./Switch";

// TODO(owner): the public repo URL, once the project is public.
const SETUP_GUIDE = "https://github.com/OpenSourceCalendar/opensourcecalendar/blob/main/docs/google-calendar-setup.md";
const POLL_MS = 3_000;
const POLL_FOR_MS = 5 * 60_000;

const PROBLEMS: Record<string, string> = {
  signed_out: "Google signed this calendar out. This happens if you removed its access or changed your Google password.",
  missing_permission: "Google no longer lets this calendar see or edit your events.",
  calendar_missing: "The Google calendar it used was deleted, or isn't shared with you anymore.",
};

function ago(iso: string | null, now: number): string {
  if (!iso) return "not yet";
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min === 1) return "1 minute ago";
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  return h === 1 ? "1 hour ago" : `${h} hours ago`;
}

export function Google({
  calendar,
  notify,
  onCalendar,
  navigate,
  google,
  onGoogle,
  billing,
  paused,
}: PageProps & { google: GoogleStatus | null; onGoogle: (g: GoogleStatus) => void; billing: BillingInfo | null; paused: boolean }) {
  const [waiting, setWaiting] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "connect" | "sync" | "allday" | "calendar" | "disconnect">("");
  const [calendars, setCalendars] = useState<GoogleCalendarChoice[] | null>(null);
  const [switchTo, setSwitchTo] = useState<GoogleCalendarChoice | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pollStarted = useRef(0);

  const refresh = () => adminApi.google().then(onGoogle, () => {});

  // Keep "Last checked" fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // While the Google tab is open: check every few seconds, and as soon as the owner comes back to this tab.
  useEffect(() => {
    if (!waiting) return;
    pollStarted.current = Date.now();
    const check = () => {
      if (Date.now() - pollStarted.current > POLL_FOR_MS) return setWaiting(false);
      void refresh();
    };
    const t = setInterval(check, POLL_MS);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", check);
    };
  }, [waiting]);

  useEffect(() => {
    if (waiting && google?.status === "active") {
      setWaiting(false);
      setFallbackUrl(null);
      notify({ text: "Google Calendar connected" });
    }
  }, [waiting, google?.status, notify]);

  const active = google?.status === "active";
  useEffect(() => {
    if (!active) return setCalendars(null);
    adminApi.googleCalendars().then((r) => setCalendars(r.calendars), () => setCalendars([]));
  }, [active, google?.calendar?.id]);

  async function connect() {
    // Open the tab now, inside the click: browsers block tabs opened after waiting for the server.
    const tab = window.open("", "_blank");
    setBusy("connect");
    try {
      const { url } = await adminApi.connectGoogle();
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else setFallbackUrl(url);
      setWaiting(true);
    } catch (e) {
      tab?.close();
      notify({ text: adminErrorText(e), error: true });
    }
    setBusy("");
  }

  async function run<T>(what: typeof busy, fn: () => Promise<T>, done?: (v: T) => void) {
    setBusy(what);
    try {
      done?.(await fn());
    } catch (e) {
      notify({ text: adminErrorText(e), error: true });
    }
    setBusy("");
  }

  const blockAllDay = calendar.rules.block_all_day_google;
  const setAllDay = (on: boolean) =>
    run("allday", async () => {
      const next = await adminApi.updateCalendar({ rules: { block_all_day_google: on } });
      onCalendar(next);
      // Apply it to the booking page now rather than at the next check.
      if (active) onGoogle(await adminApi.syncGoogle());
    }, () => notify({ text: "Saved" }));

  // On Free, or for a paused client, busy sync is off and connecting is refused, so the connect buttons lead to the Plan page.
  const free = onFree(billing) || paused;
  const pausedNote = paused ? "Paused — subscribe to White-label to turn it back on." : "Paused on Free. Upgrade to turn it back on.";
  const toPlan = (
    <button type="button" className="btn btn-primary btn-auto" onClick={() => navigate("/admin/plan")}>
      See plans
    </button>
  );

  const header = (
    <header className="admin-band">
      <h1 className="admin-title">Google Calendar</h1>
      <p className="muted">Never get double-booked. Bookings go into your Google Calendar, and your own events block those times here.</p>
    </header>
  );

  if (!google) return header;

  if (!google.configured) {
    return (
      <>
        {header}
        <section className="card gc-card">
          <p className="lede">Google Calendar isn't set up on this server yet.</p>
          <p className="muted small">
            Whoever runs this booking calendar can turn it on by following the{" "}
            <a href={SETUP_GUIDE} target="_blank" rel="noopener noreferrer">
              Google Calendar setup guide
            </a>
            .
          </p>
        </section>
      </>
    );
  }

  const waitingNote = waiting && (
    <div className="gc-waiting" role="status" aria-live="polite">
      <span className="gc-pulse" aria-hidden="true" />
      <div>
        <p>Finish connecting in the Google tab. This page updates by itself.</p>
        {fallbackUrl && (
          <a className="btn btn-primary gc-open" href={fallbackUrl} target="_blank" rel="noopener noreferrer">
            Open Google sign-in
          </a>
        )}
        <button type="button" className="link muted small" onClick={() => (setWaiting(false), setFallbackUrl(null))}>
          Cancel
        </button>
      </div>
    </div>
  );

  const disconnectDialog = disconnecting && (
    <Dialog kind="modal" title="Disconnect Google Calendar?" onClose={() => setDisconnecting(false)}>
      <p className="lede">Bookings already in your Google Calendar stay there. New bookings won't be added, and your Google events won't block times anymore.</p>
      <div className="two">
        <button type="button" className="btn btn-secondary" onClick={() => setDisconnecting(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy === "disconnect"}
          onClick={() =>
            run("disconnect", adminApi.disconnectGoogle, () => {
              setDisconnecting(false);
              void refresh();
              notify({ text: "Google Calendar disconnected" });
            })
          }
        >
          {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    </Dialog>
  );

  if (google.status === "not_connected") {
    return (
      <>
        {header}
        <section className="card gc-card gc-connect">
          <ul className="gc-benefits">
            <li>New bookings show up in your Google Calendar, on your phone and computer.</li>
            <li>Your own events block those times on your booking page.</li>
            <li>Works with Google Calendar on iPhone, Android and desktop.</li>
          </ul>
          {free ? (
            <>
              <p>{paused ? "Subscribe to White-label to turn Google Calendar sync back on." : "Google Calendar sync is included in Pro."}</p>
              {toPlan}
            </>
          ) : waitingNote || (
            <button type="button" className="btn btn-primary gc-cta" disabled={busy === "connect"} onClick={connect}>
              {busy === "connect" ? "Opening Google…" : "Connect Google Calendar"}
            </button>
          )}
          <p className="muted small">
            Google will ask to let this booking calendar see and edit your calendar events. Your event details are never shown on your booking page. They only block the time.
          </p>
        </section>
        <Faq />
      </>
    );
  }

  if (google.status === "broken") {
    return (
      <>
        {header}
        <section className="card gc-card gc-broken" aria-labelledby="gc-broken-title">
          <h2 className="card-title" id="gc-broken-title">
            Google Calendar stopped connecting
          </h2>
          <p>{PROBLEMS[google.problem ?? ""] ?? "Something went wrong with the connection."}</p>
          <p className="muted small">Until you reconnect, new bookings aren't added to Google. Times you were busy before still stay blocked.</p>
          {free && <p>{pausedNote}</p>}
          {waitingNote || (
            <div className="gc-actions">
              {free ? (
                toPlan
              ) : (
                <button type="button" className="btn btn-primary" disabled={busy === "connect"} onClick={connect}>
                  {busy === "connect" ? "Opening Google…" : "Reconnect"}
                </button>
              )}
              <button type="button" className="link muted" onClick={() => setDisconnecting(true)}>
                Disconnect
              </button>
            </div>
          )}
        </section>
        {disconnectDialog}
      </>
    );
  }

  // Connected.
  const current = google.calendar;
  const choices = calendars && current && !calendars.some((c) => c.id === current.id) ? [{ ...current, primary: false }, ...calendars] : calendars;
  const ordered = choices ? [...choices].sort((a, b) => Number(b.primary) - Number(a.primary)) : null;
  return (
    <>
      {header}
      <section className="card gc-card" aria-labelledby="gc-status">
        <p className="gc-ok" id="gc-status">
          <span className="status-dot is-ok" aria-hidden="true" />
          Connected to <strong>{google.email || "your Google account"}</strong>
        </p>
        {free && (
          <>
            <p className="gc-warning" role="status">
              {pausedNote}
            </p>
            {toPlan}
          </>
        )}
        {google.warning && (
          <p className="gc-warning" role="status">
            {google.warning === "push_failed"
              ? "A booking couldn't be added to Google Calendar. It will try again with the next change. If this keeps happening, disconnect and connect again."
              : "Google Calendar hasn't been checked for a while. Times you're busy in Google may not be blocked yet."}
          </p>
        )}
        <p className="muted small">
          Last checked {ago(google.last_synced_at, now)}
          {" · "}
          <button type="button" className="link" disabled={busy === "sync"} onClick={() => run("sync", adminApi.syncGoogle, onGoogle)}>
            {busy === "sync" ? "Checking…" : "Check now"}
          </button>
        </p>

        <div className="field gc-field">
          <label className="label" htmlFor="gc-calendar">
            Calendar
          </label>
          <select
            id="gc-calendar"
            className="input"
            value={current?.id ?? ""}
            disabled={!ordered || busy === "calendar"}
            onChange={(e) => setSwitchTo(ordered?.find((c) => c.id === e.target.value) ?? null)}
          >
            {(ordered ?? (current ? [{ ...current, primary: false }] : [])).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.primary ? " (main)" : ""}
              </option>
            ))}
          </select>
          <p className="hint">Bookings go into this calendar, and its busy events block times.</p>
        </div>

        <Setting title="All-day events block the whole day" help="Turn off if you use all-day events for notes or reminders.">
          <Switch checked={blockAllDay} label="All-day events block the whole day" disabled={busy === "allday"} onChange={setAllDay} />
        </Setting>

        <div className="gc-actions">
          <button type="button" className="link gc-danger" onClick={() => setDisconnecting(true)}>
            Disconnect Google Calendar
          </button>
        </div>
      </section>
      <Faq />

      {switchTo && current && (
        <Dialog kind="modal" title={`Use ${switchTo.name}?`} onClose={() => setSwitchTo(null)}>
          <p className="lede">Upcoming bookings move to {switchTo.name}. They'll be taken off {current.name}.</p>
          <div className="two">
            <button type="button" className="btn btn-secondary" onClick={() => setSwitchTo(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === "calendar"}
              onClick={() =>
                run("calendar", () => adminApi.setGoogleCalendar(switchTo.id), (next) => {
                  onGoogle(next);
                  setSwitchTo(null);
                  notify({ text: `Now using ${switchTo.name}` });
                })
              }
            >
              {busy === "calendar" ? "Moving…" : "Move bookings"}
            </button>
          </div>
        </Dialog>
      )}
      {disconnectDialog}
    </>
  );
}

function Faq() {
  return (
    <section className="gc-faq" aria-labelledby="gc-faq-title">
      <h2 className="card-title" id="gc-faq-title">
        Questions
      </h2>
      <details>
        <summary>Will my customers see my private events?</summary>
        <p>No. Customers only see that a time isn't available.</p>
      </details>
      <details>
        <summary>What if I change a booking in Google?</summary>
        <p>Make changes here instead. Changes made in Google aren't copied back, and the next change made here will put the booking's time back.</p>
      </details>
      <details>
        <summary>Which events block times?</summary>
        <p>Events marked Busy. Events marked Free, and ones you've declined, don't. All-day events block the whole day unless you turn that off.</p>
      </details>
    </section>
  );
}
