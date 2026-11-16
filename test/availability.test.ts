import { describe, it, expect } from "vitest";
import { call, newOwner } from "./helpers";

type Day = { weekday: number; open: boolean; start_min: number; end_min: number; breaks: { start_min: number; end_min: number }[] };
type Avail = { weekly: Day[]; overrides: { on_date: string; closed: boolean }[]; blocked_dates: { id: string; start_date: string }[] };

const getAvail = async (owner: Awaited<ReturnType<typeof newOwner>>) =>
  (await (await call("/api/v1/availability", { who: owner })).json()) as Avail;

describe("availability", () => {
  it("starts with every day closed", async () => {
    const owner = await newOwner();
    const a = await getAvail(owner);
    expect(a.weekly).toHaveLength(7);
    expect(a.weekly.every((d) => !d.open)).toBe(true);
  });

  it("saves weekly hours with breaks and replaces them on the next save", async () => {
    const owner = await newOwner();
    const days = [1, 2, 3, 4, 5].map((weekday) => ({
      weekday, open: true, start_min: 660, end_min: 1020, breaks: [{ start_min: 720, end_min: 780 }],
    }));
    const res = await call("/api/v1/availability/weekly", { method: "PUT", who: owner, json: { days } });
    expect(res.status).toBe(200);
    let a = await getAvail(owner);
    expect(a.weekly[1]).toEqual({ weekday: 1, open: true, start_min: 660, end_min: 1020, breaks: [{ start_min: 720, end_min: 780 }] });
    expect(a.weekly[0].open).toBe(false);

    await call("/api/v1/availability/weekly", { method: "PUT", who: owner, json: { days: [{ weekday: 6, open: true, start_min: 660, end_min: 900, breaks: [] }] } });
    a = await getAvail(owner);
    expect(a.weekly[1].open).toBe(false);
    expect(a.weekly[6]).toMatchObject({ open: true, end_min: 900 });
  });

  it("rejects hours that end before they start and breaks outside the hours", async () => {
    const owner = await newOwner();
    const bad1 = { days: [{ weekday: 1, open: true, start_min: 900, end_min: 600, breaks: [] }] };
    const bad2 = { days: [{ weekday: 1, open: true, start_min: 600, end_min: 900, breaks: [{ start_min: 500, end_min: 650 }] }] };
    expect((await call("/api/v1/availability/weekly", { method: "PUT", who: owner, json: bad1 })).status).toBe(400);
    expect((await call("/api/v1/availability/weekly", { method: "PUT", who: owner, json: bad2 })).status).toBe(400);
  });

  it("adds and removes one-day changes and blocked dates", async () => {
    const owner = await newOwner();
    const date = "2099-12-24";
    expect((await call(`/api/v1/availability/overrides/${date}`, { method: "PUT", who: owner, json: { closed: false, start_min: 540, end_min: 720 } })).status).toBe(200);
    const blocked = await call("/api/v1/availability/blocked", { method: "POST", who: owner, json: { start_date: "2099-12-25", end_date: "2099-12-26", label: "Christmas" } });
    expect(blocked.status).toBe(201);
    const { id } = (await blocked.json()) as { id: string };
    let a = await getAvail(owner);
    expect(a.overrides.map((o) => o.on_date)).toEqual([date]);
    expect(a.blocked_dates.map((b) => b.id)).toEqual([id]);

    expect((await call(`/api/v1/availability/overrides/${date}`, { method: "DELETE", who: owner })).status).toBe(204);
    expect((await call(`/api/v1/availability/blocked/${id}`, { method: "DELETE", who: owner })).status).toBe(204);
    a = await getAvail(owner);
    expect(a.overrides).toEqual([]);
    expect(a.blocked_dates).toEqual([]);
  });

  it("adds, lists and removes time blocks", async () => {
    const owner = await newOwner();
    const res = await call("/api/v1/availability/time-blocks", {
      method: "POST", who: owner,
      json: { start_at: "2099-01-05T20:00:00.000Z", end_at: "2099-01-05T21:00:00.000Z", note: "Lunch" },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const list = (await (await call("/api/v1/availability/time-blocks?from=2099-01-05T00:00:00.000Z&to=2099-01-06T00:00:00.000Z", { who: owner })).json()) as { time_blocks: { id: string; note: string }[] };
    expect(list.time_blocks).toEqual([{ id, start_at: "2099-01-05T20:00:00.000Z", end_at: "2099-01-05T21:00:00.000Z", note: "Lunch" }]);
    expect((await call(`/api/v1/availability/time-blocks/${id}`, { method: "DELETE", who: owner })).status).toBe(204);
  });
});
