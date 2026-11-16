import { Hono } from "hono";
import { z } from "zod";
import { requireCalendar } from "../auth";
import { newId } from "../lib/ids";
import { notFound, parseBody } from "../lib/http";
import type { AppEnv } from "../types";

type ServiceRow = {
  id: string; calendar_id: string; name: string; description: string; duration_min: number;
  price_cents: number | null; currency: string; color: string; location_type: string; location_text: string;
  hidden: number; sort_order: number; is_call_default: number; created_at: number; deleted_at: number | null;
};

const Fields = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000),
  duration_min: z.number().int().min(5).max(24 * 60),
  price_cents: z.number().int().min(0).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  location_type: z.enum(["phone", "video", "their_place", "business", "other"]),
  location_text: z.string().max(500),
  hidden: z.boolean(),
  is_call_default: z.boolean(),
});
const Create = Fields.partial().required({ name: true, duration_min: true });
const Patch = Fields.partial();

const DEFAULTS = {
  description: "", price_cents: null, currency: "USD", color: "#4f46e5",
  location_type: "phone", location_text: "", hidden: false, is_call_default: false,
} as const;

export function serviceJson(r: ServiceRow) {
  return {
    id: r.id, name: r.name, description: r.description, duration_min: r.duration_min,
    price_cents: r.price_cents, currency: r.currency, color: r.color,
    location_type: r.location_type, location_text: r.location_text,
    hidden: !!r.hidden, sort_order: r.sort_order, is_call_default: !!r.is_call_default,
  };
}

export async function getService(db: D1Database, calendarId: string, id: string) {
  return db.prepare("SELECT * FROM services WHERE id = ? AND calendar_id = ? AND deleted_at IS NULL")
    .bind(id, calendarId)
    .first<ServiceRow>();
}

const clearCallDefault = (db: D1Database, calendarId: string) =>
  db.prepare("UPDATE services SET is_call_default = 0 WHERE calendar_id = ?").bind(calendarId);

export const services = new Hono<AppEnv>();
services.use("*", requireCalendar);

services.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM services WHERE calendar_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at",
  )
    .bind(c.var.calendar.id)
    .all<ServiceRow>();
  return c.json({ services: results.map(serviceJson) });
});

services.post("/", async (c) => {
  const body = await parseBody(c, Create);
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const s = { ...DEFAULTS, ...body.data };
  const max = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM services WHERE calendar_id = ?")
    .bind(calId)
    .first<{ m: number }>();
  const row: ServiceRow = {
    id: newId("svc"), calendar_id: calId, name: s.name, description: s.description, duration_min: s.duration_min,
    price_cents: s.price_cents, currency: s.currency, color: s.color, location_type: s.location_type,
    location_text: s.location_text, hidden: s.hidden ? 1 : 0, sort_order: (max?.m ?? -1) + 1,
    is_call_default: s.is_call_default ? 1 : 0, created_at: Date.now(), deleted_at: null,
  };
  const insert = db.prepare(
    "INSERT INTO services (id, calendar_id, name, description, duration_min, price_cents, currency, color, location_type, location_text, hidden, sort_order, is_call_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.calendar_id, row.name, row.description, row.duration_min, row.price_cents, row.currency, row.color,
    row.location_type, row.location_text, row.hidden, row.sort_order, row.is_call_default, row.created_at);
  await db.batch(row.is_call_default ? [clearCallDefault(db, calId), insert] : [insert]);
  return c.json(serviceJson(row), 201);
});

services.put("/order", async (c) => {
  const body = await parseBody(c, z.object({ ids: z.array(z.string()).max(500) }));
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const stmts = body.data.ids.map((id, i) =>
    db.prepare("UPDATE services SET sort_order = ? WHERE id = ? AND calendar_id = ?").bind(i, id, calId),
  );
  if (stmts.length) await db.batch(stmts);
  return c.body(null, 204);
});

services.patch("/:id", async (c) => {
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const current = await getService(db, calId, c.req.param("id"));
  if (!current) return notFound(c);
  const body = await parseBody(c, Patch);
  if (!body.ok) return body.response;
  const p = body.data;
  const next: ServiceRow = {
    ...current,
    ...(p.name !== undefined && { name: p.name }),
    ...(p.description !== undefined && { description: p.description }),
    ...(p.duration_min !== undefined && { duration_min: p.duration_min }),
    ...(p.price_cents !== undefined && { price_cents: p.price_cents }),
    ...(p.currency !== undefined && { currency: p.currency }),
    ...(p.color !== undefined && { color: p.color }),
    ...(p.location_type !== undefined && { location_type: p.location_type }),
    ...(p.location_text !== undefined && { location_text: p.location_text }),
    ...(p.hidden !== undefined && { hidden: p.hidden ? 1 : 0 }),
    ...(p.is_call_default !== undefined && { is_call_default: p.is_call_default ? 1 : 0 }),
  };
  const update = db.prepare(
    "UPDATE services SET name = ?, description = ?, duration_min = ?, price_cents = ?, currency = ?, color = ?, location_type = ?, location_text = ?, hidden = ?, is_call_default = ? WHERE id = ? AND calendar_id = ?",
  ).bind(next.name, next.description, next.duration_min, next.price_cents, next.currency, next.color,
    next.location_type, next.location_text, next.hidden, next.is_call_default, next.id, calId);
  await db.batch(p.is_call_default ? [clearCallDefault(db, calId), update] : [update]);
  return c.json(serviceJson(next));
});

services.delete("/:id", async (c) => {
  const res = await c.env.DB.prepare(
    "UPDATE services SET deleted_at = ?, is_call_default = 0 WHERE id = ? AND calendar_id = ? AND deleted_at IS NULL",
  )
    .bind(Date.now(), c.req.param("id"), c.var.calendar.id)
    .run();
  if (!res.meta.changes) return notFound(c);
  return c.body(null, 204);
});
