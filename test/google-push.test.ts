import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "../src/worker/google/connection";
import { eventIdFor, runGoogleJobs } from "../src/worker/google/push";
import { runDueJobs } from "../src/worker/email/outbox";
import { bookableOwner, call, testEnv } from "./helpers";
import { calendarIdOf, connectForTest, FakeGoogle, PRIMARY, WORK } from "./google-fake";

let fake: FakeGoogle;
beforeEach(() => {
  fake = new FakeGoogle();
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});
afterEach(() => vi.restoreAllMocks());

const db = () => testEnv.DB;
type Job = { id: string; payload: string; done_at: number | null; result: string | null; attempts: number; run_at: number };
const pushJobs = (calId: string) =>
  db().prepare("SELECT id, payload, done_at, result, attempts, run_at FROM jobs WHERE calendar_id = ? AND kind = 'google.push' ORDER BY rowid").bind(calId).all<Job>().then((r) => r.results);
const pending = async (calId: string) => (await pushJobs(calId)).filter((j) => j.done_at === null);
const apptRow = (id: string) => db().prepare("SELECT * FROM appointments WHERE id = ?").bind(id).first<Record<string, unknown>>();

/** Events in that Google calendar made by this test's booking calendar (other tests' leftover jobs can run here too). */
const mine = (googleCal: string, calId: string) => fake.live(googleCal).filter((e) => e.extendedProperties?.private?.bookingCalendarCal === calId);

/** Run push jobs until this calendar has none due (other files' jobs may share the queue). */
async function drain(calId: string) {
  for (let i = 0; i < 20; i++) {
    const due = (await pending(calId)).filter((j) => j.run_at <= Date.now());
    if (!due.length) return;
    await runGoogleJobs(testEnv, Date.now());
  }
}

async function setup(connect = true) {
  const b = await bookableOwner();
  const calId = await calendarIdOf(b.owner.slug);
  if (connect) await connectForTest(calId);
  return { ...b, calId };
}

let phone = 5035550200;
async function bookPublic(slug: string, serviceId: string, start: string) {
  const res = await call(`/api/public/${slug}/book`, { method: "POST", json: { service_id: serviceId, start, first_name: "Ann", last_name: "Lee", phone: String(phone++), note: "Gate code 12" } });
  expect(res.status).toBe(201);
  return (await res.json()) as { appointment: { id: string }; manage_token: string };
}

describe("queueing pushes", () => {
  it("a booking on a connected calendar queues one push; not connected or broken queues none", async () => {
    const s = await setup();
    const { appointment } = await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    expect((await pending(s.calId)).map((j) => j.payload)).toEqual([JSON.stringify({ appointment_id: appointment.id })]);

    const off = await setup(false);
    await bookPublic(off.owner.slug, off.serviceId, off.slots[0]);
    expect(await pushJobs(off.calId)).toEqual([]);

    const broken = await setup(false);
    await connectForTest(broken.calId, { status: "broken" });
    await bookPublic(broken.owner.slug, broken.serviceId, broken.slots[0]);
    expect(await pushJobs(broken.calId)).toEqual([]);
  });

  it("dedupes waiting pushes, but not one already started", async () => {
    const s = await setup();
    const { appointment } = await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await call(`/api/v1/appointments/${appointment.id}`, { method: "PATCH", who: s.owner, json: { start: s.slots[2] } });
    expect(await pending(s.calId)).toHaveLength(1);
    await db().prepare("UPDATE jobs SET attempts = 1 WHERE calendar_id = ? AND kind = 'google.push'").bind(s.calId).run();
    await call(`/api/v1/appointments/${appointment.id}`, { method: "PATCH", who: s.owner, json: { start: s.slots[4] } });
    expect(await pending(s.calId)).toHaveLength(2);
  });

  it("every way a booking changes queues a push", async () => {
    const s = await setup();
    const queued = async (fn: () => Promise<unknown>) => {
      await db().prepare("UPDATE jobs SET done_at = 1 WHERE calendar_id = ? AND kind = 'google.push'").bind(s.calId).run();
      await fn();
      return (await pending(s.calId)).length;
    };
    const own = ((await (await call("/api/v1/appointments", { method: "POST", who: s.owner, json: { service_id: s.serviceId, start: s.slots[0], customer: { first_name: "Bo", phone: "5035550299" } } })).json()) as { appointment: { id: string } }).appointment;
    expect((await pending(s.calId)).length).toBe(1);
    const patch = (json: unknown) => call(`/api/v1/appointments/${own.id}`, { method: "PATCH", who: s.owner, json });
    expect(await queued(() => patch({ start: s.slots[2] }))).toBe(1);
    expect(await queued(() => patch({ note: "bring ladder" }))).toBe(1);
    expect(await queued(() => call(`/api/v1/appointments/${own.id}/cancel`, { method: "POST", who: s.owner, json: {} }))).toBe(1);
    expect(await queued(() => patch({ status: "booked" }))).toBe(1);

    const pub = await bookPublic(s.owner.slug, s.serviceId, s.slots[6]);
    const m = (path: string, json: unknown = {}) => call(`/api/public/manage/${pub.manage_token}/${path}`, { method: "POST", json });
    expect(await queued(() => m("reschedule", { start: s.slots[8] }))).toBe(1);
    expect(await queued(() => m("cancel", { reason: "sick" }))).toBe(1);
    // Already cancelled, so no email: but its details must still come off Google.
    expect(await queued(() => m("delete-my-data"))).toBe(1);
  });

  it("deleting a customer queues a push for each of their bookings already in Google", async () => {
    const s = await setup();
    const a = await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await drain(s.calId);
    const customerId = (await apptRow(a.appointment.id))!.customer_id as string;
    expect((await call(`/api/v1/customers/${customerId}`, { method: "DELETE", who: s.owner })).status).toBe(204);
    expect(await pending(s.calId)).toHaveLength(1);
    await drain(s.calId);
    const ev = fake.events.get(PRIMARY)!.get(await eventIdFor(a.appointment.id))!;
    expect(ev.summary).toBe("Call – Deleted");
    expect(ev.description).not.toMatch(/Phone|Email|Note/);
  });
});

describe("runGoogleJobs", () => {
  it("creates the event, then updates the same one; results are 'done', not 'sent'", async () => {
    const s = await setup();
    const sentBefore = (await db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE result = 'sent'").first<{ n: number }>())!.n;
    const { appointment } = await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await drain(s.calId);
    const id = await eventIdFor(appointment.id);
    const ev = fake.events.get(PRIMARY)!.get(id)!;
    expect(ev.summary).toBe("Call – Ann Lee");
    expect(ev.description).toContain("Gate code 12");
    expect((ev.start as { dateTime: string }).dateTime).toBe(new Date(s.slots[0]).toISOString());
    expect(ev.extendedProperties!.private).toEqual({ bookingCalendarAppt: appointment.id, bookingCalendarCal: s.calId });
    expect((await apptRow(appointment.id))!.google_event_id).toBe(id);
    expect((await pushJobs(s.calId)).map((j) => j.result)).toEqual(["done"]);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE result = 'sent'").first<{ n: number }>())!.n).toBe(sentBefore);

    await call(`/api/v1/appointments/${appointment.id}`, { method: "PATCH", who: s.owner, json: { start: s.slots[2] } });
    await drain(s.calId);
    expect(mine(PRIMARY, s.calId)).toHaveLength(1);
    expect((fake.events.get(PRIMARY)!.get(id)!.start as { dateTime: string }).dateTime).toBe(new Date(s.slots[2]).toISOString());
  });

  it("a lost reply or a repeated job still leaves one event", async () => {
    const s = await setup();
    const { appointment } = await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await drain(s.calId);
    await db().prepare("UPDATE appointments SET google_event_id = NULL WHERE id = ?").bind(appointment.id).run();
    await db().prepare("UPDATE jobs SET done_at = NULL, attempts = 0, run_at = ? WHERE calendar_id = ? AND kind = 'google.push'").bind(Date.now() - 1, s.calId).run();
    await drain(s.calId);
    expect(mine(PRIMARY, s.calId)).toHaveLength(1);
    expect(fake.calls.some((c) => c.method === "POST" && c.url.includes("/events"))).toBe(true);
  });

  it("cancel removes the event; reopening brings it back", async () => {
    const s = await setup();
    const own = ((await (await call("/api/v1/appointments", { method: "POST", who: s.owner, json: { service_id: s.serviceId, start: s.slots[0], customer: { first_name: "Cy", phone: "5035550298" } } })).json()) as { appointment: { id: string } }).appointment;
    await drain(s.calId);
    await call(`/api/v1/appointments/${own.id}/cancel`, { method: "POST", who: s.owner, json: {} });
    await drain(s.calId);
    expect(mine(PRIMARY, s.calId)).toEqual([]);
    expect((await apptRow(own.id))!.google_event_id).toBeNull();
    await call(`/api/v1/appointments/${own.id}`, { method: "PATCH", who: s.owner, json: { status: "booked" } });
    await drain(s.calId);
    expect(mine(PRIMARY, s.calId)).toHaveLength(1);
  });

  it("a push that read the booking before a cancel can't leave it in Google", async () => {
    const s = await setup();
    const own = ((await (await call("/api/v1/appointments", { method: "POST", who: s.owner, json: { service_id: s.serviceId, start: s.slots[0], customer: { first_name: "Di", phone: "5035550297" } } })).json()) as { appointment: { id: string } }).appointment;
    // Cancel lands while the first push is talking to Google.
    const real = fake.fetch;
    let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await real(input, init);
      if (!cancelled && (init?.method === "POST" || init?.method === "PUT") && String(input).includes("/events")) {
        cancelled = true;
        await call(`/api/v1/appointments/${own.id}/cancel`, { method: "POST", who: s.owner, json: {} });
      }
      return res;
    });
    await drain(s.calId);
    expect(mine(PRIMARY, s.calId)).toEqual([]);
    expect((await apptRow(own.id))!.google_event_id).toBeNull();
  });

  it("skips when the connection broke, retries Google errors, and gives up after 5", async () => {
    const s = await setup();
    await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await db().prepare("UPDATE google_connections SET status = 'broken' WHERE calendar_id = ?").bind(s.calId).run();
    fake.calls = [];
    await drain(s.calId);
    expect((await pushJobs(s.calId)).map((j) => j.result)).toEqual(["skipped:not_connected"]);
    expect(fake.calls).toEqual([]);

    await db().prepare("UPDATE google_connections SET status = 'active' WHERE calendar_id = ?").bind(s.calId).run();
    await bookPublic(s.owner.slug, s.serviceId, s.slots[4]);
    fake.fail["/events"] = { status: 500 };
    await runGoogleJobs(testEnv, Date.now());
    const [job] = await pending(s.calId);
    expect(job.attempts).toBe(1);
    expect(job.run_at - Date.now()).toBeGreaterThan(50_000);
    for (let i = 0; i < 4; i++) {
      await db().prepare("UPDATE jobs SET run_at = ? WHERE id = ?").bind(Date.now() - 1, job.id).run();
      await runGoogleJobs(testEnv, Date.now());
    }
    expect((await pushJobs(s.calId)).at(-1)!.result).toBe("failed:500_unknown");
  });

  it("a removed permission marks the connection broken", async () => {
    const s = await setup();
    await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    fake.fail["/events"] = { status: 403, reason: "insufficientPermissions" };
    await drain(s.calId);
    expect((await pushJobs(s.calId))[0].result).toBe("failed:403_insufficientPermissions");
    const conn = await getConnection(db(), s.calId);
    expect([conn!.status, conn!.last_error]).toEqual(["broken", "missing_permission"]);
  });

  it("remove_from deletes from the old calendar only, and never from the one in use", async () => {
    const s = await setup();
    const { appointment } = await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await drain(s.calId);
    const id = await eventIdFor(appointment.id);
    fake.addEvent(WORK, { id, summary: "copy" });
    const queue = (from: string) => db().prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at) VALUES (?, ?, 'google.push', ?, ?)")
      .bind(`job_rm_${from.length}_${Date.now()}`, s.calId, JSON.stringify({ appointment_id: appointment.id, remove_from: from }), Date.now() - 1).run();
    await queue(PRIMARY);
    await drain(s.calId);
    expect((await pushJobs(s.calId)).at(-1)!.result).toBe("skipped:current_calendar");
    expect(mine(PRIMARY, s.calId)).toHaveLength(1);
    await queue(WORK);
    await drain(s.calId);
    expect(fake.live(WORK)).toEqual([]);
    expect(mine(PRIMARY, s.calId)).toHaveLength(1);
  });

  it("a failing old calendar never breaks the connection; a failed booking push is shown", async () => {
    const s = await setup();
    const { appointment } = await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await drain(s.calId);
    await db().prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at) VALUES (?, ?, 'google.push', ?, ?)")
      .bind(`job_rm403_${Date.now()}`, s.calId, JSON.stringify({ appointment_id: appointment.id, remove_from: WORK }), Date.now() - 1).run();
    fake.fail[encodeURIComponent(WORK)] = { status: 403, reason: "forbidden" };
    await drain(s.calId);
    expect((await pushJobs(s.calId)).at(-1)!.result).toBe("failed:403_forbidden");
    expect((await getConnection(db(), s.calId))!.status).toBe("active");

    fake.fail = { "/events": { status: 500 } };
    await call(`/api/v1/appointments/${appointment.id}`, { method: "PATCH", who: s.owner, json: { start: s.slots[2] } });
    for (let i = 0; i < 6; i++) {
      await db().prepare("UPDATE jobs SET run_at = ? WHERE calendar_id = ? AND done_at IS NULL").bind(Date.now() - 1, s.calId).run();
      await runGoogleJobs(testEnv, Date.now());
    }
    expect((await getConnection(db(), s.calId))!.push_error).toBe("500_unknown");
    fake.fail = {};
    await call(`/api/v1/appointments/${appointment.id}`, { method: "PATCH", who: s.owner, json: { start: s.slots[4] } });
    await drain(s.calId);
    expect((await getConnection(db(), s.calId))!.push_error).toBeNull();
  });

  it("the email runner never takes Google jobs", async () => {
    const s = await setup();
    await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await runDueJobs(testEnv, Date.now(), async () => {});
    expect((await pending(s.calId))[0].attempts).toBe(0);
  });
});
