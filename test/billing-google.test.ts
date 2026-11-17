import { describe, it, expect, vi, afterEach } from "vitest";
import { runGoogleSync } from "../src/worker/google/busy";
import { runGoogleJobs } from "../src/worker/google/push";
import { app } from "../src/worker/index";
import { connectForTest, FakeGoogle } from "./google-fake";
import { billingEnv, hostedAccount, setBilling } from "./stripe-fake";

afterEach(() => vi.restoreAllMocks());

describe("Google on Free", () => {
  it("the cron sync skips a Free calendar and runs again once paid", async () => {
    const env = billingEnv();
    const fake = new FakeGoogle();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    await connectForTest(a.calendarId); // writes through testEnv.DB, the same database
    fake.addEvent("owner@gmail.com", { id: "busy1", start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() }, end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() } });
    await runGoogleSync(env, Date.now());
    expect(fake.googleCalls().length).toBe(0);
    await setBilling(env, a.userId, { plan: "pro", status: "active" });
    await env.DB.prepare("UPDATE google_connections SET last_attempt_at = 0 WHERE calendar_id = ?").bind(a.calendarId).run();
    await runGoogleSync(env, Date.now());
    expect(fake.googleCalls().length).toBeGreaterThan(0);
  });
  it("push jobs for a Free calendar are closed as skipped:plan", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await env.DB.prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at) VALUES (?, ?, 'google.push', ?, 0)").bind(`job_${a.userId}`, a.calendarId, JSON.stringify({ appointment_id: "apt_x" })).run();
    await runGoogleJobs(env, Date.now());
    expect((await env.DB.prepare("SELECT result FROM jobs WHERE id = ?").bind(`job_${a.userId}`).first<{ result: string }>())!.result).toBe("skipped:plan");
  });
  it("connecting Google Calendar is refused on Free", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const res = await app.request("https://book.example.test/api/admin/google/connect", { method: "POST", headers: { Authorization: `Session ${a.token}` } }, env);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "plan_required" });
    const sync = await app.request("https://book.example.test/api/admin/google/sync", { method: "POST", headers: { Authorization: `Session ${a.token}` } }, env);
    expect(sync.status).toBe(402);
  });
});
