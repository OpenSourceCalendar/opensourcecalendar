import { describe, it, expect } from "vitest";
import { parseRules, mergeRules, parseBranding, parseNotifications } from "../src/worker/settings";

describe("settings", () => {
  it("fills defaults from an empty object", () => {
    const r = parseRules("{}");
    expect(r).toMatchObject({
      buffer_min: 0, max_per_day: null, min_notice_min: 60, max_days_ahead: 90,
      change_cutoff_hours: 0, slot_step_min: 15, cancel_reason_required: false,
      block_all_day_google: true, powered_by: true,
    });
    expect(r.required_fields).toEqual({ first_name: true, last_name: false, email: false, phone: true });
    expect(parseBranding("{}").color).toBe("#2d6a4f");
    expect(parseNotifications("{}").reminder_mode).toBe("smart");
  });

  it("merges a partial update and rejects bad values", () => {
    const merged = mergeRules("{}", { buffer_min: 15, max_per_day: 9 });
    expect(merged.success && merged.data.buffer_min).toBe(15);
    expect(merged.success && merged.data.min_notice_min).toBe(60);
    expect(mergeRules("{}", { buffer_min: 20 }).success).toBe(false);
  });

  it("requires phone or email to be required", () => {
    const res = mergeRules("{}", {
      required_fields: { first_name: true, last_name: false, email: false, phone: false },
    });
    expect(res.success).toBe(false);
  });
});
