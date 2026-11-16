import { describe, it, expect } from "vitest";
import { bookableOwner, call } from "./helpers";

describe("days with open times", () => {
  it("lists every open day in the month, and drops a fully blocked day", async () => {
    const { owner, serviceId, date } = await bookableOwner();
    const month = date.slice(0, 7);
    const all = (await (await call(`/api/public/${owner.slug}/days?service_id=${serviceId}&month=${month}`)).json()) as { days: string[] };
    expect(all.days).toContain(date);

    await call("/api/v1/availability/blocked", { method: "POST", who: owner, json: { start_date: date, end_date: date } });
    const after = (await (await call(`/api/public/${owner.slug}/days?service_id=${serviceId}&month=${month}`)).json()) as { days: string[] };
    expect(after.days).not.toContain(date);
    expect(after.days.length).toBe(all.days.length - 1);
  });

  it("validates the month and hides hidden services", async () => {
    const { owner, serviceId } = await bookableOwner();
    expect((await call(`/api/public/${owner.slug}/days?service_id=${serviceId}&month=2026-13`)).status).toBe(400);
    expect((await call(`/api/public/${owner.slug}/days?service_id=${serviceId}&month=9999-12`)).status).toBe(400);
    const past = await call(`/api/public/${owner.slug}/days?service_id=${serviceId}&month=2020-01`);
    expect(past.status).toBe(200);
    expect(((await past.json()) as { days: string[] }).days).toEqual([]);
    const hidden = (await (await call("/api/v1/services", { method: "POST", who: owner, json: { name: "H", duration_min: 30, hidden: true } })).json()) as { id: string };
    expect((await call(`/api/public/${owner.slug}/days?service_id=${hidden.id}&month=2026-12`)).status).toBe(404);
  });

  it("serves the manage link's days, calendar file and the consent wording", async () => {
    const { owner, serviceId, slots, date } = await bookableOwner();
    const pub = (await (await call(`/api/public/${owner.slug}`)).json()) as { consent_wording: string };
    expect(pub.consent_wording).toMatch(/Reply STOP to opt out/);
    const booked = (await (await call(`/api/public/${owner.slug}/book`, { method: "POST", json: { service_id: serviceId, start: slots[0], first_name: "Ann", phone: "5035551201" } })).json()) as { manage_token: string };
    const days = (await (await call(`/api/public/manage/${booked.manage_token}/days?month=${date.slice(0, 7)}`)).json()) as { days: string[] };
    expect(days.days).toContain(date);
    const ics = await call(`/api/public/manage/${booked.manage_token}/ics`);
    expect(ics.headers.get("Content-Type")).toMatch(/^text\/calendar/);
    expect(await ics.text()).toContain("SUMMARY:Call");
  });
});
