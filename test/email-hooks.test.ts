import { describe, it, expect } from "vitest";
import { bookableOwner, call, testEnv } from "./helpers";
import { runDueJobs, type OutgoingEmail } from "../src/worker/email/outbox";
import { reminderAt } from "../src/worker/email/reminder-time";
import { parseNotifications } from "../src/worker/settings";
import type { Bindings } from "../src/worker/types";

type Job = { kind: string; run_at: number; payload: string; done_at: number | null; result: string | null };
const jobs = async (appointmentId: string) =>
  (await testEnv.DB.prepare("SELECT kind, run_at, payload, done_at, result FROM jobs WHERE json_extract(payload, '$.appointment_id') = ? ORDER BY rowid")
    .bind(appointmentId)
    .all<Job>()).results;
/** The kinds still waiting to be sent, sorted, without the "email." prefix. */
const open = async (id: string) => (await jobs(id)).filter((j) => j.done_at === null).map((j) => j.kind.slice(6)).sort();
const openReminders = async (id: string) => (await jobs(id)).filter((j) => j.done_at === null && j.kind === "email.customer.reminder");

type Booked = { appointment: { id: string; start: string }; manage_token: string };
let phone = 1000;
const nextPhone = () => `503-555-${String(phone++).padStart(4, "0")}`;

async function publicBook(email = "cust@example.com", slot = 0) {
  const b = await bookableOwner();
  const res = await call(`/api/public/${b.owner.slug}/book`, {
    method: "POST",
    json: { service_id: b.serviceId, start: b.slots[slot], first_name: "Cam", phone: nextPhone(), email },
  });
  expect(res.status).toBe(201);
  return { ...b, booked: (await res.json()) as Booked };
}

async function ownerBook(start?: string) {
  const b = await bookableOwner();
  const res = await call("/api/v1/appointments", {
    method: "POST", who: b.owner,
    json: { service_id: b.serviceId, start: start ?? b.slots[0], customer: { first_name: "Dee", phone: nextPhone(), email: "dee@example.com" }, allow_outside_hours: !!start },
  });
  expect(res.status).toBe(201);
  return { ...b, id: ((await res.json()) as { appointment: { id: string } }).appointment.id };
}

describe("emails queued by booking changes", () => {
  it("a booking from the booking page: confirmation, owner notice and a reminder at the right time", async () => {
    const { booked } = await publicBook();
    expect(await open(booked.appointment.id)).toEqual(["customer.booked", "customer.reminder", "owner.new"]);
    const [reminder] = await openReminders(booked.appointment.id);
    const start = Date.parse(booked.appointment.start);
    expect(reminder.run_at).toBe(reminderAt(start, parseNotifications("{}"), "America/Los_Angeles"));
    expect(JSON.parse(reminder.payload).start).toBe(start);
  });

  it("a booking the owner makes doesn't email the owner", async () => {
    const { id } = await ownerBook();
    expect(await open(id)).toEqual(["customer.booked", "customer.reminder"]);
  });

  it("no reminder when its time has already passed", async () => {
    const soon = new Date(Math.ceil((Date.now() + 30 * 60_000) / 60_000) * 60_000).toISOString();
    const { id } = await ownerBook(soon);
    expect(await open(id)).toEqual(["customer.booked"]);
  });

  it("rescheduling from the link: change notices, and exactly one reminder, for the new time", async () => {
    const { booked, slots } = await publicBook();
    const moved = await call(`/api/public/manage/${booked.manage_token}/reschedule`, { method: "POST", json: { start: slots[4] } });
    expect(moved.status).toBe(200);
    const id = booked.appointment.id;
    expect(await open(id)).toEqual(["customer.booked", "customer.changed", "customer.reminder", "owner.changed", "owner.new"]);
    const reminders = await openReminders(id);
    expect(reminders).toHaveLength(1);
    expect(JSON.parse(reminders[0].payload).start).toBe(Date.parse(slots[4]));
  });

  it("cancelling from the link: cancellation notices, and the reminder is called off", async () => {
    const { booked } = await publicBook();
    expect((await call(`/api/public/manage/${booked.manage_token}/cancel`, { method: "POST", json: {} })).status).toBe(200);
    const kinds = await open(booked.appointment.id);
    expect(kinds).toContain("customer.cancelled");
    expect(kinds).toContain("owner.cancelled");
    expect(kinds).not.toContain("customer.reminder");
  });

  it("'delete my data' tells only the owner, and calls off the reminder", async () => {
    const { booked } = await publicBook();
    expect((await call(`/api/public/manage/${booked.manage_token}/delete-my-data`, { method: "POST" })).status).toBe(204);
    expect(await open(booked.appointment.id)).toEqual(["customer.booked", "owner.cancelled", "owner.new"]);
  });

  it("the owner's note edits and status changes queue nothing; a second cancel doesn't email again", async () => {
    const { owner, id } = await ownerBook();
    const before = (await jobs(id)).length;
    await call(`/api/v1/appointments/${id}`, { method: "PATCH", who: owner, json: { note: "hi" } });
    await call(`/api/v1/appointments/${id}`, { method: "PATCH", who: owner, json: { status: "confirmed" } });
    expect((await jobs(id)).length).toBe(before);
    await call(`/api/v1/appointments/${id}/cancel`, { method: "POST", who: owner, json: {} });
    await call(`/api/v1/appointments/${id}/cancel`, { method: "POST", who: owner, json: {} });
    await call(`/api/v1/appointments/${id}`, { method: "PATCH", who: owner, json: { status: "cancelled" } });
    expect((await jobs(id)).filter((j) => j.kind === "email.customer.cancelled")).toHaveLength(1);
  });

  it("an unchanged start sends no change notice; a service change does, still with one reminder", async () => {
    const { owner, id, slots } = await ownerBook();
    await call(`/api/v1/appointments/${id}`, { method: "PATCH", who: owner, json: { start: slots[0] } });
    expect(await open(id)).toEqual(["customer.booked", "customer.reminder"]);
    const other = (await (await call("/api/v1/services", { method: "POST", who: owner, json: { name: "Other", duration_min: 30 } })).json()) as { id: string };
    expect((await call(`/api/v1/appointments/${id}`, { method: "PATCH", who: owner, json: { service_id: other.id } })).status).toBe(200);
    expect(await open(id)).toEqual(["customer.booked", "customer.changed", "customer.reminder"]);
  });

  it("cancel then reopen: a fresh confirmation and one reminder", async () => {
    const { owner, id } = await ownerBook();
    await call(`/api/v1/appointments/${id}/cancel`, { method: "POST", who: owner, json: {} });
    expect((await call(`/api/v1/appointments/${id}`, { method: "PATCH", who: owner, json: { status: "booked" } })).status).toBe(200);
    expect(await open(id)).toEqual(["customer.booked", "customer.booked", "customer.cancelled", "customer.reminder"]);
  });

  it("end to end: after a reschedule, exactly one reminder is sent", async () => {
    const { booked, slots } = await publicBook("e2e@example.com");
    await call(`/api/public/manage/${booked.manage_token}/reschedule`, { method: "POST", json: { start: slots[6] } });
    const env = { ...testEnv, EMAIL_FROM: "bookings@cal.example" } as Bindings;
    const sent: OutgoingEmail[] = [];
    const now = Date.parse(slots[6]) - 3600_000;
    while ((await runDueJobs(env, now, async (m) => void sent.push(m))) > 0);
    const mine = sent.filter((m) => m.to === "e2e@example.com");
    expect(mine.filter((m) => m.subject.startsWith("Reminder:"))).toHaveLength(1);
    expect(mine.map((m) => m.subject.split(" ")[0]).sort()).toEqual(["Reminder:", "Your", "Your"]);
  });
});

describe("sending limits", () => {
  it("a fourth booking for the same address in a day gets no customer emails (the owner is still told)", async () => {
    const b = await bookableOwner();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await call(`/api/public/${b.owner.slug}/book`, {
        method: "POST",
        json: { service_id: b.serviceId, start: b.slots[i * 2], first_name: "Spam", phone: nextPhone(), email: "victim@example.com" },
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as Booked).appointment.id);
    }
    expect(await open(ids[2])).toEqual(["customer.booked", "customer.reminder", "owner.new"]);
    expect(await open(ids[3])).toEqual(["owner.new"]);
  });

  it("a booking changed many times by its link stops emailing its customer (the owner is still told)", async () => {
    const { booked, slots } = await publicBook();
    await testEnv.DB.prepare("UPDATE appointments SET ics_sequence = 5 WHERE id = ?").bind(booked.appointment.id).run();
    const before = (await jobs(booked.appointment.id)).map((j) => j.kind);
    expect((await call(`/api/public/manage/${booked.manage_token}/reschedule`, { method: "POST", json: { start: slots[4] } })).status).toBe(200);
    expect((await call(`/api/public/manage/${booked.manage_token}/cancel`, { method: "POST", json: {} })).status).toBe(200);
    const added = (await jobs(booked.appointment.id)).slice(before.length).map((j) => j.kind).sort();
    expect(added).toEqual(["email.owner.cancelled", "email.owner.changed"]);
  });
});
