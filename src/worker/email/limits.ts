// Limits that stop the public booking page being used to send email to strangers.
// The page takes any email address and hands back a manage link, so without these a
// script could book, move and cancel over and over, emailing someone each time.

import { sha256Hex } from "../lib/ids";

const DAY = 86_400_000;

/** More bookings than this for one inbox in 24 hours: the booking stands, but that inbox gets no emails for it. */
export const MAX_BOOKINGS_PER_ADDRESS = 3;
/** A booking changed this many times by its link stops emailing its customer about further changes. */
export const MAX_CHANGES_WITH_EMAIL = 6;
/** Emails one calendar may send in 24 hours. Past this they wait, they aren't dropped. */
export const MAX_EMAILS_PER_CALENDAR = 200;

/**
 * One key per real inbox: lowercased, "+tag" removed, and dots removed for Gmail (which ignores them),
 * so name+1@gmail.com and n.ame@gmail.com count as the same person. Hashed: the queue never holds the address.
 */
export async function addressKey(email: string): Promise<string> {
  const [local, domain = ""] = email.trim().toLowerCase().split("@");
  let user = local.split("+")[0];
  let host = domain;
  if (host === "googlemail.com") host = "gmail.com";
  if (host === "gmail.com") user = user.replace(/\./g, "");
  return sha256Hex(`${user}@${host}`);
}

/**
 * Whether this inbox may get emails for a new booking, and its key to record on the confirmation job.
 * Counted from queued confirmations, which "delete my data" doesn't erase, so deleting can't reset it.
 */
export async function addressUnderLimit(db: D1Database, calendarId: string, email: string | null, now: number): Promise<{ ok: boolean; key?: string }> {
  if (!email) return { ok: true };
  const key = await addressKey(email);
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE calendar_id = ? AND kind = 'email.customer.booked' AND json_extract(payload, '$.addr') = ? AND json_extract(payload, '$.due') > ?",
  )
    .bind(calendarId, key, now - DAY)
    .first<{ n: number }>();
  return { ok: (row?.n ?? 0) < MAX_BOOKINGS_PER_ADDRESS, key };
}

/** True once a booking has been changed often enough that its customer shouldn't be emailed about more changes. */
export const tooManyChanges = (icsSequence: number) => icsSequence >= MAX_CHANGES_WITH_EMAIL;

/** True if this calendar has already sent its day's worth of email. */
export async function calendarOverDailyCap(db: D1Database, calendarId: string, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE calendar_id = ? AND done_at > ? AND result = 'sent'")
    .bind(calendarId, now - DAY)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_EMAILS_PER_CALENDAR;
}
