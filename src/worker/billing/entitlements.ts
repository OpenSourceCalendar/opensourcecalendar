// The one place that says what a calendar may do. Footer, customer reminders, Google sync, the Free email limit and
// a paused client's booking page all ask this and nothing else.
import { HOSTED_APP } from "../auth";
import type { Bindings, CalendarRow } from "../types";
import { billingOn, type Plan } from "./config";
import { getBilling, isClient, type BillingRow } from "./store";

export const FREE_MONTHLY_EMAIL_BOOKINGS = 10;
/** past_due keeps access while Stripe retries the card; the cancellation after the last retry ends it. */
export const LIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

export type Entitlements = {
  /** null = billing doesn't apply to this calendar. */
  plan: Plan | null;
  limited: boolean;
  reminders: boolean;
  /** Bookings are copied to Google Calendar. */
  googlePush: boolean;
  /** Google busy times are synced in and checked before a booking; connecting Google is allowed. */
  googleBusy: boolean;
  footerForced: boolean;
  /** No "Powered by" footer whatever the setting says (White-label, or a paused client). Wins over footerForced. */
  footerHidden: boolean;
  /** The account is on White-label: paid (a trial counts) or inside its grace month. */
  whiteLabel: boolean;
  /** A client calendar of an account that isn't on White-label: no new booking-page bookings. */
  paused: boolean;
  monthlyEmailBookings: number | null;
};

const ALL: Entitlements = {
  plan: null, limited: false, reminders: true, googlePush: true, googleBusy: true, footerForced: false, footerHidden: false,
  whiteLabel: false, paused: false, monthlyEmailBookings: null,
};
const FREE: Entitlements = {
  plan: "free", limited: true, reminders: false, googlePush: false, googleBusy: false, footerForced: true, footerHidden: false,
  whiteLabel: false, paused: false, monthlyEmailBookings: FREE_MONTHLY_EMAIL_BOOKINGS,
};
// Everything for bookings already made keeps working (reminders, emails, their Google events). No busy sync: there are
// no new bookings to protect, and an unpaid account shouldn't get it forever. Never the Free monthly limit.
const PAUSED: Omit<Entitlements, "plan"> = {
  limited: false, reminders: true, googlePush: true, googleBusy: false, footerForced: false, footerHidden: true,
  whiteLabel: false, paused: true, monthlyEmailBookings: null,
};

export function isPaid(row: Pick<BillingRow, "plan" | "status" | "grace_until"> | null, now: number): boolean {
  if (!row) return false;
  return (row.plan !== "free" && LIVE_STATUSES.has(row.status)) || (row.grace_until ?? 0) > now;
}

/** White-label is on: paid White-label (a trial counts) or inside a grace month (after it ended or dropped to Pro). */
export function whiteLabelOn(row: Pick<BillingRow, "plan" | "status" | "grace_until"> | null, now: number): boolean {
  if (!row) return false;
  return (row.plan === "white_label" && LIVE_STATUSES.has(row.status)) || (row.grace_until ?? 0) > now;
}

/** May add clients: paid White-label, a trial included. A grace month keeps clients running but adds none. */
export const canAddClients = (row: Pick<BillingRow, "plan" | "status"> | null): boolean =>
  !!row && row.plan === "white_label" && LIVE_STATUSES.has(row.status);

/** Does billing apply to this calendar at all? Only hosted accounts, only with billing on. */
export const billed = (env: Bindings, cal: Pick<CalendarRow, "app_id">) => cal.app_id === HOSTED_APP && billingOn(env);

/** Entitlements of a billed calendar from its account's billing row (GET /clients reads the row once for many). */
export function entitlementsFrom(row: Pick<BillingRow, "plan" | "status" | "grace_until"> | null, home: boolean, now: number): Entitlements {
  const paid = isPaid(row, now);
  const plan: Plan = paid ? (row!.status === "canceled" ? "white_label" : row!.plan) : "free";
  const whiteLabel = whiteLabelOn(row, now);
  if (!home && !whiteLabel) return { ...PAUSED, plan };
  if (paid) return { ...ALL, plan, whiteLabel, footerHidden: whiteLabel };
  return FREE;
}

export async function entitlements(env: Bindings, cal: Pick<CalendarRow, "app_id" | "external_user_id" | "account_user_id">, now = Date.now()): Promise<Entitlements> {
  if (!billed(env, cal)) return ALL;
  // Every hosted calendar has account_user_id (migration 0012 filled in the older ones).
  return entitlementsFrom(await getBilling(env.DB, cal.account_user_id!), !isClient(cal), now);
}

export async function entitlementsFor(env: Bindings, calendarId: string, now = Date.now()): Promise<Entitlements> {
  if (!billingOn(env)) return ALL;
  const cal = await env.DB.prepare("SELECT app_id, external_user_id, account_user_id FROM calendars WHERE id = ?").bind(calendarId)
    .first<Pick<CalendarRow, "app_id" | "external_user_id" | "account_user_id">>();
  return cal ? entitlements(env, cal, now) : ALL;
}
