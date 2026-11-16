import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { call, bookableOwner, newOwner, type Who } from "./helpers";
import { addDays, localToUtc, utcToLocalDate, weekdayOf } from "../src/worker/slots/tz";

const TZ = "America/Los_Angeles";

async function openSession(owner: Who) {
  const res = await call("/api/v1/admin-sessions", { method: "POST", who: owner });
  return ((await res.json()) as { token: string }).token;
}

async function insertAppointment(owner: Who, serviceId: string, customerId: string, start: number, status: string) {
  const cal = (await (await call("/api/v1/calendar", { who: owner })).json()) as { id: string };
  const id = `apt_${Math.random().toString(36).slice(2)}${Date.now()}`;
  await env.DB.prepare(
    "INSERT INTO appointments (id, calendar_id, service_id, customer_id, start_at, end_at, status, manage_token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, cal.id, serviceId, customerId, start, start + 30 * 60000, status, `h_${id}`, Date.now(), Date.now()).run();
  return id;
}

async function makeCustomer(owner: Who, first: string, phone: string) {
  const res = await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: first, phone } });
  return ((await res.json()) as { customer: { id: string } }).customer.id;
}

type Dash = {
  today: number; this_week: number; this_month: number; customers: number;
  today_appointments: { id: string; start: string; status: string }[];
  recent_customers: { id: string; first_name: string }[];
};

describe("GET /dashboard", () => {
  it("counts active appointments in today, this week and this month, in the calendar's time zone", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    // Two real bookings 30 days out and one cancelled.
    const book = (start: string, first: string, phone: string) =>
      call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, start, customer: { first_name: first, phone } } });
    await book(slots[0], "Ann", "5035550101");
    const second = (await (await book(slots[4], "Bob", "5035550102")).json()) as { appointment: { id: string } };
    await call(`/api/v1/appointments/${second.appointment.id}/cancel`, { method: "POST", who: owner, json: {} });
    const out = (await (await call("/api/v1/dashboard", { who: owner })).json()) as Dash;
    expect(out.customers).toBe(2);
    expect(out.today).toBe(0);
    expect(out.today_appointments).toEqual([]);
    expect(out.recent_customers.map((c) => c.first_name)).toEqual(["Bob", "Ann"]);

    // Appointments placed directly in D1 around "today" in the calendar's zone.
    const today = utcToLocalDate(Date.now(), TZ);
    const noon = (date: string) => localToUtc(date, 720, TZ);
    const cus = await makeCustomer(owner, "Cy", "5035550103");
    const late = await insertAppointment(owner, serviceId, cus, noon(today) + 3600_000, "done");
    const early = await insertAppointment(owner, serviceId, cus, noon(today), "booked");
    await insertAppointment(owner, serviceId, cus, noon(today) + 7200_000, "cancelled");
    await insertAppointment(owner, serviceId, cus, noon(addDays(today, -40)), "booked"); // outside week and month
    await insertAppointment(owner, serviceId, cus, noon(addDays(today, 40)), "booked"); // outside week and month
    let expectedWeek = 2;
    let expectedMonth = 2;
    if (weekdayOf(today) !== 6) {
      const tomorrow = addDays(today, 1);
      await insertAppointment(owner, serviceId, cus, noon(tomorrow), "booked");
      expectedWeek += 1;
      if (tomorrow.slice(0, 7) === today.slice(0, 7)) expectedMonth += 1;
    }

    const after = (await (await call("/api/v1/dashboard", { who: owner })).json()) as Dash;
    expect(after.today).toBe(2);
    expect(after.this_week).toBe(expectedWeek);
    expect(after.this_month).toBe(expectedMonth);
    expect(after.customers).toBe(3);
    expect(after.today_appointments.map((a) => a.id)).toEqual([early, late]); // by start time, cancelled left out
    expect(after.recent_customers).toHaveLength(3);

    // The owner screens see the same numbers through a session.
    const token = await openSession(owner);
    const viaSession = (await (await call("/api/admin/dashboard", { headers: { Authorization: `Session ${token}` } })).json()) as Dash;
    expect(viaSession.today).toBe(2);
  });

  it("only counts its own calendar and limits recent customers to five", async () => {
    const a = await bookableOwner();
    for (let i = 0; i < 6; i++) await makeCustomer(a.owner, `C${i}`, `503555020${i}`);
    const b = await newOwner();
    const mine = (await (await call("/api/v1/dashboard", { who: a.owner })).json()) as Dash;
    expect(mine.customers).toBe(6);
    expect(mine.recent_customers).toHaveLength(5);
    const theirs = (await (await call("/api/v1/dashboard", { who: b })).json()) as Dash;
    expect(theirs).toMatchObject({ today: 0, this_week: 0, this_month: 0, customers: 0, today_appointments: [], recent_customers: [] });
  });

  it("needs a calendar", async () => {
    const owner = await newOwner();
    const other = { key: owner.key, user: "nobody-here" };
    expect((await call("/api/v1/dashboard", { who: other })).status).toBe(404);
  });
});

describe("GET /customers/:id/appointments", () => {
  it("lists a customer's history newest first with counts", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const cus = await makeCustomer(owner, "Dee", "5035550301");
    const book = async (start: string) => {
      const res = await call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, customer_id: cus, start } });
      return ((await res.json()) as { appointment: { id: string } }).appointment.id;
    };
    const first = await book(slots[0]);
    const second = await book(slots[4]);
    const third = await book(slots[8]);
    await call(`/api/v1/appointments/${second}`, { method: "PATCH", who: owner, json: { status: "done" } });
    await call(`/api/v1/appointments/${third}/cancel`, { method: "POST", who: owner, json: {} });
    // Someone else's appointment never shows up.
    const otherCus = await makeCustomer(owner, "Eve", "5035550302");
    await call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, customer_id: otherCus, start: slots[12] } });

    const res = await call(`/api/v1/customers/${cus}/appointments`, { who: owner });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appointments: { id: string; start: string; status: string }[]; counts: unknown; first_booked: string | null };
    expect(body.appointments.map((a) => a.id)).toEqual([third, second, first]);
    expect(body.appointments.map((a) => a.status)).toEqual(["cancelled", "done", "booked"]);
    expect(body.counts).toEqual({ booked: 2, completed: 1, cancelled: 1 });
    expect(body.first_booked).toBe(new Date(slots[0]).toISOString());
  });

  it("gives an empty history, and 404 for another calendar or an unknown customer", async () => {
    const { owner } = await bookableOwner();
    const cus = await makeCustomer(owner, "Fay", "5035550303");
    const empty = (await (await call(`/api/v1/customers/${cus}/appointments`, { who: owner })).json()) as { appointments: unknown[]; counts: unknown; first_booked: unknown };
    expect(empty).toEqual({ appointments: [], counts: { booked: 0, completed: 0, cancelled: 0 }, first_booked: null });

    const other = await newOwner();
    expect((await call(`/api/v1/customers/${cus}/appointments`, { who: other })).status).toBe(404);
    const token = await openSession(other);
    expect((await call(`/api/admin/customers/${cus}/appointments`, { headers: { Authorization: `Session ${token}` } })).status).toBe(404);
    expect((await call("/api/v1/customers/cus_nope/appointments", { who: owner })).status).toBe(404);
  });
});
