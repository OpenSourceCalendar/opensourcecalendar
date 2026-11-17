import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

const TABLES = [
  "apps", "calendars", "weekly_hours", "weekly_breaks", "date_overrides", "blocked_dates",
  "time_blocks", "services", "customers", "appointments", "reminders", "consents",
  "google_connections", "google_busy", "jobs", "released_slugs", "google_states", "waitlist",
  "users", "invites", "login_links", "billing", "stripe_events", "free_limit_notices",
];

describe("schema", () => {
  it("has all 24 tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual([...TABLES].sort());
  });

  it("appointments has emails_off (0011)", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(appointments)").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toContain("emails_off");
  });
});
