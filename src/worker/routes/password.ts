// A signed-in person's own password, and "sign out of all devices". Hosted accounts only (agencies, ordinary
// accounts and White-label clients alike); 404 for host-app and standalone sessions.
import { Hono } from "hono";
import { z } from "zod";
import { HOSTED_APP, hostedSession } from "../auth";
import { forgetAttempt, ipKey, startAttempt } from "../accounts/attempts";
import { weakPassword } from "../accounts/breach";
import { clientBrand } from "../accounts/client-users";
import { passwordSetEmail } from "../accounts/email";
import { hashPassword, passwordProblem, passwordsOn, verifyPassword } from "../accounts/password";
import { revokeTokens } from "../accounts/store";
import { emailFrom } from "../email/send";
import { parseBody } from "../lib/http";
import { smallBody } from "./accounts";
import type { AppEnv } from "../types";

/** Signed in this recently = has just proved the inbox or the password, so no current password is needed. */
export const FRESH_SIGN_IN_MS = 15 * 60_000;

export const passwordRoutes = new Hono<AppEnv>();

const SetBody = z.object({ password: z.string().max(1024), current_password: z.string().max(1024).optional() });

passwordRoutes.post("/password", smallBody, async (c) => {
  if (c.var.app.id !== HOSTED_APP || !passwordsOn(c.env)) return c.json({ error: "not_found" }, 404);
  const body = await parseBody(c, SetBody);
  if (!body.ok) return body.response;
  const problem = passwordProblem(body.data.password);
  if (problem) return c.json({ error: `password_${problem}` }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const user = await db.prepare("SELECT id, email, password_hash, client_calendar_id FROM users WHERE id = ?")
    .bind(c.var.userId).first<{ id: string; email: string; password_hash: string | null; client_calendar_id: string | null }>();
  if (!user) return c.json({ error: "unauthorized" }, 401);

  // A stolen old session must not be able to add or change a password: either a recent sign-in (emailed link,
  // Google, password or invite), or the current password.
  if (now - c.var.sessionIssuedAt >= FRESH_SIGN_IN_MS) {
    if (!user.password_hash || !body.data.current_password) return c.json({ error: "reauth_required" }, 403);
    // Same limits as password sign-in, so an old session can't be used to guess the password without limit.
    const attempt = await startAttempt(db, user.email, await ipKey(c.env, c.req.header("CF-Connecting-IP")), now);
    if (!attempt.allowed) return c.json({ error: "too_many_tries" }, 429);
    if (!(await verifyPassword(c.env, body.data.current_password, user.password_hash))) return c.json({ error: "wrong_password" }, 403);
    await forgetAttempt(db, attempt.id);
  }

  const brand = user.client_calendar_id ? await clientBrand(db, user.client_calendar_id) : null;
  if (await weakPassword(body.data.password, [user.email, brand?.name])) return c.json({ error: "password_weak" }, 400);

  await db.prepare("UPDATE users SET password_hash = ?, password_set_at = ?, session_version = session_version + 1 WHERE id = ?")
    .bind(await hashPassword(c.env, body.data.password), now, user.id).run();
  await revokeTokens(db, user.id, user.email, now);
  const from = emailFrom(c.env);
  if (from && c.env.EMAIL) {
    const mail = passwordSetEmail(from, user.email, !!user.password_hash, user.client_calendar_id ? (brand?.name ?? "your booking calendar") : null);
    c.executionCtx.waitUntil(c.env.EMAIL.send(mail).catch((err) => console.error(JSON.stringify({ event: "password_email_failed", error: String(err).slice(0, 200) }))));
  }
  // This device stays signed in with a token of the new version; every other one is signed out. The new token keeps
  // this sign-in's issue time: changing a password is not a fresh sign-in.
  return c.json(await hostedSession(c.env, user.id, now, c.var.sessionIssuedAt));
});

passwordRoutes.post("/sign-out-everywhere", async (c) => {
  if (c.var.app.id !== HOSTED_APP) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  await c.env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").bind(c.var.userId).run();
  // Same sign-in, same issue time: otherwise a stolen old token could call this to look "recently signed in" and then
  // add a password without knowing the current one.
  return c.json(await hostedSession(c.env, c.var.userId, now, c.var.sessionIssuedAt));
});
