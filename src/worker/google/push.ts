// Booking → Google. Each booking change queues a `google.push` job (in the same batch as its emails);
// runGoogleJobs makes the Google event match the appointment as it is when the job runs.
import { getAppointmentFull, type AppointmentFull } from "../booking/book";
import { entitlementsFor } from "../billing/entitlements";
import { newId, sha256Hex } from "../lib/ids";
import type { Bindings, CalendarRow } from "../types";
import { OWN_APPT, OWN_CAL, RUN_BUDGET_MS } from "./busy";
import { deleteEvent, errorCode, googleConfig, GoogleError, putEvent, type GoogleConfig } from "./client";
import { accessTokenFor, brokenReason, forgetAccessToken, getConnection, markBroken, NotConnected } from "./connection";

/** The Google event id for an appointment: fixed, so retries and races can't make a second event. Hex is valid in Google ids. */
export const eventIdFor = async (appointmentId: string) => (await sha256Hex(`booking-calendar:${appointmentId}`)).slice(0, 40);

const ACTIVE = "EXISTS (SELECT 1 FROM google_connections WHERE calendar_id = ?2 AND status = 'active')";

/**
 * Queue one appointment's push. Skipped when the calendar isn't connected, and when the same push is
 * already waiting and not yet started (it will read the latest state anyway).
 */
export function googlePushJob(db: D1Database, calendarId: string, appointmentId: string, now: number, removeFrom?: string): D1PreparedStatement {
  const payload = JSON.stringify(removeFrom ? { appointment_id: appointmentId, remove_from: removeFrom } : { appointment_id: appointmentId });
  return db.prepare(
    `INSERT INTO jobs (id, calendar_id, kind, payload, run_at)
     SELECT ?1, ?2, 'google.push', ?3, ?4
     WHERE ${ACTIVE}
       AND NOT EXISTS (SELECT 1 FROM jobs WHERE calendar_id = ?2 AND kind = 'google.push' AND done_at IS NULL AND attempts = 0 AND payload = ?3)`,
  ).bind(newId("job"), calendarId, payload, now);
}

/**
 * Queue pushes for many appointments at once:
 * - `upcoming`: every active one not yet over (after connecting or switching calendars);
 * - `inGoogle`: every one already in Google, any status or time (after reconnecting, so changes made while broken arrive);
 * - `customerId`: every one of this customer already in Google (after the customer is deleted, so names come off);
 * - `removeFrom`: delete the upcoming ones from the calendar the owner switched away from.
 * json_object builds the same text as JSON.stringify above, so the dedupe check still matches.
 */
export function googlePushMany(
  db: D1Database, calendarId: string, now: number,
  which: { upcoming: true } | { inGoogle: true } | { customerId: string } | { removeFrom: string },
): D1PreparedStatement {
  const insert = (payload: string, where: string) =>
    `INSERT INTO jobs (id, calendar_id, kind, payload, run_at)
     SELECT 'job_' || lower(hex(randomblob(12))), ?2, 'google.push', ${payload}, ?1 FROM appointments a
     WHERE a.calendar_id = ?2 AND ${where} AND ${ACTIVE}
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.calendar_id = ?2 AND j.kind = 'google.push' AND j.done_at IS NULL AND j.attempts = 0 AND j.payload = ${payload})`;
  const plain = "json_object('appointment_id', a.id)";
  if ("customerId" in which) {
    return db.prepare(insert(plain, "a.customer_id = ?3 AND a.google_event_id IS NOT NULL")).bind(now, calendarId, which.customerId);
  }
  if ("removeFrom" in which) {
    return db.prepare(insert("json_object('appointment_id', a.id, 'remove_from', ?3)", "a.end_at > ?1 AND a.google_event_id IS NOT NULL"))
      .bind(now, calendarId, which.removeFrom);
  }
  // Two minutes later, so new bookings aren't stuck behind a long catch-up.
  if ("inGoogle" in which) return db.prepare(insert(plain, "a.google_event_id IS NOT NULL")).bind(now + 120_000, calendarId);
  return db.prepare(insert(plain, "a.end_at > ?1 AND a.status IN ('booked', 'confirmed')")).bind(now, calendarId);
}

/** What goes into the owner's Google Calendar. It's their own calendar, so the customer's details are included. */
export function eventBody(a: AppointmentFull, cal: CalendarRow, id: string, publicUrl: string | undefined) {
  const who = `${a.contact_first_name} ${a.contact_last_name}`.trim();
  const lines: string[] = [];
  if (a.contact_phone) lines.push(`Phone: ${a.contact_phone}`);
  if (a.contact_email) lines.push(`Email: ${a.contact_email}`);
  if (a.note) lines.push(`Note: ${a.note}`);
  lines.push("", "Added by your booking calendar. To move or cancel it, use the booking calendar: changes made here in Google aren't copied back.");
  if (publicUrl) lines.push(`${publicUrl.replace(/\/+$/, "")}/admin/schedule`);
  return {
    id,
    summary: who ? `${a.service_name} – ${who}` : a.service_name,
    description: lines.join("\n").trim(),
    start: { dateTime: new Date(a.start_at).toISOString(), timeZone: cal.time_zone },
    end: { dateTime: new Date(a.end_at).toISOString(), timeZone: cal.time_zone },
    status: "confirmed",
    transparency: "opaque",
    extendedProperties: { private: { [OWN_APPT]: a.id, [OWN_CAL]: cal.id } },
  };
}

type PushPayload = { appointment_id: string; remove_from?: string };

async function pushOne(env: Bindings, cfg: GoogleConfig, calendarId: string, p: PushPayload, now: number): Promise<string> {
  const db = env.DB;
  const conn = await getConnection(db, calendarId);
  if (!conn || conn.status !== "active") return "skipped:not_connected";
  if (p.remove_from && p.remove_from === conn.google_calendar_id) return "skipped:current_calendar"; // switched back
  const access = await accessTokenFor(env, cfg, conn, now);
  const eventId = await eventIdFor(p.appointment_id);
  if (p.remove_from) {
    await deleteEvent(access, p.remove_from, eventId);
    return "done";
  }
  const cal = await db.prepare("SELECT * FROM calendars WHERE id = ?").bind(calendarId).first<CalendarRow>();
  const appt = cal ? await getAppointmentFull(db, calendarId, p.appointment_id) : null;
  const again = () => googlePushJob(db, calendarId, p.appointment_id, Date.now()).run();

  if (!cal || !appt || appt.status === "cancelled") {
    await deleteEvent(access, conn.google_calendar_id, eventId);
    const cleared = await db.prepare(
      "UPDATE appointments SET google_event_id = NULL WHERE id = ? AND calendar_id = ? AND status = 'cancelled' AND updated_at = ?",
    ).bind(p.appointment_id, calendarId, appt?.updated_at ?? 0).run();
    // Reopened while we were deleting: put it back.
    if (appt && !cleared.meta.changes) await again();
    return "done";
  }
  await putEvent(access, conn.google_calendar_id, eventBody(appt, cal, eventId, env.PUBLIC_URL), appt.google_event_id === eventId);
  // Only if nothing changed while we talked to Google (a cancel, a move, a disconnect). Otherwise what we
  // wrote may be stale, so queue a fresh push that will read the latest state.
  const saved = await db.prepare(
    `UPDATE appointments SET google_event_id = ?1 WHERE id = ?2 AND calendar_id = ?3 AND updated_at = ?4
       AND EXISTS (SELECT 1 FROM google_connections WHERE calendar_id = ?3 AND status = 'active' AND google_calendar_id = ?5)`,
  ).bind(eventId, appt.id, calendarId, appt.updated_at, conn.google_calendar_id).run();
  if (!saved.meta.changes) {
    await again();
    // The owner switched calendars while we were writing: take this copy back off the old one.
    const nowConn = await getConnection(db, calendarId);
    if (nowConn && nowConn.google_calendar_id !== conn.google_calendar_id) {
      await googlePushJob(db, calendarId, p.appointment_id, Date.now(), conn.google_calendar_id).run();
    }
  }
  return "done";
}

const MAX_ATTEMPTS = 5;
/** Same as runDueJobs: a job claimed this often without finishing is left for the clean-up. */
const MAX_CLAIMS = 8;
const BATCH = 20;
const BACKOFF_MIN = [1, 5, 15, 60];

/**
 * Run due Google pushes. Claims each job the same way runDueJobs does (push run_at forward in one UPDATE;
 * only the run that changed the row does the work). Results are 'done' — never 'sent', which the daily
 * email cap counts.
 */
export async function runGoogleJobs(env: Bindings, now: number): Promise<number> {
  const db = env.DB;
  const cfg = googleConfig(env);
  const began = Date.now();
  const { results } = await db.prepare(
    "SELECT id, calendar_id, payload, run_at, attempts FROM jobs WHERE done_at IS NULL AND kind = 'google.push' AND run_at <= ? AND attempts < ? ORDER BY run_at LIMIT ?",
  ).bind(now, MAX_CLAIMS, BATCH).all<{ id: string; calendar_id: string; payload: string; run_at: number; attempts: number }>();

  let handled = 0;
  for (const job of results) {
    if (Date.now() - began > RUN_BUDGET_MS) break;
    const attempt = job.attempts + 1;
    const retryAt = Math.max(now, Date.now()) + (BACKOFF_MIN[job.attempts] ?? 60) * 60_000;
    const claim = await db.prepare("UPDATE jobs SET attempts = ?, run_at = ? WHERE id = ? AND done_at IS NULL AND run_at = ?")
      .bind(attempt, retryAt, job.id, job.run_at).run();
    if (!claim.meta.changes) continue;
    handled++;

    // Free plan: nothing goes to Google. Close the job so it doesn't retry.
    if (!(await entitlementsFor(env, job.calendar_id, now)).google) {
      await db.prepare("UPDATE jobs SET done_at = ?, result = 'skipped:plan' WHERE id = ?").bind(now, job.id).run();
      continue;
    }

    let result: string | null;
    let payload: PushPayload | null = null;
    try {
      payload = JSON.parse(job.payload) as PushPayload;
      result = cfg ? await pushOne(env, cfg, job.calendar_id, payload, now) : "skipped:not_configured";
      if (result === "done") await db.prepare("UPDATE google_connections SET push_error = NULL WHERE calendar_id = ? AND push_error IS NOT NULL").bind(job.calendar_id).run();
    } catch (err) {
      const code = err instanceof NotConnected ? "not_connected" : !payload ? "bad_payload" : errorCode(err);
      // A calendar the owner switched away from failing says nothing about the one in use.
      const reason = payload?.remove_from ? null : brokenReason(err);
      if (err instanceof NotConnected) result = "skipped:not_connected";
      else if (!payload) result = "failed:bad_payload";
      else if (reason) {
        await markBroken(db, job.calendar_id, reason);
        result = `failed:${code}`;
      } else {
        if (err instanceof GoogleError && err.status === 401) await forgetAccessToken(db, job.calendar_id);
        result = attempt >= MAX_ATTEMPTS || (payload.remove_from && brokenReason(err)) ? `failed:${code}` : null;
        // Gave up on a booking: tell the owner on the Google screen.
        if (result && !payload.remove_from) await db.prepare("UPDATE google_connections SET push_error = ? WHERE calendar_id = ?").bind(code, job.calendar_id).run();
      }
      console.error(JSON.stringify({ event: "google_push_failed", job: job.id, attempt, code, gave_up: result !== null }));
    }
    if (result !== null) await db.prepare("UPDATE jobs SET done_at = ?, result = ? WHERE id = ?").bind(now, result, job.id).run();
  }
  return handled;
}
