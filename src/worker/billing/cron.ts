// Every minute from the cron: White-label grace emails and its end, the daily reconcile with Stripe, cleanup.
import { publicBase } from "../accounts/config";
import { enqueueEmail } from "../email/outbox";
import type { Bindings } from "../types";
import { billingOn } from "./config";
import { accountCalendars } from "./store";
import { stripe } from "./stripe";
import { applySubscription, droppedToFree, syncSubscription, type StripeSub } from "./sync";

const DAY = 86_400_000;
const REMIND_BEFORE = 7 * DAY;
/** Once a day, from 10:00 UTC (about 2–3 AM in the US); a late or skipped cron tick still runs it that day. */
export const isReconcileMinute = (now: number) => new Date(now).getUTCHours() >= 10;

async function graceEmail(env: Bindings, userId: string, kind: "email.account.grace_start" | "email.account.grace_end", until: number, now: number) {
  const cal = (await accountCalendars(env.DB, userId))[0];
  if (!cal) return;
  await enqueueEmail(env.DB, cal.id, kind, { appointment_id: "", origin: publicBase(env), user_id: userId, until }, now).run();
}

export async function runBillingCron(env: Bindings, now: number): Promise<void> {
  if (!billingOn(env)) return;
  const db = env.DB;
  const { results } = await db.prepare("SELECT user_id, grace_until, grace_checkin_sent, grace_reminder_sent FROM billing WHERE grace_until IS NOT NULL")
    .all<{ user_id: string; grace_until: number; grace_checkin_sent: number; grace_reminder_sent: number }>();
  for (const g of results) {
    if (g.grace_until <= now) {
      // Grace is over (entitlements already say Free); tidy the row and run the drop-to-Free side effects, in one
      // batch. The side effects come first and only while grace_until is still this value, so they run once.
      const still = "EXISTS (SELECT 1 FROM billing WHERE user_id = ? AND grace_until = ?)";
      await db.batch([
        ...droppedToFree(db, await accountCalendars(db, g.user_id), still, g.user_id, g.grace_until),
        db.prepare("UPDATE billing SET grace_until = NULL, updated_at = ? WHERE user_id = ? AND grace_until = ?").bind(now, g.user_id, g.grace_until),
      ]);
      continue;
    }
    // Each email is claimed by flipping its flag first, so overlapping cron runs send it once.
    if (!g.grace_checkin_sent) {
      const claim = await db.prepare("UPDATE billing SET grace_checkin_sent = 1 WHERE user_id = ? AND grace_checkin_sent = 0").bind(g.user_id).run();
      if (claim.meta.changes) await graceEmail(env, g.user_id, "email.account.grace_start", g.grace_until, now);
    }
    if (!g.grace_reminder_sent && g.grace_until - now <= REMIND_BEFORE) {
      const claim = await db.prepare("UPDATE billing SET grace_reminder_sent = 1 WHERE user_id = ? AND grace_reminder_sent = 0").bind(g.user_id).run();
      if (claim.meta.changes) await graceEmail(env, g.user_id, "email.account.grace_end", g.grace_until, now);
    }
  }

  const today = new Date(now).toISOString().slice(0, 10);
  // Claim today's reconcile in one statement, so overlapping cron runs do it once. The marker lives in stripe_events
  // (id 'reconcile:<date>'), which the cleanup below clears after 30 days.
  const claimed = isReconcileMinute(now) && (await db.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, 'reconcile', ?)").bind(`reconcile:${today}`, now).run()).meta.changes;
  if (claimed) {
    // Skips subscriptions that ended for good (canceled is final in Stripe) once any grace is over.
    const rows = await db.prepare(
      `SELECT user_id, stripe_customer_id, stripe_subscription_id FROM billing
       WHERE (stripe_subscription_id IS NOT NULL OR stripe_customer_id IS NOT NULL)
         AND NOT (status IN ('canceled', 'incomplete_expired') AND COALESCE(grace_until, 0) <= ?)`,
    ).bind(now).all<{ user_id: string; stripe_customer_id: string | null; stripe_subscription_id: string | null }>();
    for (const s of rows.results) {
      try {
        if (s.stripe_subscription_id) {
          await syncSubscription(env, s.user_id, s.stripe_subscription_id, now);
        } else {
          // A customer with no subscription on our side: every webhook for it may have been missed. Take the newest.
          const { data } = await stripe<{ data: StripeSub[] }>(env, "GET", "/v1/subscriptions", { customer: s.stripe_customer_id, status: "all", limit: 5 });
          const newest = data.sort((a, b) => b.created - a.created)[0];
          if (newest) await applySubscription(env, s.user_id, newest, now);
        }
      } catch (err) {
        console.error(JSON.stringify({ event: "billing_reconcile_failed", user: s.user_id, error: String(err).slice(0, 200) }));
      }
    }
  }
  await db.prepare("DELETE FROM stripe_events WHERE received_at < ?").bind(now - 30 * DAY).run();
}
