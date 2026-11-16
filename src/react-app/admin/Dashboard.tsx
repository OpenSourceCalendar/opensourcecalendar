import { useEffect, useState } from "react";
import { dateInZone, dateLabel, formatTime } from "../time";
import { adminApi, adminErrorText, fullName, STATUS_LABEL, type AdminAppointment, type AdminCalendar, type DashboardData } from "./api";
import { AppointmentPanel } from "./AppointmentPanel";
import { Icon } from "./Icon";
import { minuteOfDay } from "./zone";

function greeting(zone: string): string {
  const hour = minuteOfDay(Date.now(), zone) / 60;
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** "3 appointments today. Next one at 1:00 PM." (Cancelled ones aren't in the list.) */
function todayLine(data: DashboardData, zone: string): string {
  const n = data.today;
  if (!n) return "Nothing booked today.";
  const count = `${n} ${n === 1 ? "appointment" : "appointments"} today.`;
  const next = data.today_appointments.find((a) => (a.status === "booked" || a.status === "confirmed") && Date.parse(a.start) > Date.now());
  return next ? `${count} Next one at ${formatTime(next.start, zone)}.` : `${count} All done for the day.`;
}

export function Dashboard({
  calendar,
  reloadKey,
  navigate,
  onNewEntry,
}: {
  calendar: AdminCalendar;
  /** Bump to refetch (e.g. after New Entry saves). */
  reloadKey: number;
  navigate: (path: string) => void;
  onNewEntry: () => void;
}) {
  const zone = calendar.time_zone;
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<AdminAppointment | null>(null);
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    let live = true;
    adminApi.dashboard().then(
      (d) => live && (setData(d), setError("")),
      (e) => live && setError(adminErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [reloadKey, changes]);

  const cards: [string, number | undefined][] = [
    ["Today", data?.today],
    ["This week", data?.this_week],
    ["This month", data?.this_month],
    ["Customers", data?.customers],
  ];

  return (
    <>
      <header className="admin-band">
        <p className="muted">{dateLabel(dateInZone(Date.now(), zone))}</p>
        <h1 className="admin-title">{greeting(zone)}</h1>
        {data && <p className="muted">{todayLine(data, zone)}</p>}
        <dl className="counts">
          {cards.map(([label, value]) => (
            <div className="count" key={label}>
              <dt>{label}</dt>
              <dd>{value ?? <span className="skeleton count-skeleton" />}</dd>
            </div>
          ))}
        </dl>
      </header>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className="dash-cols">
        <section className="card" aria-labelledby="dash-today">
          <h2 className="card-title" id="dash-today">
            Today's schedule
          </h2>
          {!data ? (
            <span className="skeleton block" />
          ) : data.today_appointments.length ? (
            <ul className="rows">
              {data.today_appointments.map((a) => (
                <li key={a.id}>
                  <button type="button" className="row" onClick={() => setOpen(a)}>
                    <span className="row-time">{formatTime(a.start, zone)}</span>
                    <span className="row-main">
                      <strong>{fullName(a.customer)}</strong>
                      <span className="muted small">{a.service_name}</span>
                    </span>
                    <span className={`badge badge-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="admin-empty">
              <p className="sub">No appointments today</p>
              <p className="muted small">Appointments will appear here as they're booked</p>
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="dash-recent">
          <h2 className="card-title" id="dash-recent">
            Recent customers
          </h2>
          {!data ? (
            <span className="skeleton block" />
          ) : data.recent_customers.length ? (
            <ul className="rows">
              {data.recent_customers.map((c) => (
                <li key={c.id}>
                  <button type="button" className="row" onClick={() => navigate(`/admin/customers/${encodeURIComponent(c.id)}`)}>
                    <span className="row-main">
                      <strong>{fullName(c)}</strong>
                      <span className="muted small">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted center">No customers yet</p>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => navigate("/admin/customers")}>
            View all customers
          </button>
        </section>
      </div>

      <button type="button" className="fab" aria-label="New entry" onClick={onNewEntry}>
        <Icon name="plus" size={24} />
      </button>

      {open && (
        <AppointmentPanel appointment={open} calendar={calendar} onClose={() => setOpen(null)} onChanged={() => setChanges((n) => n + 1)} />
      )}
    </>
  );
}
