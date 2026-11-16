import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleConfig, type GEvent } from "../src/worker/google/client";
import { accessTokenFor, getConnection, NotConnected } from "../src/worker/google/connection";
import { checkGoogleWindow, eventsToBusy, runGoogleSync, syncBusy } from "../src/worker/google/busy";
import { localToUtc } from "../src/worker/slots/tz";
import type { CalendarRow } from "../src/worker/types";
import { bookableOwner, call, newOwner, testEnv } from "./helpers";
import { calendarIdOf, connectForTest, FakeGoogle, PRIMARY } from "./google-fake";

const LA = "America/Los_Angeles";
const O = { calendarId: "cal_me", timeZone: LA, blockAllDay: true };
const timed = (id: string, start: string, end: string, extra: Partial<GEvent> = {}): GEvent => ({ id, start: { dateTime: start }, end: { dateTime: end }, ...extra });

describe("eventsToBusy", () => {
  const a = timed("a", "2026-12-01T17:00:00Z", "2026-12-01T18:00:00Z");
  it("keeps a timed busy event", () => {
    expect(eventsToBusy([a], O)).toEqual([{ id: "a", start: Date.parse("2026-12-01T17:00:00Z"), end: Date.parse("2026-12-01T18:00:00Z") }]);
  });
  it("skips Free, cancelled, declined, working-location and birthday events", () => {
    expect(eventsToBusy([{ ...a, transparency: "transparent" }], O)).toEqual([]);
    expect(eventsToBusy([{ ...a, status: "cancelled" }], O)).toEqual([]);
    expect(eventsToBusy([{ ...a, attendees: [{ self: true, responseStatus: "declined" }] }], O)).toEqual([]);
    expect(eventsToBusy([{ ...a, eventType: "workingLocation" }], O)).toEqual([]);
    expect(eventsToBusy([{ ...a, eventType: "birthday" }], O)).toEqual([]);
  });
  it("keeps out-of-office and focus time", () => {
    expect(eventsToBusy([{ ...a, eventType: "outOfOffice" }, { ...a, id: "b", eventType: "focusTime" }], O)).toHaveLength(2);
  });
  it("skips this calendar's own bookings but not another booking calendar's", () => {
    expect(eventsToBusy([{ ...a, extendedProperties: { private: { bookingCalendarCal: "cal_me" } } }], O)).toEqual([]);
    expect(eventsToBusy([{ ...a, extendedProperties: { private: { bookingCalendarCal: "cal_other" } } }], O)).toHaveLength(1);
  });
  it("all-day events block whole local days when the switch is on, even when marked Free", () => {
    const day = { id: "d", start: { date: "2026-12-24" }, end: { date: "2026-12-26" }, transparency: "transparent" };
    expect(eventsToBusy([day], O)).toEqual([{ id: "d", start: localToUtc("2026-12-24", 0, LA), end: localToUtc("2026-12-26", 0, LA) }]);
    expect(eventsToBusy([day], { ...O, blockAllDay: false })).toEqual([]);
  });
  it("skips empty or backwards events and sorts by start", () => {
    const back = timed("x", "2026-12-01T18:00:00Z", "2026-12-01T17:00:00Z");
    const early = timed("e", "2026-12-01T10:00:00Z", "2026-12-01T11:00:00Z");
    expect(eventsToBusy([a, back, early], O).map((b) => b.id)).toEqual(["e", "a"]);
  });
});

let fake: FakeGoogle;
beforeEach(() => {
  fake = new FakeGoogle();
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});
afterEach(() => vi.restoreAllMocks());

const cfg = () => googleConfig(testEnv)!;
const calRow = (id: string) => testEnv.DB.prepare("SELECT * FROM calendars WHERE id = ?").bind(id).first<CalendarRow>() as Promise<CalendarRow>;
const busyRows = (id: string) => testEnv.DB.prepare("SELECT google_event_id, start_at, end_at FROM google_busy WHERE calendar_id = ? ORDER BY start_at").bind(id).all().then((r) => r.results);
const DAY = 86_400_000;
const at = (h: number) => new Date(Date.now() + 2 * DAY + h * 3_600_000).toISOString();

async function connected() {
  const owner = await newOwner();
  const id = await calendarIdOf(owner.slug);
  await connectForTest(id);
  return { owner, id };
}
const sync = async (id: string) => syncBusy(testEnv, cfg(), (await getConnection(testEnv.DB, id))!, await calRow(id), Date.now());

describe("access tokens", () => {
  it("caches the access token, and refreshes after it expires", async () => {
    const { id } = await connected();
    const conn = (await getConnection(testEnv.DB, id))!;
    const t1 = await accessTokenFor(testEnv, cfg(), conn, Date.now());
    const t2 = await accessTokenFor(testEnv, cfg(), (await getConnection(testEnv.DB, id))!, Date.now());
    expect(t2).toBe(t1);
    expect(fake.calls.filter((c) => c.url.includes("/token"))).toHaveLength(1);
    const t3 = await accessTokenFor(testEnv, cfg(), (await getConnection(testEnv.DB, id))!, Date.now() + 2 * 3_600_000);
    expect(t3).not.toBe(t1);
  });
  it("marks the connection broken when Google signed it out", async () => {
    const { id } = await connected();
    fake.refreshTokens.clear();
    await expect(accessTokenFor(testEnv, cfg(), (await getConnection(testEnv.DB, id))!, Date.now())).rejects.toBeInstanceOf(NotConnected);
    const conn = await getConnection(testEnv.DB, id);
    expect([conn!.status, conn!.last_error]).toEqual(["broken", "signed_out"]);
  });
  it("keeps the connection when the server's client secret is wrong", async () => {
    const { id } = await connected();
    fake.fail["/token"] = { status: 401, reason: "invalid_client" };
    await expect(accessTokenFor(testEnv, cfg(), (await getConnection(testEnv.DB, id))!, Date.now())).rejects.not.toBeInstanceOf(NotConnected);
    expect((await getConnection(testEnv.DB, id))!.status).toBe("active");
  });
});

describe("syncBusy", () => {
  it("copies busy events, follows deletions, and skips writing when nothing changed", async () => {
    const { id } = await connected();
    fake.addEvent(PRIMARY, timed("e1", at(1), at(2)));
    fake.addEvent(PRIMARY, timed("e2", at(3), at(4)));
    await sync(id);
    expect((await busyRows(id)).map((r) => r.google_event_id)).toEqual(["e1", "e2"]);
    const first = (await getConnection(testEnv.DB, id))!;
    expect(first.last_synced_at).toBeGreaterThan(0);

    fake.events.get(PRIMARY)!.get("e1")!.deleted = true;
    await sync(id);
    expect((await busyRows(id)).map((r) => r.google_event_id)).toEqual(["e2"]);

    // Unchanged: rows stay, only the hash/time row is touched (a stray row would survive if we skipped wrongly).
    await testEnv.DB.prepare("INSERT INTO google_busy VALUES (?, 'stray', 1, 2)").bind(id).run();
    const hash = (await getConnection(testEnv.DB, id))!.busy_hash;
    await sync(id);
    expect((await getConnection(testEnv.DB, id))!.busy_hash).toBe(hash);
    expect((await busyRows(id)).map((r) => r.google_event_id)).toEqual(["stray", "e2"]);
  });
  it("handles many events and Google's paging", async () => {
    const { id } = await connected();
    fake.pageSize = 7;
    for (let i = 0; i < 45; i++) fake.addEvent(PRIMARY, timed(`m${i}`, at(i), at(i + 0.5)));
    await sync(id);
    expect(await busyRows(id)).toHaveLength(45);
  });
  it("only asks for the bookable window", async () => {
    const { id } = await connected();
    await sync(id);
    const url = new URL(fake.calls.find((c) => c.url.includes("/events"))!.url);
    const max = Date.parse(url.searchParams.get("timeMax")!);
    expect(Math.abs(max - (Date.now() + 92 * DAY))).toBeLessThan(60_000); // default max_days_ahead 90, + 2
  });
  it("a sync that finishes after a calendar switch leaves the new calendar's busy times alone", async () => {
    const { id } = await connected();
    const oldConn = (await getConnection(testEnv.DB, id))!;
    await testEnv.DB.prepare("UPDATE google_connections SET google_calendar_id = 'work_x@group.calendar.google.com' WHERE calendar_id = ?").bind(id).run();
    await testEnv.DB.prepare("INSERT INTO google_busy VALUES (?, 'new-cal-event', 1, 2)").bind(id).run();
    await syncBusy(testEnv, cfg(), oldConn, await calRow(id), Date.now());
    expect((await busyRows(id)).map((r) => r.google_event_id)).toEqual(["new-cal-event"]);
  });

  it("writes nothing if the calendar was disconnected mid-sync", async () => {
    const { id } = await connected();
    fake.addEvent(PRIMARY, timed("e1", at(1), at(2)));
    const conn = (await getConnection(testEnv.DB, id))!;
    await testEnv.DB.prepare("DELETE FROM google_connections WHERE calendar_id = ?").bind(id).run();
    await syncBusy(testEnv, cfg(), conn, await calRow(id), Date.now()).catch(() => {});
    expect(await busyRows(id)).toEqual([]);
  });
});

describe("checking Google right before a booking", () => {
  it("an event added in the last minute blocks the booking", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const id = await calendarIdOf(owner.slug);
    await connectForTest(id);
    const start = Date.parse(slots[0]);
    fake.addEvent(PRIMARY, timed("late", new Date(start).toISOString(), new Date(start + 30 * 60_000).toISOString()));
    const res = await call(`/api/public/${owner.slug}/book`, { method: "POST", json: { service_id: serviceId, start: slots[0], first_name: "Ann", phone: "5035550101" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("slot_unavailable");
    expect((await getConnection(testEnv.DB, id))!.busy_hash).toBeNull();
  });
  it("Google being down never fails the booking", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    await connectForTest(await calendarIdOf(owner.slug));
    fake.fail["googleapis.com"] = { status: 0, network: true };
    const res = await call(`/api/public/${owner.slug}/book`, { method: "POST", json: { service_id: serviceId, start: slots[0], first_name: "Ann", phone: "5035550102" } });
    expect(res.status).toBe(201);
  });
  it("doesn't call Google when the calendar isn't connected, or the time isn't open", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    await call(`/api/public/${owner.slug}/book`, { method: "POST", json: { service_id: serviceId, start: slots[0], first_name: "Ann", phone: "5035550103" } });
    expect(fake.calls).toEqual([]);
    await connectForTest(await calendarIdOf(owner.slug));
    const closed = new Date(Date.parse(slots[0]) - 12 * 3_600_000).toISOString(); // middle of the night
    await call(`/api/public/${owner.slug}/book`, { method: "POST", json: { service_id: serviceId, start: closed, first_name: "Ann", phone: "5035550104" } });
    expect(fake.calls).toEqual([]);
  });
  it("gives up after 2.5 seconds", async () => {
    const { owner } = await connected();
    const cal = await calRow(await calendarIdOf(owner.slug));
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {})); // never answers
    const t = Date.now();
    await checkGoogleWindow(testEnv, cal, Date.now() + DAY, Date.now() + DAY + 1_800_000, Date.now());
    expect(Date.now() - t).toBeLessThan(4_000);
  });
});

describe("runGoogleSync (cron)", () => {
  it("syncs due active connections and records problems", async () => {
    const ok = await connected();
    const gone = await connected();
    await testEnv.DB.prepare("UPDATE google_connections SET google_calendar_id = 'missing@x' WHERE calendar_id = ?").bind(gone.id).run();
    const flaky = await connected();
    await testEnv.DB.prepare("UPDATE google_connections SET google_calendar_id = 'flaky@x' WHERE calendar_id = ?").bind(flaky.id).run();
    fake.events.set("flaky@x", new Map());
    fake.fail["flaky%40x"] = { status: 500 };
    const broken = await connected();
    await testEnv.DB.prepare("UPDATE google_connections SET status = 'broken' WHERE calendar_id = ?").bind(broken.id).run();
    // Other test files' connections may be due too; keep running until ours are done.
    for (let i = 0; i < 10 && !(await getConnection(testEnv.DB, ok.id))!.last_synced_at; i++) await runGoogleSync(testEnv, Date.now());
    for (let i = 0; i < 10 && (await getConnection(testEnv.DB, gone.id))!.status === "active"; i++) await runGoogleSync(testEnv, Date.now());
    expect((await getConnection(testEnv.DB, ok.id))!.last_synced_at).toBeGreaterThan(0);
    const g = (await getConnection(testEnv.DB, gone.id))!;
    expect([g.status, g.last_error]).toEqual(["broken", "calendar_missing"]);
    const f = (await getConnection(testEnv.DB, flaky.id))!;
    expect([f.status, f.last_error]).toEqual(["active", "500_unknown"]);
    expect((await getConnection(testEnv.DB, broken.id))!.last_synced_at).toBeNull();
  });
});
