// White-label agencies: the account's calendars (its own and its clients'), and adding a client. Owner app only
// (not /api/v1); 404 for sessions that aren't hosted accounts.
import { Hono } from "hono";
import { z } from "zod";
import { agencyOnly, HOSTED_APP } from "../auth";
import { billed, canAddClients, entitlementsFrom } from "../billing/entitlements";
import { accountCalendars, getBilling, homeCalendar, isClient } from "../billing/store";
import { newId } from "../lib/ids";
import { parseBody } from "../lib/http";
import { mergeBranding, mergeNotifications, parseBranding } from "../settings";
import type { AppEnv, CalendarRow } from "../types";
import { calendarJson, Slug, slugTaken, TimeZone } from "./calendar";

/** Calendars per account, its own included, unless billing.client_limit says otherwise (set by the operator). */
export const DEFAULT_CLIENT_LIMIT = 50;

export const clients = new Hono<AppEnv>();

clients.use("*", agencyOnly);
clients.use("*", async (c, next) => {
  if (c.var.app.id !== HOSTED_APP) return c.json({ error: "not_found" }, 404);
  await next();
});

clients.get("/", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const [cals, row] = await Promise.all([accountCalendars(db, c.var.userId), getBilling(db, c.var.userId)]);
  return c.json({
    calendars: cals.map((cal) => ({
      id: cal.id,
      business_name: parseBranding(cal.branding).business_name,
      slug: cal.slug,
      time_zone: cal.time_zone,
      home: !isClient(cal),
      paused: billed(c.env, cal) && entitlementsFrom(row, !isClient(cal), now).paused,
    })),
    limit: row?.client_limit ?? DEFAULT_CLIENT_LIMIT,
    count: cals.length,
  });
});

const AddBody = z.object({
  business_name: z.string().trim().min(1).max(80),
  slug: Slug,
  time_zone: TimeZone,
  // Checked for shape by the notifications settings below.
  owner_email: z.string().trim().min(1).max(254),
});

clients.post("/", async (c) => {
  const body = await parseBody(c, AddBody);
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const userId = c.var.userId;
  // Paid White-label (a trial counts). A grace month keeps clients running but adds none.
  if (!canAddClients(await getBilling(db, userId))) return c.json({ error: "white_label_required" }, 403);
  if (!(await homeCalendar(db, userId))) return c.json({ error: "calendar_not_found" }, 404);
  if (await slugTaken(db, body.data.slug)) return c.json({ error: "slug_taken" }, 409);
  const branding = mergeBranding("{}", { business_name: body.data.business_name });
  const notifications = mergeNotifications("{}", { owner_email: body.data.owner_email });
  if (!branding.success) return c.json({ error: "invalid_input", issues: branding.error.issues }, 400);
  if (!notifications.success) return c.json({ error: "invalid_input", issues: notifications.error.issues }, 400);

  const id = newId("cal");
  const row: CalendarRow = {
    id,
    app_id: HOSTED_APP,
    // Never equals a user id, and keeps UNIQUE (app_id, external_user_id).
    external_user_id: `${userId}:${id}`,
    account_user_id: userId,
    slug: body.data.slug,
    time_zone: body.data.time_zone,
    rules: "{}",
    branding: JSON.stringify(branding.data),
    notifications: JSON.stringify(notifications.data),
    created_at: Date.now(),
  };
  let added: D1Result;
  try {
    // The count and the insert are one statement (D1 runs each statement atomically), so two adds at once can't
    // both slip under the limit.
    added = await db.prepare(
      `INSERT INTO calendars (id, app_id, external_user_id, account_user_id, slug, time_zone, rules, branding, notifications, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM calendars WHERE account_user_id = ?) < COALESCE((SELECT client_limit FROM billing WHERE user_id = ?), ?)`,
    ).bind(
      row.id, row.app_id, row.external_user_id, row.account_user_id, row.slug, row.time_zone, row.rules, row.branding, row.notifications, row.created_at,
      userId, userId, DEFAULT_CLIENT_LIMIT,
    ).run();
  } catch (err) {
    // Lost a race for the booking address.
    if (String(err).includes("UNIQUE")) return c.json({ error: "slug_taken" }, 409);
    throw err;
  }
  if (!added.meta.changes) return c.json({ error: "client_limit", message: "Contact us to add more" }, 409);
  return c.json(calendarJson(row, c.env), 201);
});
