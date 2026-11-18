import { describe, it, expect } from "vitest";
import { app } from "../src/worker/index";
import { call, newOwner, testEnv, uniq } from "./helpers";
import { addClient, adminCall, billingEnv, clientCalendar, hostedAccount, setBilling } from "./stripe-fake";

const json = async <T>(res: Response) => (await res.json()) as T;

describe("X-Client", () => {
  it("selects the account's own client; no header is the account's own calendar", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    expect((await json<{ id: string }>(await adminCall(env, a.token, "/calendar"))).id).toBe(a.calendarId);
    expect((await json<{ id: string }>(await adminCall(env, a.token, "/calendar", { client: c.calendarId }))).id).toBe(c.calendarId);
  });

  it("another agency's calendar or an unknown id is 404 calendar_not_found", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const b = await hostedAccount(env);
    const theirs = await clientCalendar(env, b.userId);
    for (const id of [theirs.calendarId, b.calendarId, "cal_nope"]) {
      const res = await adminCall(env, a.token, "/calendar", { client: id });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "calendar_not_found" });
    }
  });

  it("is ignored for API-key apps", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const owner = await newOwner();
    const res = await call("/api/v1/calendar", { who: owner, headers: { "X-Client": c.calendarId } });
    expect((await json<{ slug: string }>(res)).slug).toBe(owner.slug);
  });

  it("is ignored for host-app admin sessions", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const owner = await newOwner();
    const { token } = await json<{ token: string }>(await call("/api/v1/admin-sessions", { method: "POST", who: owner }));
    const res = await adminCall(env, token, "/calendar", { client: c.calendarId });
    expect(res.status).toBe(200);
    expect((await json<{ slug: string }>(res)).slug).toBe(owner.slug);
  });

  it("the home calendar's own id, or an empty header, is the home calendar", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await clientCalendar(env, a.userId);
    expect((await json<{ id: string }>(await adminCall(env, a.token, "/calendar", { client: a.calendarId }))).id).toBe(a.calendarId);
    const empty = await app.request("https://book.example.test/api/admin/calendar", { headers: { Authorization: `Session ${a.token}`, "X-Client": "" } }, env);
    expect((await json<{ id: string }>(empty)).id).toBe(a.calendarId);
  });

  it("every owner route acts on the selected client (services, availability, branding, appointments)", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    const as = (path: string, init: { method?: string; json?: unknown } = {}) => adminCall(env, a.token, path, { ...init, client: c.calendarId });

    const svc = await json<{ id: string }>(await as("/services", { method: "POST", json: { name: "Haircut", duration_min: 30 } }));
    const names = async (client?: string) => (await json<{ services: { name: string }[] }>(await adminCall(env, a.token, "/services", { client }))).services.map((s) => s.name);
    expect(await names(c.calendarId)).toEqual(["Haircut"]);
    expect(await names()).not.toContain("Haircut");

    const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: weekday === 3, start_min: 600, end_min: 660, breaks: [] }));
    expect((await as("/availability/weekly", { method: "PUT", json: { days } })).ok).toBe(true);
    const weekly = async (client?: string) => (await json<{ weekly: unknown[] }>(await adminCall(env, a.token, "/availability", { client }))).weekly;
    expect(await weekly()).not.toEqual(await weekly(c.calendarId));

    expect((await as("/calendar", { method: "PATCH", json: { branding: { business_name: "Client Two" } } })).ok).toBe(true);
    const name = async (client?: string) => (await json<{ branding: { business_name: string } }>(await adminCall(env, a.token, "/calendar", { client }))).branding.business_name;
    expect(await name(c.calendarId)).toBe("Client Two");
    expect(await name()).not.toBe("Client Two");

    const start = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) + "T18:00:00Z";
    const made = await as("/appointments", { method: "POST", json: { service_id: svc.id, start, customer: { first_name: "Ann", phone: "5035550101" }, allow_outside_hours: true } });
    expect(made.status).toBe(201);
    const range = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 7 * 86_400_000).toISOString())}`;
    const count = async (client?: string) => (await json<{ appointments: unknown[] }>(await adminCall(env, a.token, `/appointments?${range}`, { client }))).appointments.length;
    expect(await count(c.calendarId)).toBe(1);
    expect(await count()).toBe(0);
  });
});

const DAY = 86_400_000;
type Listed = { calendars: { id: string; business_name: string; slug: string; time_zone: string; home: boolean; paused: boolean }[]; limit: number; count: number };
const input = (extra: Record<string, unknown> = {}) => ({
  business_name: "Client Co", slug: `client-${uniq()}`, time_zone: "America/Los_Angeles", owner_email: "client@example.test", ...extra,
});
const add = (env: typeof testEnv, token: string, body: unknown) => adminCall(env, token, "/clients", { method: "POST", json: body });

describe("POST /clients", () => {
  it("White-label (a trial counts) adds a client with its name and notification email", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "white_label", status: "trialing" });
    const res = await add(env, a.token, input());
    expect(res.status).toBe(201);
    const cal = await json<{ id: string; branding: { business_name: string }; notifications: { owner_email: string } }>(res);
    expect(cal.branding.business_name).toBe("Client Co");
    expect(cal.notifications.owner_email).toBe("client@example.test");
    const row = await env.DB.prepare("SELECT app_id, external_user_id, account_user_id FROM calendars WHERE id = ?").bind(cal.id).first();
    expect(row).toEqual({ app_id: "app_hosted", external_user_id: `${a.userId}:${cal.id}`, account_user_id: a.userId });
  });

  it("Free, Pro and a grace month are refused with 403 white_label_required", async () => {
    const env = billingEnv();
    for (const billing of [null, { plan: "pro", status: "active" }, { plan: "white_label", status: "canceled", grace_until: Date.now() + DAY }]) {
      const a = await hostedAccount(env);
      if (billing) await setBilling(env, a.userId, billing);
      const res = await add(env, a.token, input());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "white_label_required" });
    }
  });

  it("needs a business name (1–80 characters) and a free booking address", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "white_label", status: "active" });
    expect((await add(env, a.token, input({ business_name: "  " }))).status).toBe(400);
    expect((await add(env, a.token, input({ business_name: "x".repeat(81) }))).status).toBe(400);
    expect((await add(env, a.token, input({ owner_email: "not-an-email" }))).status).toBe(400);
    const taken = await add(env, a.token, input({ slug: a.slug }));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "slug_taken" });
  });

  it("stops at 50 calendars by default, the agency's own included", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "white_label", status: "active" });
    for (let i = 0; i < 49; i++) await clientCalendar(env, a.userId);
    const res = await add(env, a.token, input());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "client_limit" });
  });

  it("a per-account limit overrides the default, and two adds at once at the limit let only one in", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "white_label", status: "active", client_limit: 3 });
    expect((await add(env, a.token, input())).status).toBe(201);
    const both = await Promise.all([add(env, a.token, input()), add(env, a.token, input())]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await json<Listed>(await adminCall(env, a.token, "/clients"))).count).toBe(3);
  });

  it("is 404 for sessions that aren't hosted accounts", async () => {
    const owner = await newOwner();
    const s = await json<{ token: string }>(await call("/api/v1/admin-sessions", { method: "POST", who: owner }));
    expect((await call("/api/admin/clients", { headers: { Authorization: `Session ${s.token}` } })).status).toBe(404);
    expect((await call("/api/v1/clients", { who: owner })).status).toBe(404);
  });
});

describe("GET /clients", () => {
  it("lists the agency's own calendar and its clients, paused ones marked, with the limit", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "white_label", status: "active" });
    const c = await addClient(env, a.token, "Barber Bob");
    let list = await json<Listed>(await adminCall(env, a.token, "/clients"));
    expect(list).toMatchObject({ limit: 50, count: 2 });
    expect(list.calendars).toEqual([
      expect.objectContaining({ id: a.calendarId, home: true, paused: false }),
      { id: c.calendarId, business_name: "Barber Bob", slug: c.slug, time_zone: "America/Los_Angeles", home: false, paused: false },
    ]);
    await setBilling(env, a.userId, { status: "canceled" });
    list = await json<Listed>(await adminCall(env, a.token, "/clients"));
    expect(list.calendars.find((x) => x.id === c.calendarId)!.paused).toBe(true);
  });
  it("a Free account sees just its own calendar", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    expect(await json<Listed>(await adminCall(env, a.token, "/clients"))).toMatchObject({ count: 1, calendars: [{ id: a.calendarId, home: true }] });
  });
});
