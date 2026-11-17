// Google sign-in `state`: a nonce (also in an HttpOnly cookie, tying the callback to this browser) and the
// invite's hash, signed and short-lived. Its own HMAC prefix: a Calendar-connect state or a session can't pass.
import { toBase64Url } from "../lib/ids";
import { fromBase64Url } from "../lib/session";

const enc = new TextEncoder();
export const SIGNIN_TTL_MS = 15 * 60_000;

async function sign(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`google-signin:${payload}`)));
}

export async function signSignInState(secret: string, nonce: string, inviteHash: string | null, now: number): Promise<string> {
  const payload = toBase64Url(enc.encode(JSON.stringify({ n: nonce, i: inviteHash, exp: now + SIGNIN_TTL_MS })));
  return `${payload}.${toBase64Url(await sign(secret, payload))}`;
}

export async function verifySignInState(secret: string, token: string, now: number): Promise<{ nonce: string; inviteHash: string | null } | null> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined || token.length > 1024) return null;
  const given = fromBase64Url(sig);
  const expected = await sign(secret, payload);
  if (!given || given.length !== expected.length || !crypto.subtle.timingSafeEqual(given, expected)) return null;
  const raw = fromBase64Url(payload);
  if (!raw) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(raw)) as { n?: unknown; i?: unknown; exp?: unknown };
    if (typeof s.n !== "string" || typeof s.exp !== "number" || s.exp < now || (s.i !== null && typeof s.i !== "string")) return null;
    return { nonce: s.n, inviteHash: s.i };
  } catch {
    return null;
  }
}

/**
 * Who signed in, from the id_token Google's token endpoint returned over TLS (so its signature needn't be
 * checked). Only a verified email counts: a missing email_verified is NOT verified.
 */
export function readIdToken(idToken: string | undefined): { sub: string; email: string } | null {
  const part = idToken?.split(".")[1];
  const raw = part ? fromBase64Url(part) : null;
  if (!raw) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(raw)) as { sub?: unknown; email?: unknown; email_verified?: unknown };
    if (typeof c.sub !== "string" || typeof c.email !== "string" || c.email_verified !== true) return null;
    return { sub: c.sub, email: c.email.trim().toLowerCase() };
  } catch {
    return null;
  }
}
