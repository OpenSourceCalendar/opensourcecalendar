import { Hono } from "hono";
import { z } from "zod";
import { agencyOnly, HOSTED_APP, requireCalendar } from "../auth";
import { newId } from "../lib/ids";
import { isTimeZone, parseBody } from "../lib/http";
import { imageUrl } from "../lib/image-url";
import { mergeBranding, mergeNotifications, mergeRules, parseBranding, parseNotifications, parseRules } from "../settings";
import { emailEnabled } from "../email/send";
import { isClient } from "../billing/store";
import { entitlements } from "../billing/entitlements";
import type { AppEnv, Bindings, CalendarRow } from "../types";

const RESERVED = new Set(["admin", "api", "app", "book", "m", "manage", "health", "images", "setup", "static", "assets", "www"]);
export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/)
  .refine((s) => !RESERVED.has(s), { message: "reserved" });
export const TimeZone = z.string().refine(isTimeZone, { message: "unknown time zone" });

/** The owner's view of a calendar. `email_enabled`: whether this install can send email at all. */
export function calendarJson(row: CalendarRow, env: Bindings) {
  const branding = parseBranding(row.branding);
  return {
    id: row.id,
    slug: row.slug,
    time_zone: row.time_zone,
    rules: parseRules(row.rules),
    branding: { ...branding, logo_url: imageUrl(branding.logo_key), hero_url: imageUrl(branding.hero_key) },
    notifications: parseNotifications(row.notifications),
    email_enabled: emailEnabled(env),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** How long a changed booking link stays reserved for the calendar that gave it up. */
const SLUG_HOLD_MS = 90 * 24 * 60 * 60 * 1000;

/** In use by another calendar, or given up by another calendar in the last 90 days. */
export async function slugTaken(db: D1Database, slug: string, exceptId?: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM calendars WHERE slug = ?").bind(slug).first<{ id: string }>();
  if (row) return row.id !== exceptId;
  const held = await db.prepare("SELECT calendar_id FROM released_slugs WHERE slug = ? AND released_at > ?")
    .bind(slug, Date.now() - SLUG_HOLD_MS)
    .first<{ calendar_id: string }>();
  return !!held && held.calendar_id !== exceptId;
}

export const calendar = new Hono<AppEnv>();

calendar.post("/", agencyOnly, async (c) => {
  const body = await parseBody(c, z.object({ slug: Slug, time_zone: TimeZone }));
  if (!body.ok) return body.response;
  const db = c.env.DB;

  const existing = await db.prepare("SELECT id FROM calendars WHERE app_id = ? AND external_user_id = ?")
    .bind(c.var.app.id, c.var.userId)
    .first();
  if (existing) return c.json({ error: "calendar_exists" }, 409);
  if (await slugTaken(db, body.data.slug)) return c.json({ error: "slug_taken" }, 409);

  const row: CalendarRow = {
    id: newId("cal"),
    app_id: c.var.app.id,
    external_user_id: c.var.userId,
    // Hosted home calendars belong to their account; host apps and standalone installs have no account.
    account_user_id: c.var.app.id === HOSTED_APP ? c.var.userId : null,
    slug: body.data.slug,
    time_zone: body.data.time_zone,
    rules: "{}",
    branding: "{}",
    notifications: "{}",
    created_at: Date.now(),
  };
  try {
    await db.prepare(
      "INSERT INTO calendars (id, app_id, external_user_id, account_user_id, slug, time_zone, rules, branding, notifications, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(row.id, row.app_id, row.external_user_id, row.account_user_id, row.slug, row.time_zone, row.rules, row.branding, row.notifications, row.created_at)
      .run();
  } catch (err) {
    // Lost a race on one of the two unique constraints.
    const message = String(err);
    if (message.includes("UNIQUE")) {
      return c.json({ error: message.includes("calendars.slug") ? "slug_taken" : "calendar_exists" }, 409);
    }
    throw err;
  }
  return c.json(calendarJson(row, c.env), 201);
});

/** What this calendar's plan allows, for the owner screens (a client's own sign-in can't read /billing). */
async function accessJson(env: Bindings, cal: CalendarRow) {
  const e = await entitlements(env, cal);
  // `free` is the agency's own plan: a client calendar never shows it (a paused client must not learn the agency is on Free).
  return { paused: e.paused, reminders: e.reminders, google_busy: e.googleBusy, footer_hidden: e.footerHidden, free: e.plan === "free" && !isClient(cal) };
}

calendar.get("/", requireCalendar, async (c) => c.json({ ...calendarJson(c.var.calendar, c.env), access: await accessJson(c.env, c.var.calendar) }));

calendar.patch("/", requireCalendar, async (c) => {
  const body = await parseBody(
    c,
    z.object({
      slug: Slug.optional(),
      time_zone: TimeZone.optional(),
      rules: z.record(z.string(), z.unknown()).optional(),
      branding: z.record(z.string(), z.unknown()).optional(),
      notifications: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  if (!body.ok) return body.response;
  // Image keys are only ever set by the upload route.
  if (body.data.branding) {
    delete body.data.branding.logo_key;
    delete body.data.branding.hero_key;
  }
  const cal = c.var.calendar;
  const next = { ...cal };

  if (body.data.slug && body.data.slug !== cal.slug) {
    if (await slugTaken(c.env.DB, body.data.slug, cal.id)) return c.json({ error: "slug_taken" }, 409);
    next.slug = body.data.slug;
  }
  if (body.data.time_zone) next.time_zone = body.data.time_zone;

  const parts = [
    ["rules", mergeRules] as const,
    ["branding", mergeBranding] as const,
    ["notifications", mergeNotifications] as const,
  ];
  for (const [field, mergeFn] of parts) {
    const patch = body.data[field];
    if (!patch) continue;
    const merged = mergeFn(cal[field], patch);
    if (!merged.success) return c.json({ error: "invalid_input", issues: merged.error.issues }, 400);
    next[field] = JSON.stringify(merged.data);
  }
  // A client's emails are sent under its business name; empty would fall back to "Open Source Calendar".
  if (isClient(cal) && !parseBranding(next.branding).business_name.trim()) {
    return c.json({ error: "invalid_input", missing: ["business_name"] }, 400);
  }

  try {
    const db = c.env.DB;
    const update = c.env.DB.prepare(
      // Keep whatever image keys are in the row now: an upload may have landed since this request read it.
      "UPDATE calendars SET slug = ?, time_zone = ?, rules = ?, branding = json_set(?, '$.logo_key', json_extract(branding, '$.logo_key'), '$.hero_key', json_extract(branding, '$.hero_key')), notifications = ? WHERE id = ?",
    )
      .bind(next.slug, next.time_zone, next.rules, next.branding, next.notifications, cal.id);
    // Changing the link reserves the old name for this calendar, and un-reserves the new one if it was ours.
    await db.batch(
      next.slug === cal.slug
        ? [update]
        : [
            update,
            db.prepare("INSERT OR REPLACE INTO released_slugs (slug, calendar_id, released_at) VALUES (?, ?, ?)").bind(cal.slug, cal.id, Date.now()),
            db.prepare("DELETE FROM released_slugs WHERE slug = ?").bind(next.slug),
          ],
    );
  } catch (err) {
    // Lost a race with another calendar taking the same slug.
    if (String(err).includes("UNIQUE")) return c.json({ error: "slug_taken" }, 409);
    throw err;
  }
  // Re-read: an image upload may have landed while this request ran, and `next` would show the old key.
  const fresh = await c.env.DB.prepare("SELECT * FROM calendars WHERE id = ?").bind(cal.id).first<CalendarRow>();
  const saved = fresh ?? next;
  return c.json({ ...calendarJson(saved, c.env), access: await accessJson(c.env, saved) });
});
