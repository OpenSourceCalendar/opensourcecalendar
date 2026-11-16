// Booking events for host apps. Booking actions add `webhook.deliver` jobs (webhooks/job.ts, only when the
// app has a webhook address); runWebhookJobs sends them, signed, and retries until the receiver answers 2xx.
// Bodies are built from the records as they are when sent, like emails.
import { appointmentJson, getAppointmentFull } from "../booking/book";
import { customerJson, type CustomerRow } from "../routes/customers";
import type { Bindings } from "../types";
import type { WebhookType } from "./job";
import { signBody, webhookSecret } from "./secret";

// The shared clean-up (runDueJobs) closes any job claimed 8 times, so stay under it, as Google pushes do.
const MAX_ATTEMPTS = 7;
const MAX_CLAIMS = 8;
const BATCH = 25;
const BACKOFF_MIN = [1, 5, 15, 60];
/** Stop claiming after this long; sends run side by side, each capped at SEND_TIMEOUT_MS. */
const RUN_BUDGET_MS = 15_000;
const SEND_TIMEOUT_MS = 5_000;

type Payload = { type: WebhookType; appointment_id?: string; customer_id?: string; external_ref?: string | null; at: number };
type Job = { id: string; calendar_id: string; payload: string; run_at: number; attempts: number };

type Target = { url: string; appId: string; version: number };

async function targetFor(db: D1Database, calendarId: string) {
  return db.prepare(
    `SELECT c.id, c.external_user_id, c.slug, a.id AS app_id, a.webhook_url, a.webhook_secret_version
     FROM calendars c JOIN apps a ON a.id = c.app_id WHERE c.id = ?`,
  ).bind(calendarId).first<{ id: string; external_user_id: string; slug: string; app_id: string; webhook_url: string | null; webhook_secret_version: number }>();
}

/** The request to send for one event, or why not. */
export async function buildEvent(db: D1Database, id: string, calendarId: string, p: Payload): Promise<(Target & { body: string }) | { skip: string }> {
  const row = await targetFor(db, calendarId);
  if (!row) return { skip: "no_calendar" };
  if (!row.webhook_url) return { skip: "no_webhook" };
  let data: Record<string, unknown> = {};
  if (p.type === "customer.deleted") {
    data = { customer: { id: p.customer_id, external_ref: p.external_ref ?? null } };
  } else if (p.appointment_id) {
    const appt = await getAppointmentFull(db, calendarId, p.appointment_id);
    if (!appt) return { skip: "gone" };
    data = { appointment: appointmentJson(appt) };
  } else if (p.customer_id) {
    // Deleted since: send nothing, so a late customer.created can't bring back a record the receiver erased.
    const cus = await db.prepare("SELECT * FROM customers WHERE id = ? AND calendar_id = ? AND deleted_at IS NULL").bind(p.customer_id, calendarId).first<CustomerRow>();
    if (!cus) return { skip: "gone" };
    data = { customer: customerJson(cus) };
  }
  const body = JSON.stringify({
    id, type: p.type, created_at: new Date(p.at).toISOString(),
    calendar: { id: row.id, external_user_id: row.external_user_id, slug: row.slug }, data,
  });
  return { url: row.webhook_url, appId: row.app_id, version: row.webhook_secret_version, body };
}

/** POST one signed event. Returns the HTTP status, or 0 for a network error or timeout. */
export async function sendEvent(env: Bindings, target: Target & { body: string }): Promise<number> {
  const t = Math.floor(Date.now() / 1000);
  const sig = await signBody(await webhookSecret(env, target.appId, target.version), t, target.body);
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "BookingCalendar-Webhook/1", "X-Calendar-Signature": `t=${t},v1=${sig}` },
      body: target.body,
      redirect: "manual", // a redirect isn't a delivery, and mustn't carry the body somewhere else
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel(); // replies aren't read
    return res.status;
  } catch {
    return 0;
  }
}

async function deliver(env: Bindings, job: Job, attempt: number, now: number): Promise<void> {
  const db = env.DB;
  let result: string | null = null;
  let payload: Payload | null = null;
  try {
    payload = JSON.parse(job.payload) as Payload;
  } catch {
    result = "failed:bad_payload";
  }
  if (payload) {
    try {
      const built = await buildEvent(db, job.id, job.calendar_id, payload);
      if ("skip" in built) result = `skipped:${built.skip}`;
      else {
        const status = await sendEvent(env, built);
        if (status >= 200 && status < 300) result = "done";
        // 410 Gone is the one answer that means "stop". Anything else (a 401 mid-rotation, a 404 or 502
        // during their deploy) may work next time.
        else if (status === 410) result = "failed:410";
        else result = attempt >= MAX_ATTEMPTS ? `failed:${status || "network"}` : null;
      }
    } catch {
      // Our side failed (a database hiccup): try again later, like a failed send.
      result = attempt >= MAX_ATTEMPTS ? "failed:error" : null;
    }
  }
  // Guarded: a DELETE /webhook while this was sending has already closed the job; keep its result.
  // A finished customer.deleted doesn't keep the erased customer's outside reference around.
  if (result !== null) {
    await db.prepare("UPDATE jobs SET done_at = ?, result = ?, payload = json_remove(payload, '$.external_ref') WHERE id = ? AND done_at IS NULL").bind(now, result, job.id).run();
  }
}

export async function runWebhookJobs(env: Bindings, now: number): Promise<number> {
  const db = env.DB;
  const began = Date.now();
  const { results } = await db.prepare(
    "SELECT id, calendar_id, payload, run_at, attempts FROM jobs WHERE done_at IS NULL AND kind = 'webhook.deliver' AND run_at <= ? AND attempts < ? ORDER BY run_at LIMIT ?",
  ).bind(now, MAX_CLAIMS, BATCH).all<Job>();
  const sends: Promise<void>[] = [];
  for (const job of results) {
    if (Date.now() - began > RUN_BUDGET_MS) break;
    const retryAt = Math.max(now, Date.now()) + (BACKOFF_MIN[job.attempts] ?? 60) * 60_000;
    const claim = await db.prepare("UPDATE jobs SET attempts = ?, run_at = ? WHERE id = ? AND done_at IS NULL AND run_at = ?")
      .bind(job.attempts + 1, retryAt, job.id, job.run_at).run();
    if (!claim.meta.changes) continue; // another run has it
    // Side by side: one slow receiver can't hold up everyone else's events.
    sends.push(deliver(env, job, job.attempts + 1, now));
  }
  await Promise.allSettled(sends);
  return sends.length;
}
