import { subtract, type Interval } from "./intervals";
import { addDays, localToUtc, offsetMinutes, utcToLocalDate, weekdayOf } from "./tz";

export type Status = "booked" | "confirmed" | "done" | "no_show" | "cancelled";

/** Opening hours for one day, in minutes after local midnight. */
export type DayHours = { open: boolean; start: number; end: number; breaks: Interval[] };

export type SlotInput = {
  /** Day being asked about, YYYY-MM-DD in the calendar's time zone. */
  date: string;
  timeZone: string;
  /** Current time, UTC ms. */
  now: number;
  durationMin: number;
  stepMin: number;
  bufferMin: number;
  /** 0 = Sunday … 6 = Saturday. A missing weekday means closed. */
  weekly: Partial<Record<number, DayHours>>;
  /** One-day change for `date`, if any. */
  override: DayHours | null;
  blockedDates: { start: string; end: string }[];
  /** Appointments near `date`, UTC ms. */
  appointments: { id: string; start: number; end: number; status: Status }[];
  /** Time blocks and Google busy times, UTC ms. No buffer is added to these. */
  busy: Interval[];
  /** When rescheduling, the appointment being moved doesn't block itself. */
  excludeAppointmentId?: string;
  minNoticeMin: number;
  maxDaysAhead: number;
  maxPerDay: number | null;
};

/** Start times (UTC ms) a customer may book on `input.date`, earliest first. */
export function findSlots(input: SlotInput): number[] {
  const { date, timeZone } = input;

  if (input.blockedDates.some((b) => date >= b.start && date <= b.end)) return [];

  const today = utcToLocalDate(input.now, timeZone);
  if (date < today || date > addDays(today, input.maxDaysAhead)) return [];

  const hours = input.override ?? input.weekly[weekdayOf(date)];
  if (!hours || !hours.open) return [];

  const active = input.appointments.filter(
    (a) => a.status !== "cancelled" && a.id !== input.excludeAppointmentId,
  );

  if (input.maxPerDay !== null) {
    const sameDay = active.filter((a) => utcToLocalDate(a.start, timeZone) === date).length;
    if (sameDay >= input.maxPerDay) return [];
  }

  const openRanges = subtract([{ start: hours.start, end: hours.end }], hours.breaks);
  const duration = input.durationMin * 60000;
  const buffer = input.bufferMin * 60000;
  const earliest = input.now + input.minNoticeMin * 60000;
  const slots: number[] = [];

  for (const range of openRanges) {
    // Compare against closing time in real (UTC) time, so a service can't run past
    // closing on the day clocks change.
    const closeAt = localToUtc(date, range.end, timeZone);
    const first = Math.ceil(range.start / input.stepMin) * input.stepMin;
    for (let minute = first; minute < range.end; minute += input.stepMin) {
      const start = localToUtc(date, minute, timeZone);
      // Skip clock times that don't exist (the hour skipped when clocks spring forward).
      if (minuteOfDay(start, timeZone) !== minute) continue;
      const end = start + duration;
      if (end > closeAt) continue;
      if (start < earliest) continue;
      // Both the existing appointment and the new one get the buffer after them.
      if (active.some((a) => start < a.end + buffer && end + buffer > a.start)) continue;
      if (input.busy.some((b) => start < b.end && end > b.start)) continue;
      slots.push(start);
    }
  }
  return slots;
}

function minuteOfDay(utcMs: number, timeZone: string): number {
  const local = new Date(utcMs + offsetMinutes(utcMs, timeZone) * 60000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}
