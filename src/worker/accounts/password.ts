// Password hashing and rules (NIST SP 800-63B rev 4, OWASP). Every stored hash says how it was made
// ("<kdf>$<params>$<pepper id>$<salt>$<hash>"), so the settings can be raised later and old hashes are re-made at the
// next sign-in (needsRehash) without signing anyone out.
import Argon2, { Argon2Type, Argon2Version } from "@phi-ag/argon2";
import wasm from "@phi-ag/argon2/argon2.wasm";
import { signupOn } from "./config";
import { toBase64Url } from "../lib/ids";
import { fromBase64Url } from "../lib/session";
import type { Bindings } from "../types";

export const PASSWORD_MIN = 15;
export const PASSWORD_MAX = 256;
const KDF = "argon2id";
/** OWASP's Argon2id minimum (19 MiB, 2 passes, 1 lane): about 70 ms of CPU per hash on Workers (Task 1). */
export type KdfParams = { m: number; t: number; p: number };
const PARAMS: KdfParams = { m: 19456, t: 2, p: 1 };
const PARAMS_TEXT = `m=${PARAMS.m},t=${PARAMS.t},p=${PARAMS.p}`;
const PEPPER_ID = "p1";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const enc = new TextEncoder();

/** Password sign-in exists only on the hosted service, and only with a pepper set. */
export const passwordsOn = (env: Bindings) => signupOn(env) && !!env.PASSWORD_PEPPER;

/** Length after NFC, in characters (an emoji is one). No other rules, on purpose. */
export function passwordProblem(password: string): "too_short" | "too_long" | null {
  const n = [...password.normalize("NFC")].length;
  if (n < PASSWORD_MIN) return "too_short";
  if (n > PASSWORD_MAX) return "too_long";
  return null;
}

/**
 * HMAC with the worker secret first: a stolen copy of D1 alone can't be guessed against. Returned as base64url text,
 * which is what Argon2 gets as its "password": the library takes a C string, so raw bytes (which can hold a zero byte)
 * would be cut short; base64url has no zero bytes and is always the same 43 characters.
 */
async function peppered(env: Bindings, password: string): Promise<string> {
  if (!env.PASSWORD_PEPPER) throw new Error("PASSWORD_PEPPER is not set");
  const key = await crypto.subtle.importKey("raw", enc.encode(env.PASSWORD_PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(password.normalize("NFC")))));
}

// One WebAssembly instance per isolate, made on first use. A failed start isn't kept, so the next request tries again.
let instance: Promise<Argon2> | undefined;
function argon2(): Promise<Argon2> {
  instance ??= WebAssembly.instantiate(wasm).then(
    (made) => new Argon2(made),
    (err: unknown) => {
      instance = undefined;
      throw err;
    },
  );
  return instance;
}

/** Raw 32-byte Argon2id output with our own salt; we write the stored form ourselves, not the library's. */
async function kdf(input: string, salt: Uint8Array, { m, t, p }: KdfParams): Promise<Uint8Array> {
  return (await argon2()).hash(input, {
    salt,
    hashLength: HASH_BYTES,
    timeCost: t,
    memoryCost: m,
    parallelism: p,
    type: Argon2Type.Argon2id,
    version: Argon2Version.Version13,
  }).hash;
}

/** `params` is only lowered by tests (to make an "old" hash). */
export async function hashPassword(env: Bindings, password: string, params: KdfParams = PARAMS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await kdf(await peppered(env, password), salt, params);
  return `${KDF}$m=${params.m},t=${params.t},p=${params.p}$${PEPPER_ID}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

// Our own constant-time compare: crypto.subtle.timingSafeEqual's typing is one of the known typecheck errors.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Settings from a stored hash, or null. Never stronger than the current ones: a bad row can't make us work harder. */
function parseParams(text: string | undefined): KdfParams | null {
  const found = /^m=(\d{1,6}),t=(\d{1,2}),p=(\d{1,2})$/.exec(text ?? "");
  if (!found) return null;
  const [m, t, p] = found.slice(1).map(Number);
  const ok = p >= 1 && p <= PARAMS.p && t >= 1 && t <= PARAMS.t && m >= 8 * p && m <= PARAMS.m;
  return ok ? { m, t, p } : null;
}

export async function verifyPassword(env: Bindings, password: string, stored: string): Promise<boolean> {
  const [kdfName, paramsText, pepperId, saltText, hashText, extra] = stored.split("$");
  const params = parseParams(paramsText);
  const salt = fromBase64Url(saltText ?? "");
  const hash = fromBase64Url(hashText ?? "");
  const input = await peppered(env, password);
  if (kdfName !== KDF || pepperId !== PEPPER_ID || extra !== undefined || !params || salt?.length !== SALT_BYTES || hash?.length !== HASH_BYTES) {
    // Same work as a real check, so a broken row can't be told apart by timing.
    await kdf(input, new Uint8Array(SALT_BYTES), PARAMS);
    return false;
  }
  return sameBytes(await kdf(input, salt, params), hash);
}

/** Made with older settings (or another KDF or pepper id): re-hash at the next successful sign-in. */
export const needsRehash = (stored: string) => !stored.startsWith(`${KDF}$${PARAMS_TEXT}$${PEPPER_ID}$`);

/**
 * Checked against when there's no account or no password, so every answer takes the same time. A fixed, well-formed
 * string (zero salt, zero hash): verifying runs the full Argon2id and can't match, since no real input hashes to zeros.
 */
export const DUMMY_HASH = `${KDF}$${PARAMS_TEXT}$${PEPPER_ID}$${"A".repeat(22)}$${"A".repeat(43)}`;
