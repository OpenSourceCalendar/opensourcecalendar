import { describe, it, expect } from "vitest";
import { call, createApp, newOwner, uniq, testEnv } from "./helpers";

describe("setup", () => {
  it("rejects a wrong setup token", async () => {
    const res = await call("/api/setup/apps", { method: "POST", headers: { Authorization: "Bearer nope" }, json: { name: "x" } });
    expect(res.status).toBe(401);
  });
  it("returns an API key once", async () => {
    expect(await createApp()).toMatch(/^bc_[A-Za-z0-9_-]{43}$/);
  });
});

describe("auth", () => {
  it("needs a valid API key", async () => {
    expect((await call("/api/v1/calendar")).status).toBe(401);
    expect((await call("/api/v1/calendar", { who: { key: "bc_wrong", user: "u" } })).status).toBe(401);
  });
  it("needs X-Calendar-User", async () => {
    const key = await createApp();
    const res = await call("/api/v1/calendar", { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(400);
  });
});

describe("calendar", () => {
  it("creates, reads and updates the user's calendar", async () => {
    const owner = await newOwner();
    const got = await call("/api/v1/calendar", { who: owner });
    expect(got.status).toBe(200);
    const cal = (await got.json()) as { slug: string; time_zone: string; rules: { min_notice_min: number } };
    expect(cal.slug).toBe(owner.slug);
    expect(cal.rules.min_notice_min).toBe(60);

    const patched = await call("/api/v1/calendar", {
      method: "PATCH",
      who: owner,
      json: { rules: { buffer_min: 15 }, branding: { business_name: "Acme Fence" } },
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { rules: { buffer_min: number; min_notice_min: number }; branding: { business_name: string } };
    expect(after.rules.buffer_min).toBe(15);
    expect(after.rules.min_notice_min).toBe(60);
    expect(after.branding.business_name).toBe("Acme Fence");
  });

  it("saves a page style, defaults to classic and rejects unknown styles", async () => {
    const owner = await newOwner();
    const fresh = (await (await call("/api/v1/calendar", { who: owner })).json()) as { branding: { style: string } };
    expect(fresh.branding.style).toBe("classic");

    const ok = await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { branding: { style: "midnight" } } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { branding: { style: string } }).branding.style).toBe("midnight");

    const bad = await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { branding: { style: "neon" } } });
    expect(bad.status).toBe(400);
  });

  it("returns 404 before a calendar exists and 409 on a second create", async () => {
    const key = await createApp();
    const who = { key, user: `u-${uniq()}` };
    expect((await call("/api/v1/calendar", { who })).status).toBe(404);
    const slug = `s-${uniq()}`;
    expect((await call("/api/v1/calendar", { method: "POST", who, json: { slug, time_zone: "UTC" } })).status).toBe(201);
    const again = await call("/api/v1/calendar", { method: "POST", who, json: { slug: `t-${uniq()}`, time_zone: "UTC" } });
    expect(again.status).toBe(409);
  });

  it("rejects taken, reserved or malformed slugs and bad time zones", async () => {
    const a = await newOwner();
    const key = await createApp();
    const post = (json: unknown) => call("/api/v1/calendar", { method: "POST", who: { key, user: `u-${uniq()}` }, json });
    expect((await post({ slug: a.slug, time_zone: "UTC" })).status).toBe(409);
    expect((await post({ slug: "admin", time_zone: "UTC" })).status).toBe(400);
    expect((await post({ slug: "Bad Slug", time_zone: "UTC" })).status).toBe(400);
    expect((await post({ slug: `ok-${uniq()}`, time_zone: "Mars/Olympus" })).status).toBe(400);
  });

  it("rejects invalid settings", async () => {
    const owner = await newOwner();
    const res = await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { buffer_min: 7 } } });
    expect(res.status).toBe(400);
  });

  it("returns 409, not 500, when two calendars race for the same new slug", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    const slug = `race-${uniq()}`;
    const statuses = (
      await Promise.all([a, b].map((who) => call("/api/v1/calendar", { method: "PATCH", who, json: { slug } })))
    ).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe("changed booking links are held", () => {
  const patch = (who: Awaited<ReturnType<typeof newOwner>>, slug: string) => call("/api/v1/calendar", { method: "PATCH", who, json: { slug } });

  it("nobody else can take a link for 90 days after its owner changes it, but the owner can take it back", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const old = a.slug;
    expect((await patch(a, `new-${uniq()}`)).status).toBe(200);

    expect((await patch(b, old)).status).toBe(409);
    const key = await createApp();
    const fresh = await call("/api/v1/calendar", { method: "POST", who: { key, user: `u-${uniq()}` }, json: { slug: old, time_zone: "UTC" } });
    expect(fresh.status).toBe(409);
    expect(((await fresh.json()) as { error: string }).error).toBe("slug_taken");

    expect((await patch(a, old)).status).toBe(200);
    expect((await call(`/api/public/${old}`)).status).toBe(200);
  });

  it("frees the link once the 90 days are up", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const old = a.slug;
    expect((await patch(a, `new-${uniq()}`)).status).toBe(200);
    await testEnv.DB.prepare("UPDATE released_slugs SET released_at = ? WHERE slug = ?").bind(Date.now() - 91 * 86400000, old).run();
    expect((await patch(b, old)).status).toBe(200);
  });
});

describe("notification settings", () => {
  it("are saved, and the calendar says whether email is set up", async () => {
    const owner = await newOwner();
    const res = await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { notifications: { owner_email: "me@example.com", reminder_mode: "hours_before", reminder_hours_before: 3 } } });
    expect(res.status).toBe(200);
    const cal = (await res.json()) as { email_enabled: boolean; notifications: { owner_email: string; reminder_mode: string; reminder_hours_before: number } };
    expect(cal.email_enabled).toBe(false); // no EMAIL_FROM in tests
    expect(cal.notifications).toMatchObject({ owner_email: "me@example.com", reminder_mode: "hours_before", reminder_hours_before: 3 });
  });
});
