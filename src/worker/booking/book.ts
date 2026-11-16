import { newId, sha256Hex, toBase64Url } from "../lib/ids";
import { parseRules } from "../settings";
import { findSlots } from "../slots/find-slots";
import { loadSlotInput } from "../slots/load";
import { addDays, localToUtc, utcToLocalDate } from "../slots/tz";
import type { CalendarRow } from "../types";

export type AppointmentRow = {
  id: string; calendar_id: string; service_id: string; customer_id: string; start_at: number; end_at: number;
  status: "booked" | "confirmed" | "done" | "no_show" | "cancelled"; source: string; note: string;
  cancel_reason: string | null; manage_token_hash: string; ics_sequence: number; google_event_id: string | null;
  created_at: number; updated_at: number;
  contact_first_name: string; contact_last_name: string; contact_phone: string | null; contact_email: string | null;
  /** The zone the customer booked in, for their emails. Null = use the calendar's. */
  customer_time_zone: string | null;
};

/** The contact details submitted for one appointment. */
export type Contact = { first_name: string; last_name: string; phone: string | null; email: string | null };

export type AppointmentFull = AppointmentRow & {
  service_name: string; first_name: string; last_name: string; phone: string | null; email: string | null;
};

export type BookError = "slot_unavailable" | "slot_taken";

/**
 * True when [?2, ?3) is free in calendar ?1, ignoring appointment ?4:
 * no active appointment within the buffer (?5 ms), no time block, no Google busy time,
 * and fewer than ?6 active appointments starting in the local day [?7, ?8) (?6 NULL = no limit).
 * Shared by insert and move so the rule is written once.
 */
const FREE = `
  NOT EXISTS (SELECT 1 FROM appointments a WHERE a.calendar_id = ?1 AND a.status != 'cancelled' AND a.id != ?4
              AND a.start_at < ?3 + ?5 AND a.end_at + ?5 > ?2)
  AND NOT EXISTS (SELECT 1 FROM time_blocks t WHERE t.calendar_id = ?1 AND t.start_at < ?3 AND t.end_at > ?2)
  AND NOT EXISTS (SELECT 1 FROM google_busy g WHERE g.calendar_id = ?1 AND g.start_at < ?3 AND g.end_at > ?2)
  AND (?6 IS NULL OR (SELECT COUNT(*) FROM appointments d WHERE d.calendar_id = ?1 AND d.status != 'cancelled'
                      AND d.id != ?4 AND d.start_at >= ?7 AND d.start_at < ?8) < ?6)`;

function freeParams(cal: CalendarRow, start: number, end: number, excludeId: string, enforceRules: boolean) {
  const rules = parseRules(cal.rules);
  const date = utcToLocalDate(start, cal.time_zone);
  return [
    cal.id, start, end, excludeId,
    enforceRules ? rules.buffer_min * 60000 : 0,
    enforceRules ? rules.max_per_day : null,
    localToUtc(date, 0, cal.time_zone),
    localToUtc(addDays(date, 1), 0, cal.time_zone),
  ];
}

/** True if the slot finder would offer `start` for this service (hours, breaks, notice, limits, conflicts). */
export async function isOpenTime(
  db: D1Database, cal: CalendarRow, service: { duration_min: number }, start: number, now: number, excludeId?: string,
): Promise<boolean> {
  const date = utcToLocalDate(start, cal.time_zone);
  const input = await loadSlotInput(db, cal, service, date, now, excludeId);
  return findSlots(input).includes(start);
}

/** Deterministic, unguessable manage token for an appointment. */
export async function manageToken(secret: string, appointmentId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`manage:${appointmentId}`));
  return toBase64Url(new Uint8Array(sig));
}

export function requireSecret(secret: string | undefined): string {
  if (!secret) throw new Error("MANAGE_SECRET is not set");
  return secret;
}

export async function createAppointment(
  db: D1Database,
  secret: string,
  cal: CalendarRow,
  args: {
    service: { id: string; duration_min: number }; customerId: string; contact: Contact; start: number; source: string; note: string;
    enforceRules: boolean; now: number; customerTimeZone?: string | null;
  },
): Promise<{ ok: true; appointment: AppointmentRow; token: string } | { ok: false; error: BookError }> {
  if (args.enforceRules && !(await isOpenTime(db, cal, args.service, args.start, args.now))) {
    return { ok: false, error: "slot_unavailable" };
  }
  const id = newId("apt");
  const token = await manageToken(secret, id);
  const end = args.start + args.service.duration_min * 60000;
  const tokenHash = await sha256Hex(token);
  const res = await db.prepare(
    `INSERT INTO appointments (id, calendar_id, service_id, customer_id, start_at, end_at, status, source, note, manage_token_hash, created_at, updated_at,
                               contact_first_name, contact_last_name, contact_phone, contact_email, customer_time_zone)
     SELECT ?9, ?1, ?10, ?11, ?2, ?3, 'booked', ?12, ?13, ?14, ?15, ?15, ?16, ?17, ?18, ?19, ?20 WHERE ${FREE}`,
  )
    .bind(
      ...freeParams(cal, args.start, end, "", args.enforceRules), id, args.service.id, args.customerId, args.source, args.note, tokenHash, args.now,
      args.contact.first_name, args.contact.last_name, args.contact.phone, args.contact.email, args.customerTimeZone ?? null,
    )
    .run();
  if (!res.meta.changes) return { ok: false, error: "slot_taken" };
  return {
    ok: true,
    token,
    appointment: {
      id, calendar_id: cal.id, service_id: args.service.id, customer_id: args.customerId, start_at: args.start, end_at: end,
      status: "booked", source: args.source, note: args.note, cancel_reason: null, manage_token_hash: tokenHash,
      ics_sequence: 0, google_event_id: null, created_at: args.now, updated_at: args.now,
      contact_first_name: args.contact.first_name, contact_last_name: args.contact.last_name,
      contact_phone: args.contact.phone, contact_email: args.contact.email,
      customer_time_zone: args.customerTimeZone ?? null,
    },
  };
}

/** Move a booked/confirmed appointment (and optionally change its service). */
export async function moveAppointment(
  db: D1Database,
  cal: CalendarRow,
  appt: AppointmentRow,
  args: { service: { id: string; duration_min: number }; start: number; enforceRules: boolean; now: number },
): Promise<{ ok: true } | { ok: false; error: BookError }> {
  if (args.enforceRules && !(await isOpenTime(db, cal, args.service, args.start, args.now, appt.id))) {
    return { ok: false, error: "slot_unavailable" };
  }
  const end = args.start + args.service.duration_min * 60000;
  const res = await db.prepare(
    `UPDATE appointments SET start_at = ?2, end_at = ?3, service_id = ?9, ics_sequence = ics_sequence + 1, updated_at = ?10
     WHERE id = ?4 AND calendar_id = ?1 AND status IN ('booked', 'confirmed') AND ${FREE}`,
  )
    .bind(...freeParams(cal, args.start, end, appt.id, args.enforceRules), args.service.id, args.now)
    .run();
  return res.meta.changes ? { ok: true } : { ok: false, error: "slot_taken" };
}

/** Un-cancel an appointment, only if its time is still free (buffer and daily limit apply unless enforceRules is false). */
export async function reactivateAppointment(
  db: D1Database,
  cal: CalendarRow,
  appt: AppointmentRow,
  args: { status: "booked" | "confirmed"; enforceRules: boolean; now: number },
): Promise<{ ok: true } | { ok: false; error: BookError }> {
  const res = await db.prepare(
    `UPDATE appointments SET status = ?9, cancel_reason = NULL, ics_sequence = ics_sequence + 1, updated_at = ?10
     WHERE id = ?4 AND calendar_id = ?1 AND status = 'cancelled' AND ${FREE}`,
  )
    .bind(...freeParams(cal, appt.start_at, appt.end_at, appt.id, args.enforceRules), args.status, args.now)
    .run();
  return res.meta.changes ? { ok: true } : { ok: false, error: "slot_taken" };
}

/** Returns false if it was already cancelled (or isn't in this calendar). */
export async function cancelAppointment(db: D1Database, calendarId: string, id: string, reason: string | null, now: number) {
  const res = await db.prepare(
    "UPDATE appointments SET status = 'cancelled', cancel_reason = ?, ics_sequence = ics_sequence + 1, updated_at = ? WHERE id = ? AND calendar_id = ? AND status != 'cancelled'",
  )
    .bind(reason, now, id, calendarId)
    .run();
  return !!res.meta.changes;
}

export const FULL_SELECT = `SELECT a.*, s.name AS service_name, c.first_name, c.last_name, c.phone, c.email
  FROM appointments a JOIN services s ON s.id = a.service_id JOIN customers c ON c.id = a.customer_id`;

export async function getAppointmentFull(db: D1Database, calendarId: string, id: string) {
  return db.prepare(`${FULL_SELECT} WHERE a.id = ? AND a.calendar_id = ?`).bind(id, calendarId).first<AppointmentFull>();
}

export async function getAppointmentByToken(db: D1Database, token: string) {
  return db.prepare(`${FULL_SELECT} WHERE a.manage_token_hash = ?`).bind(await sha256Hex(token)).first<AppointmentFull>();
}

function contactJson(r: AppointmentRow): Contact {
  return { first_name: r.contact_first_name, last_name: r.contact_last_name, phone: r.contact_phone, email: r.contact_email };
}

/** For the customer: only this appointment's own submitted details, never the stored customer record. */
export function publicAppointmentJson(r: AppointmentFull) {
  return {
    id: r.id,
    service_name: r.service_name,
    start: new Date(r.start_at).toISOString(),
    end: new Date(r.end_at).toISOString(),
    status: r.status,
    cancel_reason: r.cancel_reason,
    contact: contactJson(r),
  };
}

export function appointmentJson(r: AppointmentFull) {
  return {
    id: r.id,
    service_id: r.service_id,
    service_name: r.service_name,
    customer: { id: r.customer_id, first_name: r.first_name, last_name: r.last_name, phone: r.phone, email: r.email },
    contact: contactJson(r),
    start: new Date(r.start_at).toISOString(),
    end: new Date(r.end_at).toISOString(),
    status: r.status,
    source: r.source,
    note: r.note,
    cancel_reason: r.cancel_reason,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}
