import { useEffect, useState } from "react";
import { TimeGrid } from "../components/TimeGrid";
import { dateInZone, formatDate, formatTime, zoneLabel } from "../time";
import {
  adminApi, adminErrorText, fullName, STATUS_LABEL,
  type AdminAppointment, type AdminCalendar, type Contact, type Status,
} from "./api";
import { CopyLink, Dialog } from "./Dialog";
import { parseTime, zoneIso } from "./zone";

const sameContact = (a: Contact, b: Contact) =>
  a.first_name === b.first_name && a.last_name === b.last_name && a.phone === b.phone && a.email === b.email;

/** Side panel (bottom sheet on phones) for one appointment: details, status, note, reschedule, cancel. */
export function AppointmentPanel({
  appointment,
  calendar,
  onClose,
  onChanged,
}: {
  appointment: AdminAppointment;
  calendar: AdminCalendar;
  onClose: () => void;
  /** Called after every saved change so the screen behind can reload. */
  onChanged: () => void;
}) {
  const zone = calendar.time_zone;
  const [appt, setAppt] = useState(appointment);
  const [manageUrl, setManageUrl] = useState("");
  const [note, setNote] = useState(appointment.note);
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Reschedule form
  const [date, setDate] = useState(() => dateInZone(Date.parse(appointment.start), zone));
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [anyTime, setAnyTime] = useState(false);
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    let live = true;
    adminApi.appointment(appointment.id).then(
      (full) => live && setManageUrl(`${window.location.origin}/m/${full.manage_token}`),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [appointment.id]);

  useEffect(() => {
    if (mode !== "reschedule" || anyTime || !date) return;
    let live = true;
    setSlots(null);
    setSlot(null);
    adminApi.slots(appt.service_id, date).then(
      (r) => live && setSlots(r.slots),
      () => live && setSlots([]),
    );
    return () => {
      live = false;
    };
  }, [mode, anyTime, date, appt.service_id]);

  async function run(action: () => Promise<AdminAppointment>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      // Keep a note that's been typed but not saved; other actions mustn't throw it away.
      if (note === appt.note || note === next.note) setNote(next.note);
      setAppt(next);
      setMode("view");
      onChanged();
    } catch (e) {
      setError(adminErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  const minute = parseTime(time);
  const newStart = anyTime ? (date && minute !== null ? zoneIso(date, minute, zone) : null) : slot;
  const active = appt.status === "booked" || appt.status === "confirmed";
  const cancelled = appt.status === "cancelled";
  // A cancelled appointment can only be reopened; anything else can't be "cancelled" from the select (use Cancel).
  const statusOptions: Status[] = cancelled ? ["cancelled", "booked", "confirmed"] : ["booked", "confirmed", "done", "no_show"];

  return (
    <Dialog kind="panel" title={appt.service_name} onClose={onClose}>
      <div className="panel-when">
        <p className="panel-date">{formatDate(appt.start, zone)}</p>
        <p className="muted">
          {formatTime(appt.start, zone)} – {formatTime(appt.end, zone)} · {zoneLabel(zone)}
        </p>
      </div>

      <section className="panel-block">
        <h3 className="panel-label">Customer</h3>
        <p className="panel-name">{fullName(appt.customer)}</p>
        {appt.customer.phone && (
          <p>
            <a href={`tel:${appt.customer.phone}`}>{appt.customer.phone}</a>
          </p>
        )}
        {appt.customer.email && (
          <p>
            <a href={`mailto:${appt.customer.email}`}>{appt.customer.email}</a>
          </p>
        )}
        {!sameContact(appt.customer, appt.contact) && (
          <p className="muted small">
            Booked as: {[fullName(appt.contact), appt.contact.phone, appt.contact.email].filter(Boolean).join(" · ")}
          </p>
        )}
      </section>

      <div className="field">
        <label className="label" htmlFor="appt-status">
          Status
        </label>
        <select
          id="appt-status"
          className="input"
          value={appt.status}
          disabled={busy}
          onChange={(e) => {
            const status = e.target.value as Status;
            // Reopening puts it back at its own time, which the owner may have set outside open hours. It must still be free.
            if (status !== appt.status) void run(() => adminApi.updateAppointment(appt.id, { status, allow_outside_hours: cancelled }));
          }}
        >
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {cancelled && appt.cancel_reason && <p className="muted small">Reason: {appt.cancel_reason}</p>}
      </div>

      {appt.source && (
        <p className="muted small">Source: {appt.source === "booking_page" ? "Booking page" : appt.source}</p>
      )}

      <div className="field">
        <label className="label" htmlFor="appt-note">
          Note
        </label>
        <textarea id="appt-note" className="input" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        {note !== appt.note && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => adminApi.updateAppointment(appt.id, { note }))}>
            Save note
          </button>
        )}
      </div>

      {manageUrl && (
        <div className="field">
          <span className="label">Customer's link to change or cancel</span>
          <CopyLink url={manageUrl} />
        </div>
      )}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {mode === "view" && active && (
        <div className="stack">
          <div className="two">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => adminApi.updateAppointment(appt.id, { status: "done" }))}>
              Mark done
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => adminApi.updateAppointment(appt.id, { status: "no_show" }))}>
              Mark no-show
            </button>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => (setError(""), setMode("reschedule"))}>
            Reschedule
          </button>
          <button type="button" className="btn btn-danger-outline" onClick={() => (setError(""), setMode("cancel"))}>
            Cancel appointment
          </button>
        </div>
      )}

      {mode === "reschedule" && (
        <section className="panel stack" aria-label="Reschedule">
          <h3 className="panel-title">Pick a new time</h3>
          <div className="field">
            <label className="label" htmlFor="appt-date">
              Date
            </label>
            <input id="appt-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <label className="check-row">
            <input type="checkbox" checked={anyTime} onChange={(e) => setAnyTime(e.target.checked)} />
            Allow outside open hours
          </label>
          {anyTime ? (
            <div className="field">
              <label className="label" htmlFor="appt-time">
                Time ({zoneLabel(zone)})
              </label>
              <input id="appt-time" className="input" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          ) : (
            date && <TimeGrid slots={slots} selected={slot} zone={zone} onSelect={setSlot} />
          )}
          <div className="two">
            <button type="button" className="btn btn-secondary" onClick={() => setMode("view")}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !newStart}
              onClick={() => run(() => adminApi.updateAppointment(appt.id, { start: newStart!, allow_outside_hours: anyTime }))}
            >
              {busy ? "Moving…" : "Move"}
            </button>
          </div>
        </section>
      )}

      {mode === "cancel" && (
        <section className="panel stack" aria-label="Cancel appointment">
          <h3 className="panel-title">Cancel this appointment?</h3>
          <div className="field">
            <label className="label" htmlFor="appt-reason">
              Reason <span className="opt">(optional)</span>
            </label>
            <textarea id="appt-reason" className="input" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="two">
            <button type="button" className="btn btn-secondary" onClick={() => setMode("view")}>
              Keep it
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => run(() => adminApi.cancelAppointment(appt.id, reason.trim()))}>
              {busy ? "Cancelling…" : "Cancel it"}
            </button>
          </div>
        </section>
      )}
    </Dialog>
  );
}
