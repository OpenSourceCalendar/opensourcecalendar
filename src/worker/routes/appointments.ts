import { Hono } from "hono";
import { z } from "zod";
import { requireCalendar } from "../auth";
import {
  appointmentJson, cancelAppointment, createAppointment, FULL_SELECT, getAppointmentFull, manageToken,
  moveAppointment, reactivateAppointment, requireSecret, type AppointmentFull, type Contact,
} from "../booking/book";
import { notFound, parseBody } from "../lib/http";
import { CustomerInput, fillMissingContact, findOrCreateCustomer, getCustomer, normalizeEmail } from "./customers";
import { getService } from "./services";
import { emailsFor } from "../email/outbox";
import { googlePushJob } from "../google/push";
import { originOf, queueEmails } from "../email/queue";
import type { AppEnv } from "../types";

const Iso = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));
const STATUS = z.enum(["booked", "confirmed", "done", "no_show", "cancelled"]);

const Create = z
  .object({
    service_id: z.string(),
    start: Iso,
    customer_id: z.string().optional(),
    customer: CustomerInput.optional(),
    note: z.string().max(2000).default(""),
    source: z.string().max(100).default(""),
    allow_outside_hours: z.boolean().default(false),
  })
  .refine((b) => !!b.customer_id !== !!b.customer, { message: "give customer_id or customer, not both" });

const Patch = z.object({
  start: Iso.optional(),
  service_id: z.string().optional(),
  status: STATUS.optional(),
  note: z.string().max(2000).optional(),
  allow_outside_hours: z.boolean().default(false),
});

export const appointments = new Hono<AppEnv>();
appointments.use("*", requireCalendar);

appointments.post("/", async (c) => {
  const body = await parseBody(c, Create);
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const cal = c.var.calendar;
  const b = body.data;

  const service = await getService(db, cal.id, b.service_id);
  if (!service) return notFound(c);

  let customerId: string;
  let contact: Contact;
  if (b.customer_id) {
    const existing = await getCustomer(db, cal.id, b.customer_id);
    if (!existing) return notFound(c);
    customerId = existing.id;
    contact = { first_name: existing.first_name, last_name: existing.last_name, phone: existing.phone, email: existing.email };
  } else {
    const found = await findOrCreateCustomer(db, cal.id, b.customer!);
    const filled = found.created ? found.customer : await fillMissingContact(db, found.customer, b.customer!);
    customerId = filled.id;
    const s = b.customer!;
    contact = { first_name: s.first_name, last_name: s.last_name ?? "", phone: s.phone ?? null, email: s.email ? normalizeEmail(s.email) : null };
  }

  const now = Date.now();
  const res = await createAppointment(db, requireSecret(c.env.MANAGE_SECRET), cal, {
    service, customerId, contact, start: b.start, source: b.source, note: b.note, enforceRules: !b.allow_outside_hours, now,
  });
  if (!res.ok) return c.json({ error: res.error }, 409);
  await queueEmails(c, res.appointment.id, () => emailsFor(db, cal, "booked", res.appointment, { origin: originOf(c), byCustomer: false, now }));
  const full = await getAppointmentFull(db, cal.id, res.appointment.id);
  return c.json({ appointment: appointmentJson(full!), manage_token: res.token, manage_path: `/m/${res.token}` }, 201);
});

appointments.get("/", async (c) => {
  const q = z
    .object({ from: Iso, to: Iso, status: STATUS.optional(), service_id: z.string().optional() })
    .safeParse({ from: c.req.query("from"), to: c.req.query("to"), status: c.req.query("status"), service_id: c.req.query("service_id") });
  if (!q.success) return c.json({ error: "invalid_input", issues: q.error.issues }, 400);
  const where = ["a.calendar_id = ?", "a.start_at < ?", "a.end_at > ?"];
  const params: unknown[] = [c.var.calendar.id, q.data.to, q.data.from];
  if (q.data.status) { where.push("a.status = ?"); params.push(q.data.status); }
  if (q.data.service_id) { where.push("a.service_id = ?"); params.push(q.data.service_id); }
  const { results } = await c.env.DB.prepare(`${FULL_SELECT} WHERE ${where.join(" AND ")} ORDER BY a.start_at LIMIT 1000`)
    .bind(...params)
    .all<AppointmentFull>();
  return c.json({ appointments: results.map(appointmentJson) });
});

appointments.get("/:id", async (c) => {
  const row = await getAppointmentFull(c.env.DB, c.var.calendar.id, c.req.param("id"));
  if (!row) return notFound(c);
  return c.json({ ...appointmentJson(row), manage_token: await manageToken(requireSecret(c.env.MANAGE_SECRET), row.id) });
});

appointments.patch("/:id", async (c) => {
  const db = c.env.DB;
  const cal = c.var.calendar;
  const current = await getAppointmentFull(db, cal.id, c.req.param("id"));
  if (!current) return notFound(c);
  const body = await parseBody(c, Patch);
  if (!body.ok) return body.response;
  const p = body.data;
  const now = Date.now();

  const active = current.status === "booked" || current.status === "confirmed";
  if (p.start !== undefined || p.service_id !== undefined) {
    // Only active appointments move; the owner reactivates a cancelled one first.
    if (!active) return c.json({ error: "not_active" }, 409);
    const service = await getService(db, cal.id, p.service_id ?? current.service_id);
    if (!service) return notFound(c);
    const moved = await moveAppointment(db, cal, current, {
      service, start: p.start ?? current.start_at, enforceRules: !p.allow_outside_hours, now,
    });
    if (!moved.ok) return c.json({ error: moved.error }, 409);
    // Emailed now, not at the end: a later part of this patch can still fail.
    await queueEmails(c, current.id, async () => {
      const after = await getAppointmentFull(db, cal.id, current.id);
      const changed = after && (after.start_at !== current.start_at || after.service_id !== current.service_id);
      return changed ? emailsFor(db, cal, "changed", after, { origin: originOf(c), byCustomer: false, now }) : [];
    });
  }
  let plainStatus: string | null = null;
  if (p.status === "cancelled") {
    if (await cancelAppointment(db, cal.id, current.id, null, now)) {
      await queueEmails(c, current.id, () => emailsFor(db, cal, "cancelled", current, { origin: originOf(c), byCustomer: false, now }));
    }
  } else if (p.status !== undefined && current.status === "cancelled") {
    // Un-cancelling takes the time back, so it must still be free.
    if (p.status !== "booked" && p.status !== "confirmed") return c.json({ error: "not_active" }, 409);
    const back = await reactivateAppointment(db, cal, current, { status: p.status, enforceRules: !p.allow_outside_hours, now });
    if (!back.ok) return c.json({ error: back.error }, 409);
    await queueEmails(c, current.id, async () => {
      const after = await getAppointmentFull(db, cal.id, current.id);
      return after ? emailsFor(db, cal, "booked", after, { origin: originOf(c), byCustomer: false, now }) : [];
    });
  } else if (p.status !== undefined) {
    plainStatus = p.status;
  }
  if (plainStatus !== null || p.note !== undefined) {
    // A status change must not revive an appointment cancelled since we read it (that would skip the free-time check).
    const res = await db.prepare(
      "UPDATE appointments SET status = COALESCE(?1, status), note = COALESCE(?2, note), updated_at = ?3 WHERE id = ?4 AND calendar_id = ?5 AND (?1 IS NULL OR status != 'cancelled')",
    )
      .bind(plainStatus, p.note ?? null, now, current.id, cal.id)
      .run();
    if (!res.meta.changes) return c.json({ error: "not_active" }, 409);
    // The note shows in the Google event.
    if (p.note !== undefined) await queueEmails(c, current.id, () => [googlePushJob(db, cal.id, current.id, now)]);
  }
  return c.json(appointmentJson((await getAppointmentFull(db, cal.id, current.id))!));
});

appointments.post("/:id/cancel", async (c) => {
  const body = await parseBody(c, z.object({ reason: z.string().max(500).optional() }).default({}));
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const cal = c.var.calendar;
  const current = await getAppointmentFull(db, cal.id, c.req.param("id"));
  if (!current) return notFound(c);
  const now = Date.now();
  // Only when it actually changed: cancelling twice mustn't email twice.
  if (await cancelAppointment(db, cal.id, current.id, body.data.reason ?? null, now)) {
    await queueEmails(c, current.id, () => emailsFor(db, cal, "cancelled", current, { origin: originOf(c), byCustomer: false, now }));
  }
  return c.json(appointmentJson((await getAppointmentFull(db, cal.id, current.id))!));
});
