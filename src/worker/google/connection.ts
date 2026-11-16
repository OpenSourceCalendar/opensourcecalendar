import type { Bindings } from "../types";
import { GoogleError, refreshAccess, type GoogleConfig, type TokenResponse } from "./client";
import { openToken, sealToken } from "./crypto";

export type ConnectionRow = {
  calendar_id: string; google_email: string; refresh_token_enc: string; google_calendar_id: string;
  google_calendar_name: string; status: "active" | "broken"; last_synced_at: number | null;
  access_token_enc: string | null; access_expires_at: number | null; last_error: string | null;
  busy_hash: string | null; connected_at: number; last_attempt_at: number | null; push_error: string | null;
};

/** The connection is broken or gone; the job or sync is skipped, not retried. */
export class NotConnected extends Error {}

export const getConnection = (db: D1Database, calendarId: string) =>
  db.prepare("SELECT * FROM google_connections WHERE calendar_id = ?").bind(calendarId).first<ConnectionRow>();

/** Stop using the connection until the owner reconnects. Busy times already copied are kept, so nothing known gets double-booked. */
export async function markBroken(db: D1Database, calendarId: string, reason: string): Promise<void> {
  await db.prepare("UPDATE google_connections SET status = 'broken', last_error = ?, access_token_enc = NULL, access_expires_at = NULL WHERE calendar_id = ? AND status = 'active'")
    .bind(reason, calendarId)
    .run();
  console.error(JSON.stringify({ event: "google_broken", calendar: calendarId, reason }));
}

/**
 * What an error from Google means for the connection: a reason to mark it broken, or null when trying
 * again later may work (network, rate limits, Google having a bad minute).
 */
export function brokenReason(err: unknown): string | null {
  if (!(err instanceof GoogleError)) return null;
  if (err.status === 404) return "calendar_missing";
  if (err.status === 403 && (err.reason === "insufficientPermissions" || err.reason === "forbidden" || err.reason === "requiredAccessLevel" || err.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return "missing_permission";
  return null;
}

/** A working access token: the cached one, or a fresh one from the refresh token. */
export async function accessTokenFor(env: Bindings, cfg: GoogleConfig, conn: ConnectionRow, now: number, timeoutMs?: number): Promise<string> {
  if (conn.status !== "active") throw new NotConnected();
  if (conn.access_token_enc && (conn.access_expires_at ?? 0) > now + 60_000) {
    const cached = await openToken(cfg.tokenKey, conn.calendar_id, conn.access_token_enc);
    if (cached) return cached;
  }
  const refresh = await openToken(cfg.tokenKey, conn.calendar_id, conn.refresh_token_enc);
  if (!refresh) {
    await markBroken(env.DB, conn.calendar_id, "token_unreadable");
    throw new NotConnected();
  }
  let tok: TokenResponse;
  try {
    tok = await refreshAccess(cfg, refresh, timeoutMs);
  } catch (err) {
    // invalid_grant: revoked, expired (the 7-day testing rule), or the password changed.
    if (err instanceof GoogleError && err.reason === "invalid_grant") {
      await markBroken(env.DB, conn.calendar_id, "signed_out");
      throw new NotConnected();
    }
    // A wrong client id or secret is this server's setup, not the owner's connection: keep it, shout in the logs.
    if (err instanceof GoogleError && (err.reason === "invalid_client" || err.reason === "unauthorized_client")) {
      console.error(JSON.stringify({ event: "google_setup_problem", reason: err.reason }));
    }
    throw err;
  }
  await env.DB.prepare("UPDATE google_connections SET access_token_enc = ?, access_expires_at = ? WHERE calendar_id = ? AND status = 'active'")
    .bind(await sealToken(cfg.tokenKey, conn.calendar_id, tok.access_token), now + tok.expires_in * 1000, conn.calendar_id)
    .run();
  return tok.access_token;
}

/** After a 401 from the Calendar API: forget the cached access token so the next try refreshes it. */
export const forgetAccessToken = (db: D1Database, calendarId: string) =>
  db.prepare("UPDATE google_connections SET access_token_enc = NULL, access_expires_at = NULL WHERE calendar_id = ?").bind(calendarId).run();
