import { describe, it, expect } from "vitest";
import { call, newOwner, createApp, uniq } from "./helpers";

async function openAdmin(owner: { key: string; user: string }) {
  const res = await call("/api/v1/admin-sessions", { method: "POST", who: owner });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; url: string; expires_at: string };
}
const asOwner = (token: string, path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Session ${token}` } });

describe("owner sessions from a host app", () => {
  it("issues a session link and the same API works under /api/admin", async () => {
    const owner = await newOwner();
    const s = await openAdmin(owner);
    expect(s.url).toBe(`/admin#session=${s.token}`);
    const cal = await asOwner(s.token, "/api/admin/calendar");
    expect(cal.status).toBe(200);
    expect(((await cal.json()) as { slug: string }).slug).toBe(owner.slug);
    const svc = await asOwner(s.token, "/api/admin/services", { method: "POST", json: { name: "Call", duration_min: 30 } });
    expect(svc.status).toBe(201);
  });

  it("refuses missing, bad and API-key credentials on /api/admin", async () => {
    const owner = await newOwner();
    expect((await call("/api/admin/calendar")).status).toBe(401);
    expect((await asOwner("garbage", "/api/admin/calendar")).status).toBe(401);
    // An API key is not a session.
    expect((await call("/api/admin/calendar", { headers: { Authorization: `Bearer ${owner.key}`, "X-Calendar-User": owner.user } })).status).toBe(401);
  });

  it("a session only sees its own calendar", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const svc = (await (await call("/api/v1/services", { method: "POST", who: a, json: { name: "Secret", duration_min: 30 } })).json()) as { id: string };
    const sb = await openAdmin(b);
    expect((await asOwner(sb.token, `/api/admin/services/${svc.id}`, { method: "PATCH", json: { name: "x" } })).status).toBe(404);
    const list = (await (await asOwner(sb.token, "/api/admin/services")).json()) as { services: unknown[] };
    expect(list.services).toEqual([]);
  });

  it("can create the calendar for a new user", async () => {
    const key = await createApp();
    const who = { key, user: `new-${uniq()}` };
    const s = await openAdmin(who);
    expect((await asOwner(s.token, "/api/admin/calendar")).status).toBe(404);
    const created = await asOwner(s.token, "/api/admin/calendar", { method: "POST", json: { slug: `s-${uniq()}`, time_zone: "UTC" } });
    expect(created.status).toBe(201);
  });
});

describe("standalone password login", () => {
  it("logs in with the owner password and rejects a wrong one", async () => {
    expect((await call("/api/admin/login", { method: "POST", json: { password: "wrong" } })).status).toBe(401);
    const res = await call("/api/admin/login", { method: "POST", json: { password: "test-owner-password" } });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const cal = await asOwner(token, "/api/admin/calendar");
    expect([200, 404]).toContain(cal.status); // 404 until the standalone owner creates their calendar
  });
});
