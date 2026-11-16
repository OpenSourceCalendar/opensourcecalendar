// Webhook signing. The secret is derived (like manage links), so nothing secret is stored:
// whsec_ + base64url(HMAC-SHA256(MANAGE_SECRET, "webhook:<app id>:<version>")).
// Rotating MANAGE_SECRET therefore also rotates every app's webhook secret.
import { requireSecret } from "../booking/book";
import { toBase64Url } from "../lib/ids";
import type { Bindings } from "../types";

const enc = new TextEncoder();

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export async function webhookSecret(env: Bindings, appId: string, version: number): Promise<string> {
  return `whsec_${toBase64Url(await hmac(requireSecret(env.MANAGE_SECRET), `webhook:${appId}:${version}`))}`;
}

/** Hex HMAC-SHA256 of "<t>.<body>", keyed with the whole whsec_… string: the v1 in X-Calendar-Signature. */
export async function signBody(secret: string, t: number, body: string): Promise<string> {
  return [...(await hmac(secret, `${t}.${body}`))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
