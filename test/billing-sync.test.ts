import { describe, it, expect, vi, afterEach } from "vitest";
import { applySubscription, syncSubscription } from "../src/worker/billing/sync";
import { getBilling } from "../src/worker/billing/store";
import { isPaid } from "../src/worker/billing/entitlements";
import { billingEnv, FakeStripe, hostedAccount, setBilling } from "./stripe-fake";
import { connectForTest } from "./google-fake";

afterEach(() => vi.restoreAllMocks());
const DAY = 86_400_000;

async function setup() {
  const env = billingEnv({ EMAIL: { send: vi.fn(async () => {}) } });
  const fake = new FakeStripe();
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
  const a = await hostedAccount(env);
  await setBilling(env, a.userId, { stripe_customer_id: `cus_${a.userId}` });
  return { env, fake, a };
}

describe("syncSubscription", () => {
  it("saves a trial: plan, interval, status, period end, trial used", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_year", status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 14 * 86400, metadata: { user_id: a.userId } });
    await syncSubscription(env, a.userId, sub.id, Date.now());
    const row = (await getBilling(env.DB, a.userId))!;
    expect(row).toMatchObject({ stripe_subscription_id: sub.id, plan: "pro", interval: "year", status: "trialing", trial_used: 1 });
    expect(row.current_period_end).toBe(sub.items.data[0].current_period_end * 1000);
  });

  it("a stray event for an old, ended subscription doesn't overwrite the live one", async () => {
    const { env, fake, a } = await setup();
    const old = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "canceled" });
    const live = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active" });
    await syncSubscription(env, a.userId, live.id, Date.now());
    await syncSubscription(env, a.userId, old.id, Date.now());
    expect((await getBilling(env.DB, a.userId))!.stripe_subscription_id).toBe(live.id);
  });

  it("a new subscription is saved even if the old one's 'deleted' event hasn't arrived yet", async () => {
    const { env, fake, a } = await setup();
    const a1 = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active" });
    await syncSubscription(env, a.userId, a1.id, Date.now());
    a1.status = "canceled"; // Stripe knows; our row still says active
    const b = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "trialing" });
    await syncSubscription(env, a.userId, b.id, Date.now());
    expect(await getBilling(env.DB, a.userId)).toMatchObject({ stripe_subscription_id: b.id, status: "trialing" });
    expect((env.EMAIL as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it("never attaches a subscription from another Stripe customer", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: "cus_someone_else", price: "price_pro_month", status: "active" });
    await syncSubscription(env, a.userId, sub.id, Date.now());
    expect((await getBilling(env.DB, a.userId))!.stripe_subscription_id).toBeNull();
  });

  it("downgrade clears busy_hash so re-upgrading rewrites Google busy times", async () => {
    const { env, fake, a } = await setup();
    await connectForTest(a.calendarId);
    await env.DB.prepare("UPDATE google_connections SET busy_hash = 'h' WHERE calendar_id = ?").bind(a.calendarId).run();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active" });
    await syncSubscription(env, a.userId, sub.id, Date.now());
    sub.status = "canceled";
    await syncSubscription(env, a.userId, sub.id, Date.now());
    expect((await env.DB.prepare("SELECT busy_hash FROM google_connections WHERE calendar_id = ?").bind(a.calendarId).first<{ busy_hash: string | null }>())!.busy_hash).toBeNull();
  });

  it("a second live subscription is not saved and the operator is emailed", async () => {
    const { env, fake, a } = await setup();
    const first = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active" });
    const second = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_month", status: "trialing" });
    await syncSubscription(env, a.userId, first.id, Date.now());
    await syncSubscription(env, a.userId, second.id, Date.now());
    expect((await getBilling(env.DB, a.userId))!.stripe_subscription_id).toBe(first.id);
    expect((env.EMAIL as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(expect.objectContaining({ to: "support@example.test" }));
  });

  it("Pro cancelled: Free at once, no grace, Google busy times removed", async () => {
    const { env, fake, a } = await setup();
    await env.DB.prepare("INSERT INTO google_busy (calendar_id, google_event_id, start_at, end_at) VALUES (?, 'e1', 1, 2)").bind(a.calendarId).run();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active" });
    await syncSubscription(env, a.userId, sub.id, Date.now());
    sub.status = "canceled";
    await syncSubscription(env, a.userId, sub.id, Date.now());
    const row = (await getBilling(env.DB, a.userId))!;
    expect(row.status).toBe("canceled");
    expect(row.grace_until).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM google_busy WHERE calendar_id = ?").bind(a.calendarId).first<{ n: number }>())!.n).toBe(0);
  });

  it("White-label that paid at least once gets 30 days of grace, once per subscription", async () => {
    const { env, fake, a } = await setup();
    const now = Date.now();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_month", status: "active" });
    fake.invoices.push({ subscription: sub.id, amount_paid: 5000, status: "paid" });
    await syncSubscription(env, a.userId, sub.id, now);
    sub.status = "canceled";
    await syncSubscription(env, a.userId, sub.id, now);
    let row = (await getBilling(env.DB, a.userId))!;
    expect(row.grace_until).toBe(now + 30 * DAY);
    expect(row.grace_subscription_id).toBe(sub.id);
    await syncSubscription(env, a.userId, sub.id, now + DAY); // re-delivered: grace doesn't restart
    row = (await getBilling(env.DB, a.userId))!;
    expect(row.grace_until).toBe(now + 30 * DAY);
  });

  it("a White-label trial cancelled before any payment gets no grace ($0 trial invoice doesn't count)", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_month", status: "canceled", trial_end: Math.floor(Date.now() / 1000) });
    fake.invoices.push({ subscription: sub.id, amount_paid: 0, status: "paid" });
    await syncSubscription(env, a.userId, sub.id, Date.now());
    expect((await getBilling(env.DB, a.userId))!.grace_until).toBeNull();
  });

  it("resubscribing clears the grace email flags but keeps grace_subscription_id", async () => {
    const { env, fake, a } = await setup();
    await setBilling(env, a.userId, { plan: "white_label", status: "canceled", grace_until: Date.now() + DAY, grace_subscription_id: "sub_old", grace_checkin_sent: 1 });
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_month", status: "active" });
    await applySubscription(env, a.userId, sub, Date.now());
    expect(await getBilling(env.DB, a.userId)).toMatchObject({ grace_until: null, grace_checkin_sent: 0, grace_subscription_id: "sub_old", status: "active" });
  });

  it("an unknown price still saves the status: a cancelled subscription on an old price ends paid access", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active" });
    await syncSubscription(env, a.userId, sub.id, Date.now());
    sub.items.data[0].price.id = "price_retired";
    sub.status = "canceled";
    sub.cancel_at_period_end = true;
    await syncSubscription(env, a.userId, sub.id, Date.now());
    const row = (await getBilling(env.DB, a.userId))!;
    expect(row).toMatchObject({ status: "canceled", plan: "pro", interval: "month", cancel_at_period_end: 1 });
    expect(isPaid(row, Date.now())).toBe(false);
  });

  it("an unknown price on a Free account stays Free", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_retired", status: "active" });
    await syncSubscription(env, a.userId, sub.id, Date.now());
    const row = (await getBilling(env.DB, a.userId))!;
    expect(row).toMatchObject({ stripe_subscription_id: sub.id, status: "active", plan: "free" });
    expect(isPaid(row, Date.now())).toBe(false);
  });

  it("becoming paid also brings bookings already in Google up to date (cancelled while Free)", async () => {
    const { env, fake, a } = await setup();
    await connectForTest(a.calendarId);
    const svc = `svc_${crypto.randomUUID()}`;
    const cus = `cus_${crypto.randomUUID()}`;
    const apt = `apt_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO services (id, calendar_id, name, duration_min, color, location_type, created_at) VALUES (?, ?, 'Call', 30, '#2d6a4f', 'business', 0)").bind(svc, a.calendarId),
      env.DB.prepare("INSERT INTO customers (id, calendar_id, first_name, email, created_at) VALUES (?, ?, 'Ann', 'ann@example.test', 0)").bind(cus, a.calendarId),
      env.DB.prepare(`INSERT INTO appointments (id, calendar_id, service_id, customer_id, start_at, end_at, status, source, manage_token_hash, created_at, updated_at, google_event_id)
        VALUES (?, ?, ?, ?, ?, ?, 'cancelled', 'booking_page', ?, 0, 0, 'ev1')`).bind(apt, a.calendarId, svc, cus, Date.now() + DAY, Date.now() + DAY + 1_800_000, apt),
    ]);
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active" });
    await syncSubscription(env, a.userId, sub.id, Date.now());
    const job = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE calendar_id = ? AND kind = 'google.push' AND payload = ?")
      .bind(a.calendarId, JSON.stringify({ appointment_id: apt })).first<{ n: number }>();
    expect(job!.n).toBe(1);
  });

  it("a late event for an older ended subscription doesn't touch the newer one's grace", async () => {
    const { env, fake, a } = await setup();
    const now = Date.now();
    const older = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_month", status: "canceled", created: Math.floor(now / 1000) - 90 * 86400 });
    const newer = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_month", status: "canceled", created: Math.floor(now / 1000) - 10 * 86400 });
    fake.invoices.push({ subscription: older.id, amount_paid: 5000, status: "paid" });
    const grace = now + 10 * DAY;
    await setBilling(env, a.userId, { stripe_subscription_id: newer.id, plan: "white_label", interval: "month", status: "canceled", grace_until: grace, grace_subscription_id: newer.id, grace_checkin_sent: 1 });
    await syncSubscription(env, a.userId, older.id, now);
    expect(await getBilling(env.DB, a.userId)).toMatchObject({ stripe_subscription_id: newer.id, grace_until: grace, grace_subscription_id: newer.id, grace_checkin_sent: 1 });
  });

  it("grace is granted at most once in one event (stored live one ended, incoming one ended too)", async () => {
    const { env, fake, a } = await setup();
    const now = Date.now();
    const first = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_month", status: "active", created: Math.floor(now / 1000) - 90 * 86400 });
    const second = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_month", status: "canceled", created: Math.floor(now / 1000) - 10 * 86400 });
    fake.invoices.push({ subscription: first.id, amount_paid: 5000, status: "paid" }, { subscription: second.id, amount_paid: 5000, status: "paid" });
    await syncSubscription(env, a.userId, first.id, now);
    first.status = "canceled"; // Stripe knows; our row still says active
    await syncSubscription(env, a.userId, second.id, now);
    const row = (await getBilling(env.DB, a.userId))!;
    expect(row.grace_subscription_id).toBe(first.id);
    expect(row.grace_until).toBe(now + 30 * DAY);
  });
});
