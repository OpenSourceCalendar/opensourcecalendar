import { describe, it, expect } from "vitest";
import { entitlements, entitlementsFor, isPaid } from "../src/worker/billing/entitlements";
import type { CalendarRow } from "../src/worker/types";
import { newOwner, testEnv } from "./helpers";
import { billingEnv, hostedAccount, setBilling } from "./stripe-fake";

const cal = async (env: typeof testEnv, id: string) => (await env.DB.prepare("SELECT * FROM calendars WHERE id = ?").bind(id).first<CalendarRow>())!;
const DAY = 86_400_000;

describe("isPaid", () => {
  const now = Date.now();
  it("live statuses on a paid plan are paid; grace is paid; everything else is not", () => {
    for (const status of ["trialing", "active", "past_due"]) expect(isPaid({ plan: "pro", status, grace_until: null }, now)).toBe(true);
    for (const status of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused", "none"]) expect(isPaid({ plan: "pro", status, grace_until: null }, now)).toBe(false);
    expect(isPaid({ plan: "white_label", status: "canceled", grace_until: now + DAY }, now)).toBe(true);
    expect(isPaid({ plan: "white_label", status: "canceled", grace_until: now - 1 }, now)).toBe(false);
    expect(isPaid(null, now)).toBe(false);
  });
});

describe("entitlements", () => {
  it("billing off: everything allowed, not limited", async () => {
    const a = await hostedAccount(billingEnv());
    const e = await entitlements(billingEnv({ STRIPE_SECRET_KEY: undefined }), await cal(testEnv, a.calendarId));
    expect(e).toMatchObject({ limited: false, reminders: true, google: true, footerForced: false });
  });
  it("calendars outside the hosted app are never limited", async () => {
    const owner = await newOwner();
    const row = await testEnv.DB.prepare("SELECT * FROM calendars WHERE slug = ?").bind(owner.slug).first<CalendarRow>();
    expect((await entitlements(billingEnv(), row!)).limited).toBe(false);
  });
  it("a hosted account with no billing row is Free", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    expect(await entitlements(env, await cal(env, a.calendarId))).toMatchObject({ plan: "free", limited: true, reminders: false, google: false, footerForced: true, monthlyEmailBookings: 10 });
  });
  it("trialing Pro gets everything; entitlementsFor finds it by calendar id", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "pro", status: "trialing" });
    expect(await entitlementsFor(env, a.calendarId)).toMatchObject({ plan: "pro", limited: false, reminders: true, google: true, footerForced: false });
  });
});
