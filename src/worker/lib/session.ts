import { toBase64Url } from "./ids";

export type Session = { a: string; u: string; exp: number };

const enc = new TextEncoder();

export function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`session:${data}`)));
}

export async function signSession(secret: string, who: { a: string; u: string }, now: number, ttlMs: number): Promise<string> {
  const payload = toBase64Url(enc.encode(JSON.stringify({ a: who.a, u: who.u, exp: now + ttlMs })));
  return `${payload}.${toBase64Url(await hmac(secret, payload))}`;
}

export async function verifySession(secret: string, token: string, now: number): Promise<Session | null> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined || token.length > 2048) return null;
  const given = fromBase64Url(sig);
  const expected = await hmac(secret, payload);
  if (!given || given.length !== expected.length || !crypto.subtle.timingSafeEqual(given, expected)) return null;
  const raw = fromBase64Url(payload);
  if (!raw) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(raw)) as Session;
    if (typeof s.a !== "string" || typeof s.u !== "string" || typeof s.exp !== "number" || s.exp < now) return null;
    return { a: s.a, u: s.u, exp: s.exp };
  } catch {
    return null;
  }
}
