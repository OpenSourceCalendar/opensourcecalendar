// The outbox: booking actions add rows to `jobs`; `runDueJobs` sends the ones that are due.
// It runs right after each booking request (so a confirmation arrives within seconds) and
// every minute from the cron (retries and reminders).

import { newId } from "../lib/ids";
import { parseNotifications } from "../settings";
import type { Bindings, CalendarRow } from "../types";
import { reminderAt } from "./reminder-time";
import { buildEmail } from "./send";
import { googlePushJob } from "../google/push";
import { webhookJob } from "../webhooks/job";

export type EmailKind =
  | "email.customer.booked" | "email.customer.changed" | "email.customer.cancelled" | "email.customer.reminder"
  | "email.owner.new" | "email.owner.changed" | "email.owner.cancelled"
  | "email.account.limit" | "email.account.grace_start" | "email.account.grace_end";

export interface EmailPayload {
  appointment_id: string;
  /** Where the request came from, for links when PUBLIC_URL isn't set: the cron run has no request to read it from. */
  origin: string;
  /** Reminders only: the start time this reminder was made for. */
  start?: number;
  /** When the job was first due (set by enqueueEmail), for the daily-limit retry window. */
  due?: number;
  /** Confirmations from the booking page: the hashed inbox, for the per-address limit. */
  addr?: string;
  /** Account emails: the account (users.id). */
  user_id?: string;
  /** Account limit email: 'YYYY-MM'. */
  month?: string;
  /** Grace emails: when the grace month ends (ms). */
  until?: number;
}

export interface OutgoingEmail {
  to: string;
  from: { email: string; name: string };
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: string; type: string; disposition: "attachment" }[];
  headers?: Record<string, string>;
}

export type Sender = (message: OutgoingEmail) => Promise<void>;

const MAX_ATTEMPTS = 5;
/** A job that has been claimed this often without finishing (e.g. it crashes the worker) is left alone. */
const MAX_CLAIMS = 8;
const BATCH = 20;
const HOUR = 3600_000;
const KEEP_DONE_MS = 30 * 24 * HOUR;
/** Wait after each failed try: 1, 5, 15, 60 minutes. */
const BACKOFF_MIN = [1, 5, 15, 60];
/** Errors where the same message will fail the same way again (from Cloudflare's documented codes). */
const PERMANENT = new Set([
  "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_RECIPIENT_SUPPRESSED",
  "E_RECIPIENT_NOT_ALLOWED", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS", "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG", "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY",
]);

/** A statement that queues one email. */
export function enqueueEmail(db: D1Database, calendarId: string, kind: EmailKind, payload: EmailPayload, runAt: number): D1PreparedStatement {
  return db.prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at) VALUES (?, ?, ?, ?, ?)")
    .bind(newId("job"), calendarId, kind, JSON.stringify({ ...payload, due: runAt }), runAt);
}

/** Close any reminder still waiting for this appointment (it's being replaced, or the appointment is cancelled). */
const closeReminders = (db: D1Database, calendarId: string, appointmentId: string, now: number) =>
  db.prepare(
    "UPDATE jobs SET done_at = ?, result = 'skipped:replaced' WHERE calendar_id = ? AND kind = 'email.customer.reminder' AND done_at IS NULL AND json_extract(payload, '$.appointment_id') = ?",
  ).bind(now, calendarId, appointmentId);

/**
 * The statements for one booking event (its emails, its Google Calendar update and its webhook event), to run in one `db.batch`.
 * `byCustomer`: true only for the booking page and manage link — the owner isn't emailed about their own actions.
 * `toCustomer`: false when the sending limits say this booking's address shouldn't get email.
 */
export function emailsFor(
  db: D1Database,
  cal: Pick<CalendarRow, "id" | "time_zone" | "notifications">,
  event: "booked" | "changed" | "cancelled",
  appt: { id: string; start_at: number },
  opts: { origin: string; byCustomer: boolean; toCustomer?: boolean; addressKey?: string; now: number },
): D1PreparedStatement[] {
  const payload: EmailPayload = { appointment_id: appt.id, origin: opts.origin };
  const out = [closeReminders(db, cal.id, appt.id, opts.now)];
  const toCustomer = opts.toCustomer !== false;
  if (toCustomer) out.push(enqueueEmail(db, cal.id, `email.customer.${event}`, opts.addressKey ? { ...payload, addr: opts.addressKey } : payload, opts.now));
  if (opts.byCustomer) out.push(enqueueEmail(db, cal.id, `email.owner.${event === "booked" ? "new" : event}`, payload, opts.now));
  if (event !== "cancelled" && toCustomer) {
    const at = reminderAt(appt.start_at, parseNotifications(cal.notifications), cal.time_zone);
    if (at > opts.now) out.push(enqueueEmail(db, cal.id, "email.customer.reminder", { ...payload, start: appt.start_at }, at));
  }
  out.push(googlePushJob(db, cal.id, appt.id, opts.now));
  out.push(webhookJob(db, cal.id, event === "booked" ? "booking.created" : event === "changed" ? "booking.changed" : "booking.cancelled", { appointment_id: appt.id }, opts.now));
  return out;
}

/**
 * Send every email that is due; returns how many jobs it handled. Safe to run from several
 * places at once: a job is claimed by pushing its `run_at` forward in one UPDATE, and only
 * the run that changed the row sends it.
 */
export async function runDueJobs(env: Bindings, now: number, send: Sender, opts: { cleanUp?: boolean } = {}): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    "SELECT id, calendar_id, kind, payload, run_at, attempts FROM jobs WHERE done_at IS NULL AND run_at <= ? AND attempts < ? AND kind LIKE 'email.%' ORDER BY run_at LIMIT ?",
  )
    .bind(now, MAX_CLAIMS, BATCH)
    .all<{ id: string; calendar_id: string; kind: string; payload: string; run_at: number; attempts: number }>();

  let handled = 0;
  for (const job of results) {
    const attempt = job.attempts + 1;
    // Based on the real clock too: a slow run mustn't let the cron re-claim a job mid-send.
    const base = Math.max(now, Date.now());
    const retryAt = base + (BACKOFF_MIN[job.attempts] ?? 60) * 60_000;
    const claim = await db.prepare("UPDATE jobs SET attempts = ?, run_at = ? WHERE id = ? AND done_at IS NULL AND run_at = ?")
      .bind(attempt, retryAt, job.id, job.run_at)
      .run();
    if (!claim.meta.changes) continue; // another run has it
    handled++;

    let result: string | null;
    let payload: EmailPayload | null = null;
    try {
      payload = JSON.parse(job.payload) as EmailPayload;
      const built = await buildEmail(env, job.calendar_id, job.kind as EmailKind, payload, now);
      if ("wait" in built) {
        // Over the calendar's daily limit: try again in an hour, for up to a day, without using up a try.
        if (now - (payload.due ?? job.run_at) < 24 * HOUR) {
          await db.prepare("UPDATE jobs SET attempts = ?, run_at = ? WHERE id = ?").bind(job.attempts, base + HOUR, job.id).run();
          result = null;
        } else result = `skipped:${built.wait}`;
      } else if ("skip" in built) result = `skipped:${built.skip}`;
      else {
        await send(built.message);
        result = "sent";
      }
    } catch (err) {
      let code = String((err as { code?: unknown }).code ?? "unknown");
      if (!payload) result = "failed:bad_payload";
      else if (code === "E_DAILY_LIMIT_EXCEEDED" && now - (payload.due ?? job.run_at) < 24 * HOUR) {
        // The account's daily quota, not this email: try again in an hour without using up a try.
        await db.prepare("UPDATE jobs SET attempts = ?, run_at = ? WHERE id = ?").bind(job.attempts, base + HOUR, job.id).run();
        result = null;
      } else {
        result = PERMANENT.has(code) || attempt >= MAX_ATTEMPTS ? `failed:${code}` : null;
      }
      if (!payload) code = "bad_payload";
      // The code only: Cloudflare's error text can contain the recipient's address.
      console.error(JSON.stringify({ event: "email_failed", job: job.id, kind: job.kind, attempt, code, gave_up: result !== null }));
    }
    if (result !== null) await db.prepare("UPDATE jobs SET done_at = ?, result = ? WHERE id = ?").bind(now, result, job.id).run();
  }

  if (opts.cleanUp) {
    // A job claimed too often without finishing (it crashes the worker) is closed, so it gets cleaned up too.
    await db.prepare("UPDATE jobs SET done_at = ?, result = 'failed:stuck' WHERE done_at IS NULL AND attempts >= ?").bind(now, MAX_CLAIMS).run();
    await db.prepare("DELETE FROM jobs WHERE done_at IS NOT NULL AND done_at < ?").bind(now - KEEP_DONE_MS).run();
  }
  return handled;
}
