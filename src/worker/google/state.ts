// The OAuth `state`: which calendar is connecting, plus a one-time nonce (stored hashed in
// google_states), signed and short-lived. There are no cookies (owner screens work inside other
// sites' iframes), so this is what ties Google's answer to a calendar.
import { toBase64Url } from "../lib/ids";
import { fromBase64Url } from "../lib/session";

const enc = new TextEncoder();
export const STATE_TTL_MS = 15 * 60_000;

async function sign(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Its own prefix: sessions sign "session:…", so neither can pass as the other.
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`google-state:${payload}`)));
}

export async function signState(secret: string, calendarId: string, nonce: string, now: number): Promise<string> {
  const payload = toBase64Url(enc.encode(JSON.stringify({ c: calendarId, exp: now + STATE_TTL_MS, n: nonce })));
  return `${payload}.${toBase64Url(await sign(secret, payload))}`;
}

/** The calendar id and nonce, or null. Doesn't check the nonce is still unused; the caller does. */
export async function verifyState(secret: string, token: string, now: number): Promise<{ calendarId: string; nonce: string } | null> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined || token.length > 1024) return null;
  const given = fromBase64Url(sig);
  const expected = await sign(secret, payload);
  if (!given || given.length !== expected.length || !crypto.subtle.timingSafeEqual(given, expected)) return null;
  const raw = fromBase64Url(payload);
  if (!raw) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(raw)) as { c?: unknown; exp?: unknown; n?: unknown };
    if (typeof s.c !== "string" || typeof s.n !== "string" || typeof s.exp !== "number" || s.exp < now) return null;
    return { calendarId: s.c, nonce: s.n };
  } catch {
    return null;
  }
}
