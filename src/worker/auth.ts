import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { newId, randomToken, sha256Hex } from "./lib/ids";
import { signSession, verifySession } from "./lib/session";
import { publicBase, signupOn } from "./accounts/config";
import { createInvite } from "./accounts/store";
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
  await next();
});

/**
 * Loads the calendar owned by (app, user). Never trusts a calendar id from the request, with one exception: a hosted
 * account's X-Client header picks one of that same account's calendars (anything else is 404, the same answer whether
 * it doesn't exist or isn't theirs). API-key apps, host-app sessions and standalone installs never read the header.
 */
export const requireCalendar = createMiddleware<AppEnv>(async (c, next) => {
  const client = c.var.app.id === HOSTED_APP ? c.req.header("X-Client") : undefined;
  const row = client
    ? await c.env.DB.prepare("SELECT * FROM calendars WHERE id = ? AND app_id = ? AND account_user_id = ?")
        .bind(client, HOSTED_APP, c.var.userId).first<CalendarRow>()
    : await c.env.DB.prepare("SELECT * FROM calendars WHERE app_id = ? AND external_user_id = ?")
        .bind(c.var.app.id, c.var.userId).first<CalendarRow>();
  if (!row) return c.json({ error: "calendar_not_found" }, 404);
  c.set("calendar", row);
  await next();
});

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const HOSTED_APP = "app_hosted";
export const HOSTED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A 30-day owner session for a hosted account. Creates the built-in hosted app row on first use. */
export async function hostedSession(env: AppEnv["Bindings"], userId: string, now: number) {
  // Its key hash can never match a real key, like the standalone app's.
  await env.DB.prepare("INSERT OR IGNORE INTO apps (id, name, api_key_hash, created_at) VALUES (?, 'Hosted', ?, ?)")
    .bind(HOSTED_APP, `none:${HOSTED_APP}`, now).run();
  const token = await signSession(requireSessionSecret(env.SESSION_SECRET), { a: HOSTED_APP, u: userId }, now, HOSTED_SESSION_TTL_MS);
  return { token, expires_at: new Date(now + HOSTED_SESSION_TTL_MS).toISOString() };
}

/** GET /api/admin/account: the hosted account's email; 404 for host-app and password sessions. */
export async function accountInfo(c: Context<AppEnv>) {
  if (c.var.app.id !== HOSTED_APP) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(c.var.userId).first<{ email: string }>();
  return row ? c.json({ email: row.email }) : c.json({ error: "not_found" }, 404);
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
  // A deleted hosted account is signed out at once, not when its 30-day token runs out.
  if (s.a === HOSTED_APP && !(await c.env.DB.prepare("SELECT 1 AS ok FROM users WHERE id = ?").bind(s.u).first())) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("app", app);
  c.set("userId", s.u);
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
