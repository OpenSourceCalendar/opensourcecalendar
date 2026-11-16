// The statements that queue webhook events. Kept apart from the runner so booking and customer code can
// import it without an import cycle.
import { newId } from "../lib/ids";

export type WebhookType = "booking.created" | "booking.changed" | "booking.cancelled" | "customer.created" | "customer.deleted" | "ping";

/** Only when the calendar's app has a webhook address. The job id is the event id (evt_…), stable across retries. */
const HAS_WEBHOOK = "EXISTS (SELECT 1 FROM calendars c JOIN apps a ON a.id = c.app_id WHERE c.id = ?2 AND a.webhook_url IS NOT NULL)";

export function webhookJob(
  db: D1Database, calendarId: string, type: WebhookType, ref: { appointment_id?: string; customer_id?: string }, now: number,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO jobs (id, calendar_id, kind, payload, run_at) SELECT ?1, ?2, 'webhook.deliver', ?3, ?4 WHERE ${HAS_WEBHOOK}`)
    .bind(newId("evt"), calendarId, JSON.stringify({ type, ...ref, at: now }), now);
}

/**
 * customer.deleted carries only ids, captured before the erase (run it first in the erase batch): the
 * customer's details are gone by the time it's sent, and the receiver only needs to know which record to drop.
 */
export function customerDeletedJob(db: D1Database, calendarId: string, customerId: string, now: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO jobs (id, calendar_id, kind, payload, run_at)
     SELECT ?1, ?2, 'webhook.deliver', json_object('type', 'customer.deleted', 'customer_id', ?3, 'external_ref', cu.external_ref, 'at', ?4), ?4
     FROM customers cu WHERE cu.id = ?3 AND cu.calendar_id = ?2 AND cu.deleted_at IS NULL AND ${HAS_WEBHOOK}`,
  ).bind(newId("evt"), calendarId, customerId, now);
}
