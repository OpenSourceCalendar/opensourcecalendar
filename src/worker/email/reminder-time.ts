import { addDays, localToUtc, offsetMinutes, utcToLocalDate } from "../slots/tz";

const HOUR = 3600_000;
const EARLY_BEFORE_MIN = 9 * 60; // appointments starting before 9:00 AM count as early-morning
const EVENING_MIN = 18 * 60; // their reminder goes out at 6:00 PM the day before

/** When to remind the customer about an appointment starting at `start` (UTC ms). */
export function reminderAt(
  start: number,
  n: { reminder_mode: "smart" | "hours_before"; reminder_hours_before: number },
  timeZone: string,
): number {
  if (n.reminder_mode === "hours_before") return start - n.reminder_hours_before * HOUR;
  const localMs = start + offsetMinutes(start, timeZone) * 60_000;
  const minuteOfDay = Math.floor((((localMs % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
  if (minuteOfDay >= EARLY_BEFORE_MIN) return start - 2 * HOUR;
  return localToUtc(addDays(utcToLocalDate(start, timeZone), -1), EVENING_MIN, timeZone);
}
