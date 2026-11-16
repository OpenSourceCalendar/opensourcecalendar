import { useEffect, useRef, useState } from "react";
import { addDays, dateInZone, dateLabel } from "../time";
import type { PageProps } from "./AdminApp";
import { adminApi, adminErrorText, type Notifications as Settings } from "./api";
import { SaveBar } from "./SaveBar";
import { Setting, Switch } from "./Switch";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE = 160;
const FILL_INS = ["Business Name", "Date", "Time", "Service"] as const;
const HOURS: number[] = [1, 2, 3, 6, 12, 24, 48];

export function Notifications({ calendar, notify, setDirty, onCalendar }: PageProps) {
  const saved = calendar.notifications;
  const [form, setForm] = useState<Settings>(saved);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [sampleService, setSampleService] = useState("Free estimate");
  const message = useRef<HTMLTextAreaElement>(null);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((f) => ({ ...f, [key]: value }));

  const changed = (Object.keys(form) as (keyof Settings)[]).filter((k) => form[k] !== saved[k]);
  const dirty = changed.length > 0;
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);

  useEffect(() => {
    adminApi.services().then((r) => r.services[0] && setSampleService(r.services[0].name), () => {});
  }, []);

  const ownerEmail = form.owner_email.trim();
  const ownerEmailOk = !ownerEmail || EMAIL_RE.test(ownerEmail);
  // Only matters while confirmations are on (the box is hidden otherwise, so it couldn't be fixed).
  const tooLong = form.customer_confirmation && form.confirmation_message.length > MAX_MESSAGE;
  const blocked = !ownerEmailOk
    ? "Check the email address for your notifications."
    : tooLong
      ? `The confirmation message is over ${MAX_MESSAGE} characters.`
      : form.customer_confirmation && !form.confirmation_message.trim()
        ? "Write a confirmation message, or turn confirmations off."
        : "";

  async function save() {
    if (saving || blocked) return;
    setSaving(true);
    setSaveError("");
    try {
      // Only what changed, so a setting saved from elsewhere in the meantime isn't overwritten.
      const patch = Object.fromEntries(changed.map((k) => [k, k === "owner_email" ? ownerEmail : form[k]])) as Partial<Settings>;
      const next = await adminApi.updateCalendar({ notifications: patch });
      onCalendar(next);
      setForm(next.notifications);
      notify({ text: "Saved" });
    } catch (e) {
      setSaveError(adminErrorText(e));
    }
    setSaving(false);
  }

  function insert(fillIn: string) {
    const box = message.current;
    const text = `[${fillIn}]`;
    const value = form.confirmation_message;
    const at = box ? box.selectionStart : value.length;
    const end = box ? box.selectionEnd : value.length;
    set("confirmation_message", value.slice(0, at) + text + value.slice(end));
    // Put the cursor after the inserted fill-in once React has updated the box.
    requestAnimationFrame(() => {
      box?.focus();
      box?.setSelectionRange(at + text.length, at + text.length);
    });
  }

  // A sample of the filled-in message: next Tuesday at 3:00 PM, the first service.
  const today = dateInZone(Date.now(), calendar.time_zone);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const sample: Record<string, string> = {
    "Business Name": calendar.branding.business_name || "us",
    Date: dateLabel(addDays(today, ((2 - weekday + 7) % 7) || 7)),
    Time: "3:00 PM",
    Service: sampleService,
  };
  const preview = form.confirmation_message.replace(/\[(Business Name|Date|Time|Service)\]/g, (_, key: string) => sample[key]);
  const hourOptions = HOURS.includes(form.reminder_hours_before) ? HOURS : [...HOURS, form.reminder_hours_before].sort((a, b) => a - b);

  return (
    <>
      <header className="admin-band">
        <h1 className="admin-title">Notifications</h1>
        <p className="muted">Emails about your bookings, for you and your customers.</p>
      </header>

      {!calendar.email_enabled && (
        <p className="info">Email isn't set up on this calendar yet, so nothing below is sent. You can still choose your settings now.</p>
      )}

      <section className="card settings" aria-labelledby="nt-you">
        <h2 className="card-title" id="nt-you">
          Your notifications
        </h2>
        <div className="field nt-email">
          <label className="label" htmlFor="nt-owner-email">
            Send my notifications to
          </label>
          <input
            id="nt-owner-email"
            className="input"
            type="email"
            autoComplete="email"
            maxLength={254}
            placeholder="you@yourbusiness.com"
            value={form.owner_email}
            aria-invalid={!ownerEmailOk}
            aria-describedby="nt-owner-email-help"
            onChange={(e) => set("owner_email", e.target.value)}
          />
          <p id="nt-owner-email-help" className={ownerEmailOk ? "hint" : "field-error"}>
            {ownerEmailOk ? "Booking emails for you go here. Customers' replies come here too." : "That doesn't look like an email address."}
          </p>
        </div>
        {(
          [
            ["owner_new", "New booking"],
            ["owner_change", "Customer reschedules"],
            ["owner_cancel", "Customer cancels"],
          ] as const
        ).map(([key, title]) => (
          <Setting key={key} title={title} help={ownerEmail ? undefined : "Add your email above to get these."}>
            <Switch checked={form[key]} label={`Email me when: ${title.toLowerCase()}`} disabled={!ownerEmail} onChange={(on) => set(key, on)} />
          </Setting>
        ))}
        <p className="muted small nt-note">You aren't emailed about changes you make yourself.</p>
      </section>

      <section className="card settings" aria-labelledby="nt-customers">
        <h2 className="card-title" id="nt-customers">
          Emails to your customers
        </h2>
        <p className="muted small">Sent to the email they gave when booking. Customers without an email get none.</p>
        <Setting title="Booking confirmation" help="With their link to change or cancel, and a file that adds it to their calendar.">
          <Switch checked={form.customer_confirmation} label="Send a booking confirmation" onChange={(on) => set("customer_confirmation", on)} />
        </Setting>
        {form.customer_confirmation && (
          <div className="nt-message">
            <div className="nt-message-head">
              <label className="label" htmlFor="nt-message">
                Confirmation message
              </label>
              <span id="nt-count" className={tooLong ? "nt-count is-over" : "nt-count"}>
                {form.confirmation_message.length} / {MAX_MESSAGE}
              </span>
            </div>
            <textarea
              id="nt-message"
              ref={message}
              className="input"
              rows={3}
              value={form.confirmation_message}
              aria-invalid={tooLong}
              aria-describedby="nt-count"
              onChange={(e) => set("confirmation_message", e.target.value)}
            />
            <div className="nt-chips" role="group" aria-label="Insert a fill-in">
              {FILL_INS.map((f) => (
                <button key={f} type="button" className="nt-chip" onClick={() => insert(f)}>
                  [{f}]
                </button>
              ))}
            </div>
            <p className="sr-only" aria-live="polite">
              {tooLong ? `Over ${MAX_MESSAGE} characters.` : ""}
            </p>
            {preview.trim() && (
              <p className="nt-preview">
                <span className="muted small">Preview: </span>
                {preview}
              </p>
            )}
          </div>
        )}
        <Setting title="Change notice" help="When the time of their appointment changes.">
          <Switch checked={form.customer_change} label="Send a change notice" onChange={(on) => set("customer_change", on)} />
        </Setting>
        <Setting title="Cancellation notice" help="When their appointment is cancelled, by them or by you.">
          <Switch checked={form.customer_cancel} label="Send a cancellation notice" onChange={(on) => set("customer_cancel", on)} />
        </Setting>
      </section>

      <section className="card settings" aria-labelledby="nt-reminder">
        <h2 className="card-title" id="nt-reminder">
          Reminder
        </h2>
        <Setting title="Send a reminder" help="An email to the customer before their appointment.">
          <Switch checked={form.reminder} label="Send a reminder" onChange={(on) => set("reminder", on)} />
        </Setting>
        {form.reminder && (
          <fieldset className="fieldset nt-timing">
            <legend className="label">When</legend>
            <label className="check-row nt-option">
              <input type="radio" name="nt-mode" checked={form.reminder_mode === "smart"} onChange={() => set("reminder_mode", "smart")} />
              <span>
                <strong>Smart timing</strong>
                <span className="muted small"> 2 hours before. For appointments before 9 AM, at 6 PM the evening before.</span>
              </span>
            </label>
            <label className="check-row nt-option">
              <input type="radio" name="nt-mode" checked={form.reminder_mode === "hours_before"} onChange={() => set("reminder_mode", "hours_before")} />
              <span>
                <strong>A set time before</strong>
              </span>
            </label>
            {form.reminder_mode === "hours_before" && (
              <select
                className="input nt-hours"
                aria-label="How long before"
                value={form.reminder_hours_before}
                onChange={(e) => set("reminder_hours_before", Number(e.target.value))}
              >
                {hourOptions.map((h) => (
                  <option key={h} value={h}>
                    {h === 1 ? "1 hour" : `${h} hours`} before
                  </option>
                ))}
              </select>
            )}
            <p className="muted small">Changing this affects new bookings and reschedules. Reminders already lined up keep their time.</p>
          </fieldset>
        )}
      </section>

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={saveError}
        blocked={blocked}
        onSave={save}
        onDiscard={() => {
          setForm(saved);
          setSaveError("");
        }}
      />
    </>
  );
}
