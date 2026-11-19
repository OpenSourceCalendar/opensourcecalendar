import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { newId, randomToken, sha256Hex } from "./lib/ids";
import { signSession, verifySession } from "./lib/session";
import { publicBase, signupOn } from "./accounts/config";
import { createInvite } from "./accounts/store";
import { clientBrand } from "./accounts/client-users";
import type { AppEnv, AppRow, CalendarRow } from "./types";

const encoder = new TextEncoder();

async function sameSecret(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return crypto.subtle.timingSafeEqual(encoder.encode(ha), encoder.encode(hb));
}

export const setup = new Hono<AppEnv>();

setup.post("/apps", async (c) => {
  const token = c.env.SETUP_TOKEN;
  if (!token) return c.notFound();
  const given = (c.req.header("Authorization") ?? "").replace(/^Bearer /, "");
  if (!(await sameSecret(given, token))) return c.json({ error: "unauthorized" }, 401);

  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) return c.json({ error: "invalid_input" }, 400);

  const apiKey = `bc_${randomToken()}`;
  const id = newId("app");
  await c.env.DB.prepare("INSERT INTO apps (id, name, api_key_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, name, await sha256Hex(apiKey), Date.now())
    .run();
  return c.json({ app_id: id, api_key: apiKey }, 201);
});

/** An invite link for hosted sign-up (one use, 14 days). 404 unless sign-up is on. */
setup.post("/invites", async (c) => {
  const token = c.env.SETUP_TOKEN;
  if (!token || !signupOn(c.env)) return c.notFound();
  const given = (c.req.header("Authorization") ?? "").replace(/^Bearer /, "");
  if (!(await sameSecret(given, token))) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { note?: unknown } | null;
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 200) : "";
  const invite = await createInvite(c.env.DB, note, Date.now());
  return c.json({ url: `${publicBase(c.env)}/signup?invite=${invite.token}`, expires_at: new Date(invite.expiresAt).toISOString() }, 201);
});

/** Checks the app API key and reads X-Calendar-User. */
export const requireApp = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!key) return c.json({ error: "unauthorized" }, 401);
  const app = await c.env.DB.prepare("SELECT id, name FROM apps WHERE api_key_hash = ?")
    .bind(await sha256Hex(key))
    .first<AppRow>();
  if (!app) return c.json({ error: "unauthorized" }, 401);

  const user = c.req.header("X-Calendar-User") ?? "";
  if (!user || user.length > 200) return c.json({ error: "invalid_input", message: "X-Calendar-User header required" }, 400);

  c.set("app", app);
  c.set("userId", user);
  c.set("clientCalendarId", null);
  c.set("sessionIssuedAt", 0);
  c.set("sessionVersion", 0);
  await next();
});

/**
 * Loads the calendar owned by (app, user). Never trusts a calendar id from the request, with one exception: a hosted
 * account's X-Client header picks one of that same account's calendars (anything else is 404, the same answer whether
 * it doesn't exist or isn't theirs). API-key apps, host-app sessions and standalone installs never read the header.
 * An empty X-Client header counts as no header. Client users: their own calendar only, and X-Client is ignored.
 */
export const requireCalendar = createMiddleware<AppEnv>(async (c, next) => {
  let row: CalendarRow | null;
  if (c.var.clientCalendarId) {
    // A client's own sign-in opens its one calendar, never another (X-Client is not read at all).
    row = await c.env.DB.prepare("SELECT * FROM calendars WHERE id = ? AND app_id = ? AND account_user_id IS NOT NULL")
      .bind(c.var.clientCalendarId, HOSTED_APP).first<CalendarRow>();
  } else {
    const client = c.var.app.id === HOSTED_APP ? c.req.header("X-Client") : undefined;
    row = client
      ? await c.env.DB.prepare("SELECT * FROM calendars WHERE id = ? AND app_id = ? AND account_user_id = ?")
          .bind(client, HOSTED_APP, c.var.userId).first<CalendarRow>()
      : await c.env.DB.prepare("SELECT * FROM calendars WHERE app_id = ? AND external_user_id = ?")
          .bind(c.var.app.id, c.var.userId).first<CalendarRow>();
  }
  if (!row) return c.json({ error: "calendar_not_found" }, 404);
  c.set("calendar", row);
  await next();
});

/** Agency and ordinary accounts only: a client's own sign-in never reaches billing, the client list or calendar creation. */
export const agencyOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.clientCalendarId) return c.json({ error: "forbidden" }, 403);
  await next();
});

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const HOSTED_APP = "app_hosted";
export const HOSTED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A 30-day owner session for a hosted account, stamped with its current session_version. Creates the built-in hosted
 * app row on first use. `issuedAt` = when this sign-in happened: `now` for a real sign-in (password, emailed link,
 * Google, invite accept); the old session's issue time when re-issuing for the same sign-in (password change, sign out
 * of all devices), so re-issuing never makes a session "recently signed in".
 */
export async function hostedSession(env: AppEnv["Bindings"], userId: string, now: number, issuedAt = now, version?: number) {
  // Its key hash can never match a real key, like the standalone app's.
  await env.DB.prepare("INSERT OR IGNORE INTO apps (id, name, api_key_hash, created_at) VALUES (?, 'Hosted', ?, ?)")
    .bind(HOSTED_APP, `none:${HOSTED_APP}`, now).run();
  // `version` = the one a guarded bump just returned; read it here otherwise.
  const v = version ?? (await env.DB.prepare("SELECT session_version FROM users WHERE id = ?").bind(userId).first<{ session_version: number }>())?.session_version ?? 0;
  const token = await signSession(requireSessionSecret(env.SESSION_SECRET), { a: HOSTED_APP, u: userId, v, t: issuedAt }, now, HOSTED_SESSION_TTL_MS);
  return { token, expires_at: new Date(now + HOSTED_SESSION_TTL_MS).toISOString() };
}

/** GET /api/admin/account: who is signed in (role "client" = a White-label client's own sign-in); 404 for host-app and password sessions. */
export async function accountInfo(c: Context<AppEnv>) {
  if (c.var.app.id !== HOSTED_APP) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare("SELECT email, client_calendar_id, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?")
    .bind(c.var.userId).first<{ email: string; client_calendar_id: string | null; has_password: number }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!row.client_calendar_id) return c.json({ email: row.email, role: "account", has_password: !!row.has_password });
  const brand = await clientBrand(c.env.DB, row.client_calendar_id);
  return c.json({ email: row.email, role: "client", has_password: !!row.has_password, business_name: brand?.name ?? "", login_path: brand ? `/login/${brand.slug}` : "/login" });
}
const STANDALONE_APP = "app_standalone";
const STANDALONE_USER = "owner";

function requireSessionSecret(secret: string | undefined): string {
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return secret;
}

/** Owner screens: `Authorization: Session <token>`. Sets the same vars as requireApp. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Session ") ? header.slice(8) : "";
  const s = token ? await verifySession(requireSessionSecret(c.env.SESSION_SECRET), token, Date.now()) : null;
  if (!s) return c.json({ error: "unauthorized" }, 401);
  const app = await c.env.DB.prepare("SELECT id, name FROM apps WHERE id = ?").bind(s.a).first<AppRow>();
  if (!app) return c.json({ error: "unauthorized" }, 401);
  let clientCalendarId: string | null = null;
  if (s.a === HOSTED_APP) {
    const user = await c.env.DB.prepare("SELECT session_version, client_calendar_id FROM users WHERE id = ?")
      .bind(s.u).first<{ session_version: number; client_calendar_id: string | null }>();
    // A deleted account, or one whose sessions were ended (password change, "sign out of all devices", a removed
    // client sign-in), is signed out at once, not when its 30-day token runs out.
    if (!user || user.session_version !== s.v) return c.json({ error: "unauthorized" }, 401);
    clientCalendarId = user.client_calendar_id;
  }
  c.set("app", app);
  c.set("userId", s.u);
  c.set("clientCalendarId", clientCalendarId);
  c.set("sessionIssuedAt", s.t);
  c.set("sessionVersion", s.v);
  await next();
});

/** Host app → owner screens link. Mounted inside /api/v1 (API key auth). */
export async function createAdminSession(c: Context<AppEnv>) {
  const now = Date.now();
  const token = await signSession(requireSessionSecret(c.env.SESSION_SECRET), { a: c.var.app.id, u: c.var.userId }, now, SESSION_TTL_MS);
  return c.json({ token, expires_at: new Date(now + SESSION_TTL_MS).toISOString(), url: `/admin#session=${token}` }, 201);
}

/** Standalone installs: password login. 404 unless OWNER_PASSWORD is set. */
export const adminLogin = new Hono<AppEnv>();
adminLogin.post("/login", async (c) => {
  const password = c.env.OWNER_PASSWORD;
  if (!password) return c.notFound();
  const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
  const given = typeof body?.password === "string" ? body.password : "";
  if (!(await sameSecret(given, password))) {
    await new Promise((r) => setTimeout(r, 500)); // slow down guessing
    return c.json({ error: "unauthorized" }, 401);
  }
  // The built-in app row for standalone installs; its key hash can never match a real key.
  await c.env.DB.prepare("INSERT OR IGNORE INTO apps (id, name, api_key_hash, created_at) VALUES (?, 'Standalone', ?, ?)")
    .bind(STANDALONE_APP, `none:${STANDALONE_APP}`, Date.now())
    .run();
  const now = Date.now();
  const token = await signSession(requireSessionSecret(c.env.SESSION_SECRET), { a: STANDALONE_APP, u: STANDALONE_USER }, now, SESSION_TTL_MS);
  return c.json({ token, expires_at: new Date(now + SESSION_TTL_MS).toISOString() });
});
