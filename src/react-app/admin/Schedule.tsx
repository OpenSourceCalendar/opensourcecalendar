import { useEffect, useMemo, useState } from "react";
import { addDays, addMonths, dateInZone, dateLabel, formatTime, monthLabel, shortDate, zoneLabel } from "../time";
import {
  adminApi, adminErrorText, STATUS_LABEL,
  type AdminAppointment, type AdminCalendar, type AdminService, type GoogleBusy, type Reminder, type Status, type TimeBlock, type WeeklyDay,
} from "./api";
import { AppointmentPanel } from "./AppointmentPanel";
import { Dialog } from "./Dialog";
import type { EntryStart } from "./NewEntry";
import { MonthView, TimeGridView } from "./ScheduleViews";
import type { Notify } from "./Toast";
import { minuteOfDay, zoneIso } from "./zone";

type View = "month" | "week" | "day";
const VIEWS: View[] = ["month", "week", "day"];
const VIEW_KEY = "bc_schedule_view";

function savedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY) as View | null;
    if (v && VIEWS.includes(v)) return v;
  } catch {
    /* storage blocked */
  }
  return window.matchMedia("(max-width: 599px)").matches ? "day" : "month";
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The dates a view shows. Month view fills whole weeks, Sunday to Saturday. */
function visibleDates(view: View, cursor: string): string[] {
  if (view === "day") return [cursor];
  let first = cursor;
  let count = 7;
  if (view === "month") {
    first = `${cursor.slice(0, 7)}-01`;
    const days = Number(addDays(`${addMonths(cursor.slice(0, 7), 1)}-01`, -1).slice(8));
    count = Math.ceil((weekday(first) + days) / 7) * 7;
  }
  const start = addDays(first, -weekday(first));
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

interface Loaded {
  /** The date range this was fetched for. */
  range: string;
  appointments: AdminAppointment[];
  reminders: Reminder[];
  blocks: TimeBlock[];
  googleBusy: GoogleBusy[];
}


export function Schedule({
  calendar,
  reloadKey,
  notify,
  onNewEntry,
}: {
  calendar: AdminCalendar;
  notify: Notify;
  /** Bump to refetch (e.g. after New Entry saves). */
  reloadKey: number;
  onNewEntry: (start?: EntryStart) => void;
}) {
  const zone = calendar.time_zone;
  const today = dateInZone(Date.now(), zone);
  const [view, setView] = useState<View>(savedView);
  const [cursor, setCursor] = useState(today);
  const [services, setServices] = useState<AdminService[]>([]);
  const [weekly, setWeekly] = useState<WeeklyDay[]>([]);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [open, setOpen] = useState<AdminAppointment | null>(null);
  const [openBlock, setOpenBlock] = useState<TimeBlock | null>(null);
  const [changes, setChanges] = useState(0);
  const reload = () => setChanges((n) => n + 1);

  const dates = useMemo(() => visibleDates(view, cursor), [view, cursor]);
  const from = zoneIso(dates[0], 0, zone);
  const to = zoneIso(addDays(dates[dates.length - 1], 1), 0, zone);
  const range = `${from}|${to}`;

  useEffect(() => {
    adminApi.services().then((r) => setServices(r.services), () => {});
    adminApi.availability().then((r) => setWeekly(r.weekly), () => {});
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([
      adminApi.appointments(from, to),
      adminApi.reminders(from, to),
      adminApi.timeBlocks(from, to),
      // Extra information only: a failure here mustn't stop the schedule loading.
      adminApi.googleBusy(from, to).catch(() => ({ busy: [] })),
    ]).then(
      ([a, r, b, g]) => {
        if (!live) return;
        setData({ range, appointments: a.appointments, reminders: r.reminders, blocks: b.time_blocks, googleBusy: g.busy });
        setError("");
      },
      (e) => live && setError(adminErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [from, to, reloadKey, changes]);

  function changeView(next: View) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* storage blocked */
    }
  }

  function step(dir: number) {
    if (view === "month") setCursor(`${addMonths(cursor.slice(0, 7), dir)}-01`);
    else setCursor(addDays(cursor, view === "week" ? 7 * dir : dir));
  }

  // While another range loads, show it as loading rather than as an empty calendar.
  const current = data?.range === range ? data : null;
  const shown = (current?.appointments ?? []).filter(
    (a) => (!serviceId || a.service_id === serviceId) && (status ? a.status === status : a.status !== "cancelled"),
  );
  const colors = new Map(services.map((s) => [s.id, s.color]));
  const colorOf = (a: AdminAppointment) => colors.get(a.service_id) ?? "var(--brand)";

  // Open hours with an hour on each side, widened to fit anything already on these days.
  const hours = useMemo(() => {
    const openDays = weekly.filter((d) => d.open);
    let start = openDays.length ? Math.min(...openDays.map((d) => d.start_min)) - 60 : 7 * 60;
    let end = openDays.length ? Math.max(...openDays.map((d) => d.end_min)) + 60 : 19 * 60;
    for (const a of data?.appointments ?? []) {
      const s = minuteOfDay(a.start, zone);
      start = Math.min(start, s);
      end = Math.max(end, Math.min(1440, s + (Date.parse(a.end) - Date.parse(a.start)) / 60000));
    }
    for (const r of data?.reminders ?? []) {
      const at = minuteOfDay(r.at, zone);
      start = Math.min(start, at);
      end = Math.max(end, at + 1);
    }
    return { start: Math.max(0, Math.floor(start / 60) * 60), end: Math.min(1440, Math.ceil(end / 60) * 60) };
  }, [weekly, data, zone]);

  async function move(a: AdminAppointment, date: string, minute: number) {
    const start = zoneIso(date, minute, zone);
    if (start === a.start) return;
    const end = new Date(Date.parse(start) + Date.parse(a.end) - Date.parse(a.start)).toISOString();
    // Show it in the new place straight away; a refusal snaps it back.
    setData((d) => d && { ...d, appointments: d.appointments.map((x) => (x.id === a.id ? { ...x, start, end } : x)) });
    try {
      await adminApi.updateAppointment(a.id, { start });
      notify({
        text: `Moved to ${shortDate(start, zone)}, ${formatTime(start, zone)}`,
        undo: async () => {
          try {
            // The old time may have been outside open hours; going back is always allowed if it's still free.
            await adminApi.updateAppointment(a.id, { start: a.start, allow_outside_hours: true });
            notify({ text: "Moved back" });
          } catch (e) {
            notify({ text: adminErrorText(e), error: true });
          }
          reload();
        },
      });
    } catch (e) {
      // Refused: put it back where it was, even if the reload below fails.
      setData((d) => d && { ...d, appointments: d.appointments.map((x) => (x.id === a.id ? a : x)) });
      notify({ text: adminErrorText(e), error: true });
    }
    reload();
  }

  async function removeBlock(b: TimeBlock) {
    try {
      await adminApi.deleteTimeBlock(b.id);
      notify({ text: "Block removed" });
    } catch (e) {
      notify({ text: adminErrorText(e), error: true });
    }
    setOpenBlock(null);
    reload();
  }

  const title =
    view === "month"
      ? monthLabel(cursor.slice(0, 7))
      : view === "week"
        ? `${dateLabel(dates[0], { month: "short", day: "numeric" })} – ${dateLabel(dates[6], { month: "short", day: "numeric", year: "numeric" })}`
        : dateLabel(cursor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <>
      <header className="sched-head admin-band">
        <div className="sched-nav">
          <button type="button" className="icon-btn" aria-label={`Previous ${view}`} onClick={() => step(-1)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" className="icon-btn" aria-label={`Next ${view}`} onClick={() => step(1)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <h1 className="sched-title" aria-live="polite">{title}</h1>
        </div>
        <div className="segmented" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => changeView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </header>

      <div className="sched-filters">
        <select className="input" aria-label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">All services</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="input" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
          <option value="">All statuses (not cancelled)</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary sched-today" disabled={dates.includes(today)} onClick={() => setCursor(today)}>
          Today
        </button>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className={current ? "sched-body" : "sched-body is-loading"} aria-busy={!current}>
        {view === "month" ? (
          <MonthView
            dates={dates}
            month={cursor.slice(0, 7)}
            today={today}
            zone={zone}
            appointments={shown}
            colorOf={colorOf}
            onOpen={setOpen}
            onDay={(date) => (setCursor(date), changeView("day"))}
            onAdd={(date) => onNewEntry({ date })}
          />
        ) : (
          <TimeGridView
            dates={dates}
            today={today}
            zone={zone}
            hours={hours}
            appointments={shown}
            blocks={current?.blocks ?? []}
            googleBusy={current?.googleBusy ?? []}
            reminders={current?.reminders ?? []}
            colorOf={colorOf}
            onOpen={setOpen}
            onOpenBlock={setOpenBlock}
            onDay={(date) => (setCursor(date), changeView("day"))}
            onAdd={(date, minute) => onNewEntry({ date, minute })}
            onMove={move}
          />
        )}
      </div>
      <p className="muted small">
        Times are in {zoneLabel(zone)}.
        {view !== "month" && !!current?.googleBusy.length && " Grey dashed boxes are busy times from your Google Calendar."}
      </p>

      {open && <AppointmentPanel appointment={open} calendar={calendar} onClose={() => setOpen(null)} onChanged={reload} />}

      {openBlock && (
        <Dialog kind="modal" title="Blocked time" onClose={() => setOpenBlock(null)}>
          <div className="stack">
            <p>
              <strong>{shortDate(openBlock.start_at, zone)}</strong>, {formatTime(openBlock.start_at, zone)} –{" "}
              {formatTime(openBlock.end_at, zone)}
            </p>
            {openBlock.note && <p className="muted">{openBlock.note}</p>}
            <p className="muted small">Nobody can book during this time.</p>
            <button type="button" className="btn btn-danger-outline" onClick={() => removeBlock(openBlock)}>
              Remove block
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
