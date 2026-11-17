// Turns Stripe's current view of a subscription into our billing row. Called by the webhook and the daily
// reconcile; always with a subscription fetched from Stripe, never an event's copy (events can arrive out of order).
import type { Bindings } from "../types";
import { planForPrice } from "./config";
import { sendOperatorEmail } from "./emails";
import { isPaid, LIVE_STATUSES } from "./entitlements";
import { stripe } from "./stripe";
import { accountCalendars, ensureBillingRow, getBilling } from "./store";
import { googlePushMany } from "../google/push";

export const GRACE_MS = 30 * 86_400_000;

export type StripeSub = {
  id: string; customer: string; status: string; cancel_at_period_end: boolean; trial_end: number | null; created: number;
  metadata?: Record<string, string>;
  items: { data: { price: { id: string }; current_period_end: number }[] };
};

export async function syncSubscription(env: Bindings, userId: string, subscriptionId: string, now: number): Promise<void> {
  const sub = await stripe<StripeSub>(env, "GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  await applySubscription(env, userId, sub, now);
}

async function hadRealPayment(env: Bindings, subscriptionId: string): Promise<boolean> {
  const { data } = await stripe<{ data: { amount_paid: number }[] }>(env, "GET", "/v1/invoices", { subscription: subscriptionId, status: "paid", limit: 10 });
  return data.some((i) => i.amount_paid > 0);
}

/**
 * Drop-to-Free side effects. Busy times from Google would go stale while sync is paused, so they're removed, and
 * busy_hash is cleared so the first sync after an upgrade rewrites them (syncBusy skips the write when the hash is unchanged).
 */
async function droppedToFree(env: Bindings, userId: string): Promise<void> {
  const cals = await accountCalendars(env.DB, userId);
  if (!cals.length) return;
  await env.DB.batch(cals.flatMap((c) => [
    env.DB.prepare("DELETE FROM google_busy WHERE calendar_id = ?").bind(c.id),
    env.DB.prepare("UPDATE google_connections SET busy_hash = NULL WHERE calendar_id = ?").bind(c.id),
  ]));
}

/** Free → paid: bookings made while Google was paused are pushed now (push jobs were closed as skipped:plan). */
async function becamePaid(env: Bindings, userId: string, now: number): Promise<void> {
  const cals = await accountCalendars(env.DB, userId);
  if (cals.length) await env.DB.batch(cals.map((c) => googlePushMany(env.DB, c.id, now, { upcoming: true })));
}

export async function applySubscription(env: Bindings, userId: string, sub: StripeSub, now: number): Promise<void> {
  const db = env.DB;
  await ensureBillingRow(db, userId, now);
  let prev = (await getBilling(db, userId))!;
  // A subscription from a different Stripe customer is never attached (the customer link is ours; metadata is not proof).
  if (prev.stripe_customer_id && prev.stripe_customer_id !== sub.customer) {
    console.error(JSON.stringify({ event: "billing_customer_mismatch", subscription: sub.id }));
    return;
  }
  const incomingLive = LIVE_STATUSES.has(sub.status);
  if (prev.stripe_subscription_id && prev.stripe_subscription_id !== sub.id && LIVE_STATUSES.has(prev.status)) {
    // Our copy may be stale (events arrive in any order): ask Stripe about the stored subscription first.
    const stored = await stripe<StripeSub>(env, "GET", `/v1/subscriptions/${encodeURIComponent(prev.stripe_subscription_id)}`);
    if (LIVE_STATUSES.has(stored.status)) {
      if (incomingLive) {
        // Two genuinely live subscriptions (two checkouts at once). Keep the stored one; a person refunds the other.
        await sendOperatorEmail(env, "Duplicate subscription", `Account ${userId} has a second live subscription ${sub.id} (kept ${prev.stripe_subscription_id}). Cancel and refund it in the Stripe Dashboard.`);
      }
      return; // an event for an older or extra subscription never overwrites the live one
    }
    await applySubscription(env, userId, stored, now); // record that the stored one ended, then carry on with this one
    prev = (await getBilling(db, userId))!;
  }

  const item = sub.items.data[0];
  const priced = item ? planForPrice(env, item.price.id) : null;
  if (!priced) {
    console.error(JSON.stringify({ event: "billing_unknown_price", subscription: sub.id }));
    return;
  }
  const wasPaid = isPaid(prev, now);
  let graceUntil = prev.grace_until;
  let graceSub = prev.grace_subscription_id;
  let checkin = prev.grace_checkin_sent;
  let reminder = prev.grace_reminder_sent;
  if (incomingLive) {
    graceUntil = null;
    checkin = 0;
    reminder = 0;
  } else if (sub.status === "canceled" && priced.plan === "white_label" && graceSub !== sub.id && (await hadRealPayment(env, sub.id))) {
    graceUntil = now + GRACE_MS;
    graceSub = sub.id;
    checkin = 0;
    reminder = 0;
  }

  await db.prepare(
    `UPDATE billing SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, interval = ?, status = ?, current_period_end = ?,
       cancel_at_period_end = ?, trial_used = MAX(trial_used, ?), trial_end = ?, grace_until = ?, grace_subscription_id = ?,
       grace_checkin_sent = ?, grace_reminder_sent = ?, updated_at = ? WHERE user_id = ?`,
  ).bind(
    sub.customer, sub.id, priced.plan, priced.interval, sub.status, item.current_period_end * 1000,
    sub.cancel_at_period_end ? 1 : 0, sub.trial_end ? 1 : 0, sub.trial_end ? sub.trial_end * 1000 : null,
    graceUntil, graceSub, checkin, reminder, now, userId,
  ).run();

  const nowPaid = isPaid({ plan: priced.plan, status: sub.status, grace_until: graceUntil }, now);
  if (wasPaid && !nowPaid) await droppedToFree(env, userId);
  if (!wasPaid && nowPaid) await becamePaid(env, userId, now);
}

export { droppedToFree };
