import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { call, newOwner } from "./helpers";

async function setUp() {
  const owner = await newOwner();
  const svc = (await (await call("/api/v1/services", { method: "POST", who: owner, json: { name: "Call", duration_min: 30 } })).json()) as { id: string };
  const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: true, start_min: 660, end_min: 720, breaks: [] }));
  await call("/api/v1/availability/weekly", { method: "PUT", who: owner, json: { days } });
  await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { min_notice_min: 0, max_days_ahead: 730 } } });
  return { owner, svc };
}

// A date far enough ahead to never be "today", inside max_days_ahead.
function futureDate(daysAhead = 30) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

describe("GET /api/v1/slots", () => {
  it("returns open times for a service", async () => {
    const { owner, svc } = await setUp();
    const res = await call(`/api/v1/slots?service_id=${svc.id}&date=${futureDate()}`, { who: owner });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slots: string[]; time_zone: string };
    expect(body.time_zone).toBe("America/Los_Angeles");
    expect(body.slots).toHaveLength(3); // 11:00, 11:15, 11:30 for a 30-min service in 11:00-12:00
  });

  it("leaves out time blocks and booked appointments", async () => {
    const { owner, svc } = await setUp();
    const date = futureDate();
    const all = ((await (await call(`/api/v1/slots?service_id=${svc.id}&date=${date}`, { who: owner })).json()) as { slots: string[] }).slots;

    await call("/api/v1/availability/time-blocks", { method: "POST", who: owner, json: { start_at: all[0], end_at: new Date(Date.parse(all[0]) + 15 * 60000).toISOString() } });

    // Insert an appointment directly (booking API arrives in Phase 3).
    const cal = (await (await call("/api/v1/calendar", { who: owner })).json()) as { id: string };
    const cus = (await (await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "A", phone: "5035550100" } })).json()) as { customer: { id: string } };
    const start = Date.parse(all[2]);
    await env.DB.prepare(
      "INSERT INTO appointments (id, calendar_id, service_id, customer_id, start_at, end_at, status, manage_token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?)",
    ).bind(`apt_${Date.now()}`, cal.id, svc.id, cus.customer.id, start, start + 30 * 60000, `h_${Date.now()}`, Date.now(), Date.now()).run();

    const after = ((await (await call(`/api/v1/slots?service_id=${svc.id}&date=${date}`, { who: owner })).json()) as { slots: string[] }).slots;
    expect(after).toEqual([]); // 11:00 is blocked, 11:15 would run into the 11:30 booking, 11:30 is booked
  });

  it("validates input and hides other calendars' services", async () => {
    const { owner, svc } = await setUp();
    expect((await call(`/api/v1/slots?service_id=${svc.id}&date=2026-02-30`, { who: owner })).status).toBe(400);
    const other = await newOwner();
    expect((await call(`/api/v1/slots?service_id=${svc.id}&date=${futureDate()}`, { who: other })).status).toBe(404);
  });
});
