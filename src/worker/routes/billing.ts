// Billing for hosted accounts: plan status, starting a Stripe Checkout, opening the Stripe billing portal, and the
// webhook. Owner routes 404 unless billing is on and the session is a hosted account.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { publicBase } from "../accounts/config";
import { HOSTED_APP, requireCalendar } from "../auth";
import { billingOn, priceFor } from "../billing/config";
import { FREE_MONTHLY_EMAIL_BOOKINGS, isPaid, LIVE_STATUSES } from "../billing/entitlements";
import { bookingsThisMonth } from "../billing/limit";
import { billingByCustomer, ensureBillingRow, getBilling, userEmail } from "../billing/store";
import { stripe, StripeError, verifyStripeSignature } from "../billing/stripe";
import { sendOperatorEmail } from "../billing/emails";
import { syncSubscription } from "../billing/sync";
import { parseBody } from "../lib/http";
import type { AppEnv } from "../types";

export const billing = new Hono<AppEnv>();

const HOUR = 3_600_000;
const CHECKOUTS_PER_HOUR = 5;
// Tags our sessions in the Stripe Dashboard (Stripe asks for a label with an 8-letter suffix).
const INTEGRATION_ID = "osc-plan-checkout-qvbmtrzk";

billing.use("*", async (c, next) => {
  if (!billingOn(c.env) || c.var.app.id !== HOSTED_APP) {
    return c.req.method === "GET" && c.req.path.endsWith("/billing") ? c.json({ enabled: false }) : c.json({ error: "not_found" }, 404);
  }
  await next();
});

billing.get("/", requireCalendar, async (c) => {
  const now = Date.now();
  const row = await getBilling(c.env.DB, c.var.userId);
  const paid = isPaid(row, now);
  return c.json({
    enabled: true,
    plan: paid ? row!.plan : "free",
    status: row?.status ?? "none",
    interval: row?.interval ?? null,
    paid,
    trial_available: !row?.trial_used,
    trial_end: row?.trial_end ? new Date(row.trial_end).toISOString() : null,
    current_period_end: row?.current_period_end ? new Date(row.current_period_end).toISOString() : null,
    cancel_at_period_end: !!row?.cancel_at_period_end,
    grace_until: row?.grace_until && row.grace_until > now ? new Date(row.grace_until).toISOString() : null,
    has_customer: !!row?.stripe_customer_id,
    bookings_this_month: await bookingsThisMonth(c.env.DB, c.var.calendar, now),
    monthly_limit: paid ? null : FREE_MONTHLY_EMAIL_BOOKINGS,
  });
});

const CheckoutBody = z.object({ plan: z.enum(["pro", "white_label"]), interval: z.enum(["month", "year"]) }).strict();

billing.post("/checkout", async (c) => {
  const body = await parseBody(c, CheckoutBody);
  if (!body.ok) return body.response;
  const env = c.env;
  const db = env.DB;
  const userId = c.var.userId;
  const now = Date.now();
  await ensureBillingRow(db, userId, now);

  // Rate limit, so checkout can't be used to test stolen cards.
  const row = (await getBilling(db, userId))!;
  const recent = (JSON.parse(row.checkout_attempts) as number[]).filter((t) => t > now - HOUR);
  if (recent.length >= CHECKOUTS_PER_HOUR) return c.json({ error: "too_many_attempts" }, 429);
  // Claimed only if no other request changed the list since we read it, so two at once can't both reach Stripe.
  const claim = await db.prepare("UPDATE billing SET checkout_attempts = ?, updated_at = ? WHERE user_id = ? AND checkout_attempts = ?")
    .bind(JSON.stringify([...recent, now]), now, userId, row.checkout_attempts).run();
  if (!claim.meta.changes) return c.json({ error: "checkout_in_progress" }, 409);

  try {
    let customer = row.stripe_customer_id;
    if (!customer) {
      const created = await stripe<{ id: string }>(env, "POST", "/v1/customers", { email: await userEmail(db, userId), metadata: { user_id: userId } }, `customer-${userId}`);
      customer = created.id;
      await db.prepare("UPDATE billing SET stripe_customer_id = ? WHERE user_id = ? AND stripe_customer_id IS NULL").bind(customer, userId).run();
      customer = (await getBilling(db, userId))!.stripe_customer_id!;
    }
    // Ask Stripe, not our table (it fills in only after the webhook): a live subscription changes plan in the portal.
    const subs = await stripe<{ data: { status: string }[] }>(env, "GET", "/v1/subscriptions", { customer, status: "all", limit: 20 });
    if (subs.data.some((s) => LIVE_STATUSES.has(s.status) || s.status === "incomplete" || s.status === "unpaid" || s.status === "paused")) {
      return c.json({ error: "already_subscribed" }, 409);
    }
    // One open checkout per account, so two tabs can't finish two subscriptions.
    const open = await stripe<{ data: { id: string }[] }>(env, "GET", "/v1/checkout/sessions", { customer, status: "open", limit: 20 });
    for (const s of open.data) await stripe(env, "POST", `/v1/checkout/sessions/${s.id}/expire`);

    const base = publicBase(env);
    const session = await stripe<{ url: string }>(env, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: userId,
      line_items: [{ price: priceFor(env, body.data.plan, body.data.interval), quantity: 1 }],
      subscription_data: { metadata: { user_id: userId }, ...(row.trial_used ? {} : { trial_period_days: 14 }) },
      payment_method_collection: "always",
      automatic_tax: { enabled: true },
      customer_update: { address: "auto" },
      billing_address_collection: "required",
      success_url: `${base}/admin/plan?checkout=done`,
      cancel_url: `${base}/admin/plan`,
      integration_identifier: INTEGRATION_ID,
    }, `checkout-${userId}-${now}`);
    return c.json({ url: session.url });
  } catch (err) {
    if (err instanceof StripeError) {
      console.error(JSON.stringify({ event: "billing_checkout_failed", code: err.code, status: err.status }));
      return c.json({ error: "stripe_unavailable" }, 502);
    }
    throw err;
  }
});

billing.post("/portal", async (c) => {
  const row = await getBilling(c.env.DB, c.var.userId);
  if (!row?.stripe_customer_id) return c.json({ error: "no_customer" }, 409);
  try {
    const session = await stripe<{ url: string }>(c.env, "POST", "/v1/billing_portal/sessions", {
      customer: row.stripe_customer_id, return_url: `${publicBase(c.env)}/admin/plan`,
    });
    return c.json({ url: session.url });
  } catch (err) {
    if (err instanceof StripeError) return c.json({ error: "stripe_unavailable" }, 502);
    throw err;
  }
});

type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };
const SUB_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.trial_will_end"]);

/** POST /api/billing/webhook — no session; Stripe's signature is the only way in. */
export async function billingWebhook(c: Context<AppEnv>) {
  const env = c.env;
  if (!billingOn(env)) return c.json({ error: "not_found" }, 404);
  const raw = await c.req.text(); // the exact bytes Stripe signed; never re-serialize
  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET!, c.req.header("Stripe-Signature") ?? "", raw, Date.now()))) {
    return c.json({ error: "bad_signature" }, 400);
  }
  const event = JSON.parse(raw) as StripeEvent;
  const now = Date.now();
  const seen = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").bind(event.id, event.type, now).run();
  if (!seen.meta.changes) return c.json({ received: true }); // already handled

  try {
    const o = event.data.object;
    if (event.type === "charge.dispute.created") {
      const amount = typeof o.amount === "number" ? `${(o.amount / 100).toFixed(2)} ${String(o.currency ?? "").toUpperCase()}` : "unknown amount";
      await sendOperatorEmail(env, "A customer opened a dispute", `Dispute ${String(o.id)} on charge ${String(o.charge)} for ${amount}. https://dashboard.stripe.com/disputes/${encodeURIComponent(String(o.id))}`);
      return c.json({ received: true });
    }
    let subscriptionId: string | null = null;
    let customer: string | null = null;
    let userId: string | null = null;
    if (SUB_EVENTS.has(event.type)) {
      subscriptionId = String(o.id);
      customer = String(o.customer);
      userId = (o.metadata as Record<string, string> | undefined)?.user_id ?? null;
    } else if (event.type === "checkout.session.completed") {
      subscriptionId = typeof o.subscription === "string" ? o.subscription : null;
      customer = String(o.customer);
      userId = typeof o.client_reference_id === "string" ? o.client_reference_id : null;
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const parent = o.parent as { subscription_details?: { subscription?: string } } | undefined;
      subscriptionId = parent?.subscription_details?.subscription ?? null;
      customer = String(o.customer);
    }
    if (!subscriptionId) return c.json({ received: true });
    // Trust our own customer → account link over metadata; metadata is only a fallback for the first event.
    const byCustomer = customer ? await billingByCustomer(env.DB, customer) : null;
    const account = byCustomer?.user_id ?? userId;
    if (!account || !(await env.DB.prepare("SELECT 1 AS ok FROM users WHERE id = ?").bind(account).first())) {
      console.warn(JSON.stringify({ event: "billing_unknown_account", type: event.type }));
      return c.json({ received: true });
    }
    await syncSubscription(env, account, subscriptionId, now);
    return c.json({ received: true });
  } catch (err) {
    // Forget the event so Stripe's retry is processed.
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = ?").bind(event.id).run();
    console.error(JSON.stringify({ event: "billing_webhook_failed", type: event.type, error: String(err).slice(0, 200) }));
    return c.json({ error: "retry" }, 500);
  }
}
