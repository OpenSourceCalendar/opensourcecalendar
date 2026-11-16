import { Hono } from "hono";
import { z } from "zod";
import { requireCalendar } from "../auth";
import { appointmentJson, FULL_SELECT, type AppointmentFull } from "../booking/book";
import { newId } from "../lib/ids";
import { notFound, parseBody } from "../lib/http";
import type { AppEnv } from "../types";
import { googlePushMany } from "../google/push";
import { customerDeletedJob, webhookJob } from "../webhooks/job";

export type CustomerRow = {
  id: string; calendar_id: string; first_name: string; last_name: string; phone: string | null; phone_norm: string | null;
  email: string | null; notes: string; external_ref: string | null; created_at: number; deleted_at: number | null;
  delete_requested_at: number | null;
  delete_request_appointment_id: string | null;
};

/** Digits only, US 10-digit numbers get a leading 1. Null if too short to be a phone. */
export function normalizePhone(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const Phone = z.string().trim().max(40).refine((p) => normalizePhone(p) !== null, { message: "not a phone number" });
export const Email = z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: "not an email" });

const Fields = z.strictObject({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().max(100),
  phone: Phone.nullable(),
  email: Email.nullable(),
  notes: z.string().max(5000),
  external_ref: z.string().max(200).nullable(),
});

export const CustomerInput = Fields.partial()
  .required({ first_name: true })
  .refine((c) => !!c.phone || !!c.email, { message: "phone or email required" });
const Patch = Fields.partial();

export function customerJson(r: CustomerRow) {
  return {
    id: r.id, first_name: r.first_name, last_name: r.last_name, phone: r.phone, email: r.email,
    notes: r.notes, external_ref: r.external_ref, created_at: new Date(r.created_at).toISOString(),
    delete_requested_at: r.delete_requested_at === null ? null : new Date(r.delete_requested_at).toISOString(),
    delete_request_appointment_id: r.delete_request_appointment_id,
  };
}

async function findByContact(db: D1Database, calendarId: string, phoneNorm: string | null, email: string | null, exceptId = "") {
  if (!phoneNorm && !email) return null;
  return db.prepare(
    "SELECT * FROM customers WHERE calendar_id = ? AND deleted_at IS NULL AND id != ? AND ((phone_norm IS NOT NULL AND phone_norm = ?) OR (email IS NOT NULL AND email = ?)) LIMIT 1",
  )
    .bind(calendarId, exceptId, phoneNorm, email)
    .first<CustomerRow>();
}

/** Returns the existing customer with the same phone or email, or creates one. */
export async function findOrCreateCustomer(db: D1Database, calendarId: string, input: z.output<typeof CustomerInput>) {
  const phoneNorm = input.phone ? normalizePhone(input.phone) : null;
  const email = input.email ? normalizeEmail(input.email) : null;
  const existing = await findByContact(db, calendarId, phoneNorm, email);
  if (existing) return { customer: existing, created: false };

  const row: CustomerRow = {
    id: newId("cus"), calendar_id: calendarId, first_name: input.first_name, last_name: input.last_name ?? "",
    phone: input.phone ?? null, phone_norm: phoneNorm, email, notes: input.notes ?? "",
    external_ref: input.external_ref ?? null, created_at: Date.now(), deleted_at: null, delete_requested_at: null, delete_request_appointment_id: null,
  };
  try {
    // The webhook event goes in the same batch: no event for a customer that wasn't created.
    await db.batch([
      db.prepare(
        "INSERT INTO customers (id, calendar_id, first_name, last_name, phone, phone_norm, email, notes, external_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(row.id, row.calendar_id, row.first_name, row.last_name, row.phone, row.phone_norm, row.email, row.notes, row.external_ref, row.created_at),
      webhookJob(db, calendarId, "customer.created", { customer_id: row.id }, row.created_at),
    ]);
  } catch (err) {
    // Two bookings for the same new person at once: the other insert won, use it.
    if (!String(err).includes("UNIQUE")) throw err;
    const winner = await findByContact(db, calendarId, phoneNorm, email);
    if (!winner) throw err;
    return { customer: winner, created: false };
  }
  return { customer: row, created: true };
}

export async function getCustomer(db: D1Database, calendarId: string, id: string) {
  return db.prepare("SELECT * FROM customers WHERE id = ? AND calendar_id = ? AND deleted_at IS NULL").bind(id, calendarId).first<CustomerRow>();
}

export const customers = new Hono<AppEnv>();
customers.use("*", requireCalendar);

customers.get("/", async (c) => {
  const calId = c.var.calendar.id;
  const ref = c.req.query("external_ref");
  const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 100);
  let stmt;
  if (ref) {
    stmt = c.env.DB.prepare("SELECT * FROM customers WHERE calendar_id = ? AND deleted_at IS NULL AND external_ref = ? ORDER BY created_at DESC LIMIT 50").bind(calId, ref);
  } else if (q) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    // Only search phone digits when the query looks like a phone number (no letters, 3+ digits),
    // otherwise "bob1@…" would match every +1 number.
    const digits = q.replace(/\D/g, "");
    const phoneLike = !/[a-z@]/.test(q) && digits.length >= 3;
    const digitLike = phoneLike ? `%${digits}%` : null; // LIKE NULL never matches
    stmt = c.env.DB.prepare(
      "SELECT * FROM customers WHERE calendar_id = ?3 AND deleted_at IS NULL AND (lower(first_name) LIKE ?1 ESCAPE '\\' OR lower(last_name) LIKE ?1 ESCAPE '\\' OR lower(first_name || ' ' || last_name) LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\' OR phone_norm LIKE ?2) ORDER BY created_at DESC LIMIT 50",
    ).bind(like, digitLike, calId);
  } else {
    stmt = c.env.DB.prepare(// Anyone who asked for their data to be deleted comes first, so the owner can't miss it past the 50 limit.
    "SELECT * FROM customers WHERE calendar_id = ? AND deleted_at IS NULL ORDER BY (delete_requested_at IS NULL), created_at DESC LIMIT 50").bind(calId);
  }
  const { results } = await stmt.all<CustomerRow>();
  return c.json({ customers: results.map(customerJson) });
});

customers.post("/", async (c) => {
  const body = await parseBody(c, CustomerInput);
  if (!body.ok) return body.response;
  const { customer, created } = await findOrCreateCustomer(c.env.DB, c.var.calendar.id, body.data);
  return c.json({ customer: customerJson(customer), created }, created ? 201 : 200);
});

customers.get("/:id", async (c) => {
  const row = await getCustomer(c.env.DB, c.var.calendar.id, c.req.param("id"));
  return row ? c.json(customerJson(row)) : notFound(c);
});

/** Every appointment this customer has in this calendar, newest first, with counts. */
customers.get("/:id/appointments", async (c) => {
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const cus = await getCustomer(db, calId, c.req.param("id"));
  if (!cus) return notFound(c);
  const { results } = await db.prepare(`${FULL_SELECT} WHERE a.calendar_id = ? AND a.customer_id = ? ORDER BY a.start_at DESC LIMIT 200`)
    .bind(calId, cus.id)
    .all<AppointmentFull>();
  const agg = await db.prepare(
    `SELECT COALESCE(SUM(status != 'cancelled'), 0) AS booked, COALESCE(SUM(status = 'done'), 0) AS completed,
            COALESCE(SUM(status = 'cancelled'), 0) AS cancelled, MIN(CASE WHEN status != 'cancelled' THEN start_at END) AS first
     FROM appointments WHERE calendar_id = ? AND customer_id = ?`,
  )
    .bind(calId, cus.id)
    .first<{ booked: number; completed: number; cancelled: number; first: number | null }>();
  return c.json({
    appointments: results.map(appointmentJson),
    counts: { booked: agg?.booked ?? 0, completed: agg?.completed ?? 0, cancelled: agg?.cancelled ?? 0 },
    first_booked: agg?.first == null ? null : new Date(agg.first).toISOString(),
  });
});

/** The owner looked at a "delete my data" request and is keeping the customer. */
customers.post("/:id/dismiss-delete-request", async (c) => {
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const cus = await getCustomer(db, calId, c.req.param("id"));
  if (!cus) return notFound(c);
  await db.prepare("UPDATE customers SET delete_requested_at = NULL, delete_request_appointment_id = NULL WHERE id = ? AND calendar_id = ?")
    .bind(cus.id, calId)
    .run();
  return c.json(customerJson({ ...cus, delete_requested_at: null, delete_request_appointment_id: null }));
});

customers.patch("/:id", async (c) => {
  const db = c.env.DB;
  const calId = c.var.calendar.id;
  const current = await getCustomer(db, calId, c.req.param("id"));
  if (!current) return notFound(c);
  const body = await parseBody(c, Patch);
  if (!body.ok) return body.response;
  const p = body.data;
  const next: CustomerRow = {
    ...current,
    ...(p.first_name !== undefined && { first_name: p.first_name }),
    ...(p.last_name !== undefined && { last_name: p.last_name }),
    ...(p.notes !== undefined && { notes: p.notes }),
    ...(p.external_ref !== undefined && { external_ref: p.external_ref }),
    ...(p.phone !== undefined && { phone: p.phone, phone_norm: p.phone ? normalizePhone(p.phone) : null }),
    ...(p.email !== undefined && { email: p.email ? normalizeEmail(p.email) : null }),
  };
  if (!next.phone_norm && !next.email) return c.json({ error: "invalid_input", message: "phone or email required" }, 400);
  if (await findByContact(db, calId, next.phone_norm, next.email, current.id)) return c.json({ error: "customer_exists" }, 409);
  try {
    await db.prepare(
      "UPDATE customers SET first_name = ?, last_name = ?, phone = ?, phone_norm = ?, email = ?, notes = ?, external_ref = ? WHERE id = ? AND calendar_id = ?",
    )
      .bind(next.first_name, next.last_name, next.phone, next.phone_norm, next.email, next.notes, next.external_ref, current.id, calId)
      .run();
  } catch (err) {
    // Lost a race with another edit taking the same phone or email.
    if (String(err).includes("UNIQUE")) return c.json({ error: "customer_exists" }, 409);
    throw err;
  }
  return c.json(customerJson(next));
});

customers.delete("/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const calId = c.var.calendar.id;
  const now = Date.now();
  const [, res] = await db.batch([
    // First, while external_ref still exists: tells a host app (a CRM) to erase its copy too.
    customerDeletedJob(db, calId, id, now),
    db.prepare(
      "UPDATE customers SET first_name = 'Deleted', last_name = '', phone = NULL, phone_norm = NULL, email = NULL, notes = '', external_ref = NULL, deleted_at = ? WHERE id = ? AND calendar_id = ? AND deleted_at IS NULL",
    ).bind(now, id, calId),
    // Each appointment keeps a copy of the details submitted for it, and a free-text note that can hold
    // personal details; clear those too. Text-consent records are kept on purpose, as proof of permission.
    db.prepare(
      "UPDATE appointments SET contact_first_name = 'Deleted', contact_last_name = '', contact_phone = NULL, contact_email = NULL, note = '', updated_at = ? WHERE customer_id = ? AND calendar_id = ?",
    ).bind(now, id, calId),
    // Their name and details come off the events in Google too.
    googlePushMany(db, calId, now, { customerId: id }),
  ]);
  if (!res.meta.changes) return notFound(c);
  return c.body(null, 204);
});

/** Fill in an email and last name the customer doesn't have yet. Never overwrites. Ignores values another customer already uses. */
export async function fillMissingContact(
  db: D1Database,
  cus: CustomerRow,
  input: { last_name?: string; email?: string | null },
): Promise<CustomerRow> {
  const email = !cus.email && input.email ? normalizeEmail(input.email) : null;
  const lastName = !cus.last_name && input.last_name ? input.last_name : null;
  if (!email && !lastName) return cus;
  const next: CustomerRow = {
    ...cus,
    ...(email && { email }),
    ...(lastName && { last_name: lastName }),
  };
  try {
    await db.prepare("UPDATE customers SET last_name = ?, email = ? WHERE id = ? AND calendar_id = ?")
      .bind(next.last_name, next.email, cus.id, cus.calendar_id)
      .run();
    return next;
  } catch (err) {
    if (String(err).includes("UNIQUE")) return cus; // belongs to someone else; keep what we had
    throw err;
  }
}
