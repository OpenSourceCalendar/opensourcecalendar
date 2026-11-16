import { useEffect, useState, type FormEvent } from "react";
import { TimeGrid } from "../components/TimeGrid";
import { dateInZone, formatDate, formatTime, zoneLabel } from "../time";
import {
  adminApi, adminErrorText, fullName,
  type AdminCalendar, type AdminService, type Created, type Customer,
} from "./api";
import { CopyLink, Dialog } from "./Dialog";
import { minuteOfDay, parseTime, timeValue, zoneIso } from "./zone";

export interface EntryStart {
  date: string;
  /** Minutes after midnight, when a time was clicked. */
  minute?: number;
}

/** New Entry: add an appointment, or block out time. */
export function NewEntry({
  calendar,
  start,
  customer,
  onClose,
  onCreated,
}: {
  calendar: AdminCalendar;
  start?: EntryStart;
  /** Book for this customer (from their page). */
  customer?: Customer;
  onClose: () => void;
  /** Called after anything is saved so the screen behind can reload. */
  onCreated: () => void;
}) {
  const [tab, setTab] = useState<"appointment" | "block">("appointment");
  return (
    <Dialog kind="modal" title="New entry" onClose={onClose}>
      <div className="segmented" role="tablist" aria-label="Kind of entry">
        <button type="button" role="tab" aria-selected={tab === "appointment"} onClick={() => setTab("appointment")}>
          Appointment
        </button>
        <button type="button" role="tab" aria-selected={tab === "block"} onClick={() => setTab("block")}>
          Block time
        </button>
      </div>
      {tab === "appointment" ? (
        <AppointmentForm calendar={calendar} start={start} customer={customer} onClose={onClose} onCreated={onCreated} />
      ) : (
        <BlockForm calendar={calendar} start={start} onClose={onClose} onCreated={onCreated} />
      )}
    </Dialog>
  );
}

type FormProps = { calendar: AdminCalendar; start?: EntryStart; customer?: Customer; onClose: () => void; onCreated: () => void };

function AppointmentForm({ calendar, start, customer: given, onClose, onCreated }: FormProps) {
  const zone = calendar.time_zone;
  const [services, setServices] = useState<AdminService[] | null>(null);
  const [serviceId, setServiceId] = useState("");

  const [customer, setCustomer] = useState<Customer | null>(given ?? null);
  const [isNew, setIsNew] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Customer[] | null>(null);
  const [person, setPerson] = useState({ first_name: "", last_name: "", phone: "", email: "" });

  const [date, setDate] = useState(start?.date ?? dateInZone(Date.now(), zone));
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [anyTime, setAnyTime] = useState(false);
  const [time, setTime] = useState(start?.minute !== undefined ? timeValue(start.minute) : "");
  // A clicked time is used once: picked if it's open, otherwise offered as "any time".
  const [wanted, setWanted] = useState(start?.minute);

  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Created | null>(null);

  useEffect(() => {
    let live = true;
    adminApi.services().then(
      (r) => {
        if (!live) return;
        setServices(r.services);
        setServiceId((r.services.find((s) => s.is_call_default) ?? r.services[0])?.id ?? "");
      },
      (e) => live && setError(adminErrorText(e)), // services stays null: the form shows the error, not "add a service"
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (customer || isNew || q.length < 2) return setMatches(null);
    let live = true;
    const timer = setTimeout(() => {
      adminApi.customers(q).then(
        (r) => live && setMatches(r.customers.slice(0, 8)),
        () => live && setMatches([]),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, customer, isNew]);

  useEffect(() => {
    if (anyTime || !date || !serviceId) return;
    let live = true;
    setSlots(null);
    setSlot(null);
    adminApi.slots(serviceId, date).then(
      (r) => {
        if (!live) return;
        setSlots(r.slots);
        if (wanted === undefined) return;
        setWanted(undefined);
        const hit = r.slots.find((s) => minuteOfDay(s, zone) === wanted);
        if (hit) setSlot(hit);
        else setAnyTime(true);
      },
      () => live && setSlots([]),
    );
    return () => {
      live = false;
    };
  }, [anyTime, date, serviceId]);

  const minute = parseTime(time);
  const startIso = anyTime ? (date && minute !== null ? zoneIso(date, minute, zone) : null) : slot;
  const personOk = !!person.first_name.trim() && (!!person.phone.trim() || !!person.email.trim());
  const ready = !!serviceId && !!startIso && (isNew ? personOk : !!customer);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await adminApi.createAppointment({
        service_id: serviceId,
        start: startIso!,
        ...(isNew
          ? {
              customer: {
                first_name: person.first_name.trim(),
                ...(person.last_name.trim() && { last_name: person.last_name.trim() }),
                ...(person.phone.trim() && { phone: person.phone.trim() }),
                ...(person.email.trim() && { email: person.email.trim() }),
              },
            }
          : { customer_id: customer!.id }),
        note,
        source: "Added by owner",
        allow_outside_hours: anyTime,
      });
      setDone(created);
      onCreated();
    } catch (err) {
      setError(adminErrorText(err));
      setBusy(false);
    }
  }

  if (done) {
    const a = done.appointment;
    return (
      <div className="stack">
        <p className="success" role="status">
          Appointment added: {a.service_name} for {fullName(a.customer)}, {formatDate(a.start, zone)} at {formatTime(a.start, zone)}.
        </p>
        <div className="field">
          <span className="label">Customer's link to change or cancel</span>
          <CopyLink url={`${window.location.origin}${done.manage_path}`} />
        </div>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    );
  }

  if (services && !services.length) {
    return (
      <div className="admin-empty">
        <p className="sub">Add a service first</p>
        <p className="muted small">An appointment needs a service. Services arrive in the next update.</p>
      </div>
    );
  }

  const set = (key: keyof typeof person) => (e: { target: { value: string } }) => setPerson({ ...person, [key]: e.target.value });

  return (
    <form className="form" onSubmit={submit}>
      <fieldset className="fieldset">
        <legend className="label">Customer</legend>
        {customer ? (
          <div className="picked">
            <span>
              <strong>{fullName(customer)}</strong>
              <span className="muted small"> {[customer.phone, customer.email].filter(Boolean).join(" · ")}</span>
            </span>
            <button type="button" className="link" onClick={() => setCustomer(null)}>
              Change
            </button>
          </div>
        ) : isNew ? (
          <>
            <div className="form-row">
              <div className="field">
                <label className="label" htmlFor="ne-first">
                  First name
                </label>
                <input id="ne-first" className="input" autoComplete="off" maxLength={100} value={person.first_name} onChange={set("first_name")} />
              </div>
              <div className="field">
                <label className="label" htmlFor="ne-last">
                  Last name <span className="opt">(optional)</span>
                </label>
                <input id="ne-last" className="input" autoComplete="off" maxLength={100} value={person.last_name} onChange={set("last_name")} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label className="label" htmlFor="ne-phone">
                  Phone
                </label>
                <input id="ne-phone" className="input" type="tel" autoComplete="off" maxLength={40} value={person.phone} onChange={set("phone")} />
              </div>
              <div className="field">
                <label className="label" htmlFor="ne-email">
                  Email
                </label>
                <input id="ne-email" className="input" type="email" autoComplete="off" maxLength={254} value={person.email} onChange={set("email")} />
              </div>
            </div>
            <p className="hint">A phone or an email is needed. If they've booked before, we'll match them.</p>
            <button type="button" className="link" onClick={() => setIsNew(false)}>
              Search existing customers instead
            </button>
          </>
        ) : (
          <>
            <input
              className="input"
              type="search"
              placeholder="Search by name, phone or email"
              aria-label="Search customers"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {matches && (
              <ul className="matches" aria-label="Matching customers">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setCustomer(c)}>
                      <strong>{fullName(c)}</strong>
                      <span className="muted small">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                    </button>
                  </li>
                ))}
                {!matches.length && <li className="muted small matches-none">No customers match.</li>}
              </ul>
            )}
            <button type="button" className="link" onClick={() => setIsNew(true)}>
              New customer
            </button>
          </>
        )}
      </fieldset>

      <div className="field">
        <label className="label" htmlFor="ne-service">
          Service
        </label>
        <select id="ne-service" className="input" value={serviceId} disabled={!services} onChange={(e) => setServiceId(e.target.value)}>
          {(services ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.duration_min} min)
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="label" htmlFor="ne-date">
          Date
        </label>
        <input id="ne-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <label className="check-row">
        <input type="checkbox" checked={anyTime} onChange={(e) => setAnyTime(e.target.checked)} />
        Pick any time, even outside open hours
      </label>
      {anyTime ? (
        <div className="field">
          <label className="label" htmlFor="ne-time">
            Time ({zoneLabel(zone)})
          </label>
          <input id="ne-time" className="input" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      ) : (
        date &&
        serviceId && (
          <section className="times-section" aria-label="Open times">
            <h3 className="sub">Open times · {zoneLabel(zone)}</h3>
            <TimeGrid slots={slots} selected={slot} zone={zone} onSelect={setSlot} />
          </section>
        )
      )}

      <div className="field">
        <label className="label" htmlFor="ne-note">
          Note <span className="opt">(optional)</span>
        </label>
        <textarea id="ne-note" className="input" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <p className="muted small">Source: Added by owner</p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
        {busy ? "Adding…" : "Add appointment"}
      </button>
    </form>
  );
}

function BlockForm({ calendar, start, onClose, onCreated }: FormProps) {
  const zone = calendar.time_zone;
  const [date, setDate] = useState(start?.date ?? dateInZone(Date.now(), zone));
  const [from, setFrom] = useState(start?.minute !== undefined ? timeValue(start.minute) : "12:00");
  const [to, setTo] = useState(start?.minute !== undefined ? timeValue(Math.min(start.minute + 60, 1439)) : "13:00");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const a = parseTime(from);
  const b = parseTime(to);
  const ordered = a !== null && b !== null && a < b;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!date || !ordered || busy) return;
    setBusy(true);
    setError("");
    try {
      await adminApi.createTimeBlock({ start_at: zoneIso(date, a!, zone), end_at: zoneIso(date, b!, zone), note });
      onCreated();
      onClose();
    } catch (err) {
      setError(adminErrorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="lede">Nobody can book during blocked time. Appointments already there stay as they are.</p>
      <div className="field">
        <label className="label" htmlFor="nb-date">
          Date
        </label>
        <input id="nb-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="form-row">
        <div className="field">
          <label className="label" htmlFor="nb-from">
            From
          </label>
          <input id="nb-from" className="input" type="time" step={300} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="nb-to">
            To
          </label>
          <input id="nb-to" className="input" type="time" step={300} value={to} aria-invalid={!ordered} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <p className={ordered ? "hint" : "field-error"}>{ordered ? `Times are in ${zoneLabel(zone)}.` : "The end time must be after the start time."}</p>
      <div className="field">
        <label className="label" htmlFor="nb-note">
          Note <span className="opt">(optional)</span>
        </label>
        <input id="nb-note" className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={!date || !ordered || busy}>
        {busy ? "Blocking…" : "Block this time"}
      </button>
    </form>
  );
}
