import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { formatTime, shortDate } from "../time";
import type { PageProps } from "./AdminApp";
import { adminApi, adminErrorText, fullName, STATUS_LABEL, type AdminAppointment, type Customer, type CustomerHistory } from "./api";
import { AppointmentPanel } from "./AppointmentPanel";
import { CustomerDialog, initials } from "./Customers";
import { Dialog } from "./Dialog";

type Tab = "all" | "upcoming" | "completed" | "cancelled";
const TABS: [Tab, string][] = [["all", "All"], ["upcoming", "Upcoming"], ["completed", "Completed"], ["cancelled", "Cancelled"]];

function inTab(a: AdminAppointment, tab: Tab, now: number): boolean {
  if (tab === "all") return true;
  if (tab === "cancelled") return a.status === "cancelled";
  if (tab === "completed") return a.status === "done";
  return (a.status === "booked" || a.status === "confirmed") && Date.parse(a.start) > now;
}

export function CustomerPage({
  calendar,
  notify,
  navigate,
  id,
  reloadKey,
  onBook,
}: PageProps & { id: string; /** Bump to refetch (after New Entry saves). */ reloadKey: number; onBook: (customer: Customer) => void }) {
  const zone = calendar.time_zone;
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [history, setHistory] = useState<CustomerHistory | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [open, setOpen] = useState<AdminAppointment | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState(0);
  const loaded = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.all([adminApi.customer(id), adminApi.customerHistory(id)]).then(
      ([c, h]) => {
        if (!live) return;
        if (!loaded.current) setNotes(c.notes); // later reloads mustn't overwrite a note being typed
        loaded.current = true;
        setCustomer(c);
        setHistory(h);
        setError("");
      },
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(adminErrorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [id, reloadKey, changes]);

  const back = (
    <a className="back-link" href="/admin/customers" onClick={(e) => (e.preventDefault(), navigate("/admin/customers"))}>
      ‹ Customers
    </a>
  );

  if (missing) {
    return (
      <>
        {back}
        <div className="admin-empty">
          <p className="sub">We couldn't find that customer</p>
        </div>
      </>
    );
  }
  if (!customer || !history) {
    return (
      <>
        {back}
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : (
          <span className="skeleton block" />
        )}
      </>
    );
  }

  async function run(action: () => Promise<Customer | void>, done: string) {
    if (busy) return;
    setBusy(true);
    try {
      const next = await action();
      if (next) {
        // Only take the server's note when nothing unsaved is being typed.
        if (notes === customer?.notes || notes === next.notes) setNotes(next.notes);
        setCustomer(next);
      }
      notify({ text: done });
    } catch (e) {
      notify({ text: adminErrorText(e), error: true });
    }
    setBusy(false);
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await adminApi.deleteCustomer(id);
      notify({ text: "Customer deleted" });
      navigate("/admin/customers");
    } catch (e) {
      notify({ text: adminErrorText(e), error: true });
      setBusy(false);
    }
  }

  async function copyBookingLink() {
    const link = `${window.location.origin}/book/${calendar.slug}`;
    try {
      await navigator.clipboard.writeText(link);
      notify({ text: "Booking link copied" });
    } catch {
      notify({ text: link }); // clipboard blocked (it can be inside an iframe): show it instead
    }
  }

  const now = Date.now();
  const shown = history.appointments.filter((a) => inTab(a, tab, now));
  // Whoever holds a manage link may not be the customer on record, so name the booking, not the person.
  const asked = history.appointments.find((a) => a.id === customer.delete_request_appointment_id);

  return (
    <>
      {back}

      {customer.delete_requested_at && (
        <section className="notice" aria-label="Delete request">
          <p>
            <strong>Someone asked to delete this customer's data</strong>, using the link for{" "}
            {asked ? (
              <button type="button" className="link" onClick={() => setOpen(asked)}>
                the booking on {shortDate(asked.start, zone)}
              </button>
            ) : (
              "a booking"
            )}
            .
          </p>
          <div className="notice-actions">
            <button type="button" className="btn btn-danger btn-auto" onClick={() => setDeleting(true)}>
              Delete customer
            </button>
            <button type="button" className="btn btn-secondary btn-auto" disabled={busy} onClick={() => run(() => adminApi.dismissDeleteRequest(id), "Keeping this customer")}>
              Keep customer
            </button>
          </div>
        </section>
      )}

      <section className="card contact-card">
        <div className="contact-top">
          <span className="avatar avatar-lg" aria-hidden="true">
            {initials(customer)}
          </span>
          <div className="contact-main">
            <h1 className="admin-title">{fullName(customer)}</h1>
            {customer.phone && (
              <p>
                <a href={`tel:${customer.phone}`}>{customer.phone}</a>
              </p>
            )}
            {customer.email && (
              <p>
                <a href={`mailto:${customer.email}`}>{customer.email}</a>
              </p>
            )}
            {customer.external_ref && <p className="muted small">Reference: {customer.external_ref}</p>}
          </div>
          <button type="button" className="btn btn-secondary btn-auto" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
        <dl className="facts">
          <div>
            <dt>First booked</dt>
            <dd>{history.first_booked ? shortDate(history.first_booked, zone) : "Not yet"}</dd>
          </div>
          <div>
            <dt>Appointments</dt>
            <dd>{history.counts.booked + history.counts.cancelled}</dd>
          </div>
          <div>
            <dt>Booked</dt>
            <dd>{history.counts.booked}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{history.counts.completed}</dd>
          </div>
          <div>
            <dt>Cancelled</dt>
            <dd>{history.counts.cancelled}</dd>
          </div>
        </dl>
        <div className="contact-actions">
          <button type="button" className="btn btn-primary btn-auto" onClick={() => onBook(customer)}>
            Book for this customer
          </button>
          <button type="button" className="btn btn-secondary btn-auto" onClick={copyBookingLink}>
            Copy booking link
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="cu-notes">
        <h2 className="card-title" id="cu-notes">
          Notes
        </h2>
        <textarea className="input" rows={3} maxLength={5000} aria-labelledby="cu-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {notes !== customer.notes && (
          <button type="button" className="btn btn-secondary btn-auto" disabled={busy} onClick={() => run(() => adminApi.updateCustomer(id, { notes }), "Note saved")}>
            Save note
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="cu-history">
        <h2 className="card-title" id="cu-history">
          Appointment history
        </h2>
        <div className="segmented" role="group" aria-label="Show">
          {TABS.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>
              {label}
            </button>
          ))}
        </div>
        {shown.length ? (
          <ul className="rows">
            {shown.map((a) => (
              <li key={a.id}>
                <button type="button" className="row" onClick={() => setOpen(a)}>
                  <span className="row-main">
                    <strong>
                      {shortDate(a.start, zone)}, {formatTime(a.start, zone)}
                    </strong>
                    <span className="muted small">
                      {a.service_name}
                      {a.source && ` · ${a.source === "booking_page" ? "Booking page" : a.source}`}
                    </span>
                  </span>
                  <span className={`badge badge-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{tab === "all" ? "No appointments yet." : "Nothing here."}</p>
        )}
      </section>

      <button type="button" className="btn btn-danger-outline btn-auto" onClick={() => setDeleting(true)}>
        Delete customer
      </button>

      {open && <AppointmentPanel appointment={open} calendar={calendar} onClose={() => setOpen(null)} onChanged={() => setChanges((n) => n + 1)} />}

      {editing && (
        <CustomerDialog
          customer={customer}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            setCustomer(next);
            notify({ text: "Customer saved" });
          }}
        />
      )}

      {deleting && (
        <Dialog kind="modal" title={`Delete ${fullName(customer)}?`} onClose={() => setDeleting(false)}>
          <p className="lede">Their name, phone, email and booking notes are erased, here and on each of their bookings. This can't be undone.</p>
          <p className="muted small">If they agreed to get texts, the record of that is kept as proof you had permission.</p>
          <div className="two">
            <button type="button" className="btn btn-secondary" onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
