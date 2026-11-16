import { describe, it, expect } from "vitest";
import { findSlots, type SlotInput, type DayHours } from "../src/worker/slots/find-slots";

const LA = "America/Los_Angeles";
const open = (start: number, end: number, breaks: DayHours["breaks"] = []): DayHours => ({ open: true, start, end, breaks });
const H = (h: number, m = 0) => h * 60 + m;
/** UTC ms for h:m local time on Mon 16 Nov 2026 (PST, UTC-8). */
const at = (h: number, m = 0) => Date.UTC(2026, 10, 16, h + 8, m);

function base(over: Partial<SlotInput> = {}): SlotInput {
  const day = open(H(11), H(17));
  return {
    date: "2026-11-16",
    timeZone: LA,
    now: Date.UTC(2026, 10, 13, 20, 0),
    durationMin: 30,
    stepMin: 15,
    bufferMin: 0,
    weekly: { 0: day, 1: day, 2: day, 3: day, 4: day, 5: day, 6: day },
    override: null,
    blockedDates: [],
    appointments: [],
    busy: [],
    minNoticeMin: 60,
    maxDaysAhead: 90,
    maxPerDay: null,
    ...over,
  };
}

describe("findSlots", () => {
  it("offers every 15 minutes from opening until the service no longer fits", () => {
    const slots = findSlots(base());
    expect(slots[0]).toBe(at(11, 0));
    expect(slots.at(-1)).toBe(at(16, 30));
    expect(slots).toHaveLength(23);
  });

  it("gives nothing on a day that is switched off", () => {
    const weekly = { ...base().weekly, 1: { ...open(H(11), H(17)), open: false } };
    expect(findSlots(base({ weekly }))).toEqual([]);
  });

  it("removes breaks", () => {
    const weekly = { ...base().weekly, 1: open(H(11), H(17), [{ start: H(12), end: H(13) }]) };
    const slots = findSlots(base({ weekly }));
    expect(slots).toContain(at(11, 30));
    expect(slots).not.toContain(at(11, 45));
    expect(slots).not.toContain(at(12, 30));
    expect(slots).toContain(at(13, 0));
    expect(slots).toHaveLength(18);
  });

  it("gives nothing on a blocked date", () => {
    expect(findSlots(base({ blockedDates: [{ start: "2026-11-15", end: "2026-11-17" }] }))).toEqual([]);
  });

  it("uses a one-day change instead of the weekly hours", () => {
    expect(findSlots(base({ override: { ...open(H(9), H(12)), open: false } }))).toEqual([]);
    const slots = findSlots(base({ override: open(H(9), H(12)) }));
    expect(slots[0]).toBe(at(9, 0));
    expect(slots.at(-1)).toBe(at(11, 30));
    expect(slots).toHaveLength(11);
  });

  it("keeps the buffer clear on both sides of an appointment", () => {
    const slots = findSlots(
      base({ bufferMin: 15, appointments: [{ id: "a1", start: at(13, 0), end: at(13, 30), status: "booked" }] }),
    );
    expect(slots).toContain(at(12, 15));
    for (const m of [[12, 30], [12, 45], [13, 0], [13, 15], [13, 30]] as const) {
      expect(slots).not.toContain(at(m[0], m[1]));
    }
    expect(slots).toContain(at(13, 45));
  });

  it("ignores cancelled appointments and the one being rescheduled", () => {
    const appts = [
      { id: "a1", start: at(13, 0), end: at(13, 30), status: "cancelled" as const },
      { id: "a2", start: at(14, 0), end: at(14, 30), status: "booked" as const },
    ];
    expect(findSlots(base({ appointments: appts, excludeAppointmentId: "a2" }))).toHaveLength(23);
  });

  it("removes Google busy times and time blocks", () => {
    const slots = findSlots(base({ busy: [{ start: at(14, 0), end: at(15, 0) }] }));
    expect(slots).toContain(at(13, 30));
    expect(slots).not.toContain(at(13, 45));
    expect(slots).not.toContain(at(14, 45));
    expect(slots).toContain(at(15, 0));
  });

  it("drops times sooner than the minimum notice", () => {
    // Today is Fri 13 Nov; now is 12:00 local, so with 60 min notice the first time is 13:00.
    const slots = findSlots(base({ date: "2026-11-13" }));
    expect(slots[0]).toBe(Date.UTC(2026, 10, 13, 21, 0));
  });

  it("gives nothing for past days or days too far ahead", () => {
    expect(findSlots(base({ date: "2026-11-12" }))).toEqual([]);
    expect(findSlots(base({ maxDaysAhead: 2 }))).toEqual([]); // 16 Nov is 3 days ahead
    expect(findSlots(base({ maxDaysAhead: 3 }))).toHaveLength(23);
  });

  it("gives nothing once the day has the maximum bookings", () => {
    const appointments = [
      { id: "a1", start: at(11, 0), end: at(11, 30), status: "booked" as const },
      { id: "a2", start: at(16, 0), end: at(16, 30), status: "confirmed" as const },
    ];
    expect(findSlots(base({ appointments, maxPerDay: 2 }))).toEqual([]);
    expect(findSlots(base({ appointments, maxPerDay: 3 })).length).toBeGreaterThan(0);
  });

  it("lines start times up with the clock", () => {
    const weekly = { ...base().weekly, 1: open(H(11, 10), H(17)) };
    expect(findSlots(base({ weekly }))[0]).toBe(at(11, 15));
  });

  it("skips the missing hour when clocks spring forward, with no duplicates", () => {
    // 8 Mar 2026: 2:00-3:00 AM does not exist in Los Angeles.
    const now = Date.UTC(2026, 2, 1, 0, 0);
    const day = open(H(0), H(4));
    const slots = findSlots(
      base({ now, date: "2026-03-08", durationMin: 60, stepMin: 30, minNoticeMin: 0, weekly: { 0: day } }),
    );
    expect(slots).toEqual([
      Date.UTC(2026, 2, 8, 8, 0), // 0:00 PST
      Date.UTC(2026, 2, 8, 8, 30),
      Date.UTC(2026, 2, 8, 9, 0), // 1:00 PST
      Date.UTC(2026, 2, 8, 9, 30), // 1:30 PST, ends 3:30 PDT
      Date.UTC(2026, 2, 8, 10, 0), // 3:00 PDT
    ]);
  });

  it("never lets a service run past closing on a clock-change day", () => {
    // Open 1:00-3:00 AM on 8 Mar 2026. A 60-min service from 1:30 PST ends 3:30 PDT: too late.
    const now = Date.UTC(2026, 2, 1, 0, 0);
    const slots = findSlots(
      base({ now, date: "2026-03-08", durationMin: 60, stepMin: 30, minNoticeMin: 0, weekly: { 0: open(H(1), H(3)) } }),
    );
    expect(slots).toEqual([Date.UTC(2026, 2, 8, 9, 0)]);
  });

  it("is correct on the days clocks change", () => {
    const now = Date.UTC(2026, 9, 25, 19, 0);
    expect(findSlots(base({ now, date: "2026-10-31" }))[0]).toBe(Date.UTC(2026, 9, 31, 18, 0)); // PDT
    expect(findSlots(base({ now, date: "2026-11-01" }))[0]).toBe(Date.UTC(2026, 10, 1, 19, 0)); // PST
  });
});
