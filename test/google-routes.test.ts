import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index";
import { getConnection } from "../src/worker/google/connection";
import { openToken } from "../src/worker/google/crypto";
import { verifyState } from "../src/worker/google/state";
import { bookableOwner, call, newOwner, testEnv } from "./helpers";
import { calendarIdOf, connectForTest, FakeGoogle, PRIMARY, TEST_KEY, WORK } from "./google-fake";

let fake: FakeGoogle;
beforeEach(() => {
  fake = new FakeGoogle();
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});
afterEach(() => vi.restoreAllMocks());

const db = () => testEnv.DB;
type Who = { key: string; user: string };
const get = (who: Who, path = "") => call(`/api/v1/google${path}`, { who });
const status = async (who: Who) => (await (await get(who)).json()) as Record<string, unknown>;
const connectUrl = async (who: Who) => new URL(((await (await call("/api/v1/google/connect", { method: "POST", who })).json()) as { url: string }).url);

/** Walk the whole sign-in: Connect → Google → callback page → Connect button. */
async function signIn(who: Who, code = "good-code") {
  const state = (await connectUrl(who)).searchParams.get("state")!;
  const page = await call(`/api/google/callback?code=${code}&state=${encodeURIComponent(state)}`);
  const confirm = () => call("/api/google/confirm", { method: "POST", body: new URLSearchParams({ code, state }), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return { state, page, confirm };
}

describe("status and connect", () => {
  it("reports not connected, and not configured without the secrets", async () => {
    const owner = await newOwner();
    expect(await status(owner)).toEqual({ configured: true, status: "not_connected", email: null, calendar: null, last_synced_at: null, problem: null, warning: null });
    const headers = { Authorization: `Bearer ${owner.key}`, "X-Calendar-User": owner.user };
    const off = await app.request("/api/v1/google", { headers }, { ...testEnv, GOOGLE_CLIENT_ID: undefined });
    expect(((await off.json()) as { configured: boolean }).configured).toBe(false);
    const connect = await app.request("/api/v1/google/connect", { method: "POST", headers }, { ...testEnv, GOOGLE_CLIENT_ID: undefined });
    expect(connect.status).toBe(503);
  });

  it("builds Google's sign-in address", async () => {
    const owner = await newOwner();
    const url = await connectUrl(owner);
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/api/google/callback");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(expect.arrayContaining([
      "openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ]));
    expect([url.searchParams.get("access_type"), url.searchParams.get("prompt")]).toEqual(["offline", "consent"]);
    const s = await verifyState("test-session-secret", url.searchParams.get("state")!, Date.now());
    expect(s!.calendarId).toBe(await calendarIdOf(owner.slug));
  });

  it("works from the owner screens too", async () => {
    const owner = await newOwner();
    const { token } = (await (await call("/api/v1/admin-sessions", { method: "POST", who: owner })).json()) as { token: string };
    const res = await call("/api/admin/google", { headers: { Authorization: `Session ${token}` } });
    expect(((await res.json()) as { status: string }).status).toBe("not_connected");
  });
});

describe("the sign-in pages", () => {
  it("the callback asks first, saves nothing, and is locked down", async () => {
    const owner = await newOwner();
    const id = await calendarIdOf(owner.slug);
    const { page } = await signIn(owner);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('action="/api/google/confirm"');
    // Names the calendar by its booking page, never "your booking calendar" (the link may be someone else's).
    expect(html).toContain(`http://localhost/book/${owner.slug}`);
    expect(html).not.toMatch(/your booking calendar/i);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect(await getConnection(db(), id)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("Connect saves an encrypted connection, copies busy times, and queues upcoming bookings", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const id = await calendarIdOf(owner.slug);
    const live = (await (await call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550401" } } })).json()) as { appointment: { id: string } };
    const gone = (await (await call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, start: slots[2], customer: { first_name: "B", phone: "5035550402" } } })).json()) as { appointment: { id: string } };
    await call(`/api/v1/appointments/${gone.appointment.id}/cancel`, { method: "POST", who: owner, json: {} });
    fake.addEvent(PRIMARY, { id: "busy1", start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() }, end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() } });

    const { confirm } = await signIn(owner);
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("connected");
    const conn = (await getConnection(db(), id))!;
    expect([conn.status, conn.google_email, conn.google_calendar_id]).toEqual(["active", PRIMARY, PRIMARY]);
    expect(conn.refresh_token_enc).not.toContain("refresh-1");
    expect(await openToken(TEST_KEY, id, conn.refresh_token_enc)).toBe("refresh-1");
    expect((await db().prepare("SELECT google_event_id FROM google_busy WHERE calendar_id = ?").bind(id).all()).results).toEqual([{ google_event_id: "busy1" }]);
    const queued = (await db().prepare("SELECT payload FROM jobs WHERE calendar_id = ? AND kind = 'google.push'").bind(id).all<{ payload: string }>()).results.map((r) => JSON.parse(r.payload).appointment_id);
    expect(queued).toEqual([live.appointment.id]);
  });

  it("a state works once only", async () => {
    const owner = await newOwner();
    const { confirm } = await signIn(owner);
    expect((await confirm()).status).toBe(200);
    expect((await confirm()).status).toBe(400);
  });

  it("refuses bad states, a cancelled sign-in, missing permissions and a failed exchange", async () => {
    const owner = await newOwner();
    const id = await calendarIdOf(owner.slug);
    expect((await call("/api/google/callback?code=good-code&state=nonsense")).status).toBe(400);
    const { state } = await signIn(owner);
    const denied = await call(`/api/google/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    const deniedHtml = await denied.text();
    expect(deniedHtml).toContain("<h1>Not connected</h1>");
    expect(deniedHtml).not.toContain("access_denied");

    fake.grantedScope = "openid email";
    const partial = await signIn(owner);
    const r1 = await partial.confirm();
    expect(r1.status).toBe(400);
    expect(await r1.text()).toContain("tick every box");
    expect(fake.calls.some((c) => c.url.includes("/revoke"))).toBe(false);

    fake.grantedScope = (await import("./google-fake")).ALL_SCOPES;
    const bad = await signIn(owner, "bad-code");
    expect((await bad.confirm()).status).toBe(502);
    expect(await getConnection(db(), id)).toBeNull();
  });

  it("a state made for one calendar can't be used for another", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const sa = (await connectUrl(a)).searchParams.get("state")!;
    await connectUrl(b);
    // Swap the calendar inside a's state: the signature no longer matches.
    const [p, sig] = sa.split(".");
    const payload = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    payload.c = await calendarIdOf(b.slug);
    const forged = `${btoa(JSON.stringify(payload)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.${sig}`;
    const res = await call("/api/google/confirm", { method: "POST", body: new URLSearchParams({ code: "good-code", state: forged }), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(400);
    expect(await getConnection(db(), await calendarIdOf(b.slug))).toBeNull();
  });

  it("reconnecting a broken connection keeps the chosen calendar and catches Google up", async () => {
    const owner = await newOwner();
    const id = await calendarIdOf(owner.slug);
    await connectForTest(id, { googleCalendarId: WORK, status: "broken" });
    await db().prepare("UPDATE google_connections SET last_error = 'signed_out' WHERE calendar_id = ?").bind(id).run();
    const url = await connectUrl(owner);
    expect(url.searchParams.get("login_hint")).toBe(PRIMARY);
    const { confirm } = await signIn(owner);
    await confirm();
    const conn = (await getConnection(db(), id))!;
    expect([conn.status, conn.last_error, conn.google_calendar_id]).toEqual(["active", null, WORK]);
  });

  it("reconnecting keeps the chosen calendar even when Google can't list calendars", async () => {
    const owner = await newOwner();
    const id = await calendarIdOf(owner.slug);
    await connectForTest(id, { googleCalendarId: WORK, status: "broken" });
    const { confirm } = await signIn(owner);
    fake.fail["/calendarList"] = { status: 500 };
    await confirm();
    expect((await getConnection(db(), id))!.google_calendar_id).toBe(WORK);
  });

  it("shows a warning when bookings can't be copied", async () => {
    const owner = await newOwner();
    const id = await calendarIdOf(owner.slug);
    await connectForTest(id);
    expect((await status(owner)).warning).toBeNull();
    await db().prepare("UPDATE google_connections SET push_error = '500_unknown' WHERE calendar_id = ?").bind(id).run();
    expect((await status(owner)).warning).toBe("push_failed");
  });
});

describe("choosing, checking and disconnecting", () => {
  it("lists calendars and switches, moving upcoming bookings", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const id = await calendarIdOf(owner.slug);
    expect((await get(owner, "/calendars")).status).toBe(409);
    await connectForTest(id);
    const list = (await (await get(owner, "/calendars")).json()) as { calendars: { id: string; name: string; primary: boolean }[] };
    expect(list.calendars).toEqual([{ id: PRIMARY, name: PRIMARY, primary: true }, { id: WORK, name: "Work", primary: false }]);

    const appt = (await (await call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, start: slots[0], customer: { first_name: "A", phone: "5035550411" } } })).json()) as { appointment: { id: string } };
    await db().prepare("UPDATE appointments SET google_event_id = 'x' WHERE id = ?").bind(appt.appointment.id).run();
    await db().prepare("UPDATE jobs SET done_at = 1 WHERE calendar_id = ?").bind(id).run();

    expect((await call("/api/v1/google/calendar", { method: "PUT", who: owner, json: { id: "nope" } })).status).toBe(400);
    const same = await call("/api/v1/google/calendar", { method: "PUT", who: owner, json: { id: PRIMARY } });
    expect(same.status).toBe(200);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE calendar_id = ? AND done_at IS NULL").bind(id).first<{ n: number }>())!.n).toBe(0);

    const res = await call("/api/v1/google/calendar", { method: "PUT", who: owner, json: { id: WORK } });
    expect(((await res.json()) as { calendar: { id: string } }).calendar.id).toBe(WORK);
    const payloads = (await db().prepare("SELECT payload FROM jobs WHERE calendar_id = ? AND done_at IS NULL ORDER BY payload").bind(id).all<{ payload: string }>()).results.map((r) => JSON.parse(r.payload));
    expect(payloads).toEqual(expect.arrayContaining([{ appointment_id: appt.appointment.id }, { appointment_id: appt.appointment.id, remove_from: PRIMARY }]));
    expect((await getConnection(db(), id))!.last_synced_at).toBeGreaterThan(0);
  });

  it("Check now syncs, and reports a missing calendar", async () => {
    const owner = await newOwner();
    const id = await calendarIdOf(owner.slug);
    await connectForTest(id);
    const ok = (await (await call("/api/v1/google/sync", { method: "POST", who: owner })).json()) as { last_synced_at: string | null };
    expect(ok.last_synced_at).not.toBeNull();
    fake.events.delete(PRIMARY);
    await db().prepare("UPDATE google_connections SET busy_hash = NULL WHERE calendar_id = ?").bind(id).run();
    const bad = (await (await call("/api/v1/google/sync", { method: "POST", who: owner })).json()) as { status: string; problem: string };
    expect([bad.status, bad.problem]).toEqual(["broken", "calendar_missing"]);
  });

  it("disconnect clears everything on our side and revokes at Google", async () => {
    const owner = await newOwner();
    const id = await calendarIdOf(owner.slug);
    await connectForTest(id);
    // Its own Google account: other tests' calendars share the fake's default one, which stops the revoke.
    await db().prepare("UPDATE google_connections SET google_email = ? WHERE calendar_id = ?").bind(`solo-${id}@gmail.com`, id).run();
    await db().prepare("INSERT INTO google_busy VALUES (?, 'e', 1, 2)").bind(id).run();
    await db().prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at) VALUES (?, ?, 'google.push', '{}', 0)").bind(`job_d_${id}`, id).run();
    expect((await call("/api/v1/google", { method: "DELETE", who: owner })).status).toBe(204);
    expect(await getConnection(db(), id)).toBeNull();
    expect((await db().prepare("SELECT COUNT(*) AS n FROM google_busy WHERE calendar_id = ?").bind(id).first<{ n: number }>())!.n).toBe(0);
    expect((await db().prepare("SELECT result FROM jobs WHERE id = ?").bind(`job_d_${id}`).first<{ result: string }>())!.result).toBe("skipped:disconnected");
    expect(fake.calls.some((c) => c.url.includes("/revoke"))).toBe(true);
    expect((await call("/api/v1/google", { method: "DELETE", who: owner })).status).toBe(204);
  });

  it("doesn't revoke when another booking calendar uses the same Google account", async () => {
    const a = await newOwner();
    const b = await newOwner();
    await connectForTest(await calendarIdOf(a.slug));
    await connectForTest(await calendarIdOf(b.slug));
    await call("/api/v1/google", { method: "DELETE", who: a });
    expect(fake.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    expect((await status(b)).status).toBe("active");
  });

  it("each owner only sees their own connection", async () => {
    const a = await newOwner();
    const b = await newOwner();
    await connectForTest(await calendarIdOf(a.slug));
    expect((await status(a)).status).toBe("active");
    expect((await status(b)).status).toBe("not_connected");
  });
});
