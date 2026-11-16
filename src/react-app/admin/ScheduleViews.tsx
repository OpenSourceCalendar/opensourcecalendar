import { useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { addDays, dateInZone, dateLabel, formatTime, weekdayShort } from "../time";
import { fullName, STATUS_LABEL, type AdminAppointment, type GoogleBusy, type Reminder, type TimeBlock } from "./api";
import { hourLabel, minuteLabel, minuteOfDay, zoneIso } from "./zone";

const svc = (color: string) => ({ "--svc": color }) as CSSProperties;
const isActive = (a: AdminAppointment) => a.status === "booked" || a.status === "confirmed";
const apptLabel = (a: AdminAppointment, zone: string) =>
  `${formatTime(a.start, zone)}, ${fullName(a.customer)}, ${a.service_name}, ${STATUS_LABEL[a.status]}`;

/* ---------- Month ---------- */

export function MonthView({
  dates,
  month,
  today,
  zone,
  appointments,
  colorOf,
  onOpen,
  onDay,
  onAdd,
}: {
  dates: string[];
  month: string;
  today: string;
  zone: string;
  appointments: AdminAppointment[];
  colorOf: (a: AdminAppointment) => string;
  onOpen: (a: AdminAppointment) => void;
  onDay: (date: string) => void;
  onAdd: (date: string) => void;
}) {
  const byDate = new Map<string, AdminAppointment[]>();
  for (const a of appointments) {
    const d = dateInZone(Date.parse(a.start), zone);
    byDate.set(d, [...(byDate.get(d) ?? []), a]);
  }
  // Chips are too small to tap on a phone, so there a busy day opens Day view instead.
  const narrow = () => window.matchMedia("(max-width: 599px)").matches;

  return (
    <div className="month" role="grid" aria-label="Month">
      <div className="month-row month-head" role="row">
        {weekdayShort().map((n) => (
          <span key={n} role="columnheader">
            {n}
          </span>
        ))}
      </div>
      {Array.from({ length: dates.length / 7 }, (_, w) => (
        <div className="month-row" role="row" key={w}>
          {dates.slice(w * 7, w * 7 + 7).map((date) => {
            const list = byDate.get(date) ?? [];
            const count = list.length ? `, ${list.length} ${list.length === 1 ? "appointment" : "appointments"}` : "";
            return (
              <div
                key={date}
                role="gridcell"
                className={`mcell${date === today ? " is-today" : ""}${date.startsWith(month) ? "" : " is-outside"}`}
              >
                <button
                  type="button"
                  className="mcell-day"
                  aria-label={`${dateLabel(date)}${count}`}
                  onClick={() => (list.length && narrow() ? onDay(date) : onAdd(date))}
                >
                  <span className="mcell-num">{Number(date.slice(8))}</span>
                </button>
                {list.slice(0, 3).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`chip-appt is-${a.status}`}
                    style={svc(colorOf(a))}
                    aria-label={apptLabel(a, zone)}
                    onClick={() => onOpen(a)}
                  >
                    <span className="chip-time">{formatTime(a.start, zone)}</span> {fullName(a.customer)}
                  </button>
                ))}
                {list.length > 3 && (
                  <button type="button" className="mcell-more" onClick={() => onDay(date)}>
                    +{list.length - 3} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------- Week and Day ---------- */

const HOUR_PX = 56;
const SNAP = 15;

interface Placed {
  a: AdminAppointment;
  start: number;
  end: number;
  lane: number;
  lanes: number;
}

/** Side-by-side lanes for appointments that overlap. */
function place(list: AdminAppointment[], zone: string, gridEnd: number): Placed[] {
  const items: Placed[] = list
    .map((a) => {
      const start = minuteOfDay(a.start, zone);
      const minutes = Math.max(20, Math.round((Date.parse(a.end) - Date.parse(a.start)) / 60000));
      return { a, start, end: Math.min(start + minutes, gridEnd), lane: 0, lanes: 1 };
    })
    .sort((x, y) => x.start - y.start);
  let group: Placed[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    for (const p of group) p.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const p of items) {
    if (group.length && p.start >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= p.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = p.end;
    p.lane = lane;
    group.push(p);
    groupEnd = Math.max(groupEnd, p.end);
  }
  flush();
  return items;
}

interface Drag {
  id: string;
  /** Columns and minutes moved from where it started. */
  cols: number;
  minutes: number;
  colWidth: number;
}

export function TimeGridView({
  dates,
  today,
  zone,
  hours,
  appointments,
  blocks,
  googleBusy,
  reminders,
  colorOf,
  onOpen,
  onOpenBlock,
  onDay,
  onAdd,
  onMove,
}: {
  dates: string[];
  today: string;
  zone: string;
  /** First and last minute of the day shown. */
  hours: { start: number; end: number };
  appointments: AdminAppointment[];
  blocks: TimeBlock[];
  /** Busy times from Google: shown, but they can't be opened or moved. */
  googleBusy: GoogleBusy[];
  reminders: Reminder[];
  colorOf: (a: AdminAppointment) => string;
  onOpen: (a: AdminAppointment) => void;
  onOpenBlock: (b: TimeBlock) => void;
  onDay: (date: string) => void;
  onAdd: (date: string, minute: number) => void;
  onMove: (a: AdminAppointment, date: string, minute: number) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const press = useRef<{ p: Placed; col: number; x: number; y: number; moved: Drag | null } | null>(null);
  const skipClick = useRef(false);

  const top = (minute: number) => ((minute - hours.start) / 60) * HOUR_PX;
  const height = top(hours.end);
  const hourMarks = Array.from({ length: (hours.end - hours.start) / 60 }, (_, i) => hours.start / 60 + i);
  const names = weekdayShort();
  const nowMinute = minuteOfDay(Date.now(), zone);
  // Worked out once per render, not once per column (this re-renders on every drag movement).
  const dated = appointments.map((a) => ({ a, date: dateInZone(Date.parse(a.start), zone) }));

  function onPointerDown(e: PointerEvent<HTMLButtonElement>, p: Placed, col: number) {
    // Mouse and pen only: on touch, dragging would fight with scrolling. Touch uses Reschedule in the panel.
    skipClick.current = false;
    if (e.button !== 0 || e.pointerType === "touch" || !isActive(p.a)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { p, col, x: e.clientX, y: e.clientY, moved: null };
  }

  function onPointerMove(e: PointerEvent) {
    const s = press.current;
    if (!s || !grid.current) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.moved && Math.hypot(dx, dy) < 5) return;
    const colWidth = grid.current.getBoundingClientRect().width / dates.length;
    const cols = Math.max(-s.col, Math.min(dates.length - 1 - s.col, Math.round(dx / colWidth)));
    const length = s.p.end - s.p.start;
    const wanted = s.p.start + Math.round(((dy / HOUR_PX) * 60) / SNAP) * SNAP;
    const minutes = Math.max(hours.start, Math.min(hours.end - length, wanted)) - s.p.start;
    s.moved = { id: s.p.a.id, cols, minutes, colWidth };
    setDrag(s.moved);
  }

  function onPointerUp() {
    const s = press.current;
    press.current = null;
    setDrag(null);
    if (!s?.moved) return;
    // The click that follows a drag must not open the panel or New Entry. It may never arrive
    // (the block can move to another column first), so the flag also clears itself.
    skipClick.current = true;
    setTimeout(() => (skipClick.current = false), 0);
    if (s.moved.cols || s.moved.minutes) onMove(s.p.a, dates[s.col + s.moved.cols], s.p.start + s.moved.minutes);
  }

  function onColumnClick(e: MouseEvent<HTMLDivElement>, date: string) {
    if (e.target !== e.currentTarget || skipClick.current) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    onAdd(date, hours.start + Math.floor(((y / HOUR_PX) * 60) / SNAP) * SNAP);
  }

  return (
    <div className="tgrid-scroll">
      <div className={`tgrid${dates.length > 1 ? " is-week" : ""}`}>
        <div className="tgrid-head">
          <span className="tgrid-gutter" />
          {dates.map((date) => (
            <button
              key={date}
              type="button"
              className={`tgrid-dayname${date === today ? " is-today" : ""}`}
              aria-label={dateLabel(date)}
              disabled={dates.length === 1}
              onClick={() => onDay(date)}
            >
              <span>{names[new Date(`${date}T00:00:00Z`).getUTCDay()]}</span>
              <strong>{Number(date.slice(8))}</strong>
            </button>
          ))}
        </div>
        <div className="tgrid-body" style={{ height }}>
          <div className="tgrid-gutter" aria-hidden="true">
            {hourMarks.map((h) => (
              <span key={h} style={{ top: top(h * 60) }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          <div className="tgrid-cols" ref={grid} style={{ backgroundSize: `100% ${HOUR_PX}px` }}>
            {dates.map((date, col) => {
              const dayStart = Date.parse(zoneIso(date, 0, zone));
              const dayEnd = Date.parse(zoneIso(addDays(date, 1), 0, zone));
              const placed = place(
                dated.filter((d) => d.date === date).map((d) => d.a),
                zone,
                hours.end,
              );
              const dayBlocks = blocks.filter((b) => Date.parse(b.start_at) < dayEnd && Date.parse(b.end_at) > dayStart);
              const dayBusy = googleBusy.filter((b) => Date.parse(b.start) < dayEnd && Date.parse(b.end) > dayStart);
              const flags = reminders.filter((r) => dateInZone(Date.parse(r.at), zone) === date);
              return (
                <div
                  key={date}
                  className={`tgrid-col${date === today ? " is-today" : ""}`}
                  onClick={(e) => onColumnClick(e, date)}
                >
                  {dayBusy.map((b, i) => {
                    const from = Date.parse(b.start) <= dayStart ? hours.start : Math.max(hours.start, minuteOfDay(b.start, zone));
                    const to = Date.parse(b.end) >= dayEnd ? hours.end : Math.min(hours.end, minuteOfDay(b.end, zone));
                    if (to <= from) return null;
                    return (
                      <span key={`g${i}`} className="gbusy" style={{ top: top(from), height: top(to) - top(from) }}>
                        <span className="sr-only">
                          Busy in Google,{" "}
                          {Date.parse(b.start) <= dayStart && Date.parse(b.end) >= dayEnd
                            ? "all day"
                            : `${formatTime(b.start, zone)} to ${formatTime(b.end, zone)}`}
                        </span>
                        <span aria-hidden="true">Busy in Google</span>
                      </span>
                    );
                  })}
                  {dayBlocks.map((b) => {
                    const from = Date.parse(b.start_at) <= dayStart ? hours.start : Math.max(hours.start, minuteOfDay(b.start_at, zone));
                    const to = Date.parse(b.end_at) >= dayEnd ? hours.end : Math.min(hours.end, minuteOfDay(b.end_at, zone));
                    if (to <= from) return null;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className="tblock"
                        style={{ top: top(from), height: top(to) - top(from) }}
                        aria-label={`Blocked ${minuteLabel(from)} to ${minuteLabel(to)}${b.note ? `, ${b.note}` : ""}`}
                        onClick={() => onOpenBlock(b)}
                      >
                        {b.note || "Blocked"}
                      </button>
                    );
                  })}
                  {date === today && nowMinute >= hours.start && nowMinute < hours.end && (
                    <span className="now-line" style={{ top: top(nowMinute) }} aria-hidden="true" />
                  )}
                  {placed.map((p) => {
                    if (p.start >= hours.end || p.end <= hours.start) return null;
                    const dragging = drag?.id === p.a.id ? drag : null;
                    const style: CSSProperties = {
                      ...svc(colorOf(p.a)),
                      top: top(Math.max(p.start, hours.start)),
                      height: top(p.end) - top(Math.max(p.start, hours.start)),
                      left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`,
                      width: `calc(${100 / p.lanes}% - 4px)`,
                      ...(dragging && {
                        left: 2,
                        width: "calc(100% - 4px)",
                        transform: `translate(${dragging.cols * dragging.colWidth}px, ${(dragging.minutes / 60) * HOUR_PX}px)`,
                      }),
                    };
                    return (
                      <button
                        key={p.a.id}
                        type="button"
                        className={`tappt is-${p.a.status}${dragging ? " is-dragging" : ""}${isActive(p.a) ? " can-drag" : ""}${p.end - p.start <= 30 ? " is-short" : ""}`}
                        style={style}
                        aria-label={apptLabel(p.a, zone)}
                        onPointerDown={(e) => onPointerDown(e, p, col)}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={() => ((press.current = null), setDrag(null))}
                        onClick={() => {
                          if (skipClick.current) skipClick.current = false;
                          else onOpen(p.a);
                        }}
                      >
                        <span className="tappt-time">
                          {dragging ? minuteLabel(p.start + dragging.minutes) : formatTime(p.a.start, zone)}
                        </span>
                        <span className="tappt-name">{fullName(p.a.customer)}</span>
                        <span className="tappt-service">{p.a.service_name}</span>
                      </button>
                    );
                  })}
                  {flags.map((r) => {
                    const at = minuteOfDay(r.at, zone);
                    if (at < hours.start || at >= hours.end) return null;
                    return (
                      <span
                        key={r.id}
                        className={`flag${r.done ? " is-done" : ""}`}
                        style={{ top: top(at) }}
                        role="img"
                        aria-label={`Call back at ${formatTime(r.at, zone)}: ${r.title}`}
                        title={`Call back: ${r.title}`}
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M2 1v10M2 1.5h7l-1.5 2.5L9 6.5H2" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                        </svg>
                        <span className="flag-text">
                          {formatTime(r.at, zone)} {r.title}
                        </span>
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
