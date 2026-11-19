// White-label agencies: the account's calendars (its own and its clients'), and adding a client. Owner app only
// (not /api/v1); 404 for sessions that aren't hosted accounts.
import { Hono } from "hono";
import { z } from "zod";
import { agencyOnly, HOSTED_APP } from "../auth";
import { inviteAllowed, prepareInvite, removeSignIn, signInJson, signInsFor } from "../accounts/client-users";
import { publicBase } from "../accounts/config";
import { clientInviteEmail } from "../accounts/email";
import { passwordsOn } from "../accounts/password";
import { normalizeEmail } from "../accounts/store";
import { billed, canAddClients, entitlementsFrom } from "../billing/entitlements";
import { accountCalendars, getBilling, homeCalendar, isClient } from "../billing/store";
import { emailFrom } from "../email/send";
import { newId } from "../lib/ids";
import { parseBody } from "../lib/http";
import { mergeBranding, mergeNotifications, parseBranding, parseNotifications } from "../settings";
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
  const [cals, row, signIns] = await Promise.all([accountCalendars(db, c.var.userId), getBilling(db, c.var.userId), signInsFor(db, c.var.userId)]);
  return c.json({
    calendars: cals.map((cal) => ({
      id: cal.id,
      business_name: parseBranding(cal.branding).business_name,
      slug: cal.slug,
      time_zone: cal.time_zone,
      home: !isClient(cal),
      paused: billed(c.env, cal) && entitlementsFrom(row, !isClient(cal), now).paused,
      // Prefills the invite box.
      notification_email: parseNotifications(cal.notifications).owner_email,
      signin: signInJson(signIns.get(cal.id)),
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

/** One of this agency's client calendars (never its own), or null. */
async function ownClient(db: D1Database, agencyUserId: string, id: string): Promise<CalendarRow | null> {
  const cal = await db.prepare("SELECT * FROM calendars WHERE id = ? AND app_id = ? AND account_user_id = ?")
    .bind(id, HOSTED_APP, agencyUserId).first<CalendarRow>();
  return cal && isClient(cal) ? cal : null;
}

// No White-label check here (unlike POST /): a paused client can still sign in to see its bookings.
clients.post("/:id/invite", async (c) => {
  const from = emailFrom(c.env);
  if (!passwordsOn(c.env) || !from || !c.env.EMAIL) return c.json({ error: "not_available" }, 404);
  const body = await parseBody(c, z.object({ email: z.email().max(254) }));
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const now = Date.now();
  // Counted first, refusals included, so the "already has an account" answer can't be probed for free.
  if (!(await inviteAllowed(db, c.var.userId, now))) return c.json({ error: "too_many_invites" }, 429);
  const cal = await ownClient(db, c.var.userId, c.req.param("id"));
  if (!cal) return c.json({ error: "calendar_not_found" }, 404);
  const result = await prepareInvite(db, cal.id, normalizeEmail(body.data.email), now);
  if (!result.ok) return c.json({ error: result.error }, 409);
  const brand = parseBranding(cal.branding).business_name.replace(/\s+/g, " ").trim().slice(0, 80) || "Your booking calendar";
  // Always PUBLIC_URL, never the Host header; the token rides in the fragment, so it never reaches a server log.
  const mail = clientInviteEmail(from, result.user.email, `${publicBase(c.env)}/invite#t=${result.token}`, brand);
  c.executionCtx.waitUntil(c.env.EMAIL.send(mail).catch((err) => console.error(JSON.stringify({ event: "client_invite_email_failed", error: String(err).slice(0, 200) }))));
  return c.json({ signin: signInJson(result.user) });
});

clients.delete("/:id/sign-in", async (c) => {
  const cal = await ownClient(c.env.DB, c.var.userId, c.req.param("id"));
  if (!cal) return c.json({ error: "calendar_not_found" }, 404);
  await removeSignIn(c.env.DB, cal.id, Date.now());
  return c.body(null, 204);
});
