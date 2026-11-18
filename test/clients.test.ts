import { describe, it, expect } from "vitest";
import { call, newOwner } from "./helpers";
import { adminCall, billingEnv, clientCalendar, hostedAccount } from "./stripe-fake";

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
