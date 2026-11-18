import { Hono } from "hono";
import { z } from "zod";
import {
  cancelAppointment, createAppointment, getAppointmentByToken, getAppointmentFull, isOpenTime,
  moveAppointment, publicAppointmentJson, requireSecret, type AppointmentFull,
} from "../booking/book";
import { newId } from "../lib/ids";
import { verifyTurnstile } from "../lib/turnstile";
import { isDate, isTimeZone, notFound, parseBody } from "../lib/http";
import { locationText } from "../lib/location";
import { addressUnderLimit, tooManyChanges } from "../email/limits";
import { emailsFor } from "../email/outbox";
import { emailEnabled } from "../email/send";
import { originOf, queueEmails } from "../email/queue";
import { checkGoogleWindow } from "../google/busy";
import { googlePushJob } from "../google/push";
import { webhookJob } from "../webhooks/job";
import { entitlements } from "../billing/entitlements";
import { markIfOverLimit } from "../billing/limit";
import { parseBranding, parseNotifications, parseRules } from "../settings";
import { buildIcs } from "../booking/ics";
import { findSlots } from "../slots/find-slots";
import { loadSlotInput } from "../slots/load";
import { addDays, utcToLocalDate } from "../slots/tz";
import { Email, findOrCreateCustomer, normalizeEmail, Phone } from "./customers";
import { IMAGE_KEY_RE, publicBranding } from "./images";
import { getService, serviceJson } from "./services";
import type { AppEnv, CalendarRow } from "../types";

export const CONSENT_WORDING =
  "Text me appointment reminders and confirmations at the number above. Msg & data rates may apply; message frequency varies. Consent is not a condition of any purchase. Reply STOP to opt out, HELP for help.";

const MONTH_RE = /^20\d\d-(0[1-9]|1[0-2])$/;

/** Which emails a customer of this calendar gets, so the page can say "we've emailed you". */
function customerEmails(env: AppEnv["Bindings"], cal: CalendarRow) {
  const on = emailEnabled(env);
  const n = parseNotifications(cal.notifications);
  return { booked: on && n.customer_confirmation, changed: on && n.customer_change, cancelled: on && n.customer_cancel };
}

const Iso = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));

const BookBody = z.object({
  service_id: z.string(),
  start: Iso,
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().max(100).optional(),
  email: Email.optional(),
  phone: Phone.optional(),
  note: z.string().max(2000).default(""),
  text_consent: z.object({ wording: z.string().min(10).max(1000) }).optional(),
  turnstile_token: z.string().max(2048).optional(),
  /** The zone the customer is viewing times in. An unknown one is ignored, never an error. */
  time_zone: z.string().max(64).optional(),
});

async function calendarBySlug(db: D1Database, slug: string) {
  return db.prepare("SELECT * FROM calendars WHERE slug = ?").bind(slug).first<CalendarRow>();
}

async function visibleService(db: D1Database, calendarId: string, id: string) {
  const s = await getService(db, calendarId, id);
  return s && !s.hidden ? s : null;
}

async function calendarById(db: D1Database, id: string) {
  return (await db.prepare("SELECT * FROM calendars WHERE id = ?").bind(id).first<CalendarRow>())!;
}

/**
 * Dates in `month` (calendar time zone) that have at least one open time.
 * Only days inside the bookable window [today, today + max_days_ahead] are checked,
 * so months outside it cost nothing.
 */
async function openDays(db: D1Database, cal: CalendarRow, service: { duration_min: number }, month: string, now: number, excludeId?: string) {
  const days: string[] = [];
  const today = utcToLocalDate(now, cal.time_zone);
  const last = addDays(today, parseRules(cal.rules).max_days_ahead);
  const first = `${month}-01` < today ? today : `${month}-01`;
  for (let d = first; d.startsWith(month) && d <= last; d = addDays(d, 1)) {
    const input = await loadSlotInput(db, cal, service, d, now, excludeId);
    if (findSlots(input).length) days.push(d);
  }
  return days;
}

/** Customer-side changes are allowed while active and before the owner's cutoff. */
function canChange(appt: AppointmentFull, cal: CalendarRow, now: number) {
  const cutoff = parseRules(cal.rules).change_cutoff_hours * 3600000;
  return (appt.status === "booked" || appt.status === "confirmed") && now < appt.start_at - cutoff;
}

export const publicRoutes = new Hono<AppEnv>();

// Logos and hero photos. Registered before /:slug; "images" is a reserved slug.
publicRoutes.get("/images/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (!IMAGE_KEY_RE.test(key)) return notFound(c);
  const object = await c.env.IMAGES.get(key);
  if (!object) return notFound(c);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// --- Manage link (registered before /:slug so "manage" is never read as a slug) ---

publicRoutes.get("/manage/:token", async (c) => {
  const appt = await getAppointmentByToken(c.env.DB, c.req.param("token"));
  if (!appt) return notFound(c);
  const cal = await calendarById(c.env.DB, appt.calendar_id);
  const rules = parseRules(cal.rules);
  const ent = await entitlements(c.env, cal);
  return c.json({
    appointment: publicAppointmentJson(appt),
    business: publicBranding(parseBranding(cal.branding)),
    time_zone: cal.time_zone,
    can_change: canChange(appt, cal, Date.now()),
    emails: customerEmails(c.env, cal),
    change_cutoff_hours: rules.change_cutoff_hours,
    cancel_reason_required: rules.cancel_reason_required,
    max_days_ahead: rules.max_days_ahead,
    powered_by: (rules.powered_by || ent.footerForced) && !ent.footerHidden,
  });
});

publicRoutes.get("/manage/:token/slots", async (c) => {
  const db = c.env.DB;
  const appt = await getAppointmentByToken(db, c.req.param("token"));
  if (!appt) return notFound(c);
  if (appt.status !== "booked" && appt.status !== "confirmed") return c.json({ error: "not_active" }, 409);
  const date = c.req.query("date") ?? "";
  if (!isDate(date)) return c.json({ error: "invalid_input" }, 400);
  const cal = await calendarById(db, appt.calendar_id);
  if (!canChange(appt, cal, Date.now())) return c.json({ error: "too_late" }, 409);
  const service = await getService(db, cal.id, appt.service_id);
  if (!service) return notFound(c);
  const input = await loadSlotInput(db, cal, service, date, Date.now(), appt.id);
  return c.json({ date, time_zone: cal.time_zone, slots: findSlots(input).map((t) => new Date(t).toISOString()) });
});

publicRoutes.get("/manage/:token/days", async (c) => {
  const db = c.env.DB;
  const appt = await getAppointmentByToken(db, c.req.param("token"));
  if (!appt) return notFound(c);
  const month = c.req.query("month") ?? "";
  if (!MONTH_RE.test(month)) return c.json({ error: "invalid_input" }, 400);
  if (appt.status !== "booked" && appt.status !== "confirmed") return c.json({ error: "not_active" }, 409);
  const cal = await calendarById(db, appt.calendar_id);
  if (!canChange(appt, cal, Date.now())) return c.json({ error: "too_late" }, 409);
  const service = await getService(db, cal.id, appt.service_id);
  if (!service) return notFound(c);
  return c.json({ month, time_zone: cal.time_zone, days: await openDays(db, cal, service, month, Date.now(), appt.id) });
});

publicRoutes.get("/manage/:token/ics", async (c) => {
  const db = c.env.DB;
  const token = c.req.param("token");
  const appt = await getAppointmentByToken(db, token);
  if (!appt) return notFound(c);
  const cal = await calendarById(db, appt.calendar_id);
  const service = await getService(db, cal.id, appt.service_id);
  const ics = buildIcs({
    id: appt.id,
    sequence: appt.ics_sequence,
    start: appt.start_at,
    end: appt.end_at,
    title: `${appt.service_name} with ${parseBranding(cal.branding).business_name || "us"}`,
    description: `Change or cancel: ${new URL(`/m/${token}`, c.req.url).href}`,
    location: locationText(service),
    cancelled: appt.status === "cancelled",
    now: Date.now(),
  });
  return c.body(ics, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'attachment; filename="appointment.ics"',
  });
});

publicRoutes.post("/manage/:token/reschedule", async (c) => {
  const db = c.env.DB;
  const appt = await getAppointmentByToken(db, c.req.param("token"));
  if (!appt) return notFound(c);
  const body = await parseBody(c, z.object({ start: Iso, time_zone: z.string().max(64).optional() }));
  if (!body.ok) return body.response;
  const cal = await calendarById(db, appt.calendar_id);
  const now = Date.now();
  if (appt.status !== "booked" && appt.status !== "confirmed") return c.json({ error: "not_active" }, 409);
  if (!canChange(appt, cal, now)) return c.json({ error: "too_late" }, 409);
  const service = await getService(db, cal.id, appt.service_id);
  if (!service) return notFound(c);
  if (await isOpenTime(db, cal, service, body.data.start, now, appt.id)) {
    await checkGoogleWindow(c.env, cal, body.data.start, body.data.start + service.duration_min * 60_000, now);
  }
  const moved = await moveAppointment(db, cal, appt, { service, start: body.data.start, enforceRules: true, now });
  if (!moved.ok) return c.json({ error: moved.error }, 409);
  if (isTimeZone(body.data.time_zone)) {
    await db.prepare("UPDATE appointments SET customer_time_zone = ? WHERE id = ?").bind(body.data.time_zone, appt.id).run();
  }
  const after = (await getAppointmentFull(db, cal.id, appt.id))!;
  if (after.start_at !== appt.start_at) {
    // Changed many times by the link: stop emailing the customer, but still tell the owner.
    const toCustomer = !tooManyChanges(after.ics_sequence);
    await queueEmails(c, appt.id, () => emailsFor(db, cal, "changed", after, { origin: originOf(c), byCustomer: true, toCustomer, now }));
  }
  return c.json({ appointment: publicAppointmentJson(after) });
});

publicRoutes.post("/manage/:token/cancel", async (c) => {
  const db = c.env.DB;
  const appt = await getAppointmentByToken(db, c.req.param("token"));
  if (!appt) return notFound(c);
  const body = await parseBody(c, z.object({ reason: z.string().trim().max(500).optional() }).default({}));
  if (!body.ok) return body.response;
  const cal = await calendarById(db, appt.calendar_id);
  const now = Date.now();
  if (appt.status !== "booked" && appt.status !== "confirmed") return c.json({ error: "not_active" }, 409);
  if (!canChange(appt, cal, now)) return c.json({ error: "too_late" }, 409);
  if (parseRules(cal.rules).cancel_reason_required && !body.data.reason) {
    return c.json({ error: "invalid_input", missing: ["reason"] }, 400);
  }
  if (await cancelAppointment(db, cal.id, appt.id, body.data.reason || null, now)) {
    const toCustomer = !tooManyChanges(appt.ics_sequence + 1);
    await queueEmails(c, appt.id, () => emailsFor(db, cal, "cancelled", appt, { origin: originOf(c), byCustomer: true, toCustomer, now }));
  }
  return c.json({ appointment: publicAppointmentJson((await getAppointmentFull(db, cal.id, appt.id))!) });
});

publicRoutes.post("/manage/:token/delete-my-data", async (c) => {
  const db = c.env.DB;
  const appt = await getAppointmentByToken(db, c.req.param("token"));
  if (!appt) return notFound(c);
  const now = Date.now();
  // Whoever holds this link may not be the customer on record (bookings match on phone OR email),
  // so this only clears this booking and flags the customer for the owner to review.
  const [cancelled] = await db.batch([
    db.prepare(
      "UPDATE appointments SET status = 'cancelled', cancel_reason = 'Customer deleted their data', ics_sequence = ics_sequence + 1, updated_at = ? WHERE id = ? AND status IN ('booked', 'confirmed') AND start_at > ?",
    ).bind(now, appt.id, now),
    db.prepare(
      `UPDATE appointments SET contact_first_name = 'Deleted', contact_last_name = '', contact_phone = NULL, contact_email = NULL, note = '',
         cancel_reason = CASE WHEN cancel_reason IS NULL THEN NULL ELSE 'Customer deleted their data' END, updated_at = ? WHERE id = ?`,
    ).bind(now, appt.id),
    db.prepare("DELETE FROM consents WHERE appointment_id = ?").bind(appt.id),
    db.prepare("UPDATE customers SET delete_requested_at = ?, delete_request_appointment_id = ? WHERE id = ? AND calendar_id = ?")
      .bind(now, appt.id, appt.customer_id, appt.calendar_id),
  ]);
  if (cancelled.meta.changes) {
    // A slot just freed up: tell the owner. The customer gets nothing (their email is already erased).
    const cal = await calendarById(db, appt.calendar_id);
    await queueEmails(c, appt.id, () => emailsFor(db, cal, "cancelled", appt, { origin: originOf(c), byCustomer: true, toCustomer: false, now }));
  } else {
    // Past or already-cancelled booking: nothing to email, but its details must still come off Google,
    // and a host app should drop the copy it holds (booking.changed carries the erased contact).
    await queueEmails(c, appt.id, () => [
      googlePushJob(db, appt.calendar_id, appt.id, now),
      webhookJob(db, appt.calendar_id, "booking.changed", { appointment_id: appt.id }, now),
    ]);
  }
  return c.body(null, 204);
});

// --- Public booking page API ---

publicRoutes.get("/:slug", async (c) => {
  const db = c.env.DB;
  const cal = await calendarBySlug(db, c.req.param("slug"));
  if (!cal) return notFound(c);
  const rules = parseRules(cal.rules);
  const ent = await entitlements(c.env, cal);
  const { results } = await db.prepare(
    "SELECT * FROM services WHERE calendar_id = ? AND deleted_at IS NULL AND hidden = 0 ORDER BY sort_order, created_at",
  )
    .bind(cal.id)
    .all();
  return c.json({
    slug: cal.slug,
    time_zone: cal.time_zone,
    consent_wording: CONSENT_WORDING,
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null,
    branding: publicBranding(parseBranding(cal.branding)),
    services: (results as Parameters<typeof serviceJson>[0][]).map(serviceJson),
    emails: customerEmails(c.env, cal),
    booking: {
      required_fields: rules.required_fields,
      cancel_reason_required: rules.cancel_reason_required,
      change_cutoff_hours: rules.change_cutoff_hours,
      max_days_ahead: rules.max_days_ahead,
      powered_by: (rules.powered_by || ent.footerForced) && !ent.footerHidden,
    },
  });
});

publicRoutes.get("/:slug/days", async (c) => {
  const db = c.env.DB;
  const cal = await calendarBySlug(db, c.req.param("slug"));
  if (!cal) return notFound(c);
  const month = c.req.query("month") ?? "";
  if (!MONTH_RE.test(month)) return c.json({ error: "invalid_input" }, 400);
  const service = await visibleService(db, cal.id, c.req.query("service_id") ?? "");
  if (!service) return notFound(c);
  return c.json({ month, time_zone: cal.time_zone, days: await openDays(db, cal, service, month, Date.now()) });
});

publicRoutes.get("/:slug/slots", async (c) => {
  const db = c.env.DB;
  const cal = await calendarBySlug(db, c.req.param("slug"));
  if (!cal) return notFound(c);
  const date = c.req.query("date") ?? "";
  if (!isDate(date)) return c.json({ error: "invalid_input" }, 400);
  const service = await visibleService(db, cal.id, c.req.query("service_id") ?? "");
  if (!service) return notFound(c);
  const input = await loadSlotInput(db, cal, service, date, Date.now());
  return c.json({ date, time_zone: cal.time_zone, slots: findSlots(input).map((t) => new Date(t).toISOString()) });
});

publicRoutes.post("/:slug/book", async (c) => {
  const db = c.env.DB;
  const cal = await calendarBySlug(db, c.req.param("slug"));
  if (!cal) return notFound(c);
  const body = await parseBody(c, BookBody);
  if (!body.ok) return body.response;
  const b = body.data;
  // The widget runs on the booking page itself (also when the page is embedded in an iframe), so its hostname is ours:
  // PUBLIC_URL's, or the address this request came in on (an older address can keep serving the same page).
  // Which sites may make tokens at all is set on the widget in Cloudflare.
  const bookingHosts = [...new Set([new URL(c.env.PUBLIC_URL || c.req.url).hostname, new URL(c.req.url).hostname])];
  if (c.env.TURNSTILE_SECRET && !(await verifyTurnstile(c.env.TURNSTILE_SECRET, b.turnstile_token ?? "", c.req.header("CF-Connecting-IP") ?? null, { action: "book", hostnames: bookingHosts }))) {
    return c.json({ error: "turnstile_failed" }, 400);
  }
  if (b.text_consent && b.text_consent.wording !== CONSENT_WORDING) return c.json({ error: "invalid_input" }, 400);

  const required = parseRules(cal.rules).required_fields;
  const missing = (Object.keys(required) as (keyof typeof required)[]).filter((k) => required[k] && !b[k]);
  if (!b.phone && !b.email && !missing.includes("phone") && !missing.includes("email")) missing.push(required.email ? "email" : "phone");
  if (missing.length) return c.json({ error: "invalid_input", missing }, 400);

  const service = await visibleService(db, cal.id, b.service_id);
  if (!service) return notFound(c);

  if (b.text_consent && !b.phone) return c.json({ error: "invalid_input", missing: ["phone"] }, 400);

  const contact = { first_name: b.first_name, last_name: b.last_name ?? "", phone: b.phone ?? null, email: b.email ? normalizeEmail(b.email) : null };
  // Linked to an existing customer by phone or email, but never changes them: the submitter isn't verified.
  const { customer } = await findOrCreateCustomer(db, cal.id, contact);

  const now = Date.now();
  // An event added to Google in the last minute still blocks this time. Only for times that are otherwise
  // open, so junk requests never reach Google. createAppointment still does the real, atomic check.
  if (await isOpenTime(db, cal, service, b.start, now)) {
    await checkGoogleWindow(c.env, cal, b.start, b.start + service.duration_min * 60_000, now);
  }
  const res = await createAppointment(db, requireSecret(c.env.MANAGE_SECRET), cal, {
    service, customerId: customer.id, contact, start: b.start, source: "booking_page", note: b.note, enforceRules: true, now,
    customerTimeZone: isTimeZone(b.time_zone) ? b.time_zone : null,
  });
  if (!res.ok) return c.json({ error: res.error }, 409);

  if (b.text_consent) {
    // Consent is for the number typed on this booking, which may not be the stored customer's number.
    await db.prepare("INSERT INTO consents (id, customer_id, appointment_id, kind, wording, phone, given_at) VALUES (?, ?, ?, 'sms', ?, ?, ?)")
      .bind(newId("con"), customer.id, res.appointment.id, b.text_consent.wording, contact.phone, now)
      .run();
  }
  // Free plan: over 10 booking-page bookings this month, this one sends no email. Never fails the booking.
  await markIfOverLimit(c.env, cal, res.appointment.id, now).catch((err) =>
    console.error(JSON.stringify({ event: "free_limit_failed", error: String(err).slice(0, 200) })));
  await queueEmails(c, res.appointment.id, async () => {
    // Too many bookings for one address in a day: the booking stands, but that address gets no email for it.
    const limit = await addressUnderLimit(db, cal.id, contact.email, now);
    return emailsFor(db, cal, "booked", res.appointment, { origin: originOf(c), byCustomer: true, toCustomer: limit.ok, addressKey: limit.key, now });
  });
  const full = await getAppointmentFull(db, cal.id, res.appointment.id);
  return c.json({ appointment: publicAppointmentJson(full!), manage_token: res.token, manage_path: `/m/${res.token}` }, 201);
});
