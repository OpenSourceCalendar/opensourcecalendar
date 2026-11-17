import type { Bindings } from "../types";

/** Hosted sign-up is on only with SIGNUP = "invite" and a PUBLIC_URL: every account link is built from it. */
export const signupOn = (env: Bindings) => env.SIGNUP === "invite" && !!env.PUBLIC_URL;

/** PUBLIC_URL without a trailing slash. Only call when signupOn(env). */
export const publicBase = (env: Bindings) => env.PUBLIC_URL!.replace(/\/+$/, "");
