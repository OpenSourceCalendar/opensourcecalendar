import type { Context } from "hono";
import type { AppEnv } from "../types";
import { runDueJobs } from "./outbox";
import { sendWith } from "./send";
import { runGoogleJobs } from "../google/push";
import { runWebhookJobs } from "../webhooks/outbox";

/**
 * Queue emails right after a booking write, then start sending in the background so a
 * confirmation arrives within seconds. A failure here never fails the booking: it's
 * already saved and the customer has their link on screen. The loss is logged.
 */
export async function queueEmails(
  c: Context<AppEnv>,
  appointmentId: string,
  /** Builds the statements. Runs inside the try: limit lookups and re-reads can fail too, and must not fail the booking. */
  build: () => D1PreparedStatement[] | Promise<D1PreparedStatement[]>,
): Promise<void> {
  try {
    const statements = await build();
    if (!statements.length) return;
    await c.env.DB.batch(statements);
  } catch {
    console.error(JSON.stringify({ event: "email_enqueue_failed", appointment: appointmentId }));
    return;
  }
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    // No execution context (tests call the app directly): the cron sends it instead.
  }
  ctx?.waitUntil(Promise.all([
    runDueJobs(c.env, Date.now(), sendWith(c.env)).catch((err) => console.error(JSON.stringify({ event: "email_run_failed", error: String(err).slice(0, 200) }))),
    runGoogleJobs(c.env, Date.now()).catch((err) => console.error(JSON.stringify({ event: "google_run_failed", error: String(err).slice(0, 200) }))),
    runWebhookJobs(c.env, Date.now()).catch((err) => console.error(JSON.stringify({ event: "webhook_run_failed", error: String(err).slice(0, 200) }))),
  ]));
}

/** Where the request came from, for links in emails. */
export const originOf = (c: Context) => new URL(c.req.url).origin;
