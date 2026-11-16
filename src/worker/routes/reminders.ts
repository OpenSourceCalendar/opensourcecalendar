import { Hono } from "hono";
import { z } from "zod";
import { requireCalendar } from "../auth";
import { newId } from "../lib/ids";
import { notFound, parseBody } from "../lib/http";
import { getCustomer } from "./customers";
import type { AppEnv } from "../types";

type ReminderRow = { id: string; calendar_id: string; at: number; title: string; customer_id: string | null; external_ref: string | null; done: number; created_at: number };

const Iso = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));

const reminderJson = (r: ReminderRow) => ({
  id: r.id, at: new Date(r.at).toISOString(), title: r.title, customer_id: r.customer_id, external_ref: r.external_ref, done: !!r.done,
});

export const reminders = new Hono<AppEnv>();
reminders.use("*", requireCalendar);

reminders.get("/", async (c) => {
  const q = z.object({ from: Iso, to: Iso }).safeParse({ from: c.req.query("from"), to: c.req.query("to") });
  if (!q.success) return c.json({ error: "invalid_input", issues: q.error.issues }, 400);
  const { results } = await c.env.DB.prepare("SELECT * FROM reminders WHERE calendar_id = ? AND at >= ? AND at < ? ORDER BY at LIMIT 1000")
    .bind(c.var.calendar.id, q.data.from, q.data.to)
    .all<ReminderRow>();
  return c.json({ reminders: results.map(reminderJson) });
});

reminders.post("/", async (c) => {
  const body = await parseBody(c, z.object({
    at: Iso, title: z.string().trim().min(1).max(200), customer_id: z.string().optional(), external_ref: z.string().max(200).optional(),
  }));
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  if (body.data.customer_id && !(await getCustomer(db, calId, body.data.customer_id))) return notFound(c);
  const row: ReminderRow = {
    id: newId("rem"), calendar_id: calId, at: body.data.at, title: body.data.title,
    customer_id: body.data.customer_id ?? null, external_ref: body.data.external_ref ?? null, done: 0, created_at: Date.now(),
  };
  await db.prepare("INSERT INTO reminders (id, calendar_id, at, title, customer_id, external_ref, done, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
    .bind(row.id, row.calendar_id, row.at, row.title, row.customer_id, row.external_ref, row.created_at)
    .run();
  return c.json(reminderJson(row), 201);
});

reminders.patch("/:id", async (c) => {
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const current = await db.prepare("SELECT * FROM reminders WHERE id = ? AND calendar_id = ?").bind(c.req.param("id"), calId).first<ReminderRow>();
  if (!current) return notFound(c);
  const body = await parseBody(c, z.object({ at: Iso.optional(), title: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() }));
  if (!body.ok) return body.response;
  const next: ReminderRow = {
    ...current,
    ...(body.data.at !== undefined && { at: body.data.at }),
    ...(body.data.title !== undefined && { title: body.data.title }),
    ...(body.data.done !== undefined && { done: body.data.done ? 1 : 0 }),
  };
  await db.prepare("UPDATE reminders SET at = ?, title = ?, done = ? WHERE id = ? AND calendar_id = ?")
    .bind(next.at, next.title, next.done, next.id, calId)
    .run();
  return c.json(reminderJson(next));
});

reminders.delete("/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM reminders WHERE id = ? AND calendar_id = ?").bind(c.req.param("id"), c.var.calendar.id).run();
  if (!res.meta.changes) return notFound(c);
  return c.body(null, 204);
});
