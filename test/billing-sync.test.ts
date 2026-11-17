import { describe, it, expect, vi, afterEach } from "vitest";
import { applySubscription, syncSubscription } from "../src/worker/billing/sync";
import { getBilling } from "../src/worker/billing/store";
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
});
