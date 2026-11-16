import { describe, it, expect } from "vitest";
import { bookableOwner, call, testEnv } from "./helpers";
import { addressKey, MAX_EMAILS_PER_CALENDAR } from "../src/worker/email/limits";
import { enqueueEmail, runDueJobs, type OutgoingEmail } from "../src/worker/email/outbox";
import type { Bindings } from "../src/worker/types";

const env = { ...testEnv, EMAIL_FROM: "bookings@cal.example" } as Bindings;
type Booked = { appointment: { id: string }; manage_token: string };
const kinds = async (id: string) =>
  (await testEnv.DB.prepare("SELECT kind FROM jobs WHERE json_extract(payload, '$.appointment_id') = ? ORDER BY rowid").bind(id).all<{ kind: string }>()).results.map((r) => r.kind);
const job = async (id: string) =>
  (await testEnv.DB.prepare("SELECT done_at, result, attempts, run_at FROM jobs WHERE id = ?").bind(id).first<{ done_at: number | null; result: string | null; attempts: number; run_at: number }>())!;

describe("the per-inbox limit", () => {
  it("treats +tags, Gmail dots and letter case as the same inbox", async () => {
    const k = await addressKey("victim@gmail.com");
    for (const v of ["Victim@Gmail.com", "victim+1@gmail.com", "v.i.c.t.i.m@gmail.com", "victim+x@googlemail.com"]) expect(await addressKey(v)).toBe(k);
    expect(await addressKey("victim@example.com")).not.toBe(k);
    expect(await addressKey("v.ictim@example.com")).not.toBe(await addressKey("victim@example.com")); // dots matter elsewhere
  });

  it("can't be reset with 'delete my data' or dodged with address variants", async () => {
    const b = await bookableOwner();
    const variants = ["victim@gmail.com", "victim+2@gmail.com", "vic.tim@gmail.com", "VICTIM+4@gmail.com"];
    const ids: string[] = [];
    for (let i = 0; i < variants.length; i++) {
      const res = await call(`/api/public/${b.owner.slug}/book`, {
        method: "POST",
        json: { service_id: b.serviceId, start: b.slots[i * 2], first_name: "Spam", phone: `503-555-${3000 + i}`, email: variants[i] },
      });
      expect(res.status).toBe(201);
      const booked = (await res.json()) as Booked;
      ids.push(booked.appointment.id);
      // Erase it straight away, which used to take it out of the count.
      expect((await call(`/api/public/manage/${booked.manage_token}/delete-my-data`, { method: "POST" })).status).toBe(204);
    }
    expect(await kinds(ids[2])).toContain("email.customer.booked");
    expect(await kinds(ids[3])).not.toContain("email.customer.booked");
  });
});

describe("the per-calendar daily limit", () => {
  it("makes emails wait an hour instead of dropping them", async () => {
    const b = await bookableOwner();
    const res = await call("/api/v1/appointments", {
      method: "POST", who: b.owner,
      json: { service_id: b.serviceId, start: b.slots[0], customer: { first_name: "Cap", phone: "503-555-3100", email: "cap@example.com" } },
    });
    const { appointment } = (await res.json()) as { appointment: { id: string } };
    const cal = (await (await call("/api/v1/calendar", { who: b.owner })).json()) as { id: string };
    await testEnv.DB.prepare("DELETE FROM jobs WHERE calendar_id = ?").bind(cal.id).run();
    const now = Date.now();
    // The day's emails are used up.
    await testEnv.DB.batch(
      Array.from({ length: MAX_EMAILS_PER_CALENDAR }, (_, i) =>
        testEnv.DB.prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at, done_at, result) VALUES (?, ?, 'email.customer.booked', '{}', ?, ?, 'sent')")
          .bind(`job_cap_${cal.id}_${i}`, cal.id, now - 1000, now - 1000),
      ),
    );
    const stmt = enqueueEmail(testEnv.DB, cal.id, "email.customer.booked", { appointment_id: appointment.id, origin: "https://cal.example" }, now);
    await testEnv.DB.batch([stmt]);
    const [{ id }] = (await testEnv.DB.prepare("SELECT id FROM jobs WHERE json_extract(payload, '$.appointment_id') = ?").bind(appointment.id).all<{ id: string }>()).results;
    const sent: OutgoingEmail[] = [];
    while ((await runDueJobs(env, now, async (m) => void sent.push(m))) > 0);
    expect(sent.filter((m) => m.to === "cap@example.com")).toHaveLength(0);
    const after = await job(id);
    expect(after).toMatchObject({ done_at: null, attempts: 0 });
    expect(after.run_at).toBeGreaterThanOrEqual(now + 3500_000);
  });
});

describe("queue robustness", () => {
  it("a broken queue entry is closed, and the others in the same run still go", async () => {
    const b = await bookableOwner();
    const cal = (await (await call("/api/v1/calendar", { who: b.owner })).json()) as { id: string };
    await testEnv.DB.prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at) VALUES (?, ?, 'email.customer.booked', 'not json', 0)")
      .bind(`job_bad_${cal.id}`, cal.id)
      .run();
    const res = await call("/api/v1/appointments", {
      method: "POST", who: b.owner,
      json: { service_id: b.serviceId, start: b.slots[0], customer: { first_name: "Ok", phone: "503-555-3200", email: "ok@example.com" } },
    });
    expect(res.status).toBe(201);
    const sent: OutgoingEmail[] = [];
    // Its run_at must match exactly for the claim, so use a fixed time well after both.
    while ((await runDueJobs({ ...env, PUBLIC_URL: "https://cal.example" } as Bindings, Date.now() + 1000, async (m) => void sent.push(m))) > 0);
    expect((await job(`job_bad_${cal.id}`)).result).toBe("failed:bad_payload");
    expect(sent.filter((m) => m.to === "ok@example.com")).toHaveLength(1);
  });

  it("doesn't email a customer about cancelling an appointment that's already over", async () => {
    const b = await bookableOwner();
    const past = new Date(Date.now() - 2 * 3600_000).toISOString();
    const res = await call("/api/v1/appointments", {
      method: "POST", who: b.owner,
      json: { service_id: b.serviceId, start: past, customer: { first_name: "Was", phone: "503-555-3300", email: "was@example.com" }, allow_outside_hours: true },
    });
    const { appointment } = (await res.json()) as { appointment: { id: string } };
    await call(`/api/v1/appointments/${appointment.id}/cancel`, { method: "POST", who: b.owner, json: {} });
    const sent: OutgoingEmail[] = [];
    while ((await runDueJobs({ ...env, PUBLIC_URL: "https://cal.example" } as Bindings, Date.now() + 1000, async (m) => void sent.push(m))) > 0);
    expect(sent.filter((m) => m.to === "was@example.com")).toHaveLength(0);
  });
});
