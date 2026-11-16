import type { Context } from "hono";
import type { z } from "zod";

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Parse the JSON body with `schema`. On failure returns a ready 400 response. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<Parsed<z.output<S>>> {
  const raw = await c.req.json().catch(() => undefined);
  const res = schema.safeParse(raw);
  if (!res.success) {
    return { ok: false, response: c.json({ error: "invalid_input", issues: res.error.issues }, 400) };
  }
  return { ok: true, data: res.data };
}

export const notFound = (c: Context) => c.json({ error: "not_found" }, 404);

/** True for a time zone name the runtime knows, like "America/Chicago". */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
