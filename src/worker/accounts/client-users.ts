// White-label clients' own sign-ins: users rows with client_calendar_id set. Invites, removal and the client's look
// on sign-in pages and emails.
import { newId, randomToken, sha256Hex } from "../lib/ids";
import { imageUrl } from "../lib/image-url"; // not routes/images: that imports auth.ts (cycle)
import { parseBranding } from "../settings";
import { revokeTokenStatements } from "./store";

export type ClientBrand = { slug: string; name: string; logo_url: string | null; color: string; style: string };

/** How a client's sign-in pages and emails look: its business name, logo and colours. Null if the calendar is gone. */
export async function clientBrand(db: D1Database, calendarId: string): Promise<ClientBrand | null> {
  const cal = await db.prepare("SELECT slug, branding FROM calendars WHERE id = ?").bind(calendarId).first<{ slug: string; branding: string }>();
  if (!cal) return null;
  const b = parseBranding(cal.branding);
  return { slug: cal.slug, name: b.business_name.replace(/\s+/g, " ").trim().slice(0, 80) || "Your booking calendar", logo_url: imageUrl(b.logo_key), color: b.color, style: b.style };
}

export const CLIENT_INVITE_TTL_MS = 7 * 86400_000;
export const INVITES_PER_HOUR = 20;
const HOUR = 3600_000;

export type ClientSignIn = { id: string; email: string; last_login_at: number | null };

export const clientSignIn = (db: D1Database, calendarId: string) =>
  db.prepare("SELECT id, email, last_login_at FROM users WHERE client_calendar_id = ?").bind(calendarId).first<ClientSignIn>();

/** What the Clients page shows about one client's sign-in. */
export function signInJson(u: ClientSignIn | null | undefined) {
  if (!u) return { status: "not_invited" as const, email: null, last_login_at: null };
  return {
    status: u.last_login_at === null ? ("invited" as const) : ("signed_in" as const),
    email: u.email,
    last_login_at: u.last_login_at === null ? null : new Date(u.last_login_at).toISOString(),
  };
}

/** Every client sign-in of one agency, by calendar id. */
export async function signInsFor(db: D1Database, agencyUserId: string): Promise<Map<string, ClientSignIn>> {
  const rows = (await db.prepare(
    "SELECT id, email, last_login_at, client_calendar_id FROM users WHERE client_calendar_id IN (SELECT id FROM calendars WHERE account_user_id = ?)",
  ).bind(agencyUserId).all<ClientSignIn & { client_calendar_id: string }>()).results;
  return new Map(rows.map((r) => [r.client_calendar_id, { id: r.id, email: r.email, last_login_at: r.last_login_at }]));
}

/** Counts this Send/Resend (refused ones too) and says whether it's under the hourly limit. */
export async function inviteAllowed(db: D1Database, agencyUserId: string, now: number): Promise<boolean> {
  await db.prepare("INSERT INTO invite_attempts (agency_user_id, at) VALUES (?, ?)").bind(agencyUserId, now).run();
  const n = await db.prepare("SELECT COUNT(*) AS n FROM invite_attempts WHERE agency_user_id = ? AND at > ?").bind(agencyUserId, now - HOUR).first<{ n: number }>();
  return !!n && n.n <= INVITES_PER_HOUR;
}

export type InviteResult = { ok: true; user: ClientSignIn; token: string } | { ok: false; error: "email_in_use" | "signed_in" };

/**
 * Makes or updates the client's sign-in for `email` and a new one-use invite (older open ones are revoked).
 * Refuses an email another account has, and a different email once the client has signed in.
 */
export async function prepareInvite(db: D1Database, calendarId: string, email: string, now: number, retried = false): Promise<InviteResult> {
  let user = await clientSignIn(db, calendarId);
  const holder = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (holder && holder.id !== user?.id) return { ok: false, error: "email_in_use" };
  try {
    if (!user) {
      const id = newId("usr");
      await db.prepare("INSERT INTO users (id, email, created_at, client_calendar_id) VALUES (?, ?, ?, ?)").bind(id, email, now, calendarId).run();
      user = { id, email, last_login_at: null };
    } else if (user.email !== email) {
      if (user.last_login_at !== null) return { ok: false, error: "signed_in" };
      const changed = await db.prepare("UPDATE users SET email = ? WHERE id = ? AND last_login_at IS NULL").bind(email, user.id).run();
      if (changed.meta.changes !== 1) return { ok: false, error: "signed_in" };
      // Sign-in links asked for under the old address stop working.
      await db.prepare("UPDATE login_links SET used_at = ? WHERE email = ? AND used_at IS NULL").bind(now, user.email).run();
      user = { ...user, email };
    }
  } catch (err) {
    if (!String(err).includes("UNIQUE")) throw err;
    // Two invites at once (for this client, or this email from two agencies): the other one won. Look again, once;
    // if it still collides, someone else holds the address.
    if (!retried) return prepareInvite(db, calendarId, email, now, true);
    return { ok: false, error: "email_in_use" };
  }
  const token = randomToken();
  await db.batch([
    db.prepare("UPDATE client_invites SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL").bind(now, user.id),
    // The invite remembers its address: it is only valid while the sign-in still has this email (Task 11's accept).
    db.prepare("INSERT INTO client_invites (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), user.id, user.email, now, now + CLIENT_INVITE_TTL_MS),
  ]);
  return { ok: true, user, token };
}

/**
 * Deletes the client's sign-in (its sessions end at once: requireSession finds no user) and stops its invites and
 * sign-in links. The links are marked used, not deleted, so they still count toward the per-email link limit.
 */
export async function removeSignIn(db: D1Database, calendarId: string, now: number): Promise<void> {
  const user = await clientSignIn(db, calendarId);
  if (!user) return;
  await db.batch([
    ...revokeTokenStatements(db, user.id, user.email, now),
    db.prepare("DELETE FROM users WHERE id = ? AND client_calendar_id = ?").bind(user.id, calendarId),
  ]);
}
