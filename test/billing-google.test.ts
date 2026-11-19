import { describe, it, expect, vi, afterEach } from "vitest";
import { runGoogleSync } from "../src/worker/google/busy";
import { runGoogleJobs } from "../src/worker/google/push";
import { app } from "../src/worker/index";
import { connectForTest, FakeGoogle } from "./google-fake";
import { adminCall, billingEnv, clientCalendar, hostedAccount, setBilling } from "./stripe-fake";

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
  it("the cron sync clears a Free calendar's stored busy times and hash", async () => {
    const env = billingEnv();
    const fake = new FakeGoogle();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    await connectForTest(a.calendarId);
    await env.DB.batch([
      env.DB.prepare("UPDATE google_connections SET busy_hash = 'h', last_attempt_at = 0 WHERE calendar_id = ?").bind(a.calendarId),
      env.DB.prepare("INSERT INTO google_busy (calendar_id, google_event_id, start_at, end_at) VALUES (?, 'stale', 1, 2)").bind(a.calendarId),
    ]);
    await runGoogleSync(env, Date.now());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM google_busy WHERE calendar_id = ?").bind(a.calendarId).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT busy_hash FROM google_connections WHERE calendar_id = ?").bind(a.calendarId).first<{ busy_hash: string | null }>())!.busy_hash).toBeNull();
    expect(fake.googleCalls().length).toBe(0);
  });
  it("finishing Google's sign-in is refused on Free, and nothing is saved", async () => {
    const env = billingEnv();
    const fake = new FakeGoogle();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "pro", status: "active" });
    const res = await app.request("https://book.example.test/api/admin/google/connect", { method: "POST", headers: { Authorization: `Session ${a.token}` } }, env);
    const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
    await setBilling(env, a.userId, { status: "canceled" }); // dropped to Free before pressing Connect
    const confirm = await app.request("https://book.example.test/api/google/confirm", {
      method: "POST", body: new URLSearchParams({ code: "good-code", state }), headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, env);
    expect(confirm.status).toBe(402);
    expect(await confirm.text()).toContain("see your plan");
    expect(await env.DB.prepare("SELECT 1 FROM google_connections WHERE calendar_id = ?").bind(a.calendarId).first()).toBeNull();
  });
});

describe("Google for a paused client", () => {
  it("busy sync is off (stored busy times cleared, Google not called), pushes still run, connecting is refused", async () => {
    const env = billingEnv();
    const fake = new FakeGoogle();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "pro", status: "active" });
    const c = await clientCalendar(env, a.userId);
    await connectForTest(c.calendarId);
    await env.DB.batch([
      env.DB.prepare("UPDATE google_connections SET busy_hash = 'h', last_attempt_at = 0 WHERE calendar_id = ?").bind(c.calendarId),
      env.DB.prepare("INSERT INTO google_busy (calendar_id, google_event_id, start_at, end_at) VALUES (?, 'stale', 1, 2)").bind(c.calendarId),
    ]);
    await runGoogleSync(env, Date.now());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM google_busy WHERE calendar_id = ?").bind(c.calendarId).first<{ n: number }>())!.n).toBe(0);
    expect(fake.googleCalls().length).toBe(0);

    const job = `job_${c.calendarId}`;
    await env.DB.prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at) VALUES (?, ?, 'google.push', ?, 0)").bind(job, c.calendarId, JSON.stringify({ appointment_id: "apt_x" })).run();
    await runGoogleJobs(env, Date.now());
    const row = await env.DB.prepare("SELECT attempts, result FROM jobs WHERE id = ?").bind(job).first<{ attempts: number; result: string | null }>();
    expect(row!.attempts).toBe(1);
    expect(row!.result).not.toBe("skipped:plan");

    const res = await adminCall(env, a.token, "/google/connect", { method: "POST", client: c.calendarId });
    expect(res.status).toBe(402);
  });
  it("finishing Google's sign-in on a paused client says to contact the provider, never to see a plan", async () => {
    const env = billingEnv();
    const fake = new FakeGoogle();
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "white_label", status: "active" });
    const c = await clientCalendar(env, a.userId);
    const res = await adminCall(env, a.token, "/google/connect", { method: "POST", client: c.calendarId });
    const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
    await setBilling(env, a.userId, { plan: "pro" }); // White-label ended: the client is paused before Connect is pressed
    const confirm = await app.request("https://book.example.test/api/google/confirm", {
      method: "POST", body: new URLSearchParams({ code: "good-code", state }), headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, env);
    expect(confirm.status).toBe(402);
    const html = await confirm.text();
    expect(html).toContain("Please contact your provider.");
    expect(html).not.toContain("see your plan");
    expect(await env.DB.prepare("SELECT 1 FROM google_connections WHERE calendar_id = ?").bind(c.calendarId).first()).toBeNull();
  });
});
