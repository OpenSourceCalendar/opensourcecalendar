import { describe, it, expect } from "vitest";
import { bookableOwner, call, createApp, newOwner } from "./helpers";

async function seed() {
  const owner = await newOwner();
  const svc = (await (await call("/api/v1/services", { method: "POST", who: owner, json: { name: "Secret", duration_min: 30 } })).json()) as { id: string };
  const cus = (await (await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "Private", phone: "5035559999", external_ref: "lead_secret" } })).json()) as { customer: { id: string } };
  const blk = (await (await call("/api/v1/availability/blocked", { method: "POST", who: owner, json: { start_date: "2099-01-01", end_date: "2099-01-02" } })).json()) as { id: string };
  const tb = (await (await call("/api/v1/availability/time-blocks", { method: "POST", who: owner, json: { start_at: "2099-01-05T20:00:00.000Z", end_at: "2099-01-05T21:00:00.000Z" } })).json()) as { id: string };
  return { owner, svc: svc.id, cus: cus.customer.id, blk: blk.id, tb: tb.id };
}

describe("privacy between accounts", () => {
  for (const [label, makeIntruder] of [
    ["another user of the same app", async (key: string) => ({ ...(await newOwnerWithKey(key)) })],
    ["a user of another app", async (_key: string) => await newOwner()],
  ] as const) {
    it(`${label} can't read, change or delete anything`, async () => {
      const victim = await seed();
      const intruder = await makeIntruder(victim.owner.key);
      const tries: [string, string, unknown?][] = [
        ["PATCH", `/api/v1/services/${victim.svc}`, { name: "x" }],
        ["DELETE", `/api/v1/services/${victim.svc}`],
        ["GET", `/api/v1/customers/${victim.cus}`],
        ["PATCH", `/api/v1/customers/${victim.cus}`, { notes: "x" }],
        ["DELETE", `/api/v1/customers/${victim.cus}`],
        ["DELETE", `/api/v1/availability/blocked/${victim.blk}`],
        ["DELETE", `/api/v1/availability/time-blocks/${victim.tb}`],
        ["GET", `/api/v1/slots?service_id=${victim.svc}&date=2099-01-10`],
      ];
      for (const [method, path, json] of tries) {
        const res = await call(path, { method, who: intruder, json });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      const lists = await Promise.all([
        call("/api/v1/services", { who: intruder }).then((r) => r.json() as Promise<{ services: unknown[] }>),
        call("/api/v1/customers?q=Private", { who: intruder }).then((r) => r.json() as Promise<{ customers: unknown[] }>),
        call("/api/v1/customers?external_ref=lead_secret", { who: intruder }).then((r) => r.json() as Promise<{ customers: unknown[] }>),
      ]);
      expect(lists[0].services).toEqual([]);
      expect(lists[1].customers).toEqual([]);
      expect(lists[2].customers).toEqual([]);

      // The victim's data is untouched.
      expect((await call(`/api/v1/customers/${victim.cus}`, { who: victim.owner })).status).toBe(200);
    });
  }

  it("can't reorder another calendar's services or remove its one-day changes", async () => {
    const victim = await seed();
    const extra = (await (await call("/api/v1/services", { method: "POST", who: victim.owner, json: { name: "Second", duration_min: 30 } })).json()) as { id: string };
    await call("/api/v1/availability/overrides/2099-03-01", { method: "PUT", who: victim.owner, json: { closed: true } });
    const intruder = await newOwner();

    expect((await call("/api/v1/services/order", { method: "PUT", who: intruder, json: { ids: [extra.id, victim.svc] } })).status).toBe(204);
    expect((await call("/api/v1/availability/overrides/2099-03-01", { method: "DELETE", who: intruder })).status).toBe(404);

    const services = ((await (await call("/api/v1/services", { who: victim.owner })).json()) as { services: { id: string }[] }).services;
    expect(services.map((s) => s.id)).toEqual([victim.svc, extra.id]);
    const avail = (await (await call("/api/v1/availability", { who: victim.owner })).json()) as { overrides: { on_date: string }[]; blocked_dates: unknown[] };
    expect(avail.overrides.map((o) => o.on_date)).toEqual(["2099-03-01"]);
    const theirs = (await (await call("/api/v1/availability", { who: intruder })).json()) as { overrides: unknown[]; blocked_dates: unknown[] };
    expect(theirs.overrides).toEqual([]);
    expect(theirs.blocked_dates).toEqual([]);
  });

  it("the same user id under a different app is a different calendar", async () => {
    const victim = await seed();
    const otherKey = await createApp();
    const res = await call("/api/v1/calendar", { who: { key: otherKey, user: victim.owner.user } });
    expect(res.status).toBe(404);
  });

  it("can't see or change another calendar's appointments or reminders", async () => {
    const { owner, serviceId, slots, date } = await bookableOwner();
    const appt = (await (await call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, start: slots[0], customer: { first_name: "V", phone: "5035550901" } } })).json()) as { appointment: { id: string } };
    const rem = (await (await call("/api/v1/reminders", { method: "POST", who: owner, json: { at: slots[0], title: "x" } })).json()) as { id: string };
    const intruder = await newOwner();
    for (const [method, path, json] of [
      ["GET", `/api/v1/appointments/${appt.appointment.id}`],
      ["PATCH", `/api/v1/appointments/${appt.appointment.id}`, { status: "done" }],
      ["POST", `/api/v1/appointments/${appt.appointment.id}/cancel`, {}],
      ["PATCH", `/api/v1/reminders/${rem.id}`, { done: true }],
      ["DELETE", `/api/v1/reminders/${rem.id}`],
      ["POST", "/api/v1/appointments", { service_id: serviceId, start: slots[2], customer: { first_name: "I", phone: "5035550902" } }],
    ] as [string, string, unknown?][]) {
      expect((await call(path, { method, who: intruder, json })).status, `${method} ${path}`).toBe(404);
    }
    const range = `from=${date}T00:00:00.000Z&to=${date}T23:59:59.000Z`;
    expect(((await (await call(`/api/v1/appointments?${range}`, { who: intruder })).json()) as { appointments: unknown[] }).appointments).toEqual([]);
    expect(((await (await call(`/api/v1/reminders?${range}`, { who: intruder })).json()) as { reminders: unknown[] }).reminders).toEqual([]);
  });
});

async function newOwnerWithKey(key: string) {
  const user = `intruder-${crypto.randomUUID()}`;
  const slug = `in-${crypto.randomUUID().slice(0, 8)}`;
  const res = await call("/api/v1/calendar", { method: "POST", who: { key, user }, json: { slug, time_zone: "UTC" } });
  if (res.status !== 201) throw new Error(`intruder setup failed: ${res.status}`);
  return { key, user };
}
