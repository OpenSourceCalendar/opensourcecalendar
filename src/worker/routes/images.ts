import { Hono } from "hono";
import { requireCalendar } from "../auth";
import { toBase64Url } from "../lib/ids";
import { notFound } from "../lib/http";
import type { Branding } from "../settings";
import type { AppEnv } from "../types";

const KINDS = {
  logo: { max: 2 * 1024 * 1024, field: "logo_key" },
  hero: { max: 5 * 1024 * 1024, field: "hero_key" },
} as const;

/** The only keys the public image route will serve. */
export const IMAGE_KEY_RE = /^cal\/[A-Za-z0-9_]+\/(logo|hero)-[A-Za-z0-9_-]{8,40}\.(png|jpg|webp)$/;

export const imageUrl = (key: string | null) => (key ? `/api/public/images/${key}` : null);

/** Branding as the public sees it: image URLs instead of storage keys. */
export function publicBranding(b: Branding) {
  const { logo_key, hero_key, ...rest } = b;
  return { ...rest, logo_url: imageUrl(logo_key), hero_url: imageUrl(hero_key) };
}

/** PNG, JPEG or WebP, judged by the first bytes. Anything else (including SVG) is refused. */
function sniff(b: Uint8Array): { ext: string; type: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png", type: "image/png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  const ascii = (from: number) => String.fromCharCode(...b.slice(from, from + 4));
  if (b.length >= 12 && ascii(0) === "RIFF" && ascii(8) === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

/** The request body, or null once it passes `max` bytes. Never buffers more than the limit. */
async function readUpTo(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Set (or clear) one image key and return the key it replaced, read in the same step so overlapping uploads can't both miss it. */
async function swapKey(db: D1Database, calendarId: string, field: string, key: string | null): Promise<string | null> {
  const [before] = await db.batch([
    db.prepare(`SELECT json_extract(branding, '$.${field}') AS old FROM calendars WHERE id = ?`).bind(calendarId),
    db.prepare(`UPDATE calendars SET branding = json_set(branding, '$.${field}', ?) WHERE id = ?`).bind(key, calendarId),
  ]);
  return (before.results[0] as { old: string | null } | undefined)?.old ?? null;
}

export const images = new Hono<AppEnv>();
images.use("*", requireCalendar);

/** Own keys only: a plain lookup would accept "constructor" or "__proto__". */
const kindOf = (name: string) => (Object.hasOwn(KINDS, name) ? KINDS[name as keyof typeof KINDS] : null);

images.put("/:kind", async (c) => {
  const kind = kindOf(c.req.param("kind"));
  if (!kind) return notFound(c);
  if (Number(c.req.header("Content-Length") ?? 0) > kind.max) return c.json({ error: "too_large" }, 413);
  // Content-Length can be missing or wrong, so count while reading and stop at the limit.
  const bytes = await readUpTo(c.req.raw.body, kind.max);
  if (!bytes) return c.json({ error: "too_large" }, 413);
  const found = sniff(bytes);
  if (!found) return c.json({ error: "unsupported_image" }, 415);

  const cal = c.var.calendar;
  const random = toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
  const key = `cal/${cal.id}/${c.req.param("kind")}-${random}.${found.ext}`;
  await c.env.IMAGES.put(key, bytes, { httpMetadata: { contentType: found.type } });
  let old: string | null;
  try {
    old = await swapKey(c.env.DB, cal.id, kind.field, key);
  } catch (err) {
    await c.env.IMAGES.delete(key); // don't leave a file nothing points at
    throw err;
  }
  if (old && old !== key) await c.env.IMAGES.delete(old);
  return c.json({ key, url: imageUrl(key) });
});

images.delete("/:kind", async (c) => {
  const kind = kindOf(c.req.param("kind"));
  if (!kind) return notFound(c);
  const old = await swapKey(c.env.DB, c.var.calendar.id, kind.field, null);
  if (old) await c.env.IMAGES.delete(old);
  return c.body(null, 204);
});
