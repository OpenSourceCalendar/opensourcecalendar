// Google Calendar connection: status, connect, choose a calendar, check now, disconnect (owner and host
// app, like every other /api/v1 and /api/admin route), plus the two public pages Google's sign-in tab uses.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireCalendar } from "../auth";
import { entitlements } from "../billing/entitlements";
import { originOf } from "../email/queue";
import { randomToken, sha256Hex } from "../lib/ids";
import { parseBody } from "../lib/http";
import { parseBranding } from "../settings";
import type { AppEnv, Bindings, CalendarRow } from "../types";
import { recordSyncError, syncBusy } from "../google/busy";
import {
  authUrl, calendarName, emailFromIdToken, EVENTS_SCOPE, exchangeCode, googleConfig, LIST_SCOPE, listCalendars,
  redirectUri, revokeToken, type GoogleConfig, type TokenResponse,
} from "../google/client";
import { accessTokenFor, getConnection, NotConnected, type ConnectionRow } from "../google/connection";
import { openToken, sealToken } from "../google/crypto";
import { googlePushMany, runGoogleJobs } from "../google/push";
import { signState, STATE_TTL_MS, verifyState } from "../google/state";

function sessionSecret(env: Bindings): string {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  return env.SESSION_SECRET;
}

/** The owner's view of the connection. Never includes tokens. */
export async function googleStatus(env: Bindings, calendarId: string) {
  const conn = await getConnection(env.DB, calendarId);
  return {
    configured: !!googleConfig(env),
    status: conn?.status ?? ("not_connected" as const),
    email: conn?.google_email || null,
    calendar: conn ? { id: conn.google_calendar_id, name: conn.google_calendar_name } : null,
    last_synced_at: conn?.last_synced_at ? new Date(conn.last_synced_at).toISOString() : null,
    problem: conn?.status === "broken" ? conn.last_error : null,
    /** Connected, but something keeps failing: "push_failed" (a booking couldn't be copied) or "sync_failing". */
    warning: conn?.status !== "active" ? null : conn.push_error ? "push_failed"
      : conn.last_error || (conn.last_synced_at !== null && Date.now() - conn.last_synced_at > 10 * 60_000) ? "sync_failing" : null,
  };
}

/** Start the pushes in the background (tests have no execution context; the cron covers them). */
function kickPushes(c: Context<AppEnv>) {
  try {
    c.executionCtx.waitUntil(runGoogleJobs(c.env, Date.now()).catch(() => {}));
  } catch {
    // no execution context
  }
}

async function syncNow(env: Bindings, cfg: GoogleConfig, calendarId: string) {
  const conn = await getConnection(env.DB, calendarId);
  const cal = await env.DB.prepare("SELECT * FROM calendars WHERE id = ?").bind(calendarId).first<CalendarRow>();
  if (!conn || conn.status !== "active" || !cal) return;
  try {
    await syncBusy(env, cfg, conn, cal, Date.now());
  } catch (err) {
    await recordSyncError(env.DB, calendarId, err);
  }
}

export const google = new Hono<AppEnv>();
google.use("*", requireCalendar);

google.get("/", async (c) => c.json(await googleStatus(c.env, c.var.calendar.id)));

/** Busy times copied from Google, for the Schedule's grey blocks. Times only: nothing about the events themselves. */
google.get("/busy", async (c) => {
  const Iso = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));
  const q = z.object({ from: Iso, to: Iso }).safeParse({ from: c.req.query("from"), to: c.req.query("to") });
  if (!q.success) return c.json({ error: "invalid_input", issues: q.error.issues }, 400);
  const { results } = await c.env.DB.prepare(
    "SELECT start_at, end_at FROM google_busy WHERE calendar_id = ? AND start_at < ? AND end_at > ? ORDER BY start_at LIMIT 1000",
  )
    .bind(c.var.calendar.id, q.data.to, q.data.from)
    .all<{ start_at: number; end_at: number }>();
  return c.json({ busy: results.map((b) => ({ start: new Date(b.start_at).toISOString(), end: new Date(b.end_at).toISOString() })) });
});

google.post("/connect", async (c) => {
  if (!(await entitlements(c.env, c.var.calendar)).google) return c.json({ error: "plan_required" }, 402);
  const cfg = googleConfig(c.env);
  if (!cfg) return c.json({ error: "not_configured" }, 503);
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const now = Date.now();
  const nonce = randomToken();
  await db.batch([
    db.prepare("DELETE FROM google_states WHERE calendar_id = ? AND expires_at < ?").bind(calId, now),
    db.prepare("INSERT INTO google_states (nonce_hash, calendar_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(nonce), calId, now + STATE_TTL_MS),
  ]);
  const conn = await getConnection(db, calId);
  const state = await signState(sessionSecret(c.env), calId, nonce, now);
  return c.json({ url: authUrl(cfg, redirectUri(c.env, originOf(c)), state, conn?.google_email || undefined) });
});

/** An active connection and a working access token, or the response to send instead. */
async function active(c: Context<AppEnv>): Promise<{ cfg: GoogleConfig; conn: ConnectionRow; access: string } | { response: Response }> {
  const cfg = googleConfig(c.env);
  if (!cfg) return { response: c.json({ error: "not_configured" }, 503) };
  const conn = await getConnection(c.env.DB, c.var.calendar.id);
  if (!conn || conn.status !== "active") return { response: c.json({ error: "not_connected" }, 409) };
  try {
    return { cfg, conn, access: await accessTokenFor(c.env, cfg, conn, Date.now()) };
  } catch (err) {
    if (err instanceof NotConnected) return { response: c.json({ error: "not_connected" }, 409) };
    return { response: c.json({ error: "google_unavailable" }, 502) };
  }
}

google.get("/calendars", async (c) => {
  const ctx = await active(c);
  if ("response" in ctx) return ctx.response;
  try {
    const list = await listCalendars(ctx.access);
    return c.json({ calendars: list.map((x) => ({ id: x.id, name: calendarName(x), primary: !!x.primary })) });
  } catch {
    return c.json({ error: "google_unavailable" }, 502);
  }
});

google.put("/calendar", async (c) => {
  if (!(await entitlements(c.env, c.var.calendar)).google) return c.json({ error: "plan_required" }, 402);
  const body = await parseBody(c, z.object({ id: z.string().min(1).max(1024) }));
  if (!body.ok) return body.response;
  const ctx = await active(c);
  if ("response" in ctx) return ctx.response;
  const calId = c.var.calendar.id;
  if (body.data.id !== ctx.conn.google_calendar_id) {
    let found;
    try {
      found = (await listCalendars(ctx.access)).find((x) => x.id === body.data.id);
    } catch {
      return c.json({ error: "google_unavailable" }, 502);
    }
    if (!found) return c.json({ error: "invalid_input" }, 400);
    const db = c.env.DB;
    const now = Date.now();
    await db.batch([
      // Take upcoming bookings off the old calendar, then put them on the new one.
      googlePushMany(db, calId, now, { removeFrom: ctx.conn.google_calendar_id }),
      db.prepare("UPDATE google_connections SET google_calendar_id = ?, google_calendar_name = ?, busy_hash = NULL, last_synced_at = NULL, last_error = NULL WHERE calendar_id = ?")
        .bind(found.id, calendarName(found), calId),
      db.prepare("UPDATE appointments SET google_event_id = NULL WHERE calendar_id = ? AND google_event_id IS NOT NULL").bind(calId),
      // The old calendar's busy times stay until the new calendar's first sync replaces them (busy_hash is reset).
      googlePushMany(db, calId, now, { upcoming: true }),
    ]);
    await syncNow(c.env, ctx.cfg, calId);
    kickPushes(c);
  }
  return c.json(await googleStatus(c.env, calId));
});

google.post("/sync", async (c) => {
  if (!(await entitlements(c.env, c.var.calendar)).google) return c.json({ error: "plan_required" }, 402);
  const cfg = googleConfig(c.env);
  if (!cfg) return c.json({ error: "not_configured" }, 503);
  await syncNow(c.env, cfg, c.var.calendar.id);
  return c.json(await googleStatus(c.env, c.var.calendar.id));
});

google.delete("/", async (c) => {
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const conn = await getConnection(db, calId);
  if (!conn) return c.body(null, 204);
  const [, , , others] = await db.batch([
    db.prepare("DELETE FROM google_connections WHERE calendar_id = ?").bind(calId),
    db.prepare("DELETE FROM google_busy WHERE calendar_id = ?").bind(calId),
    db.prepare("UPDATE jobs SET done_at = ?, result = 'skipped:disconnected' WHERE calendar_id = ? AND kind = 'google.push' AND done_at IS NULL").bind(Date.now(), calId),
    // appointments.google_event_id is kept on purpose: if the owner reconnects, those events are brought up to
    // date (and customers deleted in the meantime are taken off them).
    db.prepare("SELECT COUNT(*) AS n FROM google_connections WHERE google_email = ? AND google_email != ''").bind(conn.google_email),
  ]);
  // Tell Google to drop the permission too, unless another booking calendar uses the same Google account:
  // revoking removes the app's access for the whole account. Best effort: it's already gone on our side.
  const shared = ((others.results[0] as { n: number } | undefined)?.n ?? 0) > 0;
  const cfg = googleConfig(c.env);
  const refresh = cfg && !shared ? await openToken(cfg.tokenKey, calId, conn.refresh_token_enc) : null;
  if (refresh) await revokeToken(refresh);
  return c.body(null, 204);
});

// ---- The pages Google's sign-in tab uses (public; tied to a calendar only by the signed, one-time state) ----

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer", // the URL holds Google's one-time code
  "X-Frame-Options": "DENY", // the Connect button can't be clicked from a hidden frame
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

function page(status: number, title: string, message: string, opts: { close?: boolean; confirm?: { code: string; state: string } } = {}) {
  const form = opts.confirm
    ? `<form method="post" action="/api/google/confirm"><input type="hidden" name="code" value="${escapeHtml(opts.confirm.code)}">` +
      `<input type="hidden" name="state" value="${escapeHtml(opts.confirm.state)}"><button type="submit">Connect</button> ` +
      `<a href="#" onclick="window.close();return false">Cancel</a></form>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--fg:#1f2937;--bg:#fff;--muted:#6b7280;--btn:#1f2937;--btn-fg:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#e5e7eb;--bg:#111827;--muted:#9ca3af;--btn:#e5e7eb;--btn-fg:#111827}}
body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:var(--fg);background:var(--bg)}
h1{font-size:1.25rem}a{color:var(--muted)}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:8px;background:var(--btn);color:var(--btn-fg);cursor:pointer;margin-right:1rem}
</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${form}${opts.close ? "<script>setTimeout(function(){window.close()},1500)</script>" : ""}</body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const EXPIRED = () => page(400, "Link expired", "This sign-in link has expired or was already used. Go back to your calendar and click Connect again.");

/** A state that's signed, unexpired and not yet used, and its calendar. */
async function liveState(env: Bindings, state: string | undefined, now: number): Promise<{ cal: CalendarRow; nonceHash: string } | null> {
  const s = state ? await verifyState(sessionSecret(env), state, now) : null;
  if (!s) return null;
  const nonceHash = await sha256Hex(s.nonce);
  const row = await env.DB.prepare("SELECT calendar_id FROM google_states WHERE nonce_hash = ? AND expires_at > ?").bind(nonceHash, now).first<{ calendar_id: string }>();
  if (!row || row.calendar_id !== s.calendarId) return null;
  const cal = await env.DB.prepare("SELECT * FROM calendars WHERE id = ?").bind(s.calendarId).first<CalendarRow>();
  return cal ? { cal, nonceHash } : null;
}

/**
 * How the confirm page names the booking calendar: its business name and its booking page address. Neutral
 * wording, never "your": the Connect link may have come from someone else.
 */
function describe(env: Bindings, c: Context, cal: CalendarRow): string {
  const name = parseBranding(cal.branding).business_name.trim();
  const page = `${(env.PUBLIC_URL || originOf(c)).replace(/\/+$/, "")}/book/${cal.slug}`;
  return name ? `“${name}” (booking page ${page})` : `the booking page ${page}`;
}

/**
 * GET /api/google/callback — Google sends the owner's browser here after they approve. Nothing is saved
 * yet: the owner confirms which business they're connecting, so a Connect link someone else sent them
 * can't quietly attach their Google Calendar to a stranger's business.
 */
export async function googleCallback(c: Context<AppEnv>) {
  if (!googleConfig(c.env)) return page(404, "Not set up", "Google Calendar isn't set up on this server.");
  const q = c.req.query();
  const live = await liveState(c.env, q.state, Date.now());
  if (!live) return EXPIRED();
  if (q.error || !q.code) return page(200, "Not connected", "Google Calendar wasn't connected. You can close this tab and try again whenever you like.");
  return page(200, "Connect Google Calendar?", `This connects your Google Calendar to ${describe(c.env, c, live.cal)}. Its bookings will be added to your Google Calendar, and your busy times will block bookings there. Only continue if that's your business.`, {
    confirm: { code: q.code.slice(0, 2048), state: q.state! },
  });
}

/** POST /api/google/confirm — the owner pressed Connect. Uses up the state, then saves the connection. */
export async function googleConfirm(c: Context<AppEnv>) {
  const cfg = googleConfig(c.env);
  if (!cfg) return page(404, "Not set up", "Google Calendar isn't set up on this server.");
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const code = typeof form.code === "string" ? form.code : "";
  const state = typeof form.state === "string" ? form.state : undefined;
  const db = c.env.DB;
  const live = await liveState(c.env, state, Date.now());
  if (!live || !code) return EXPIRED();
  // Connecting is refused on Free, like the Connect button (the plan may have changed since it was pressed).
  if (!(await entitlements(c.env, live.cal)).google) {
    return page(402, "Not connected", "Google Calendar sync is part of the paid plans. Go back to your calendar to see your plan.");
  }
  // One use only: whoever deletes the row first goes on.
  const used = await db.prepare("DELETE FROM google_states WHERE nonce_hash = ? RETURNING calendar_id").bind(live.nonceHash).first<{ calendar_id: string }>();
  if (used?.calendar_id !== live.cal.id) return EXPIRED();
  const calendarId = live.cal.id;

  let tok: TokenResponse;
  try {
    tok = await exchangeCode(cfg, code, redirectUri(c.env, originOf(c)));
  } catch {
    return page(502, "Not connected", "Google didn't finish connecting. Close this tab and click Connect again.");
  }
  const granted = (tok.scope ?? "").split(" ");
  if (!granted.includes(EVENTS_SCOPE) || !granted.includes(LIST_SCOPE) || !tok.refresh_token) {
    // Not revoked: that would also cut off another booking calendar using this Google account.
    return page(400, "Not connected", "Google Calendar wasn't connected because a permission box wasn't ticked. Close this tab, click Connect again, and tick every box on Google's screen.");
  }

  const email = emailFromIdToken(tok.id_token) ?? "";
  const existing = await getConnection(db, calendarId);
  // Same Google account as before: keep its chosen calendar even if the list below fails.
  let chosen = existing && existing.google_email === email
    ? { id: existing.google_calendar_id, name: existing.google_calendar_name }
    : { id: "primary", name: email || "Primary calendar" };
  try {
    const list = await listCalendars(tok.access_token);
    // Reconnecting keeps the calendar chosen before, if this account still has it.
    const pick = list.find((x) => x.id === existing?.google_calendar_id) ?? list.find((x) => x.primary);
    if (pick) chosen = { id: pick.id, name: calendarName(pick) };
  } catch {
    // keep "primary"; the owner can pick later
  }

  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO google_connections (calendar_id, google_email, refresh_token_enc, google_calendar_id, google_calendar_name, status,
         access_token_enc, access_expires_at, connected_at, last_error, busy_hash, last_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, NULL, NULL, NULL)
       ON CONFLICT (calendar_id) DO UPDATE SET google_email = ?2, refresh_token_enc = ?3, google_calendar_id = ?4,
         google_calendar_name = ?5, status = 'active', access_token_enc = ?6, access_expires_at = ?7, connected_at = ?8,
         last_error = NULL, busy_hash = NULL, last_synced_at = NULL`,
    ).bind(
      calendarId, email, await sealToken(cfg.tokenKey, calendarId, tok.refresh_token), chosen.id, chosen.name,
      await sealToken(cfg.tokenKey, calendarId, tok.access_token), now + tok.expires_in * 1000, now,
    ),
    // Bring events already in Google up to date with changes made while broken or disconnected.
    googlePushMany(db, calendarId, now, { inGoogle: true }),
    googlePushMany(db, calendarId, now, { upcoming: true }),
  ]);
  await syncNow(c.env, cfg, calendarId);
  kickPushes(c);
  return page(200, "Google Calendar connected", `Google Calendar is connected to ${describe(c.env, c, live.cal)}. You can close this tab and go back to your calendar.`, { close: true });
}
