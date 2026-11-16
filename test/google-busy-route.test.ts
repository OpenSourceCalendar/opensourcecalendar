import { describe, expect, it } from "vitest";
import { call, newOwner, testEnv } from "./helpers";
import { calendarIdOf } from "./google-fake";

type Who = { key: string; user: string; slug: string };
const at = (iso: string) => Date.parse(iso);

async function addBusy(who: Who, eventId: string, start: string, end: string) {
  await testEnv.DB.prepare("INSERT INTO google_busy (calendar_id, google_event_id, start_at, end_at) VALUES (?, ?, ?, ?)")
    .bind(await calendarIdOf(who.slug), eventId, at(start), at(end))
    .run();
}

const busy = (who: Who, from: string, to: string) =>
  call(`/api/v1/google/busy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { who });

describe("GET /google/busy", () => {
  it("returns only the times, overlapping the range, in order", async () => {
    const owner = await newOwner();
    await addBusy(owner, "evt-late", "2030-01-08T15:00:00Z", "2030-01-08T16:00:00Z");
    await addBusy(owner, "evt-early", "2030-01-07T09:00:00Z", "2030-01-07T10:00:00Z");
    await addBusy(owner, "evt-spans-start", "2030-01-06T23:00:00Z", "2030-01-07T01:00:00Z");
    await addBusy(owner, "evt-before", "2030-01-06T10:00:00Z", "2030-01-06T11:00:00Z");
    await addBusy(owner, "evt-after", "2030-01-14T10:00:00Z", "2030-01-14T11:00:00Z");

    const res = await busy(owner, "2030-01-07T00:00:00Z", "2030-01-14T00:00:00Z");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      busy: [
        { start: "2030-01-06T23:00:00.000Z", end: "2030-01-07T01:00:00.000Z" },
        { start: "2030-01-07T09:00:00.000Z", end: "2030-01-07T10:00:00.000Z" },
        { start: "2030-01-08T15:00:00.000Z", end: "2030-01-08T16:00:00.000Z" },
      ],
    });
  });

  it("never shows another calendar's busy times", async () => {
    const owner = await newOwner();
    const other = await newOwner();
    await addBusy(other, "evt-theirs", "2030-01-07T09:00:00Z", "2030-01-07T10:00:00Z");
    const res = await busy(owner, "2030-01-07T00:00:00Z", "2030-01-08T00:00:00Z");
    expect(await res.json()).toEqual({ busy: [] });
  });

  it("rejects a missing or bad range", async () => {
    const owner = await newOwner();
    expect((await call("/api/v1/google/busy", { who: owner })).status).toBe(400);
    expect((await busy(owner, "yesterday", "2030-01-08T00:00:00Z")).status).toBe(400);
  });

  it("works from the owner screens too", async () => {
    const owner = await newOwner();
    await addBusy(owner, "evt-1", "2030-01-07T09:00:00Z", "2030-01-07T10:00:00Z");
    const { token } = (await (await call("/api/v1/admin-sessions", { method: "POST", who: owner })).json()) as { token: string };
    const res = await call("/api/admin/google/busy?from=2030-01-07T00:00:00Z&to=2030-01-08T00:00:00Z", { headers: { Authorization: `Session ${token}` } });
    expect(((await res.json()) as { busy: unknown[] }).busy).toHaveLength(1);
  });
});
