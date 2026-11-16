import { describe, it, expect } from "vitest";
import { reminderAt } from "../src/worker/email/reminder-time";
import { localToUtc } from "../src/worker/slots/tz";

const LA = "America/Los_Angeles";
const at = (date: string, hhmm: string) => localToUtc(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), LA);
const smart = { reminder_mode: "smart" as const, reminder_hours_before: 24 };

describe("reminderAt", () => {
  it("smart: two hours before a daytime appointment", () => {
    expect(reminderAt(at("2026-11-17", "15:00"), smart, LA)).toBe(at("2026-11-17", "13:00"));
    expect(reminderAt(at("2026-11-17", "09:00"), smart, LA)).toBe(at("2026-11-17", "07:00"));
  });
  it("smart: 6 PM the evening before an early-morning appointment", () => {
    expect(reminderAt(at("2026-11-17", "08:45"), smart, LA)).toBe(at("2026-11-16", "18:00"));
    expect(reminderAt(at("2026-11-17", "00:30"), smart, LA)).toBe(at("2026-11-16", "18:00"));
  });
  it("smart: the evening before is still right across a clock change", () => {
    // Clocks go forward on 2027-03-14 in Los Angeles: 7:00 AM that day is 14:00 UTC,
    // and 6:00 PM the evening before (still winter time) is 02:00 UTC.
    expect(at("2027-03-14", "07:00")).toBe(Date.UTC(2027, 2, 14, 14, 0));
    expect(reminderAt(at("2027-03-14", "07:00"), smart, LA)).toBe(Date.UTC(2027, 2, 14, 2, 0));
  });
  it("hours_before: exactly that many hours earlier", () => {
    const start = at("2026-11-17", "15:00");
    expect(reminderAt(start, { reminder_mode: "hours_before", reminder_hours_before: 24 }, LA)).toBe(start - 24 * 3600_000);
    expect(reminderAt(start, { reminder_mode: "hours_before", reminder_hours_before: 3 }, LA)).toBe(start - 3 * 3600_000);
  });
});
