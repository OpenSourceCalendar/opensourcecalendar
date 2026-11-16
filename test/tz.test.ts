import { describe, it, expect } from "vitest";
import { offsetMinutes, localToUtc, utcToLocalDate, weekdayOf, addDays } from "../src/worker/slots/tz";

const LA = "America/Los_Angeles";

describe("offsetMinutes", () => {
  it("is -480 in winter and -420 in summer for Los Angeles", () => {
    expect(offsetMinutes(Date.UTC(2026, 10, 16, 12), LA)).toBe(-480);
    expect(offsetMinutes(Date.UTC(2026, 6, 1, 12), LA)).toBe(-420);
  });
});

describe("localToUtc", () => {
  it("handles the day clocks spring forward", () => {
    expect(localToUtc("2026-03-07", 11 * 60, LA)).toBe(Date.UTC(2026, 2, 7, 19, 0)); // PST
    expect(localToUtc("2026-03-08", 11 * 60, LA)).toBe(Date.UTC(2026, 2, 8, 18, 0)); // PDT
  });
  it("handles the day clocks fall back", () => {
    expect(localToUtc("2026-10-31", 11 * 60, LA)).toBe(Date.UTC(2026, 9, 31, 18, 0)); // PDT
    expect(localToUtc("2026-11-01", 11 * 60, LA)).toBe(Date.UTC(2026, 10, 1, 19, 0)); // PST
  });
  it("works for UTC", () => {
    expect(localToUtc("2026-11-16", 90, "UTC")).toBe(Date.UTC(2026, 10, 16, 1, 30));
  });
});

describe("utcToLocalDate", () => {
  it("returns the local calendar date", () => {
    // 05:00 UTC on 14 Nov is 9 PM on 13 Nov in Los Angeles
    expect(utcToLocalDate(Date.UTC(2026, 10, 14, 5, 0), LA)).toBe("2026-11-13");
  });
});

describe("weekdayOf / addDays", () => {
  it("knows 13 Nov 2026 is a Friday", () => {
    expect(weekdayOf("2026-11-13")).toBe(5);
  });
  it("adds days across a month end", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-11-13", 90)).toBe("2027-02-11");
  });
});
