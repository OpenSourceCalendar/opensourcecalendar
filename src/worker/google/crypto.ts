// Google tokens are stored encrypted (AES-GCM, key GOOGLE_TOKEN_KEY). The calendar id is bound in as
// additional data, so a stored token copied onto another calendar's row won't decrypt.
import { toBase64Url } from "../lib/ids";
import { fromBase64Url } from "../lib/session";

const enc = new TextEncoder();

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64Url(secret.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  if (!raw || raw.length !== 32) throw new Error("GOOGLE_TOKEN_KEY must be 32 random bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealToken(secret: string, calendarId: string, plain: string): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(calendarId) }, key, enc.encode(plain));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/** The token, or null when it can't be opened (other key, other calendar, damaged). A bad key setting still throws. */
export async function openToken(secret: string, calendarId: string, sealed: string): Promise<string | null> {
  const key = await importKey(secret);
  const [v, ivPart, ctPart, extra] = sealed.split(".");
  if (v !== "v1" || !ivPart || !ctPart || extra !== undefined) return null;
  const iv = fromBase64Url(ivPart);
  const ct = fromBase64Url(ctPart);
  if (!iv || !ct || iv.length !== 12) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(calendarId) }, key, ct);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
