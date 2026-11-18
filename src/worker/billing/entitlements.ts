// The one place that says what a calendar may do. Footer, customer reminders, Google sync and the Free email
// limit all ask this and nothing else.
import { HOSTED_APP } from "../auth";
import type { Bindings, CalendarRow } from "../types";
import { billingOn, type Plan } from "./config";
import { getBilling, type BillingRow } from "./store";

export const FREE_MONTHLY_EMAIL_BOOKINGS = 10;
/** past_due keeps access while Stripe retries the card; the cancellation after the last retry ends it. */
export const LIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

export type Entitlements = {
  /** null = billing doesn't apply to this calendar. */
  plan: Plan | null;
  limited: boolean;
  reminders: boolean;
  google: boolean;
  footerForced: boolean;
  monthlyEmailBookings: number | null;
};

const ALL: Entitlements = { plan: null, limited: false, reminders: true, google: true, footerForced: false, monthlyEmailBookings: null };
const FREE: Entitlements = { plan: "free", limited: true, reminders: false, google: false, footerForced: true, monthlyEmailBookings: FREE_MONTHLY_EMAIL_BOOKINGS };

export function isPaid(row: Pick<BillingRow, "plan" | "status" | "grace_until"> | null, now: number): boolean {
  if (!row) return false;
  return (row.plan !== "free" && LIVE_STATUSES.has(row.status)) || (row.grace_until ?? 0) > now;
}

/** Does billing apply to this calendar at all? Only hosted accounts, only with billing on. */
export const billed = (env: Bindings, cal: Pick<CalendarRow, "app_id">) => cal.app_id === HOSTED_APP && billingOn(env);

export async function entitlements(env: Bindings, cal: Pick<CalendarRow, "app_id" | "account_user_id">, now = Date.now()): Promise<Entitlements> {
  if (!billed(env, cal)) return ALL;
  // Every hosted calendar has account_user_id (migration 0012 filled in the older ones).
  const row = await getBilling(env.DB, cal.account_user_id!);
  if (isPaid(row, now)) return { ...ALL, plan: row!.status === "canceled" ? "white_label" : row!.plan };
  return FREE;
}

export async function entitlementsFor(env: Bindings, calendarId: string, now = Date.now()): Promise<Entitlements> {
  if (!billingOn(env)) return ALL;
  const cal = await env.DB.prepare("SELECT app_id, account_user_id FROM calendars WHERE id = ?").bind(calendarId)
    .first<Pick<CalendarRow, "app_id" | "account_user_id">>();
  return cal ? entitlements(env, cal, now) : ALL;
}
