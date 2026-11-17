import { describe, it, expect, vi, afterEach } from "vitest";
import { billingOn, planForPrice, priceFor } from "../src/worker/billing/config";
import { formEncode, stripe, StripeError, verifyStripeSignature } from "../src/worker/billing/stripe";
import { testEnv } from "./helpers";
import { BILLING_ENV, signStripe } from "./stripe-fake";

afterEach(() => vi.restoreAllMocks());

describe("billingOn", () => {
  it("needs every Stripe setting and hosted sign-up", () => {
    const env = { ...testEnv, ...BILLING_ENV };
    expect(billingOn(env)).toBe(true);
    for (const k of Object.keys(BILLING_ENV)) expect(billingOn({ ...env, [k]: undefined })).toBe(false);
  });
});

describe("prices", () => {
  it("maps plans to price ids and back", () => {
    const env = { ...testEnv, ...BILLING_ENV };
    expect(priceFor(env, "pro", "year")).toBe("price_pro_year");
    expect(planForPrice(env, "price_wl_month")).toEqual({ plan: "white_label", interval: "month" });
    expect(planForPrice(env, "price_other")).toBeNull();
  });
});

describe("formEncode", () => {
  it("flattens nested objects and arrays the way Stripe expects", () => {
    expect(formEncode({ a: 1, b: { c: "x", d: [{ e: true }] }, skip: undefined })).toBe("a=1&b%5Bc%5D=x&b%5Bd%5D%5B0%5D%5Be%5D=true");
  });
});

describe("stripe()", () => {
  it("sends the key, the pinned version and an idempotency key; throws StripeError on failure", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ id: "cus_1" }), { status: 200 }));
    const env = { ...testEnv, ...BILLING_ENV };
    expect(await stripe(env, "POST", "/v1/customers", { email: "a@b.c" }, "idem-1")).toEqual({ id: "cus_1" });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/customers");
    const h = new Headers(init.headers);
    expect(h.get("Authorization")).toBe("Bearer sk_test_fake");
    expect(h.get("Stripe-Version")).toBe("2026-09-30.endive");
    expect(h.get("Idempotency-Key")).toBe("idem-1");
    spy.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "resource_missing", type: "invalid_request_error" } }), { status: 404 }));
    await expect(stripe(env, "GET", "/v1/customers/x")).rejects.toMatchObject({ status: 404, code: "resource_missing" });
    expect(StripeError).toBeDefined();
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1" });
  it("accepts a fresh, correct signature", async () => {
    const now = Date.now();
    expect(await verifyStripeSignature(secret, await signStripe(secret, body, now), body, now)).toBe(true);
  });
  it("rejects a wrong secret, a changed body, an old timestamp and a missing header", async () => {
    const now = Date.now();
    const header = await signStripe(secret, body, now);
    expect(await verifyStripeSignature("whsec_other", header, body, now)).toBe(false);
    expect(await verifyStripeSignature(secret, header, body + " ", now)).toBe(false);
    expect(await verifyStripeSignature(secret, header, body, now + 6 * 60_000)).toBe(false);
    expect(await verifyStripeSignature(secret, "", body, now)).toBe(false);
  });
});
