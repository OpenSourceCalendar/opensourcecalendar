// The Free plan's monthly limit: after 10 booking-page bookings in a calendar month, new ones send no email.
import { enqueueEmail } from "../email/outbox";
import { localToUtc, utcToLocalDate } from "../slots/tz";
import type { Bindings, CalendarRow } from "../types";
import { publicBase } from "../accounts/config";
import { entitlements } from "./entitlements";

/** This calendar month in the business's time zone: [start, end) in UTC ms, and its 'YYYY-MM'. */
export function monthBounds(now: number, timeZone: string) {
  const month = utcToLocalDate(now, timeZone).slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
  return { month, start: localToUtc(`${month}-01`, 0, timeZone), end: localToUtc(next, 0, timeZone) };
}

/** Booking-page bookings this month, cancelled ones included (so book-and-cancel can't reset it). */
export async function bookingsThisMonth(db: D1Database, cal: Pick<CalendarRow, "id" | "time_zone">, now: number): Promise<number> {
  const { start, end } = monthBounds(now, cal.time_zone);
  const row = await db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE calendar_id = ? AND source = 'booking_page' AND created_at >= ? AND created_at < ?")
    .bind(cal.id, start, end).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Call after a booking-page booking is saved and BEFORE its emails are queued (queueEmails starts sending at once).
 * Over the limit: the booking is marked emails_off, and the first time this month the owner gets one email.
 */
export async function markIfOverLimit(env: Bindings, cal: CalendarRow, appointmentId: string, now: number): Promise<void> {
  const ent = await entitlements(env, cal, now);
  if (!ent.limited || ent.monthlyEmailBookings === null) return;
  if ((await bookingsThisMonth(env.DB, cal, now)) <= ent.monthlyEmailBookings) return;
  await env.DB.prepare("UPDATE appointments SET emails_off = 1 WHERE id = ? AND calendar_id = ?").bind(appointmentId, cal.id).run();
  const { month } = monthBounds(now, cal.time_zone);
  const first = await env.DB.prepare("INSERT OR IGNORE INTO free_limit_notices (calendar_id, month) VALUES (?, ?)").bind(cal.id, month).run();
  if (first.meta.changes) {
    await enqueueEmail(env.DB, cal.id, "email.account.limit", { appointment_id: "", origin: publicBase(env), user_id: cal.account_user_id!, month }, now).run();
  }
}
