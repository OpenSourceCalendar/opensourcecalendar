// Every SQL statement for the billing table and the account ↔ calendar link.
import { HOSTED_APP } from "../auth";
import type { CalendarRow } from "../types";
import type { Interval, Plan } from "./config";

export type BillingRow = {
  user_id: string; stripe_customer_id: string | null; stripe_subscription_id: string | null;
  plan: Plan; interval: Interval | null; status: string; current_period_end: number | null; cancel_at_period_end: number;
  trial_used: number; trial_end: number | null; grace_until: number | null; grace_subscription_id: string | null;
  grace_checkin_sent: number; grace_reminder_sent: number; checkout_attempts: string; updated_at: number;
};

export const getBilling = (db: D1Database, userId: string) =>
  db.prepare("SELECT * FROM billing WHERE user_id = ?").bind(userId).first<BillingRow>();

export const ensureBillingRow = (db: D1Database, userId: string, now: number) =>
  db.prepare("INSERT OR IGNORE INTO billing (user_id, updated_at) VALUES (?, ?)").bind(userId, now).run();

export const billingByCustomer = (db: D1Database, customerId: string) =>
  db.prepare("SELECT * FROM billing WHERE stripe_customer_id = ?").bind(customerId).first<BillingRow>();

/** The account's calendars (one today; White-label will have several). */
export async function accountCalendars(db: D1Database, userId: string): Promise<CalendarRow[]> {
  return (await db.prepare("SELECT * FROM calendars WHERE app_id = ? AND external_user_id = ? ORDER BY created_at")
    .bind(HOSTED_APP, userId).all<CalendarRow>()).results;
}

export const userEmail = async (db: D1Database, userId: string) =>
  (await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>())?.email ?? null;
