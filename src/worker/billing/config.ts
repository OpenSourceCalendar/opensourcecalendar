import { signupOn } from "../accounts/config";
import type { Bindings } from "../types";

export type Plan = "free" | "pro" | "white_label";
export type PaidPlan = Exclude<Plan, "free">;
export type Interval = "month" | "year";

const PRICE_VARS = {
  pro: { month: "STRIPE_PRICE_PRO_MONTH", year: "STRIPE_PRICE_PRO_YEAR" },
  white_label: { month: "STRIPE_PRICE_WL_MONTH", year: "STRIPE_PRICE_WL_YEAR" },
} as const;

/**
 * Billing is on only on our hosted service: hosted accounts on (signupOn is the one switch for that, so a future
 * public sign-up value only changes it there) and every Stripe setting present. Off = every calendar as before.
 */
export function billingOn(env: Bindings): boolean {
  if (!signupOn(env) || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return false;
  return Object.values(PRICE_VARS).every((p) => !!env[p.month] && !!env[p.year]);
}

/** The server's own price id for a plan; the browser only ever sends plan + interval. */
export const priceFor = (env: Bindings, plan: PaidPlan, interval: Interval): string => env[PRICE_VARS[plan][interval]]!;

export function planForPrice(env: Bindings, priceId: string): { plan: PaidPlan; interval: Interval } | null {
  for (const plan of ["pro", "white_label"] as const) {
    for (const interval of ["month", "year"] as const) if (env[PRICE_VARS[plan][interval]] === priceId) return { plan, interval };
  }
  return null;
}
