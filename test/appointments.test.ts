import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { bookableOwner, call } from "./helpers";

type Appt = { id: string; start: string; end: string; status: string; service_name: string; customer: { id: string; first_name: string }; cancel_reason: string | null; source: string };
type Created = { appointment: Appt; manage_token: string; manage_path: string };

const book = (who: { key: string; user: string }, json: Record<string, unknown>) =>
  call("/api/v1/appointments", { method: "POST", who, json });

describe("host appointments", () => {
  it("books an open time for a new customer and returns the manage link", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const res = await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "Mike", phone: "5035550101", external_ref: "lead_1" }, source: "Flow State" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect(body.appointment).toMatchObject({ start: slots[0], status: "booked", service_name: "Call", source: "Flow State", customer: { first_name: "Mike" } });
    expect(body.manage_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.manage_path).toBe(`/m/${body.manage_token}`);

    const again = (await (await call(`/api/v1/appointments/${body.appointment.id}`, { who: owner })).json()) as { manage_token: string };
    expect(again.manage_token).toBe(body.manage_token);
  });

  it("refuses a taken time, a time outside hours, and a missing customer", async () => {
    const { owner, serviceId, slots, date } = await bookableOwner();
    expect((await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550102" } })).status).toBe(201);
    const taken = await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "B", phone: "5035550103" } });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toBe("slot_unavailable");

    const early = `${date}T14:00:00.000Z`; // 06:00 or 07:00 in Los Angeles: closed
    const res = await book(owner, { service_id: serviceId, start: early, customer: { first_name: "C", phone: "5035550104" } });
    expect(res.status).toBe(409);
    expect((await book(owner, { service_id: serviceId, start: slots[1] })).status).toBe(400);
  });

  it("lets the owner book outside hours but never on top of another booking", async () => {
    const { owner, serviceId, slots, date } = await bookableOwner();
    const early = `${date}T14:00:00.000Z`;
    const ok = await book(owner, { service_id: serviceId, start: early, allow_outside_hours: true, customer: { first_name: "A", phone: "5035550105" } });
    expect(ok.status).toBe(201);
    await book(owner, { service_id: serviceId, start: slots[3], customer: { first_name: "B", phone: "5035550106" } });
    const clash = await book(owner, { service_id: serviceId, start: slots[3], allow_outside_hours: true, customer: { first_name: "C", phone: "5035550107" } });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toBe("slot_taken");
  });

  it("lists by range, moves, confirms and cancels; cancelling frees the time", async () => {
    const { owner, serviceId, slots, date } = await bookableOwner();
    const { appointment } = (await (await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550108" } })).json()) as Created;

    const list = (await (await call(`/api/v1/appointments?from=${date}T00:00:00.000Z&to=${date}T23:59:59.000Z`, { who: owner })).json()) as { appointments: Appt[] };
    expect(list.appointments.map((a) => a.id)).toEqual([appointment.id]);

    const moved = await call(`/api/v1/appointments/${appointment.id}`, { method: "PATCH", who: owner, json: { start: slots[4], status: "confirmed" } });
    expect(moved.status).toBe(200);
    expect((await moved.json()) as Appt).toMatchObject({ start: slots[4], status: "confirmed" });

    const free = ((await (await call(`/api/v1/slots?service_id=${serviceId}&date=${date}`, { who: owner })).json()) as { slots: string[] }).slots;
    expect(free).toContain(slots[0]);
    expect(free).not.toContain(slots[4]);

    const cancelled = await call(`/api/v1/appointments/${appointment.id}/cancel`, { method: "POST", who: owner, json: { reason: "Changed plans" } });
    expect((await cancelled.json()) as Appt).toMatchObject({ status: "cancelled", cancel_reason: "Changed plans" });
    const after = ((await (await call(`/api/v1/slots?service_id=${serviceId}&date=${date}`, { who: owner })).json()) as { slots: string[] }).slots;
    expect(after).toContain(slots[4]);
  });

  it("reuses a returning customer and fills in an email they didn't have", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const a = (await (await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "Mike", phone: "5035550109" } })).json()) as Created;
    const b = (await (await book(owner, { service_id: serviceId, start: slots[2], customer: { first_name: "Mike", phone: "(503) 555-0109", email: "mike@example.com" } })).json()) as Created;
    expect(b.appointment.customer.id).toBe(a.appointment.customer.id);
    const cus = (await (await call(`/api/v1/customers/${a.appointment.customer.id}`, { who: owner })).json()) as { email: string };
    expect(cus.email).toBe("mike@example.com");
  });

  it("respects the buffer between bookings", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { buffer_min: 15 } } });
    expect((await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550110" } })).status).toBe(201);
    // slots[2] is 09:30, right after the 09:00-09:30 booking: inside the 15-min buffer.
    expect((await book(owner, { service_id: serviceId, start: slots[2], customer: { first_name: "B", phone: "5035550111" } })).status).toBe(409);
    expect((await book(owner, { service_id: serviceId, start: slots[3], customer: { first_name: "C", phone: "5035550112" } })).status).toBe(201);
  });

  it("won't un-cancel onto a time someone else has taken", async () => {
    const { owner, serviceId, slots, date } = await bookableOwner();
    const a = (await (await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550113" } })).json()) as Created;
    await call(`/api/v1/appointments/${a.appointment.id}/cancel`, { method: "POST", who: owner, json: {} });
    expect((await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "B", phone: "5035550114" } })).status).toBe(201);

    for (const json of [{ status: "booked" }, { status: "confirmed", allow_outside_hours: true }]) {
      const res = await call(`/api/v1/appointments/${a.appointment.id}`, { method: "PATCH", who: owner, json });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("slot_taken");
    }
    const list = (await (await call(`/api/v1/appointments?from=${date}T00:00:00.000Z&to=${date}T23:59:59.000Z`, { who: owner })).json()) as { appointments: Appt[] };
    expect(list.appointments.filter((x) => x.status !== "cancelled")).toHaveLength(1);
  });

  it("un-cancels onto a free time", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const a = (await (await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550115" } })).json()) as Created;
    await call(`/api/v1/appointments/${a.appointment.id}/cancel`, { method: "POST", who: owner, json: { reason: "Oops" } });
    const res = await call(`/api/v1/appointments/${a.appointment.id}`, { method: "PATCH", who: owner, json: { status: "confirmed" } });
    expect(res.status).toBe(200);
    expect((await res.json()) as Appt).toMatchObject({ status: "confirmed", cancel_reason: null });
  });

  it("cancelling through PATCH works like the cancel endpoint", async () => {
    const { owner, serviceId, slots, date } = await bookableOwner();
    const a = (await (await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550116" } })).json()) as Created;
    const res = await call(`/api/v1/appointments/${a.appointment.id}`, { method: "PATCH", who: owner, json: { status: "cancelled" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Appt).status).toBe("cancelled");
    const row = await env.DB.prepare("SELECT ics_sequence FROM appointments WHERE id = ?").bind(a.appointment.id).first<{ ics_sequence: number }>();
    expect(row!.ics_sequence).toBe(1);
    const free = ((await (await call(`/api/v1/slots?service_id=${serviceId}&date=${date}`, { who: owner })).json()) as { slots: string[] }).slots;
    expect(free).toContain(slots[0]);
  });

  it("won't move an appointment that isn't active", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const a = (await (await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550117" } })).json()) as Created;
    await call(`/api/v1/appointments/${a.appointment.id}`, { method: "PATCH", who: owner, json: { status: "done" } });
    const res = await call(`/api/v1/appointments/${a.appointment.id}`, { method: "PATCH", who: owner, json: { start: slots[4] } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_active");
  });

  it("keeps the details given for each appointment, and clears them when the customer is deleted", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const a = (await (await book(owner, { service_id: serviceId, start: slots[0], customer: { first_name: "Mike", phone: "5035550118" } })).json()) as Created;
    expect((a.appointment as Appt & { contact: unknown }).contact).toEqual({ first_name: "Mike", last_name: "", phone: "5035550118", email: null });
    await call(`/api/v1/customers/${a.appointment.customer.id}`, { method: "PATCH", who: owner, json: { last_name: "Ross" } });
    const b = (await (await book(owner, { service_id: serviceId, start: slots[4], customer_id: a.appointment.customer.id })).json()) as Created;
    expect((b.appointment as Appt & { contact: unknown }).contact).toEqual({ first_name: "Mike", last_name: "Ross", phone: "5035550118", email: null });

    expect((await call(`/api/v1/customers/${a.appointment.customer.id}`, { method: "DELETE", who: owner })).status).toBe(204);
    const after = (await (await call(`/api/v1/appointments/${a.appointment.id}`, { who: owner })).json()) as { contact: unknown };
    expect(after.contact).toEqual({ first_name: "Deleted", last_name: "", phone: null, email: null });
  });
});
