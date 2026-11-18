// Turns one queued job into a ready-to-send email (or a reason not to send it), and the real sender.

import { getAppointmentFull, manageToken, requireSecret } from "../booking/book";
import { buildIcs } from "../booking/ics";
import { locationText } from "../lib/location";
import { parseBranding, parseNotifications, parseRules } from "../settings";
import type { Bindings, CalendarRow } from "../types";
import { buildAccountEmail } from "../billing/emails";
import { entitlements } from "../billing/entitlements";
import { isClient } from "../billing/store";
import { calendarOverDailyCap } from "./limits";
import type { EmailKind, EmailPayload, OutgoingEmail, Sender } from "./outbox";
import { customerEmail, oneLine, ownerEmail, type CustomerKind, type EmailFacts, type OwnerKind } from "./templates";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The sending address, if email is set up on this install. */
export const emailFrom = (env: Bindings): string | null => {
  const from = env.EMAIL_FROM?.trim();
  return from && EMAIL_RE.test(from) ? from : null;
};
export const emailEnabled = (env: Bindings) => emailFrom(env) !== null;

/** The real sender. Kept tiny so everything around it can be tested without a mail service. */
export const sendWith = (env: Bindings): Sender => async (message) => {
  if (!env.EMAIL) throw Object.assign(new Error("no EMAIL binding"), { code: "E_VALIDATION_ERROR" });
  await env.EMAIL.send(message);
};

const SETTING: Partial<Record<EmailKind, "customer_confirmation" | "customer_change" | "customer_cancel" | "reminder" | "owner_new" | "owner_change" | "owner_cancel">> = {
  "email.customer.booked": "customer_confirmation",
  "email.customer.changed": "customer_change",
  "email.customer.cancelled": "customer_cancel",
  "email.customer.reminder": "reminder",
  "email.owner.new": "owner_new",
  "email.owner.changed": "owner_change",
  "email.owner.cancelled": "owner_cancel",
};

/** Where links in emails point: PUBLIC_URL when set, else the origin the booking came from. */
function linkBase(env: Bindings, origin: string): string | null {
  const ok = (u: string | undefined) => !!u && /^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/?$/.test(u);
  const base = ok(env.PUBLIC_URL) ? env.PUBLIC_URL! : ok(origin) ? origin : null;
  return base && base.replace(/\/+$/, "");
}

const toBase64 = (text: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** A message to send, a reason not to send it, or a reason to try again later. */
export type Built = { message: OutgoingEmail } | { skip: string } | { wait: string };

/** The email for one queued job, or why there's nothing to send. Everything is read fresh, at send time. */
export async function buildEmail(env: Bindings, calendarId: string, kind: EmailKind, payload: EmailPayload, now: number): Promise<Built> {
  const from = emailFrom(env);
  if (!from) return { skip: "not_configured" };
  const db = env.DB;
  if (kind.startsWith("email.account.")) {
    // Account emails count toward the calendar's daily cap like every other email.
    if (await calendarOverDailyCap(db, calendarId, now)) return { wait: "daily_cap" };
    const tz = (await db.prepare("SELECT time_zone FROM calendars WHERE id = ?").bind(calendarId).first<{ time_zone: string }>())?.time_zone ?? "UTC";
    return buildAccountEmail(env, from, kind, payload, tz);
  }
  if (!(kind in SETTING)) return { skip: "unknown_kind" };
  const cal = await db.prepare("SELECT * FROM calendars WHERE id = ?").bind(calendarId).first<CalendarRow>();
  if (!cal) return { skip: "no_calendar" };
  const notifications = parseNotifications(cal.notifications);
  if (!notifications[SETTING[kind]!]) return { skip: "turned_off" };
  const appt = await getAppointmentFull(db, cal.id, payload.appointment_id);
  if (!appt) return { skip: "no_appointment" };
  // Free plan over its monthly limit: this booking never sends email (checked here, at send time, for every kind).
  if ((appt as { emails_off?: number }).emails_off) return { skip: "free_limit" };
  const ent = await entitlements(env, cal, now);
  if (kind === "email.customer.reminder" && !ent.reminders) return { skip: "plan" };

  const forOwner = kind.startsWith("email.owner.");
  const cancelled = appt.status === "cancelled";
  const active = appt.status === "booked" || appt.status === "confirmed";
  // A cancellation notice needs a cancelled appointment; everything else needs a live one that hasn't happened yet.
  if (kind.endsWith(".cancelled") ? !cancelled : !active) return { skip: "cancelled" };
  if (kind === "email.customer.reminder") {
    if (payload.start !== appt.start_at) return { skip: "moved" };
    if (appt.start_at <= now) return { skip: "past" };
  } else if (appt.end_at <= now && (!kind.endsWith(".cancelled") || !forOwner)) {
    // Nothing to tell a customer about an appointment that's over (e.g. the owner tidying up yesterday).
    return { skip: "past" };
  }

  const to = forOwner ? notifications.owner_email : appt.contact_email;
  if (!to) return { skip: "no_address" };
  const base = linkBase(env, payload.origin);
  if (!base) return { skip: "no_origin" };
  if (await calendarOverDailyCap(db, cal.id, now)) {
    console.warn(JSON.stringify({ event: "email_daily_cap", calendar: cal.id }));
    return { wait: "daily_cap" };
  }

  const branding = parseBranding(cal.branding);
  const service = await db.prepare("SELECT location_type, location_text FROM services WHERE id = ?")
    .bind(appt.service_id)
    .first<{ location_type: string; location_text: string }>();
  const manageUrl = cancelled ? null : `${base}/m/${await manageToken(requireSecret(env.MANAGE_SECRET), appt.id)}`;
  const facts: EmailFacts = {
    businessName: branding.business_name,
    businessPhone: branding.phone,
    brandColor: branding.color,
    serviceName: appt.service_name,
    start: appt.start_at,
    end: appt.end_at,
    timeZone: forOwner ? cal.time_zone : (appt.customer_time_zone ?? cal.time_zone),
    manageUrl,
    bookUrl: `${base}/book/${cal.slug}`,
    scheduleUrl: isClient(cal) ? null : `${base}/admin/schedule`,
    locationText: locationText(service, forOwner),
    confirmationMessage: notifications.confirmation_message,
    poweredBy: (parseRules(cal.rules).powered_by || ent.footerForced) && !ent.footerHidden,
    cancelReason: appt.cancel_reason,
    customer: { name: `${appt.contact_first_name} ${appt.contact_last_name}`.trim(), phone: appt.contact_phone, email: appt.contact_email },
    note: appt.note,
  };
  const body = forOwner
    ? ownerEmail(kind.slice("email.owner.".length) as OwnerKind, facts)
    : customerEmail(kind.slice("email.customer.".length) as CustomerKind, facts);

  const message: OutgoingEmail = {
    to,
    from: { email: from, name: oneLine(branding.business_name, 80) || "Open Source Calendar" },
    ...body,
    headers: { "Auto-Submitted": "auto-generated" },
  };
  // Replies reach the other side: the customer's go to the owner, the owner's go to the customer.
  const replyTo = forOwner ? appt.contact_email : notifications.owner_email;
  if (replyTo) message.replyTo = replyTo;
  // The calendar file goes to the customer. Same UID each time and a rising SEQUENCE, so their calendar updates the one event.
  if (!forOwner && kind !== "email.customer.reminder") {
    const ics = buildIcs({
      id: appt.id,
      sequence: appt.ics_sequence,
      start: appt.start_at,
      end: appt.end_at,
      title: `${appt.service_name}${branding.business_name ? ` with ${oneLine(branding.business_name, 80)}` : ""}`,
      description: manageUrl ? `Change or cancel: ${manageUrl}` : "",
      location: locationText(service),
      cancelled,
      now,
    });
    message.attachments = [{ filename: "appointment.ics", content: toBase64(ics), type: "text/calendar", disposition: "attachment" }];
  }
  return { message };
}
