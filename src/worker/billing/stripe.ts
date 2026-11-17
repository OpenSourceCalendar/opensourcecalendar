// All calls to Stripe: plain fetch, no SDK (same as the Google client). The API version is pinned per request.
import type { Bindings } from "../types";

export const STRIPE_VERSION = "2026-09-30.endive";
const TOLERANCE_S = 300;

export class StripeError extends Error {
  constructor(public status: number, public code: string) {
    super(`stripe_${code}`);
  }
}

/** Stripe's form encoding: nested keys as a[b][0][c]. Undefined/null values are left out. */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    else if (typeof v === "object") for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(`${prefix}[${k}]`, val);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

export async function stripe<T = Record<string, unknown>>(
  env: Bindings, method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string,
): Promise<T> {
  const query = method === "GET" && Object.keys(params).length ? `?${formEncode(params)}` : "";
  const headers: Record<string, string> = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_VERSION };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com${path}${query}`, {
      method, headers, body: method === "POST" ? formEncode(params) : undefined, signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new StripeError(0, "network");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; type?: string } };
  // Only the code: Stripe's message can contain customer details.
  if (!res.ok) throw new StripeError(res.status, data.error?.code ?? data.error?.type ?? "unknown");
  return data;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Stripe-Signature check on the raw body: HMAC-SHA256 of "<t>.<body>", any v1 may match, at most 5 minutes old. */
export async function verifyStripeSignature(secret: string, header: string, rawBody: string, nowMs: number): Promise<boolean> {
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowMs / 1000 - t) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = enc.encode(hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`))));
  return sigs.some((s) => {
    const given = enc.encode(s);
    return given.length === expected.length && crypto.subtle.timingSafeEqual(given, expected);
  });
}
