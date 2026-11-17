/// <reference lib="dom" />
import { describe, it, expect } from "vitest";
import { brandVars, contrastOf } from "../src/react-app/theme";

const DARK_SURFACE = "#161a20";

describe("brandVars", () => {
  it("leaves the light styles as they were", () => {
    for (const style of ["classic", "clean", "soft", "bold"] as const) {
      expect(brandVars("#0e7490", style)).toEqual(brandVars("#0e7490"));
    }
    expect(brandVars("#0e7490")["--brand"]).toBe("#0e7490");
  });

  it("keeps Midnight's brand and button text readable for any color", () => {
    for (const color of ["#0e7490", "#111111", "#1d4ed8", "#7c3aed", "#b91c1c", "#facc15", "#ffffff"]) {
      const v = brandVars(color, "midnight");
      expect(v["--brand"]).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastOf(v["--brand"], DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(v["--on-brand"], v["--brand"])).toBeGreaterThanOrEqual(4.5);
      expect(v["--brand-ink"]).toBe(v["--brand"]);
    }
  });
});
