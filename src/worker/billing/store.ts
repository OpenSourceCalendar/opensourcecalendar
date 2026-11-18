// Every SQL statement for the billing table and the account ↔ calendar link.
import { HOSTED_APP } from "../auth";
import type { CalendarRow } from "../types";
import type { Interval, Plan } from "./config";

export type BillingRow = {
  user_id: string; stripe_customer_id: string | null; stripe_subscription_id: string | null;
  plan: Plan; interval: Interval | null; status: string; current_period_end: number | null; cancel_at_period_end: number;
  trial_used: number; trial_end: number | null; grace_until: number | null; grace_subscription_id: string | null;
  grace_checkin_sent: number; grace_reminder_sent: number; checkout_attempts: string; client_limit: number | null; updated_at: number;
};

export const getBilling = (db: D1Database, userId: string) =>
  db.prepare("SELECT * FROM billing WHERE user_id = ?").bind(userId).first<BillingRow>();

export const ensureBillingRow = (db: D1Database, userId: string, now: number) =>
  db.prepare("INSERT OR IGNORE INTO billing (user_id, updated_at) VALUES (?, ?)").bind(userId, now).run();

export const billingByCustomer = (db: D1Database, customerId: string) =>
  db.prepare("SELECT * FROM billing WHERE stripe_customer_id = ?").bind(customerId).first<BillingRow>();

/** The account's calendars, its own and its clients', oldest first. Code that needs the account's own uses homeCalendar. */
export async function accountCalendars(db: D1Database, userId: string): Promise<CalendarRow[]> {
  return (await db.prepare("SELECT * FROM calendars WHERE app_id = ? AND account_user_id = ? ORDER BY created_at")
    .bind(HOSTED_APP, userId).all<CalendarRow>()).results;
}

/** The account's own calendar, made right after sign-up (external_user_id is the user id). */
export const homeCalendar = (db: D1Database, userId: string) =>
  db.prepare("SELECT * FROM calendars WHERE app_id = ? AND external_user_id = ?").bind(HOSTED_APP, userId).first<CalendarRow>();

/** A White-label client's calendar: hosted, and not the account's own. Host-app and standalone calendars never are. */
export const isClient = (cal: Pick<CalendarRow, "external_user_id" | "account_user_id">) =>
  cal.account_user_id !== null && cal.external_user_id !== cal.account_user_id;

export const userEmail = async (db: D1Database, userId: string) =>
  (await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>())?.email ?? null;
