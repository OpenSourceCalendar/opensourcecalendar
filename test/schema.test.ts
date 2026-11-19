import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";

const TABLES = [
  "apps", "calendars", "weekly_hours", "weekly_breaks", "date_overrides", "blocked_dates",
  "time_blocks", "services", "customers", "appointments", "reminders", "consents",
  "google_connections", "google_busy", "jobs", "released_slugs", "google_states", "waitlist",
  "users", "invites", "login_links", "billing", "stripe_events", "free_limit_notices",
  "client_invites", "invite_attempts", "password_attempts",
];

describe("schema", () => {
  it("calendars.account_user_id and billing.client_limit (0012)", async () => {
    const cols = async (t: string) => (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((r) => r.name);
    expect(await cols("calendars")).toContain("account_user_id");
    expect(await cols("billing")).toContain("client_limit");
  });

  it("0012 backfills account_user_id on hosted calendars only", async () => {
    // The migration already ran on an empty database; run its UPDATE again on rows made the old way.
    const m = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS.find((x) => x.name.startsWith("0012"))!;
    const backfill = m.queries.find((q) => q.includes("UPDATE calendars SET account_user_id"))!;
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO apps (id, name, api_key_hash, created_at) VALUES ('app_hosted', 'Hosted', 'none:app_hosted', 0)"),
      env.DB.prepare("INSERT OR IGNORE INTO apps (id, name, api_key_hash, created_at) VALUES ('app_backfill', 'Other', 'none:app_backfill', 0)"),
      env.DB.prepare("INSERT INTO calendars (id, app_id, external_user_id, slug, time_zone, rules, branding, notifications, created_at) VALUES ('cal_bf_hosted', 'app_hosted', 'usr_bf', 'bf-hosted', 'UTC', '{}', '{}', '{}', 0)"),
      env.DB.prepare("INSERT INTO calendars (id, app_id, external_user_id, slug, time_zone, rules, branding, notifications, created_at) VALUES ('cal_bf_app', 'app_backfill', 'someone', 'bf-app', 'UTC', '{}', '{}', '{}', 0)"),
    ]);
    await env.DB.prepare(backfill).run();
    const owner = async (id: string) => (await env.DB.prepare("SELECT account_user_id FROM calendars WHERE id = ?").bind(id).first<{ account_user_id: string | null }>())!.account_user_id;
    expect(await owner("cal_bf_hosted")).toBe("usr_bf");
    expect(await owner("cal_bf_app")).toBeNull();
  });

  it("has all 27 tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual([...TABLES].sort());
  });

  it("users get password, session and client columns (0013)", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["password_hash", "password_set_at", "session_version", "client_calendar_id"]));
  });

  it("appointments has emails_off (0011)", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(appointments)").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toContain("emails_off");
  });
});
