import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { signSession } from "../src/worker/lib/session";
import { HOSTED_APP } from "../src/worker/auth";
import { app } from "../src/worker/index";
import { clientCalendar, clientUser, hostedAccount, setBilling } from "./stripe-fake";
import { BASE, hibpClean, req, setup } from "./password-helpers";
import { uniq } from "./helpers";

const json = async <T>(res: Response) => (await res.json()) as T;
beforeEach(() => void hibpClean());
afterEach(() => vi.restoreAllMocks());

describe("a client's own sign-in", () => {
  it("always gets its own calendar, whatever X-Client says", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const mine = await clientCalendar(env, a.userId);
    const other = await clientCalendar(env, a.userId);
    const u = await clientUser(env, mine.calendarId);
    for (const client of [undefined, a.calendarId, other.calendarId, "cal_nope"]) {
      expect((await json<{ id: string }>(await req(env, "/api/admin/calendar", { token: u.token, client }))).id).toBe(mine.calendarId);
    }
  });

  it("every owner route (all of mountApi) acts on its own calendar, even with another calendar's X-Client", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const mine = await clientCalendar(env, a.userId);
    const other = await clientCalendar(env, a.userId);
    const u = await clientUser(env, mine.calendarId);
    // The agency makes the two calendars different, so "the same answer as the agency viewing mine" proves which one
    // the client's call acted on.
    const asAgency = (client: string, path: string, init: { method?: string; json?: unknown } = {}) => req(env, `/api/admin${path}`, { ...init, token: a.token, client });
    const asClient = (path: string, init: { method?: string; json?: unknown } = {}) => req(env, `/api/admin${path}`, { ...init, token: u.token, client: other.calendarId });
    const week = (open: number[]) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: open.includes(weekday), start_min: 540, end_min: 1020, breaks: [] }));
    const date = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const svc = (await json<{ id: string }>(await asAgency(mine.calendarId, "/services", { json: { name: "Mine svc", duration_min: 30 } }))).id;
    const otherSvc = (await json<{ id: string }>(await asAgency(other.calendarId, "/services", { json: { name: "Other svc", duration_min: 30 } }))).id;
    await asAgency(mine.calendarId, "/availability/weekly", { method: "PUT", json: { days: week([0, 1, 2, 3, 4, 5, 6]) } });
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    await asAgency(other.calendarId, "/availability/weekly", { method: "PUT", json: { days: week([dow]) } });
    await asAgency(mine.calendarId, "/customers", { json: { first_name: "Mona", phone: "5035550111" } });
    await asAgency(other.calendarId, "/customers", { json: { first_name: "Olga", phone: "5035550122" } });
    await asAgency(other.calendarId, "/reminders", { json: { at: `${date}T18:00:00.000Z`, title: "Other reminder" } });
    await asAgency(other.calendarId, "/calendar", { method: "PATCH", json: { branding: { business_name: "Other Co" } } });
    // A booking on the other calendar only, so /appointments differs between the two.
    const otherSlots = (await json<{ slots: string[] }>(await asAgency(other.calendarId, `/slots?service_id=${otherSvc}&date=${date}`))).slots;
    const booked = await asAgency(other.calendarId, "/appointments", { json: { service_id: otherSvc, start: otherSlots[0], customer: { first_name: "Olga", phone: "5035550122" } } });
    expect(booked.status).toBe(201);
    // /google can't easily differ (neither calendar is connected); it stays in the list as a status check.

    for (const path of [
      "/calendar", "/services", "/availability", "/customers", "/dashboard", "/google",
      `/reminders?from=${date}T00:00:00.000Z&to=${date}T23:59:59.000Z`,
      `/slots?service_id=${svc}&date=${date}`,
      `/appointments?from=${date}T00:00:00.000Z&to=${date}T23:59:59.000Z`,
    ]) {
      const theirs = await asClient(path);
      expect(theirs.status, path).toBe(200);
      expect(await theirs.json(), path).toEqual(await (await asAgency(mine.calendarId, path)).json());
    }

    // Writes land on its own calendar too: a service, and an image (images is the last mountApi route).
    await asClient("/services", { json: { name: "Drain check", duration_min: 30 } });
    const names = async (client: string) => (await json<{ services: { name: string }[] }>(await asAgency(client, "/services"))).services.map((s) => s.name);
    expect(await names(mine.calendarId)).toContain("Drain check");
    expect(await names(other.calendarId)).not.toContain("Drain check");
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]); // as in images.test.ts
    const up = await app.request(`${BASE}/api/admin/images/logo`, {
      method: "PUT", headers: { Authorization: `Session ${u.token}`, "X-Client": other.calendarId, "Content-Type": "image/png" }, body: PNG,
    }, env);
    expect(up.ok).toBe(true);
    const logo = async (client: string) => (await json<{ branding: { logo_url: string | null } }>(await asAgency(client, "/calendar"))).branding.logo_url;
    expect(await logo(mine.calendarId)).not.toBeNull();
    expect(await logo(other.calendarId)).toBeNull();
  });

  it("is refused (403) on billing, the client list, invites and making a calendar", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const mine = await clientCalendar(env, a.userId);
    const u = await clientUser(env, mine.calendarId);
    const calls: [string, { method?: string; json?: unknown }][] = [
      ["/api/admin/billing", {}],
      ["/api/admin/billing/checkout", { json: { plan: "pro", interval: "month" } }],
      ["/api/admin/billing/portal", { method: "POST" }],
      ["/api/admin/clients", {}],
      ["/api/admin/clients", { json: { business_name: "X", slug: "x-client-abc", time_zone: "America/Los_Angeles", owner_email: "x@example.test" } }],
      [`/api/admin/clients/${mine.calendarId}/invite`, { json: { email: "x@example.test" } }],
      [`/api/admin/clients/${mine.calendarId}/sign-in`, { method: "DELETE" }],
      ["/api/admin/calendar", { json: { slug: "my-own-free-cal", time_zone: "America/Los_Angeles" } }],
    ];
    for (const [path, init] of calls) {
      const res = await req(env, path, { ...init, token: u.token });
      expect(res.status, `${init.method ?? (init.json ? "POST" : "GET")} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });

  it("is signed out at once when its version moves on; a token without a version counts as version 0", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const old = await signSession("test-session-secret", { a: HOSTED_APP, u: a.userId }, Date.now(), 60_000);
    expect((await req(env, "/api/admin/calendar", { token: old })).status).toBe(200);
    await env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").bind(a.userId).run();
    expect((await req(env, "/api/admin/calendar", { token: old })).status).toBe(401);
    expect((await req(env, "/api/admin/calendar", { token: a.token })).status).toBe(401);
  });

  it("is signed out at once when its sign-in is deleted", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const mine = await clientCalendar(env, a.userId);
    const u = await clientUser(env, mine.calendarId);
    expect((await req(env, "/api/admin/calendar", { token: u.token })).status).toBe(200);
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.userId).run();
    expect((await req(env, "/api/admin/calendar", { token: u.token })).status).toBe(401);
  });

  it("the agency still reaches its billing and clients", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "white_label", status: "active" });
    expect((await req(env, "/api/admin/billing", { token: a.token })).status).toBe(200);
    expect((await req(env, "/api/admin/clients", { token: a.token })).status).toBe(200);
  });
});

describe("invites", () => {
  const invite = (env: Parameters<typeof req>[0], token: string, id: string, email: string) =>
    req(env, `/api/admin/clients/${id}/invite`, { token, json: { email } });
  const clientEmail = () => `client-${uniq()}@example.test`;

  it("creates the client's sign-in and emails a link in the client's name", async () => {
    const { env, sent } = setup();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const address = clientEmail();
    const res = await invite(env, a.token, c.calendarId, address);
    expect(res.status).toBe(200);
    expect((await json<{ signin: { status: string; email: string } }>(res)).signin).toMatchObject({ status: "invited", email: address });
    const mail = sent.at(-1)!;
    expect(mail.to).toBe(address);
    expect(mail.from.name).toBe("Client Co");
    expect(mail.subject).toBe("Your booking calendar is ready — set your password");
    expect(mail.text).toContain("https://book.example.test/invite#t=");
    expect(mail.text + mail.html).not.toMatch(/open source calendar/i);
  });

  it("escapes the business name in the email", async () => {
    const { env, sent } = setup();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    await env.DB.prepare("UPDATE calendars SET branding = ? WHERE id = ?").bind(JSON.stringify({ business_name: "<b>Evil</b> & Co" }), c.calendarId).run();
    expect((await invite(env, a.token, c.calendarId, clientEmail())).status).toBe(200);
    expect(sent.at(-1)!.html).not.toContain("<b>Evil</b>");
    expect(sent.at(-1)!.html).toContain("&#60;b&#62;Evil");
  });

  it("the client list shows each client's sign-in and notification email", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const d = await clientCalendar(env, a.userId);
    const address = clientEmail();
    await invite(env, a.token, c.calendarId, address);
    const list = await json<{ calendars: { id: string; signin: { status: string; email: string | null }; notification_email: string }[] }>(await req(env, "/api/admin/clients", { token: a.token }));
    expect(list.calendars.find((x) => x.id === c.calendarId)!.signin).toMatchObject({ status: "invited", email: address });
    expect(list.calendars.find((x) => x.id === d.calendarId)!.signin).toEqual({ status: "not_invited", email: null, last_login_at: null });
  });

  it("refuses an email that already has an account here, another agency's client, and the agency's own calendar", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const b = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const theirs = await clientCalendar(env, b.userId);
    expect(await json(await invite(env, a.token, c.calendarId, `${b.userId}@example.test`))).toEqual({ error: "email_in_use" });
    expect((await invite(env, a.token, theirs.calendarId, clientEmail())).status).toBe(404);
    expect((await invite(env, a.token, a.calendarId, clientEmail())).status).toBe(404);
    expect((await req(env, `/api/admin/clients/${theirs.calendarId}/sign-in`, { token: a.token, method: "DELETE" })).status).toBe(404);
  });

  it("before the first sign-in the address can change; after it, only the same address", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const first = clientEmail();
    await invite(env, a.token, c.calendarId, first);
    const second = clientEmail();
    expect((await invite(env, a.token, c.calendarId, second)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE client_calendar_id = ?").bind(Date.now(), c.calendarId).run();
    expect(await json(await invite(env, a.token, c.calendarId, clientEmail()))).toEqual({ error: "signed_in" });
    expect((await invite(env, a.token, c.calendarId, second)).status).toBe(200);
  });

  it("a resend revokes the older invite and stores the address it went to", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const address = clientEmail();
    await invite(env, a.token, c.calendarId, address);
    await invite(env, a.token, c.calendarId, address);
    const rows = (await env.DB.prepare(
      "SELECT email, revoked_at FROM client_invites WHERE user_id = (SELECT id FROM users WHERE client_calendar_id = ?) ORDER BY created_at, rowid",
    ).bind(c.calendarId).all<{ email: string; revoked_at: number | null }>()).results;
    expect(rows.map((r) => [r.email, r.revoked_at !== null])).toEqual([[address, true], [address, false]]);
  });

  it("20 invites an hour per agency, refused ones included, and Remove sign-in doesn't reset it", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    for (let i = 0; i < 19; i++) expect((await invite(env, a.token, c.calendarId, `${a.userId}@example.test`)).status).toBe(409);
    await req(env, `/api/admin/clients/${c.calendarId}/sign-in`, { token: a.token, method: "DELETE" });
    expect((await invite(env, a.token, c.calendarId, `${a.userId}@example.test`)).status).toBe(409);
    expect(await json(await invite(env, a.token, c.calendarId, clientEmail()))).toEqual({ error: "too_many_invites" });
  });

  it("two invites at once for one client never fail with a 500", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const all = await Promise.all([invite(env, a.token, c.calendarId, clientEmail()), invite(env, a.token, c.calendarId, clientEmail())]);
    for (const r of all) expect([200, 409]).toContain(r.status);
  });

  it("Remove sign-in signs the client out at once and keeps the calendar; inviting again works", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const u = await clientUser(env, c.calendarId);
    expect((await req(env, `/api/admin/clients/${c.calendarId}/sign-in`, { token: a.token, method: "DELETE" })).status).toBe(204);
    expect((await req(env, "/api/admin/calendar", { token: u.token })).status).toBe(401);
    expect((await req(env, "/api/admin/calendar", { token: a.token, client: c.calendarId })).status).toBe(200);
    expect((await invite(env, a.token, c.calendarId, u.email)).status).toBe(200);
  });
});
