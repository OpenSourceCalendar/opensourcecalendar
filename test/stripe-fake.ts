// A tiny in-memory Stripe for tests, installed with vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch).
import { vi } from "vitest";
import { app } from "../src/worker/index";
import { hostedSession } from "../src/worker/auth";
import { testEnv, uniq } from "./helpers";

export const BILLING_ENV = {
  SIGNUP: "invite",
  PUBLIC_URL: "https://book.example.test",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_PRO_MONTH: "price_pro_month",
  STRIPE_PRICE_PRO_YEAR: "price_pro_year",
  STRIPE_PRICE_WL_MONTH: "price_wl_month",
  STRIPE_PRICE_WL_YEAR: "price_wl_year",
};

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A Stripe-Signature header for `body`, as Stripe makes it. */
export async function signStripe(secret: string, body: string, nowMs: number): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${t},v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))}`;
}

export type FakeSub = {
  id: string; customer: string; status: string; cancel_at_period_end: boolean; trial_end: number | null; created: number;
  metadata: Record<string, string>; items: { data: { price: { id: string }; current_period_end: number }[] };
};

export class FakeStripe {
  customers = new Map<string, { id: string; email: string; metadata: Record<string, string> }>();
  subs = new Map<string, FakeSub>();
  sessions: { id: string; customer: string; status: "open" | "expired" | "complete"; params: URLSearchParams }[] = [];
  invoices: { subscription: string; amount_paid: number; status: string }[] = [];
  calls: { method: string; path: string; body: URLSearchParams }[] = [];
  private n = 0;

  addSub(s: Partial<FakeSub> & { customer: string; price: string; status: string }): FakeSub {
    const id = s.id ?? `sub_${uniq()}_${++this.n}`; // unique across tests: they share one D1, and billing.stripe_subscription_id is UNIQUE
    const sub: FakeSub = {
      id, customer: s.customer, status: s.status, cancel_at_period_end: s.cancel_at_period_end ?? false,
      trial_end: s.trial_end ?? null, created: s.created ?? Math.floor(Date.now() / 1000) + this.n,
      metadata: s.metadata ?? {}, items: { data: [{ price: { id: s.price }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    };
    this.subs.set(id, sub);
    return sub;
  }

  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    this.calls.push({ method, path: url.pathname + url.search, body });
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    const p = url.pathname;
    if (method === "POST" && p === "/v1/customers") {
      const c = { id: `cus_${uniq()}_${++this.n}`, // unique across tests: billing.stripe_customer_id is UNIQUE in the shared D1
         email: body.get("email") ?? "", metadata: { user_id: body.get("metadata[user_id]") ?? "" } };
      this.customers.set(c.id, c);
      return ok(c);
    }
    if (method === "GET" && p === "/v1/subscriptions") {
      const cus = url.searchParams.get("customer");
      return ok({ data: [...this.subs.values()].filter((s) => s.customer === cus), has_more: false });
    }
    const subMatch = p.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (method === "GET" && subMatch) {
      const s = this.subs.get(subMatch[1]);
      return s ? ok(s) : new Response(JSON.stringify({ error: { code: "resource_missing" } }), { status: 404 });
    }
    if (method === "GET" && p === "/v1/checkout/sessions") {
      const cus = url.searchParams.get("customer");
      return ok({ data: this.sessions.filter((s) => s.customer === cus && s.status === "open"), has_more: false });
    }
    if (method === "POST" && p === "/v1/checkout/sessions") {
      const s = { id: `cs_${++this.n}`, customer: body.get("customer") ?? "", status: "open" as const, params: body };
      this.sessions.push(s);
      return ok({ id: s.id, url: `https://checkout.stripe.test/${s.id}` });
    }
    const expire = p.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
    if (method === "POST" && expire) {
      const s = this.sessions.find((x) => x.id === expire[1]);
      if (s) s.status = "expired";
      return ok({ id: expire[1], status: "expired" });
    }
    if (method === "POST" && p === "/v1/billing_portal/sessions") return ok({ url: "https://billing.stripe.test/session" });
    if (method === "GET" && p === "/v1/invoices") {
      const sub = url.searchParams.get("subscription");
      return ok({ data: this.invoices.filter((i) => i.subscription === sub && i.status === "paid"), has_more: false });
    }
    return new Response(JSON.stringify({ error: { code: "fake_unhandled", message: `${method} ${p}` } }), { status: 400 });
  });
}

export const billingEnv = (extra: Record<string, unknown> = {}) =>
  ({ ...testEnv, ...BILLING_ENV, EMAIL_FROM: "hello@example.test", OPERATOR_EMAIL: "support@example.test", ...extra }) as unknown as typeof testEnv;

/** A hosted account with a calendar: { userId, token, calendarId, slug }. */
export async function hostedAccount(env: typeof testEnv) {
  const userId = `usr_${uniq()}`;
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(userId, `${userId}@example.test`, now).run();
  const { token } = await hostedSession(env, userId, now);
  const slug = `acct-${uniq()}`;
  const res = await app.request("https://book.example.test/api/admin/calendar", {
    method: "POST", headers: { Authorization: `Session ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug, time_zone: "America/Los_Angeles" }),
  }, env);
  if (res.status !== 201) throw new Error(`hostedAccount: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return { userId, token, calendarId: id, slug };
}

export async function setBilling(env: typeof testEnv, userId: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  await env.DB.prepare(
    `INSERT INTO billing (user_id, updated_at${cols.map((c) => `, ${c}`).join("")}) VALUES (?, ?${cols.map(() => ", ?").join("")})
     ON CONFLICT(user_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ") || "updated_at = excluded.updated_at"}`,
  ).bind(userId, Date.now(), ...Object.values(fields)).run();
}
