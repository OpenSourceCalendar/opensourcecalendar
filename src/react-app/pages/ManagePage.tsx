import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, icsUrl, type ManageView } from "../api";
import { applyBrand } from "../theme";
import { formatDate, formatDuration, formatTime, minutesBetween, shortDate, visitorZone, zoneLabel } from "../time";
import { ActionBar } from "../components/ActionBar";
import { DateTimePicker } from "../components/DateTimePicker";
import { Header } from "../components/Header";
import { PoweredBy } from "../components/PoweredBy";
import { Summary } from "../components/Summary";
import { ErrorScreen, LoadingScreen } from "./BookingPage";
import { NotFound } from "./NotFound";

type Mode = "view" | "reschedule" | "cancel" | "delete" | "deleted";

const STATUS: Record<string, string> = {
  booked: "Booked", confirmed: "Confirmed", cancelled: "Cancelled", completed: "Completed", no_show: "Missed",
};

const hoursText = (h: number) => (h % 24 === 0 && h >= 48 ? `${h / 24} days` : `${h} hour${h === 1 ? "" : "s"}`);

export function ManagePage({ token }: { token: string }) {
  const [view, setView] = useState<ManageView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [zone, setZone] = useState(visitorZone);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashRef = useRef<HTMLParagraphElement>(null);
  const deletedRef = useRef<HTMLHeadingElement>(null);

  const load = () =>
    api.manage(token).then(
      (v) => {
        setView(v);
        applyBrand(v.business.color);
        document.title = `Your appointment · ${v.business.business_name || "Booking"}`;
      },
      (e) => setLoadError(e instanceof ApiError ? e : new ApiError(0, "network")),
    );

  useEffect(() => {
    void load();
  }, [token]);

  useEffect(() => {
    if (flash) flashRef.current?.focus();
  }, [flash]);

  // The delete button is gone, so move focus to (and announce) the new headline.
  useEffect(() => {
    if (mode === "deleted") deletedRef.current?.focus();
  }, [mode]);

  if (loadError) return loadError.status === 404 ? <NotFound message="This appointment link isn't valid. It may have been mistyped." /> : <ErrorScreen message={errorText(loadError)} />;
  if (!view) return <LoadingScreen />;

  const a = view.appointment;
  const b = view.business;
  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setFlash(null);
  };

  /** A 409 from the server means the rules changed under us: refresh what we show. */
  async function handleChangeError(e: unknown) {
    setError(errorText(e));
    // Rules changed under us, or we never heard back: show what the server now has.
    if (e instanceof ApiError && (e.error === "too_late" || e.error === "not_active" || e.error === "network")) {
      await load();
      setMode("view");
    }
  }

  async function reschedule() {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.reschedule(token, slot, zone);
      setView((v) => v && { ...v, appointment: r.appointment });
      setMode("view");
      setDate(null);
      setSlot(null);
      const sent = view?.emails.changed && r.appointment.contact.email ? " We've emailed you the update." : "";
      setFlash(`Done. Your appointment is now ${formatDate(r.appointment.start, zone)} at ${formatTime(r.appointment.start, zone)}.${sent}`);
    } catch (e) {
      if (e instanceof ApiError && (e.error === "slot_taken" || e.error === "slot_unavailable")) {
        setError(errorText(e));
        setSlot(null);
        setReloadKey((n) => n + 1);
      } else await handleChangeError(e);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.cancel(token, reason.trim());
      setView((v) => v && { ...v, appointment: r.appointment, can_change: false });
      setMode("view");
      setFlash(`Your appointment has been cancelled.${view?.emails.cancelled && r.appointment.contact.email ? " We've emailed you the details." : ""}`);
    } catch (e) {
      if (e instanceof ApiError && e.missing.includes("reason")) setError("Please tell us why you're cancelling.");
      else await handleChangeError(e);
    } finally {
      setBusy(false);
    }
  }

  async function deleteData() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteMyData(token);
      setMode("deleted");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const cancelled = a.status === "cancelled";
  const past = Date.parse(a.start) <= Date.now();
  const phone = b.phone.trim();
  const callLine = phone ? (
    <>
      Please call <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{phone}</a>.
    </>
  ) : (
    "Please contact the business."
  );
  const name = [a.contact.first_name, a.contact.last_name].filter(Boolean).join(" ");

  if (mode === "deleted") {
    return (
      <div className="page">
        <div className="sheet">
          <Header branding={b}>
            <h1 className="title" tabIndex={-1} ref={deletedRef}>
              Your data has been deleted
            </h1>
          </Header>
          <main className="content" role="status" aria-live="polite">
            <p className="lede">
              We cancelled this booking and erased the details you entered for it. We've also asked {b.business_name || "the business"} to delete anything else they hold about you.
            </p>
          </main>
          <PoweredBy show={view.powered_by} />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="sheet">
        <Header branding={b} onBack={mode === "reschedule" ? () => switchMode("view") : undefined}>
          <h1 className="title">{mode === "reschedule" ? "Pick a new time" : "Your appointment"}</h1>
        </Header>
        <main className="content">

          <div aria-live="polite">
            {flash && (
              <p className="success" tabIndex={-1} ref={flashRef}>
                {flash}
              </p>
            )}
          </div>

          {mode === "reschedule" ? (
            <p className="service-chip">
              <strong>{a.service_name}</strong> · now {shortDate(a.start, zone)}, {formatTime(a.start, zone)}
            </p>
          ) : (
          <section className={`appt${cancelled ? " is-cancelled" : ""}`} aria-label="Appointment details">
            <div className="appt-head">
              <p className="appt-service">{a.service_name}</p>
              <span className={`badge badge-${a.status}`}>{STATUS[a.status] ?? a.status}</span>
            </div>
            <Summary
              rows={[
                { icon: "date", label: "Date", value: formatDate(a.start, zone) },
                {
                  icon: "time",
                  label: "Time",
                  value: (
                    <>
                      {formatTime(a.start, zone)} · {formatDuration(minutesBetween(a.start, a.end))}
                      <span className="summary-sub">{zoneLabel(zone)}</span>
                    </>
                  ),
                },
                ...(name ? [{ icon: "person" as const, label: "Name", value: name }] : []),
              ]}
            />
            {cancelled && a.cancel_reason && <p className="muted small">Reason: {a.cancel_reason}</p>}
          </section>
          )}

          {mode === "view" && !cancelled && (
            <p className="links-row">
              <a href={icsUrl(token)} download="appointment.ics">
                Add to calendar
              </a>
            </p>
          )}

          {mode === "reschedule" && (
            <>
              <div aria-live="assertive">
                {error && (
                  <p className="alert" role="alert">
                    {error}
                  </p>
                )}
              </div>
              <DateTimePicker
                source={{ kind: "manage", token }}
                businessZone={view.time_zone}
                maxDaysAhead={view.max_days_ahead}
                zone={zone}
                onZone={setZone}
                date={date}
                slot={slot}
                onDate={(d) => {
                  setDate(d);
                  setSlot(null);
                }}
                onSlot={(s) => {
                  setSlot(s);
                  setError(null);
                }}
                reloadKey={reloadKey}
              />
            </>
          )}

          {(mode === "view" || mode === "cancel") && view.can_change && (
            <div className="stack">
              {mode === "view" && (
                <>
                  <button type="button" className="btn btn-primary" onClick={() => switchMode("reschedule")}>
                    Pick a new time
                  </button>
                  <button type="button" className="btn btn-danger-outline" onClick={() => switchMode("cancel")}>
                    Cancel this appointment
                  </button>
                </>
              )}
              {mode === "cancel" && (
                <div className="panel" role="region" aria-label="Cancel appointment">
                  <p className="panel-title">Cancel this appointment?</p>
                  <label className="label" htmlFor="reason">
                    Reason {view.cancel_reason_required ? <span className="req" aria-hidden="true">*</span> : <span className="opt">(optional)</span>}
                  </label>
                  <textarea
                    id="reason"
                    className="input"
                    rows={3}
                    maxLength={500}
                    value={reason}
                    required={view.cancel_reason_required}
                    onChange={(e) => setReason(e.target.value)}
                    autoFocus
                  />
                  {error && (
                    <p className="field-error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="two">
                    <button type="button" className="btn btn-secondary" onClick={() => switchMode("view")} disabled={busy}>
                      Keep it
                    </button>
                    <button type="button" className="btn btn-danger" onClick={cancel} disabled={busy || (view.cancel_reason_required && !reason.trim())}>
                      {busy ? "Cancelling…" : "Yes, cancel"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === "view" && !view.can_change && !(cancelled && flash) && (
            <p className="info">
              {cancelled
                ? "This appointment was cancelled."
                : past
                  ? "This appointment has already passed."
                  : <>Changes close {hoursText(view.change_cutoff_hours)} before your appointment. {callLine}</>}
            </p>
          )}
          {mode !== "reschedule" && view.can_change && view.change_cutoff_hours > 0 && (
            <p className="info">You can change or cancel up to {hoursText(view.change_cutoff_hours)} before.</p>
          )}

          {mode === "view" && (
            <p className="delete-link">
              <button type="button" className="link muted" onClick={() => switchMode("delete")}>
                Delete my data
              </button>
            </p>
          )}
          {mode === "delete" && (
            <div className="panel" role="region" aria-label="Delete my data">
              <p className="panel-title">Delete your data?</p>
              <p className="small">
                This cancels this booking, erases the name, phone, email and notes you entered for it, and asks {b.business_name || "the business"} to delete anything else they hold about you. It can't be undone.
              </p>
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
              <div className="two">
                <button type="button" className="btn btn-secondary" onClick={() => switchMode("view")} disabled={busy} autoFocus>
                  Never mind
                </button>
                <button type="button" className="btn btn-danger" onClick={deleteData} disabled={busy}>
                  {busy ? "Deleting…" : "Yes, delete"}
                </button>
              </div>
            </div>
          )}
        </main>
        <PoweredBy show={view.powered_by} />
      </div>

      {mode === "reschedule" && (
        <ActionBar>
          <button type="button" className="btn btn-primary" disabled={!slot || busy} onClick={reschedule}>
            {busy ? "Saving…" : slot ? `Move to ${shortDate(slot, zone)} · ${formatTime(slot, zone)}` : "Pick a time"}
          </button>
        </ActionBar>
      )}
    </div>
  );
}
