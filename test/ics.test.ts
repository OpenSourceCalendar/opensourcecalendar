import { describe, it, expect } from "vitest";
import { buildIcs } from "../src/worker/booking/ics";

describe("buildIcs", () => {
  it("builds a single VEVENT with UID, SEQUENCE and UTC times, CRLF line endings", () => {
    const ics = buildIcs({
      id: "apt_123", sequence: 2, start: Date.UTC(2026, 11, 3, 18, 0), end: Date.UTC(2026, 11, 3, 18, 30),
      title: "Call with Alex", description: "Manage: https://x.test/m/abc", location: "Phone call", cancelled: false,
      now: Date.UTC(2026, 10, 14, 0, 0),
    });
    expect(ics.split("\r\n")).toEqual(expect.arrayContaining([
      "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:apt_123@booking-calendar", "SEQUENCE:2",
      "DTSTAMP:20261114T000000Z", "DTSTART:20261203T180000Z", "DTEND:20261203T183000Z",
      "SUMMARY:Call with Alex", "STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR",
    ]));
  });
  it("escapes commas, semicolons and newlines, and marks cancellations", () => {
    const ics = buildIcs({ id: "a", sequence: 0, start: 0, end: 60000, title: "A, B; C", description: "line1\nline2", location: "", cancelled: true, now: 0 });
    expect(ics).toContain("SUMMARY:A\\, B\\; C");
    expect(ics).toContain("DESCRIPTION:line1\\nline2");
    expect(ics).toContain("STATUS:CANCELLED");
  });
  it("turns a lone carriage return into an escaped newline", () => {
    const ics = buildIcs({ id: "a", sequence: 0, start: 0, end: 60000, title: "A\rDTSTART:1", description: "", location: "", cancelled: false, now: 0 });
    expect(ics).toContain("SUMMARY:A\\nDTSTART:1");
    expect(ics.split("\r\n").filter((l) => l.startsWith("DTSTART:"))).toHaveLength(1);
  });
});

describe("folding long lines", () => {
  it("never splits a character, and keeps every line within 75 bytes", async () => {
    const { buildIcs } = await import("../src/worker/booking/ics");
    const title = `${"a".repeat(66)}😀 Spa ${"é".repeat(60)}`;
    const ics = buildIcs({ id: "apt_x", sequence: 0, start: 0, end: 1, title, description: "", location: "", cancelled: false, now: 0 });
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(`SUMMARY:${title}`);
    expect(new TextDecoder().decode(new TextEncoder().encode(ics))).not.toContain("�");
  });
});
