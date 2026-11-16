import { parseRules } from "../settings";
import type { CalendarRow } from "../types";
import type { DayHours, SlotInput, Status } from "./find-slots";
import { addDays, localToUtc } from "./tz";

type Range = { start_min: number; end_min: number };

export async function loadSlotInput(
  db: D1Database,
  calendar: CalendarRow,
  service: { duration_min: number },
  date: string,
  now: number,
  excludeAppointmentId?: string,
): Promise<SlotInput> {
  const rules = parseRules(calendar.rules);
  const tz = calendar.time_zone;
  const from = localToUtc(addDays(date, -1), 0, tz);
  const to = localToUtc(addDays(date, 2), 0, tz);
  const id = calendar.id;

  const [hours, breaks, override, blocked, appts, blocks, busy] = await db.batch([
    db.prepare("SELECT weekday, start_min, end_min FROM weekly_hours WHERE calendar_id = ?").bind(id),
    db.prepare("SELECT weekday, start_min, end_min FROM weekly_breaks WHERE calendar_id = ?").bind(id),
    db.prepare("SELECT closed, start_min, end_min, breaks FROM date_overrides WHERE calendar_id = ? AND on_date = ?").bind(id, date),
    db.prepare("SELECT start_date, end_date FROM blocked_dates WHERE calendar_id = ? AND start_date <= ? AND end_date >= ?").bind(id, date, date),
    db.prepare("SELECT id, start_at, end_at, status FROM appointments WHERE calendar_id = ? AND status != 'cancelled' AND start_at < ? AND end_at > ?").bind(id, to, from),
    db.prepare("SELECT start_at, end_at FROM time_blocks WHERE calendar_id = ? AND start_at < ? AND end_at > ?").bind(id, to, from),
    db.prepare("SELECT start_at, end_at FROM google_busy WHERE calendar_id = ? AND start_at < ? AND end_at > ?").bind(id, to, from),
  ]);

  const hourRows = hours.results as ({ weekday: number } & Range)[];
  const breakRows = breaks.results as ({ weekday: number } & Range)[];
  const weekly: SlotInput["weekly"] = {};
  for (const h of hourRows) {
    weekly[h.weekday] = {
      open: true,
      start: h.start_min,
      end: h.end_min,
      breaks: breakRows.filter((b) => b.weekday === h.weekday).map((b) => ({ start: b.start_min, end: b.end_min })),
    };
  }

  const o = override.results[0] as { closed: number; start_min: number | null; end_min: number | null; breaks: string } | undefined;
  const overrideHours: DayHours | null = o
    ? o.closed
      ? { open: false, start: 0, end: 0, breaks: [] }
      : {
          open: true,
          start: o.start_min!,
          end: o.end_min!,
          breaks: (JSON.parse(o.breaks) as Range[]).map((b) => ({ start: b.start_min, end: b.end_min })),
        }
    : null;

  const span = (r: { start_at: number; end_at: number }) => ({ start: r.start_at, end: r.end_at });

  return {
    date,
    timeZone: tz,
    now,
    durationMin: service.duration_min,
    stepMin: rules.slot_step_min,
    bufferMin: rules.buffer_min,
    weekly,
    override: overrideHours,
    blockedDates: (blocked.results as { start_date: string; end_date: string }[]).map((b) => ({ start: b.start_date, end: b.end_date })),
    appointments: (appts.results as { id: string; start_at: number; end_at: number; status: Status }[]).map((a) => ({
      id: a.id, start: a.start_at, end: a.end_at, status: a.status,
    })),
    busy: [...(blocks.results as { start_at: number; end_at: number }[]), ...(busy.results as { start_at: number; end_at: number }[])].map(span),
    excludeAppointmentId,
    minNoticeMin: rules.min_notice_min,
    maxDaysAhead: rules.max_days_ahead,
    maxPerDay: rules.max_per_day,
  };
}
