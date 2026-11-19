// Every SQL statement for hosted accounts. Tokens are stored only as SHA-256 hashes.
import { newId, randomToken, sha256Hex } from "../lib/ids";

export const INVITE_TTL_MS = 14 * 86400_000;
export const LINK_TTL_MS = 15 * 60_000;
export const LINK_KEEP_MS = 2 * 86400_000;
export const LIMITS = { perEmailHour: 3, perIpHour: 10, perDay: 300 };
const HOUR = 3600_000;

export type UserRow = { id: string; email: string; google_sub: string | null; client_calendar_id: string | null };
/** A user, a Google account that doesn't match the user with that email, a client sign-in reached through Google, or nobody. */
export type Found = { user: UserRow } | { mismatch: true } | { clientOnly: true } | null;
const USER_COLS = "id, email, google_sub, client_calendar_id";

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export async function createInvite(db: D1Database, note: string, now: number) {
  const token = randomToken();
  await db.prepare("INSERT INTO invites (token_hash, note, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), note, now, now + INVITE_TTL_MS).run();
  return { token, expiresAt: now + INVITE_TTL_MS };
}

export async function inviteOpen(db: D1Database, inviteHash: string, now: number): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS ok FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(inviteHash, now).first());
}

/**
 * Who this is, in the same order everywhere: Google id, then email (linking Google if the user has none yet).
 * A White-label client's own sign-in is email + password only: through Google it's { clientOnly }, checked before
 * anything is linked, so a Google id never gets attached to it.
 */
export async function lookUp(db: D1Database, email: string, googleSub?: string): Promise<Found> {
  if (googleSub) {
    const bySub = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE google_sub = ?`).bind(googleSub).first<UserRow>();
    if (bySub) return bySub.client_calendar_id ? { clientOnly: true } : { user: bySub };
  }
  const byEmail = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).bind(email).first<UserRow>();
  if (!byEmail) return null;
  if (!googleSub) return { user: byEmail };
  if (byEmail.client_calendar_id) return { clientOnly: true };
  if (byEmail.google_sub !== null) return { mismatch: true };
  const linked = await db.prepare("UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL AND client_calendar_id IS NULL").bind(googleSub, byEmail.id).run();
  if (linked.meta.changes === 1) return { user: { ...byEmail, google_sub: googleSub } };
  return lookUp(db, email, googleSub); // linked by someone else meanwhile: now a match or a mismatch
}

/**
 * Uses up the invite, then creates the user. The invite UPDATE runs alone first: a D1 batch doesn't roll
 * back when an UPDATE changes no rows, so a used invite must stop us before the INSERT.
 */
export async function createUserWithInvite(
  db: D1Database, email: string, googleSub: string | undefined, inviteHash: string, now: number,
): Promise<Found | { inviteUsed: true }> {
  const id = newId("usr");
  const took = await db.prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, id, inviteHash, now).run();
  if (took.meta.changes !== 1) return (await lookUp(db, email, googleSub)) ?? { inviteUsed: true };
  try {
    await db.prepare("INSERT INTO users (id, email, google_sub, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, email, googleSub ?? null, now, now).run();
    return { user: { id, email, google_sub: googleSub ?? null, client_calendar_id: null } };
  } catch (err) {
    // Someone signed up with this email or Google account at the same moment, or D1 failed: give the invite back.
    await db.prepare("UPDATE invites SET used_at = NULL, used_by = NULL WHERE token_hash = ? AND used_by = ?").bind(inviteHash, id).run();
    const again = await lookUp(db, email, googleSub);
    if (again) return again;
    throw err;
  }
}

export async function touchLogin(db: D1Database, userId: string, now: number) {
  await db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now, userId).run();
}

/** Under every limit? Logs when the install-wide daily cap is hit. Approximate under concurrency. */
export async function linkAllowed(db: D1Database, email: string, ipHash: string, now: number): Promise<boolean> {
  const r = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM login_links WHERE email = ? AND created_at > ?) AS e,
            (SELECT COUNT(*) FROM login_links WHERE ip_hash = ? AND created_at > ?) AS i,
            (SELECT COUNT(*) FROM login_links WHERE created_at > ?) AS d`,
  ).bind(email, now - HOUR, ipHash, now - HOUR, now - 24 * HOUR).first<{ e: number; i: number; d: number }>();
  if (!r) return false;
  if (r.d >= LIMITS.perDay) {
    console.error(JSON.stringify({ event: "login_links_daily_cap" }));
    return false;
  }
  return r.e < LIMITS.perEmailHour && r.i < LIMITS.perIpHour;
}

export async function saveLink(db: D1Database, email: string, inviteHash: string | null, ipHash: string, now: number): Promise<string> {
  const token = randomToken();
  await db.prepare("INSERT INTO login_links (token_hash, email, invite_hash, ip_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), email, inviteHash, ipHash, now, now + LINK_TTL_MS).run();
  return token;
}

/** Marks the link used, once; null when unknown, used or expired. */
export async function useLink(db: D1Database, token: string, now: number): Promise<{ email: string; inviteHash: string | null } | null> {
  const row = await db.prepare("UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, invite_hash")
    .bind(now, await sha256Hex(token), now).first<{ email: string; invite_hash: string | null }>();
  return row ? { email: row.email, inviteHash: row.invite_hash } : null;
}

const DAY = 24 * HOUR;
export async function cleanUpLinks(db: D1Database, now: number) {
  await db.batch([
    db.prepare("DELETE FROM login_links WHERE created_at < ?").bind(now - LINK_KEEP_MS),
    // Wrong-try records are kept one day (the privacy policy says so); the limits only look back 15 minutes or an hour.
    db.prepare("DELETE FROM password_attempts WHERE at < ?").bind(now - DAY),
    db.prepare("DELETE FROM invite_attempts WHERE at < ?").bind(now - DAY),
    db.prepare("DELETE FROM client_invites WHERE expires_at < ? OR used_at < ? OR revoked_at < ?").bind(now - 7 * DAY, now - 7 * DAY, now - 7 * DAY),
  ]);
}

/**
 * After a password is set: the user's open client invites and sign-in links stop working. With `onlyIf`, they stop only
 * if the users row now has that session_version and password_set_at (so they can run in the same batch as a guarded
 * password write and do nothing when that write didn't happen).
 */
export function revokeTokenStatements(db: D1Database, userId: string, email: string, now: number, onlyIf?: { version: number; setAt: number }) {
  const guard = onlyIf ? " AND EXISTS (SELECT 1 FROM users WHERE id = ? AND session_version = ? AND password_set_at = ?)" : "";
  const extra = onlyIf ? [userId, onlyIf.version, onlyIf.setAt] : [];
  return [
    db.prepare(`UPDATE client_invites SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL${guard}`).bind(now, userId, ...extra),
    db.prepare(`UPDATE login_links SET used_at = ? WHERE email = ? AND used_at IS NULL${guard}`).bind(now, email, ...extra),
  ];
}

export async function revokeTokens(db: D1Database, userId: string, email: string, now: number) {
  await db.batch(revokeTokenStatements(db, userId, email, now));
}
