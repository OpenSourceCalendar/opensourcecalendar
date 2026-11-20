import type { Bindings } from "../types";

/**
 * Hosted sign-up is on with SIGNUP = "invite" (new accounts need an invite link) or "open" (anyone may create one),
 * and a PUBLIC_URL: every account link is built from it.
 */
export const signupOn = (env: Bindings) => (env.SIGNUP === "invite" || env.SIGNUP === "open") && !!env.PUBLIC_URL;

/** Anyone may create an account (Google or emailed link), no invite needed. */
export const signupOpen = (env: Bindings) => env.SIGNUP === "open" && signupOn(env);

/** PUBLIC_URL without a trailing slash. Only call when signupOn(env). */
export const publicBase = (env: Bindings) => env.PUBLIC_URL!.replace(/\/+$/, "");
