import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { runBillingCron, isReconcileMinute } from "../src/worker/billing/cron";
import { getBilling } from "../src/worker/billing/store";
import { billingEnv, clientCalendar, FakeStripe, hostedAccount, setBilling } from "./stripe-fake";

// The daily reconcile may run in any test here (it runs from 10:00 UTC): never let it reach the real Stripe.
beforeEach(() => void vi.spyOn(globalThis, "fetch").mockImplementation(new FakeStripe().fetch));
afterEach(() => vi.restoreAllMocks());
const DAY = 86_400_000;
const jobs = (env: ReturnType<typeof billingEnv>, cal: string, kind: string) =>
  env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE calendar_id = ? AND kind = ?").bind(cal, kind).first<{ n: number }>().then((r) => r!.n);

describe("billing cron", () => {
  it("grace emails go to the account's own calendar even when a client is older", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId, 0);
    await setBilling(env, a.userId, { plan: "white_label", status: "canceled", grace_until: Date.now() + 30 * DAY, grace_subscription_id: "sub_home" });
    await runBillingCron(env, Date.now());
    expect(await jobs(env, a.calendarId, "email.account.grace_start")).toBe(1);
    expect(await jobs(env, c.calendarId, "email.account.grace_start")).toBe(0);
  });
  it("queues the check-in once, the reminder in the last week once, then ends grace", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const now = Date.now();
    await setBilling(env, a.userId, { plan: "white_label", status: "canceled", grace_until: now + 30 * DAY, grace_subscription_id: "sub_g" });
    await runBillingCron(env, now);
    await runBillingCron(env, now + 60_000);
    expect(await jobs(env, a.calendarId, "email.account.grace_start")).toBe(1);
    expect(await jobs(env, a.calendarId, "email.account.grace_end")).toBe(0);
    await runBillingCron(env, now + 24 * DAY);
    await runBillingCron(env, now + 24 * DAY + 60_000);
    expect(await jobs(env, a.calendarId, "email.account.grace_end")).toBe(1);
    await env.DB.prepare("INSERT INTO google_busy (calendar_id, google_event_id, start_at, end_at) VALUES (?, 'g1', 1, 2)").bind(a.calendarId).run();
    await runBillingCron(env, now + 31 * DAY);
    expect((await getBilling(env.DB, a.userId))!.grace_until).toBeNull();
    expect((await getBilling(env.DB, a.userId))!.grace_subscription_id).toBe("sub_g");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM google_busy WHERE calendar_id = ?").bind(a.calendarId).first<{ n: number }>())!.n).toBe(0);
  });
  it("reconcile fixes a row that missed a webhook", async () => {
    const env = billingEnv();
    vi.restoreAllMocks();
    const fake = new FakeStripe();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "canceled" });
    await setBilling(env, a.userId, { stripe_customer_id: `cus_${a.userId}`, stripe_subscription_id: sub.id, plan: "pro", status: "active" });
    const reconcileAt = Date.UTC(2031, 0, 7, 10, 0, 30); // a date no other test's Date.now() can claim
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = 'reconcile:2031-01-07'").run();
    expect(isReconcileMinute(reconcileAt)).toBe(true);
    expect(isReconcileMinute(Date.UTC(2031, 0, 7, 9, 59))).toBe(false);
    await runBillingCron(env, reconcileAt);
    expect((await getBilling(env.DB, a.userId))!.status).toBe("canceled");
  });
  it("reconcile skips ended rows past grace, and finds the subscription for a customer that missed every webhook", async () => {
    const env = billingEnv();
    vi.restoreAllMocks();
    const fake = new FakeStripe();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const ended = await hostedAccount(env);
    const old = fake.addSub({ customer: `cus_${ended.userId}`, price: "price_pro_month", status: "canceled" });
    await setBilling(env, ended.userId, { stripe_customer_id: `cus_${ended.userId}`, stripe_subscription_id: old.id, plan: "pro", status: "canceled" });
    const missed = await hostedAccount(env);
    await setBilling(env, missed.userId, { stripe_customer_id: `cus_${missed.userId}` });
    fake.addSub({ customer: `cus_${missed.userId}`, price: "price_pro_month", status: "canceled", created: 1_000 });
    const newest = fake.addSub({ customer: `cus_${missed.userId}`, price: "price_pro_year", status: "active", created: 2_000 });
    const reconcileAt = Date.UTC(2031, 0, 8, 10, 0, 30);
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = 'reconcile:2031-01-08'").run();
    await runBillingCron(env, reconcileAt);
    expect(fake.calls.some((c) => c.path.includes(old.id))).toBe(false);
    expect(await getBilling(env.DB, missed.userId)).toMatchObject({ stripe_subscription_id: newest.id, plan: "pro", interval: "year", status: "active" });
  });
  it("deletes stripe_events older than 30 days", async () => {
    const env = billingEnv();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO stripe_events (id, type, received_at) VALUES ('evt_old_x', 't', ?), ('evt_new_x', 't', ?)").bind(now - 31 * DAY, now).run();
    await runBillingCron(env, now);
    const ids = (await env.DB.prepare("SELECT id FROM stripe_events WHERE id IN ('evt_old_x','evt_new_x')").all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toEqual(["evt_new_x"]);
  });
  it("does nothing when billing is off", async () => {
    await expect(runBillingCron(billingEnv({ STRIPE_SECRET_KEY: undefined }), Date.now())).resolves.toBeUndefined();
  });
});
