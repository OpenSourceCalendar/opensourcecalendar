// Google → booking page. Busy Google events are copied into google_busy, which the slot finder and the
// no-double-booking check already respect. Event details are never stored: only an id and a time range.
import { entitlements } from "../billing/entitlements";
import { sha256Hex } from "../lib/ids";
import { parseRules } from "../settings";
import { localToUtc } from "../slots/tz";
import type { Bindings, CalendarRow } from "../types";
import { errorCode, googleConfig, GoogleError, listEvents, type GEvent, type GoogleConfig } from "./client";
import { accessTokenFor, brokenReason, forgetAccessToken, getConnection, markBroken, NotConnected, type ConnectionRow } from "./connection";

/** Private properties on the events we create: which appointment, and which booking calendar made it. */
export const OWN_APPT = "bookingCalendarAppt";
export const OWN_CAL = "bookingCalendarCal";
const DAY = 86_400_000;

export type Busy = { id: string; start: number; end: number };

export function eventsToBusy(events: GEvent[], o: { calendarId: string; timeZone: string; blockAllDay: boolean }): Busy[] {
  const out: Busy[] = [];
  for (const e of events) {
    if (!e.id || e.status === "cancelled") continue;
    if (e.eventType === "workingLocation" || e.eventType === "birthday") continue;
    // This calendar's own bookings are already counted. Another booking calendar's bookings are busy time.
    if (e.extendedProperties?.private?.[OWN_CAL] === o.calendarId) continue;
    if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
    let start: number;
    let end: number;
    if (e.start?.date && e.end?.date) {
      // Google makes all-day events "Free" by default, so the owner's switch decides, not Free/Busy (owner decision).
      if (!o.blockAllDay) continue;
      // All-day events are dates in the owner's time zone; the end date is exclusive.
      start = localToUtc(e.start.date, 0, o.timeZone);
      end = localToUtc(e.end.date, 0, o.timeZone);
    } else if (e.start?.dateTime && e.end?.dateTime) {
      if (e.transparency === "transparent") continue; // marked Free
      start = Date.parse(e.start.dateTime);
      end = Date.parse(e.end.dateTime);
    } else continue;
    if (!(start < end)) continue;
    out.push({ id: e.id, start, end });
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/**
 * One statement for any number of rows (json_each), and only while this Google calendar is still the
 * connected one: a disconnect or calendar switch may have happened while we were asking Google.
 */
function insertBusy(db: D1Database, calendarId: string, googleCalendarId: string, rows: Busy[]): D1PreparedStatement {
  return db.prepare(
    `INSERT OR REPLACE INTO google_busy (calendar_id, google_event_id, start_at, end_at)
     SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?3)
     WHERE EXISTS (SELECT 1 FROM google_connections WHERE calendar_id = ?1 AND status = 'active' AND google_calendar_id = ?2)`,
  ).bind(calendarId, googleCalendarId, JSON.stringify(rows.map((b) => [b.id, b.start, b.end])));
}

const busyOptions = (cal: CalendarRow) => ({ calendarId: cal.id, timeZone: cal.time_zone, blockAllDay: parseRules(cal.rules).block_all_day_google });

/** Replace this calendar's busy times with what Google has now, for the whole bookable window. */
export async function syncBusy(env: Bindings, cfg: GoogleConfig, conn: ConnectionRow, cal: CalendarRow, now: number): Promise<void> {
  const db = env.DB;
  const rules = parseRules(cal.rules);
  const access = await accessTokenFor(env, cfg, conn, now);
  const events = await listEvents(access, conn.google_calendar_id, now - DAY, now + (rules.max_days_ahead + 2) * DAY);
  const busy = eventsToBusy(events, busyOptions(cal));
  const hash = await sha256Hex(JSON.stringify([conn.google_calendar_id, cal.time_zone, busy]));
  const done = db.prepare(
    "UPDATE google_connections SET last_synced_at = ?, busy_hash = ?, last_error = NULL WHERE calendar_id = ? AND status = 'active' AND google_calendar_id = ?",
  ).bind(now, hash, cal.id, conn.google_calendar_id);
  if (hash === conn.busy_hash) {
    await done.run();
    return;
  }
  // One transaction: the booking page never sees a half-written set. Every part checks this is still the
  // connected Google calendar, so a sync that finishes after a switch or a break changes nothing.
  const still = "EXISTS (SELECT 1 FROM google_connections WHERE calendar_id = ?1 AND status = 'active' AND google_calendar_id = ?2)";
  await db.batch([
    db.prepare(`DELETE FROM google_busy WHERE calendar_id = ?1 AND ${still}`).bind(cal.id, conn.google_calendar_id),
    insertBusy(db, cal.id, conn.google_calendar_id, busy),
    done,
  ]);
}

const CHECK_DEADLINE_MS = 2_500;

/**
 * Right before a customer's booking is saved: ask Google about just that time, so an event added in the
 * last minute still blocks it. Best effort, and never more than 2.5 s: a slow or failing Google never
 * fails or stalls the booking.
 */
export async function checkGoogleWindow(env: Bindings, cal: CalendarRow, start: number, end: number, now: number): Promise<void> {
  const cfg = googleConfig(env);
  if (!cfg) return;
  if (!(await entitlements(env, cal, now)).google) return;
  const work = (async () => {
    const conn = await getConnection(env.DB, cal.id);
    if (!conn || conn.status !== "active") return;
    const access = await accessTokenFor(env, cfg, conn, now, CHECK_DEADLINE_MS);
    const events = await listEvents(access, conn.google_calendar_id, start, end, CHECK_DEADLINE_MS);
    const busy = eventsToBusy(events, busyOptions(cal)).filter((b) => b.start < end && b.end > start);
    if (!busy.length) return;
    await env.DB.batch([
      insertBusy(env.DB, cal.id, conn.google_calendar_id, busy),
      // Rows added here aren't in the stored hash, so make the next sync rewrite the set.
      env.DB.prepare("UPDATE google_connections SET busy_hash = NULL WHERE calendar_id = ?").bind(cal.id),
    ]);
  })().catch((err) => {
    console.error(JSON.stringify({ event: "google_check_failed", calendar: cal.id, code: errorCode(err) }));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CHECK_DEADLINE_MS);
  });
  await Promise.race([work, deadline]);
  clearTimeout(timer);
}

const SYNC_BATCH = 10;
/** Stop starting new work after this long: the cron's wall time is limited. */
export const RUN_BUDGET_MS = 20_000;

/** Cron: refresh busy times for connections not synced in the last ~minute. Returns how many it tried. */
export async function runGoogleSync(env: Bindings, now: number): Promise<number> {
  const cfg = googleConfig(env);
  if (!cfg) return 0;
  const db = env.DB;
  const began = Date.now();
  const { results } = await db.prepare(
    "SELECT * FROM google_connections WHERE status = 'active' AND COALESCE(last_attempt_at, 0) < ? ORDER BY COALESCE(last_attempt_at, 0) LIMIT ?",
  ).bind(now - 50_000, SYNC_BATCH).all<ConnectionRow>();
  let tried = 0;
  for (const conn of results) {
    if (Date.now() - began > RUN_BUDGET_MS) break;
    tried++;
    await db.prepare("UPDATE google_connections SET last_attempt_at = ? WHERE calendar_id = ?").bind(now, conn.calendar_id).run();
    const cal = await db.prepare("SELECT * FROM calendars WHERE id = ?").bind(conn.calendar_id).first<CalendarRow>();
    // Free plan: sync is paused (not an error), so the connection is kept and picks up again once paid.
    if (!cal || !(await entitlements(env, cal, now)).google) continue;
    try {
      await syncBusy(env, cfg, conn, cal, now);
    } catch (err) {
      await recordSyncError(db, conn.calendar_id, err);
    }
  }
  return tried;
}

/** Shared by the cron and the "Check now" button. */
export async function recordSyncError(db: D1Database, calendarId: string, err: unknown): Promise<void> {
  if (err instanceof NotConnected) return; // already marked
  const reason = brokenReason(err);
  if (reason) return markBroken(db, calendarId, reason);
  if (err instanceof GoogleError && err.status === 401) await forgetAccessToken(db, calendarId);
  const code = errorCode(err);
  await db.prepare("UPDATE google_connections SET last_error = ? WHERE calendar_id = ?").bind(code, calendarId).run();
  console.error(JSON.stringify({ event: "google_sync_failed", calendar: calendarId, code }));
}
