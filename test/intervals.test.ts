import { describe, it, expect } from "vitest";
import { subtract } from "../src/worker/slots/intervals";

describe("subtract", () => {
  it("cuts a hole in the middle and trims an end", () => {
    expect(subtract([{ start: 0, end: 100 }], [{ start: 20, end: 30 }, { start: 90, end: 120 }])).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 90 },
    ]);
  });
  it("leaves ranges that don't overlap", () => {
    expect(subtract([{ start: 0, end: 10 }], [{ start: 10, end: 20 }])).toEqual([{ start: 0, end: 10 }]);
  });
  it("removes a range covered completely", () => {
    expect(subtract([{ start: 5, end: 10 }], [{ start: 0, end: 20 }])).toEqual([]);
  });
});
