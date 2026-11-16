import { Hono } from "hono";
import { z } from "zod";
import { requireCalendar } from "../auth";
import { newId } from "../lib/ids";
import { isDate, notFound, parseBody } from "../lib/http";
import { utcToLocalDate } from "../slots/tz";
import type { AppEnv } from "../types";

const Minute = z.number().int().min(0).max(1440);
const Range = z.object({ start_min: Minute, end_min: Minute }).refine((r) => r.start_min < r.end_min, { message: "start must be before end" });
const breaksInside = (d: { start_min: number; end_min: number; breaks: { start_min: number; end_min: number }[] }) =>
  d.breaks.every((b) => b.start_min >= d.start_min && b.end_min <= d.end_min);

const Day = z
  .object({ weekday: z.number().int().min(0).max(6), open: z.boolean(), start_min: Minute, end_min: Minute, breaks: z.array(Range).max(10) })
  .refine((d) => !d.open || d.start_min < d.end_min, { message: "start must be before end" })
  .refine((d) => !d.open || breaksInside(d), { message: "breaks must be inside the hours" });

const Override = z
  .object({ closed: z.boolean(), start_min: Minute.optional(), end_min: Minute.optional(), breaks: z.array(Range).max(10).default([]) })
  .refine((o) => o.closed || (o.start_min !== undefined && o.end_min !== undefined && o.start_min < o.end_min), { message: "open override needs hours" })
  .refine((o) => o.closed || breaksInside({ start_min: o.start_min!, end_min: o.end_min!, breaks: o.breaks }), { message: "breaks must be inside the hours" });

const DateStr = z.string().refine(isDate, { message: "YYYY-MM-DD" });
const Iso = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));

type HourRow = { weekday: number; start_min: number; end_min: number };
type OverrideRow = { on_date: string; closed: number; start_min: number | null; end_min: number | null; breaks: string };
type BlockedRow = { id: string; start_date: string; end_date: string; label: string };
type TimeBlockRow = { id: string; start_at: number; end_at: number; note: string };

const CLOSED_DEFAULT = { start_min: 540, end_min: 1020 };

async function readAvailability(db: D1Database, calendarId: string, timeZone: string) {
  const today = utcToLocalDate(Date.now(), timeZone);
  const [hours, breaks, overrides, blocked] = await db.batch([
    db.prepare("SELECT weekday, start_min, end_min FROM weekly_hours WHERE calendar_id = ?").bind(calendarId),
    db.prepare("SELECT weekday, start_min, end_min FROM weekly_breaks WHERE calendar_id = ? ORDER BY start_min").bind(calendarId),
    db.prepare("SELECT on_date, closed, start_min, end_min, breaks FROM date_overrides WHERE calendar_id = ? AND on_date >= ? ORDER BY on_date").bind(calendarId, today),
    db.prepare("SELECT id, start_date, end_date, label FROM blocked_dates WHERE calendar_id = ? AND end_date >= ? ORDER BY start_date").bind(calendarId, today),
  ]);
  const hourRows = hours.results as HourRow[];
  const breakRows = breaks.results as HourRow[];
  const weekly = [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const h = hourRows.find((r) => r.weekday === weekday);
    return {
      weekday,
      open: !!h,
      start_min: h?.start_min ?? CLOSED_DEFAULT.start_min,
      end_min: h?.end_min ?? CLOSED_DEFAULT.end_min,
      breaks: breakRows.filter((b) => b.weekday === weekday).map((b) => ({ start_min: b.start_min, end_min: b.end_min })),
    };
  });
  return {
    weekly,
    overrides: (overrides.results as OverrideRow[]).map((o) => ({
      on_date: o.on_date, closed: !!o.closed, start_min: o.start_min, end_min: o.end_min, breaks: JSON.parse(o.breaks),
    })),
    blocked_dates: blocked.results as BlockedRow[],
  };
}

const timeBlockJson = (r: TimeBlockRow) => ({
  id: r.id, start_at: new Date(r.start_at).toISOString(), end_at: new Date(r.end_at).toISOString(), note: r.note,
});

export const availability = new Hono<AppEnv>();
availability.use("*", requireCalendar);

availability.get("/", async (c) => c.json(await readAvailability(c.env.DB, c.var.calendar.id, c.var.calendar.time_zone)));

availability.put("/weekly", async (c) => {
  const body = await parseBody(c, z.object({ days: z.array(Day).max(7) }));
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const open = body.data.days.filter((d) => d.open);
  if (new Set(open.map((d) => d.weekday)).size !== open.length) return c.json({ error: "invalid_input", message: "duplicate weekday" }, 400);
  await db.batch([
    db.prepare("DELETE FROM weekly_hours WHERE calendar_id = ?").bind(calId),
    db.prepare("DELETE FROM weekly_breaks WHERE calendar_id = ?").bind(calId),
    ...open.map((d) =>
      db.prepare("INSERT INTO weekly_hours (calendar_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)").bind(calId, d.weekday, d.start_min, d.end_min),
    ),
    ...open.flatMap((d) =>
      d.breaks.map((b) =>
        db.prepare("INSERT INTO weekly_breaks (calendar_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)").bind(calId, d.weekday, b.start_min, b.end_min),
      ),
    ),
  ]);
  return c.json(await readAvailability(db, calId, c.var.calendar.time_zone));
});

availability.put("/overrides/:date", async (c) => {
  const date = c.req.param("date");
  if (!isDate(date)) return c.json({ error: "invalid_input" }, 400);
  const body = await parseBody(c, Override);
  if (!body.ok) return body.response;
  const o = body.data;
  await c.env.DB.prepare(
    "INSERT INTO date_overrides (calendar_id, on_date, closed, start_min, end_min, breaks) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (calendar_id, on_date) DO UPDATE SET closed = excluded.closed, start_min = excluded.start_min, end_min = excluded.end_min, breaks = excluded.breaks",
  )
    .bind(c.var.calendar.id, date, o.closed ? 1 : 0, o.closed ? null : o.start_min, o.closed ? null : o.end_min, JSON.stringify(o.closed ? [] : o.breaks))
    .run();
  return c.json({ on_date: date, closed: o.closed, start_min: o.closed ? null : o.start_min, end_min: o.closed ? null : o.end_min, breaks: o.closed ? [] : o.breaks });
});

availability.delete("/overrides/:date", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM date_overrides WHERE calendar_id = ? AND on_date = ?").bind(c.var.calendar.id, c.req.param("date")).run();
  if (!res.meta.changes) return notFound(c);
  return c.body(null, 204);
});

availability.post("/blocked", async (c) => {
  const body = await parseBody(
    c,
    z.object({ start_date: DateStr, end_date: DateStr, label: z.string().max(100).default("") }).refine((b) => b.start_date <= b.end_date, { message: "start after end" }),
  );
  if (!body.ok) return body.response;
  const row: BlockedRow = { id: newId("blk"), ...body.data };
  await c.env.DB.prepare("INSERT INTO blocked_dates (id, calendar_id, start_date, end_date, label) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, c.var.calendar.id, row.start_date, row.end_date, row.label)
    .run();
  return c.json(row, 201);
});

availability.delete("/blocked/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM blocked_dates WHERE id = ? AND calendar_id = ?").bind(c.req.param("id"), c.var.calendar.id).run();
  if (!res.meta.changes) return notFound(c);
  return c.body(null, 204);
});

availability.get("/time-blocks", async (c) => {
  const q = z.object({ from: Iso, to: Iso }).safeParse({ from: c.req.query("from"), to: c.req.query("to") });
  if (!q.success) return c.json({ error: "invalid_input", issues: q.error.issues }, 400);
  const { results } = await c.env.DB.prepare(
    "SELECT id, start_at, end_at, note FROM time_blocks WHERE calendar_id = ? AND start_at < ? AND end_at > ? ORDER BY start_at",
  )
    .bind(c.var.calendar.id, q.data.to, q.data.from)
    .all<TimeBlockRow>();
  return c.json({ time_blocks: results.map(timeBlockJson) });
});

availability.post("/time-blocks", async (c) => {
  const body = await parseBody(
    c,
    z.object({ start_at: Iso, end_at: Iso, note: z.string().max(500).default("") }).refine((b) => b.start_at < b.end_at, { message: "start must be before end" }),
  );
  if (!body.ok) return body.response;
  const row: TimeBlockRow = { id: newId("tb"), ...body.data };
  await c.env.DB.prepare("INSERT INTO time_blocks (id, calendar_id, start_at, end_at, note) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, c.var.calendar.id, row.start_at, row.end_at, row.note)
    .run();
  return c.json(timeBlockJson(row), 201);
});

availability.delete("/time-blocks/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM time_blocks WHERE id = ? AND calendar_id = ?").bind(c.req.param("id"), c.var.calendar.id).run();
  if (!res.meta.changes) return notFound(c);
  return c.body(null, 204);
});
