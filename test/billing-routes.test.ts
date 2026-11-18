import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/worker/index";
import { getBilling } from "../src/worker/billing/store";
import { adminCall, billingEnv, clientCalendar, FakeStripe, hostedAccount, setBilling } from "./stripe-fake";

afterEach(() => vi.restoreAllMocks());
const BASE = "https://book.example.test/api/admin/billing";
const post = (env: ReturnType<typeof billingEnv>, token: string, path: string, json?: unknown) =>
  app.request(`${BASE}${path}`, { method: "POST", headers: { Authorization: `Session ${token}`, "Content-Type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) }, env);

describe("GET /billing", () => {
  it("always shows the agency's own numbers, whatever X-Client says", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const svc = `svc_${crypto.randomUUID()}`;
    const cus = `cus_${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO services (id, calendar_id, name, duration_min, color, location_type, created_at) VALUES (?, ?, 'Call', 30, '#2d6a4f', 'business', 0)").bind(svc, c.calendarId),
      env.DB.prepare("INSERT INTO customers (id, calendar_id, first_name, created_at) VALUES (?, ?, 'Ann', 0)").bind(cus, c.calendarId),
      env.DB.prepare(`INSERT INTO appointments (id, calendar_id, service_id, customer_id, start_at, end_at, status, source, manage_token_hash, created_at, updated_at, contact_first_name)
        VALUES (?, ?, ?, ?, ?, ?, 'booked', 'booking_page', ?, ?, ?, 'Ann')`).bind(`apt_${cus}`, c.calendarId, svc, cus, now + 86_400_000, now + 88_200_000, `h_${cus}`, now, now),
    ]);
    const res = await adminCall(env, a.token, "/billing", { client: c.calendarId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, bookings_this_month: 0 });
  });

  it("billing off: { enabled: false }", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const res = await app.request(BASE, { headers: { Authorization: `Session ${a.token}` } }, billingEnv({ STRIPE_SECRET_KEY: undefined }));
    expect(await res.json()).toEqual({ enabled: false });
  });
  it("Free account: plan, usage and trial availability", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const body = await (await app.request(BASE, { headers: { Authorization: `Session ${a.token}` } }, env)).json();
    expect(body).toMatchObject({ enabled: true, plan: "free", status: "none", trial_available: true, bookings_this_month: 0, monthly_limit: 10, paid: false });
  });
});

describe("POST /billing/checkout", () => {
  it("creates the customer once, a 14-day trial with a card, the server's price; expires older open sessions", async () => {
    const env = billingEnv();
    const fake = new FakeStripe();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    const r1 = await post(env, a.token, "/checkout", { plan: "pro", interval: "year" });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { url: string }).url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const s1 = fake.sessions[0].params;
    expect(s1.get("mode")).toBe("subscription");
    expect(s1.get("line_items[0][price]")).toBe("price_pro_year");
    expect(s1.get("subscription_data[trial_period_days]")).toBe("14");
    expect(s1.get("payment_method_collection")).toBe("always");
    expect(s1.get("automatic_tax[enabled]")).toBe("true");
    expect(s1.get("client_reference_id")).toBe(a.userId);
    expect(s1.get("success_url")).toBe("https://book.example.test/admin/plan?checkout=done");
    expect([...s1.keys()].some((k) => k.startsWith("payment_method_types"))).toBe(false);
    await post(env, a.token, "/checkout", { plan: "white_label", interval: "month" });
    expect(fake.customers.size).toBe(1);
    expect(fake.sessions[0].status).toBe("expired");
  });
  it("no trial once used; refused with a live subscription; refuses unknown plans", async () => {
    const env = billingEnv();
    const fake = new FakeStripe();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { stripe_customer_id: "cus_x", trial_used: 1 });
    await post(env, a.token, "/checkout", { plan: "pro", interval: "month" });
    expect(fake.sessions[0].params.get("subscription_data[trial_period_days]")).toBeNull();
    fake.addSub({ customer: "cus_x", price: "price_pro_month", status: "active" });
    expect((await post(env, a.token, "/checkout", { plan: "pro", interval: "month" })).status).toBe(409);
    expect((await post(env, a.token, "/checkout", { plan: "gold", interval: "month", price: "price_1" })).status).toBe(400);
  });
  it("is rate limited to 5 starts an hour", async () => {
    const env = billingEnv();
    const fake = new FakeStripe();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    for (let i = 0; i < 5; i++) expect((await post(env, a.token, "/checkout", { plan: "pro", interval: "month" })).status).toBe(200);
    expect((await post(env, a.token, "/checkout", { plan: "pro", interval: "month" })).status).toBe(429);
  });
  it("two checkouts at once: only one reaches Stripe, the other is 409 checkout_in_progress", async () => {
    const env = billingEnv();
    const fake = new FakeStripe();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { stripe_customer_id: `cus_${a.userId}` });
    const res = await Promise.all([1, 2].map(() => post(env, a.token, "/checkout", { plan: "pro", interval: "month" })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await res.find((r) => r.status === 409)!.json()).toEqual({ error: "checkout_in_progress" });
    expect(fake.sessions.length).toBe(1);
  });
  it("is 404 for sessions that aren't hosted accounts", async () => {
    // A host-app owner session (createAdminSession) can't reach billing.
    const env = billingEnv();
    const { newOwner, call } = await import("./helpers");
    const owner = await newOwner();
    const s = (await (await call("/api/v1/admin-sessions", { method: "POST", who: owner })).json()) as { token: string };
    expect((await post(env, s.token, "/checkout", { plan: "pro", interval: "month" })).status).toBe(404);
  });
});

describe("POST /billing/portal", () => {
  it("returns a portal URL for an account with a Stripe customer, 409 without", async () => {
    const env = billingEnv();
    const fake = new FakeStripe();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    expect((await post(env, a.token, "/portal")).status).toBe(409);
    await setBilling(env, a.userId, { stripe_customer_id: "cus_y" });
    const res = await post(env, a.token, "/portal");
    expect(await res.json()).toEqual({ url: "https://billing.stripe.test/session" });
    expect(fake.calls.at(-1)!.body.get("return_url")).toBe("https://book.example.test/admin/plan");
    expect(await getBilling(env.DB, a.userId)).toBeTruthy();
  });
});
