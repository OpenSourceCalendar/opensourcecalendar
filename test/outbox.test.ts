import { describe, it, expect } from "vitest";
import { bookableOwner, call, testEnv } from "./helpers";
import { enqueueEmail, runDueJobs, type EmailKind, type OutgoingEmail } from "../src/worker/email/outbox";
import type { Bindings } from "../src/worker/types";

const ORIGIN = "https://cal.example";
const env = (extra: Partial<Bindings> = {}) => ({ ...testEnv, EMAIL_FROM: "bookings@cal.example", ...extra }) as Bindings;
type Job = { kind: string; done_at: number | null; attempts: number; run_at: number; result: string | null };
const jobsFor = async (appointmentId: string) =>
  (await testEnv.DB.prepare("SELECT kind, done_at, attempts, run_at, result FROM jobs WHERE json_extract(payload, '$.appointment_id') = ? ORDER BY rowid")
    .bind(appointmentId)
    .all<Job>()).results;

/** A calendar with one booking (made by the owner); its queue starts empty. */
async function booked(email: string | null = "pat@example.com") {
  const { owner, serviceId, slots } = await bookableOwner();
  const res = await call("/api/v1/appointments", {
    method: "POST", who: owner,
    json: { service_id: serviceId, start: slots[0], customer: { first_name: "Pat", phone: "503-555-0140", ...(email && { email }) }, note: "Back gate" },
  });
  const { appointment } = (await res.json()) as { appointment: { id: string; start: string } };
  const cal = (await (await call("/api/v1/calendar", { who: owner })).json()) as { id: string };
  await testEnv.DB.prepare("DELETE FROM jobs WHERE calendar_id = ?").bind(cal.id).run();
  return { owner, calendarId: cal.id, appointmentId: appointment.id, start: Date.parse(appointment.start) };
}
const queue = (b: { calendarId: string; appointmentId: string }, kind: EmailKind, runAt = 0, extra: { start?: number } = {}) =>
  testEnv.DB.batch([enqueueEmail(testEnv.DB, b.calendarId, kind, { appointment_id: b.appointmentId, origin: ORIGIN, ...extra }, runAt)]);
/** Run the queue until nothing more is due (other tests' jobs may be in it too). */
async function drain(e: Bindings, now: number, send: (m: OutgoingEmail) => Promise<void>) {
  while ((await runDueJobs(e, now, send)) > 0);
}

describe("outbox", () => {
  it("sends a queued email once and records it", async () => {
    const b = await booked();
    await queue(b, "email.customer.booked", 1000);
    const sent: OutgoingEmail[] = [];
    await drain(env(), 2000, async (m) => void sent.push(m));
    const mine = sent.filter((m) => m.to === "pat@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/confirmed/i);
    expect(mine[0].text).toContain(`${ORIGIN}/m/`);
    expect(mine[0].attachments?.[0]).toMatchObject({ filename: "appointment.ics", type: "text/calendar" });
    expect(atob(mine[0].attachments![0].content)).toContain(`UID:${b.appointmentId}@booking-calendar`);
    // Customer emails never carry what was typed on the booking.
    expect(mine[0].text).not.toContain("Back gate");
    expect(mine[0].text).not.toContain("Pat");
    expect(await jobsFor(b.appointmentId)).toMatchObject([{ done_at: 2000, result: "sent" }]);
    await drain(env(), 3000, async (m) => void sent.push(m));
    expect(sent.filter((m) => m.to === "pat@example.com")).toHaveLength(1); // not twice
  });

  it("leaves jobs that aren't due yet", async () => {
    const b = await booked();
    await queue(b, "email.customer.booked", Date.now() + 3600_000);
    await drain(env(), Date.now(), async () => {});
    expect((await jobsFor(b.appointmentId))[0].done_at).toBeNull();
  });

  it("retries a failed send later, and gives up after 5 tries", async () => {
    const b = await booked();
    await queue(b, "email.customer.booked", 0);
    const fail = async (m: OutgoingEmail) => {
      if (m.to === "pat@example.com") throw Object.assign(new Error("busy"), { code: "E_RATE_LIMIT_EXCEEDED" });
    };
    let now = 1000;
    for (let i = 1; i <= 5; i++) {
      await drain(env(), now, fail);
      const [job] = await jobsFor(b.appointmentId);
      expect(job.attempts).toBe(i);
      if (i < 5) {
        expect(job.done_at).toBeNull();
        expect(job.run_at).toBeGreaterThan(now);
        now = job.run_at;
      } else expect(job).toMatchObject({ done_at: now, result: "failed:E_RATE_LIMIT_EXCEEDED" });
    }
  });

  it("doesn't retry an error that can't succeed", async () => {
    const b = await booked();
    await queue(b, "email.customer.booked", 0);
    await drain(env(), 1000, async (m) => {
      if (m.to === "pat@example.com") throw Object.assign(new Error("bad"), { code: "E_VALIDATION_ERROR" });
    });
    expect(await jobsFor(b.appointmentId)).toMatchObject([{ done_at: 1000, result: "failed:E_VALIDATION_ERROR" }]);
  });

  it("waits an hour on the daily sending limit without using up a try", async () => {
    const b = await booked();
    await queue(b, "email.customer.booked", 1000);
    await drain(env(), 1000, async (m) => {
      if (m.to === "pat@example.com") throw Object.assign(new Error("quota"), { code: "E_DAILY_LIMIT_EXCEEDED" });
    });
    const [job] = await jobsFor(b.appointmentId);
    expect(job).toMatchObject({ attempts: 0, done_at: null });
    expect(job.run_at).toBeGreaterThanOrEqual(Date.now() + 3500_000);
  });

  it("skips, without sending, and says why", async () => {
    const sent: OutgoingEmail[] = [];
    const send = async (m: OutgoingEmail) => void sent.push(m);

    const noEmail = await booked(null);
    await queue(noEmail, "email.customer.booked");
    const off = await booked("off@example.com");
    await call("/api/v1/calendar", { method: "PATCH", who: off.owner, json: { notifications: { customer_confirmation: false } } });
    await queue(off, "email.customer.booked");
    const cancelled = await booked("gone@example.com");
    await call(`/api/v1/appointments/${cancelled.appointmentId}/cancel`, { method: "POST", who: cancelled.owner, json: {} });
    await testEnv.DB.prepare("DELETE FROM jobs WHERE calendar_id = ?").bind(cancelled.calendarId).run();
    await queue(cancelled, "email.customer.booked");
    const noOrigin = await booked("o@example.com");
    await testEnv.DB.batch([enqueueEmail(testEnv.DB, noOrigin.calendarId, "email.customer.booked", { appointment_id: noOrigin.appointmentId, origin: "http://evil.example" }, 0)]);
    await drain(env(), 1000, send);
    expect(sent.filter((m) => ["off@example.com", "gone@example.com", "o@example.com"].includes(m.to))).toHaveLength(0);
    expect((await jobsFor(noEmail.appointmentId))[0].result).toBe("skipped:no_address");
    expect((await jobsFor(off.appointmentId))[0].result).toBe("skipped:turned_off");
    expect((await jobsFor(cancelled.appointmentId))[0].result).toBe("skipped:cancelled");
    expect((await jobsFor(noOrigin.appointmentId))[0].result).toBe("skipped:no_origin");

    const unconfigured = await booked("u@example.com");
    await queue(unconfigured, "email.customer.booked");
    await drain(env({ EMAIL_FROM: "" }), 1000, send);
    expect(sent.filter((m) => m.to === "u@example.com")).toHaveLength(0);
    expect((await jobsFor(unconfigured.appointmentId))[0].result).toBe("skipped:not_configured");
  });

  it("PUBLIC_URL wins over the origin the booking came from", async () => {
    const b = await booked("pub@example.com");
    await queue(b, "email.customer.booked");
    const sent: OutgoingEmail[] = [];
    await drain(env({ PUBLIC_URL: "https://book.example.com" }), 1000, async (m) => void sent.push(m));
    expect(sent.find((m) => m.to === "pub@example.com")!.text).toContain("https://book.example.com/m/");
  });

  it("a reminder is skipped once the appointment has moved", async () => {
    const b = await booked("rem@example.com");
    await queue(b, "email.customer.reminder", 0, { start: b.start - 3600_000 });
    const sent: OutgoingEmail[] = [];
    await drain(env(), 1000, async (m) => void sent.push(m));
    expect((await jobsFor(b.appointmentId))[0].result).toBe("skipped:moved");
    await queue(b, "email.customer.reminder", 0, { start: b.start });
    await drain(env(), 2000, async (m) => void sent.push(m));
    const mine = sent.filter((m) => m.to === "rem@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/^Reminder:/);
    expect(mine[0].attachments).toBeUndefined();
  });

  it("owner emails go to owner_email, reply to the customer, and need an address", async () => {
    const b = await booked("cust@example.com");
    const sent: OutgoingEmail[] = [];
    await queue(b, "email.owner.new");
    await drain(env(), 1000, async (m) => void sent.push(m));
    expect((await jobsFor(b.appointmentId))[0].result).toBe("skipped:no_address");
    expect((await call("/api/v1/calendar", { method: "PATCH", who: b.owner, json: { notifications: { owner_email: "owner@example.com" } } })).status).toBe(200);
    await queue(b, "email.owner.new");
    await drain(env(), 2000, async (m) => void sent.push(m));
    const mail = sent.find((m) => m.to === "owner@example.com")!;
    expect(mail.replyTo).toBe("cust@example.com");
    expect(mail.text).toContain(`${ORIGIN}/admin/schedule`);
    expect(mail.text).toContain("Back gate"); // the owner does see the note
    expect(mail.attachments).toBeUndefined();
  });

  it("an owner_email that isn't an address is refused", async () => {
    const b = await booked();
    expect((await call("/api/v1/calendar", { method: "PATCH", who: b.owner, json: { notifications: { owner_email: "nope" } } })).status).toBe(400);
  });

  it("clears out finished jobs after 30 days, when asked", async () => {
    const b = await booked("old@example.com");
    await queue(b, "email.customer.booked");
    await drain(env(), 1000, async () => {});
    await runDueJobs(env(), 1000 + 29 * 86_400_000, async () => {}, { cleanUp: true });
    expect(await jobsFor(b.appointmentId)).toHaveLength(1);
    await runDueJobs(env(), 1000 + 31 * 86_400_000, async () => {}, { cleanUp: true });
    expect(await jobsFor(b.appointmentId)).toHaveLength(0);
  });
});
