import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/worker/index";
import { getBilling } from "../src/worker/billing/store";
import { billingEnv, FakeStripe, hostedAccount, setBilling, signStripe } from "./stripe-fake";

afterEach(() => vi.restoreAllMocks());
const URL_ = "https://book.example.test/api/billing/webhook";

async function deliver(env: ReturnType<typeof billingEnv>, event: unknown, opts: { secret?: string; header?: string } = {}) {
  const body = JSON.stringify(event);
  const header = opts.header ?? (await signStripe(opts.secret ?? "whsec_test", body, Date.now()));
  return app.request(URL_, { method: "POST", headers: { "Stripe-Signature": header, "Content-Type": "application/json" }, body }, env);
}

async function setup() {
  const send = vi.fn(async () => {});
  const env = billingEnv({ EMAIL: { send } });
  const fake = new FakeStripe();
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
  const a = await hostedAccount(env);
  await setBilling(env, a.userId, { stripe_customer_id: `cus_${a.userId}` });
  return { env, fake, a, send };
}

describe("billing webhook", () => {
  it("rejects missing and forged signatures, and does nothing", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active", metadata: { user_id: a.userId } });
    const event = { id: "evt_forged", type: "customer.subscription.updated", data: { object: sub } };
    expect((await deliver(env, event, { header: "" })).status).toBe(400);
    expect((await deliver(env, event, { secret: "whsec_wrong" })).status).toBe(400);
    expect((await getBilling(env.DB, a.userId))!.status).toBe("none");
  });
  it("a subscription event saves Stripe's current state, not the event's copy", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active", metadata: { user_id: a.userId } });
    const stale = { ...sub, status: "trialing" };
    expect((await deliver(env, { id: `evt_${a.userId}_1`, type: "customer.subscription.updated", data: { object: stale } })).status).toBe(200);
    expect((await getBilling(env.DB, a.userId))!.status).toBe("active");
  });
  it("the same event twice is handled once", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active", metadata: { user_id: a.userId } });
    const event = { id: `evt_${a.userId}_dup`, type: "customer.subscription.created", data: { object: sub } };
    await deliver(env, event);
    const before = fake.calls.length;
    expect((await deliver(env, event)).status).toBe(200);
    expect(fake.calls.length).toBe(before);
  });
  it("checkout.session.completed and invoice events find the subscription", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_wl_year", status: "trialing", metadata: { user_id: a.userId } });
    await deliver(env, { id: `evt_${a.userId}_cs`, type: "checkout.session.completed", data: { object: { client_reference_id: a.userId, customer: sub.customer, subscription: sub.id } } });
    expect((await getBilling(env.DB, a.userId))!.plan).toBe("white_label");
    sub.status = "past_due";
    await deliver(env, { id: `evt_${a.userId}_inv`, type: "invoice.payment_failed", data: { object: { customer: sub.customer, parent: { subscription_details: { subscription: sub.id } } } } });
    expect((await getBilling(env.DB, a.userId))!.status).toBe("past_due");
  });
  it("a dispute emails the operator even with no matching account", async () => {
    const { env, send } = await setup();
    const res = await deliver(env, { id: "evt_dispute_1", type: "charge.dispute.created", data: { object: { id: "dp_1", charge: "ch_1", amount: 1000, currency: "usd" } } });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "support@example.test", subject: expect.stringContaining("dispute") }));
  });
  it("unknown accounts are acknowledged and ignored", async () => {
    const { env, fake } = await setup();
    const sub = fake.addSub({ customer: "cus_nobody", price: "price_pro_month", status: "active" });
    expect((await deliver(env, { id: "evt_nobody", type: "customer.subscription.updated", data: { object: sub } })).status).toBe(200);
  });
  it("a failure after verification returns 500 and the retry is processed", async () => {
    const { env, fake, a } = await setup();
    const sub = fake.addSub({ customer: `cus_${a.userId}`, price: "price_pro_month", status: "active", metadata: { user_id: a.userId } });
    const event = { id: `evt_${a.userId}_retry`, type: "customer.subscription.updated", data: { object: sub } };
    fake.fetch.mockImplementationOnce(async () => new Response("{}", { status: 500 }));
    expect((await deliver(env, event)).status).toBe(500);
    expect((await deliver(env, event)).status).toBe(200);
    expect((await getBilling(env.DB, a.userId))!.status).toBe("active");
  });
  it("is 404 when billing is off", async () => {
    const env = billingEnv({ STRIPE_SECRET_KEY: undefined });
    expect((await app.request(URL_, { method: "POST", body: "{}" }, env)).status).toBe(404);
  });
});
