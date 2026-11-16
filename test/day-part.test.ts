import { describe, it, expect } from "vitest";
import { dayPart } from "../src/react-app/time";

describe("dayPart", () => {
  const LA = "America/Los_Angeles";
  it("splits at noon and 5 PM in the shown zone", () => {
    expect(dayPart("2026-11-17T19:59:00Z", LA)).toBe("Morning"); // 11:59 AM
    expect(dayPart("2026-11-17T20:00:00Z", LA)).toBe("Afternoon"); // 12:00 PM
    expect(dayPart("2026-11-18T00:59:00Z", LA)).toBe("Afternoon"); // 4:59 PM
    expect(dayPart("2026-11-18T01:00:00Z", LA)).toBe("Evening"); // 5:00 PM
  });
  it("midnight is morning, not hour 24", () => {
    expect(dayPart("2026-11-17T08:00:00Z", LA)).toBe("Morning"); // 12:00 AM
  });
  it("uses the zone, not UTC", () => {
    expect(dayPart("2026-11-17T09:00:00Z", "Europe/London")).toBe("Morning");
    expect(dayPart("2026-11-17T09:00:00Z", LA)).toBe("Morning"); // 1 AM
    expect(dayPart("2026-11-17T22:00:00Z", "Asia/Tokyo")).toBe("Morning"); // 7 AM next day
  });
});
