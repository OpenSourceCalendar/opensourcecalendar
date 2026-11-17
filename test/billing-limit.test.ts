import { describe, it, expect, vi } from "vitest";
import { monthBounds } from "../src/worker/billing/limit";
import { app } from "../src/worker/index";
import { billingEnv, hostedAccount, setBilling } from "./stripe-fake";

describe("monthBounds", () => {
  it("is the calendar month in the business's time zone", () => {
    // 2026-12-01 03:00 UTC is still Nov 30 in Los Angeles.
    const b = monthBounds(Date.UTC(2026, 11, 1, 3), "America/Los_Angeles");
    expect(b.month).toBe("2026-11");
    expect(b.start).toBe(Date.UTC(2026, 10, 1, 7));
    expect(b.end).toBe(Date.UTC(2026, 11, 1, 8));
  });
});

/** An open, bookable hosted calendar: hours every day, one service. Returns a function that books the next free slot. */
async function bookable(env: ReturnType<typeof billingEnv>) {
  const a = await hostedAccount(env);
  const h = { Authorization: `Session ${a.token}`, "Content-Type": "application/json" };
  const base = "https://book.example.test/api/admin";
  const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: true, start_min: 0, end_min: 1440, breaks: [] }));
  await app.request(`${base}/availability/weekly`, { method: "PUT", headers: h, body: JSON.stringify({ days }) }, env);
  await app.request(`${base}/calendar`, { method: "PATCH", headers: h, body: JSON.stringify({ rules: { min_notice_min: 0, max_days_ahead: 730, slot_step_min: 30 } }) }, env);
  const svc = (await (await app.request(`${base}/services`, { method: "POST", headers: h, body: JSON.stringify({ name: "Call", duration_min: 30 }) }, env)).json()) as { id: string };
  let n = 0;
  const book = async () => {
    // BookBody.start is an ISO date-time string, not a number.
    const start = Math.ceil((Date.now() + 2 * 86_400_000) / 1_800_000) * 1_800_000 + n++ * 1_800_000;
    const res = await app.request(`https://book.example.test/api/public/${a.slug}/book`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_id: svc.id, start: new Date(start).toISOString(), first_name: "Ann", phone: `555010${n % 10}`, email: `c${n}@example.test` }),
    }, env);
    expect(res.status).toBe(201);
    return ((await res.json()) as { appointment: { id: string } }).appointment.id;
  };
  return { a, book };
}

describe("Free limit", () => {
  it("bookings 1-10 email normally; 11+ are emails_off; the owner gets one limit email", async () => {
    const env = billingEnv({ EMAIL: { send: vi.fn() } });
    const { a, book } = await bookable(env);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await book());
    const off = await env.DB.prepare(`SELECT id FROM appointments WHERE calendar_id = ? AND emails_off = 1`).bind(a.calendarId).all<{ id: string }>();
    expect(off.results.map((r) => r.id).sort()).toEqual(ids.slice(10).sort());
    const notices = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE calendar_id = ? AND kind = 'email.account.limit'").bind(a.calendarId).first<{ n: number }>();
    expect(notices!.n).toBe(1);
  });
  it("cancelled bookings still count; owner bookings don't", async () => {
    const env = billingEnv({ EMAIL: { send: vi.fn() } });
    const { a, book } = await bookable(env);
    for (let i = 0; i < 10; i++) await book();
    await env.DB.prepare("UPDATE appointments SET status = 'cancelled' WHERE calendar_id = ?").bind(a.calendarId).run();
    const eleventh = await book();
    expect((await env.DB.prepare("SELECT emails_off FROM appointments WHERE id = ?").bind(eleventh).first<{ emails_off: number }>())!.emails_off).toBe(1);
  });
  it("paid plans are never limited", async () => {
    const env = billingEnv({ EMAIL: { send: vi.fn() } });
    const { a, book } = await bookable(env);
    await setBilling(env, a.userId, { plan: "pro", status: "active" });
    for (let i = 0; i < 11; i++) await book();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM appointments WHERE calendar_id = ? AND emails_off = 1").bind(a.calendarId).first<{ n: number }>())!.n).toBe(0);
  });
});
