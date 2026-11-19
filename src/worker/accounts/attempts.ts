// Wrong-try limits for passwords: one row per try, written BEFORE any hashing and counted right after, so tries sent
// at the same time all count, and a blocked try costs no hashing. A right password deletes its own row. Rows are
// deleted after a day (cleanUpLinks).
import type { Bindings } from "../types";

const WINDOW_MS = 15 * 60_000;
export const ATTEMPT_LIMITS = { perEmail: 5, perIp: 30 };

/** An IPv6 address's /64 ("2001:db8::1" → "2001:db8:0:0"): "::" expanded to the missing zero groups first. */
export function ipv6Net64(ip: string): string {
  const [head, tail] = ip.toLowerCase().split("::", 2);
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

/** A keyed hash of the network (IPv4 address, or IPv6 /64), so the table holds no IP addresses. */
export async function ipKey(env: Bindings, ip: string | null | undefined): Promise<string> {
  const raw = (ip ?? "").trim();
  const net = raw.includes(":") ? ipv6Net64(raw) : raw;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`ip:${net}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bad invite tokens: their own keys (see inviteTry) and their own, looser limit; never counted as sign-in tries. */
export const INVITE_TOKEN_LIMITS = { perEmail: 20, perIp: 20 };

/** Records this try, then says whether it is still under both limits (this try included). */
export async function startAttempt(
  db: D1Database, email: string, ipKeyHex: string, now: number, limits: { perEmail: number; perIp: number } = ATTEMPT_LIMITS,
): Promise<{ id: number; allowed: boolean }> {
  const row = await db.prepare("INSERT INTO password_attempts (email, ip_key, at) VALUES (?, ?, ?) RETURNING rowid AS id")
    .bind(email, ipKeyHex, now).first<{ id: number }>();
  const n = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM password_attempts WHERE email = ? AND at > ?) AS e,
            (SELECT COUNT(*) FROM password_attempts WHERE ip_key = ? AND at > ?) AS i`,
  ).bind(email, now - WINDOW_MS, ipKeyHex, now - WINDOW_MS).first<{ e: number; i: number }>();
  return { id: row!.id, allowed: !!n && n.e <= limits.perEmail && n.i <= limits.perIp };
}

export async function forgetAttempt(db: D1Database, id: number) {
  await db.prepare("DELETE FROM password_attempts WHERE rowid = ?").bind(id).run();
}
