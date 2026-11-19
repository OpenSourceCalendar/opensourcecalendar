// Hosted sign-up and log-in (invite-only). Everything here 404s unless signupOn(env).
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { hostedSession } from "../auth";
import { forgetAttempt, INVITE_TOKEN_LIMITS, ipKey, startAttempt } from "../accounts/attempts";
import { weakPassword } from "../accounts/breach";
import { acceptInvite, clientBrand, openInvite } from "../accounts/client-users";
import { publicBase, signupOn } from "../accounts/config";
import { passwordSetEmail, signInEmail } from "../accounts/email";
import { DUMMY_HASH, hashPassword, needsRehash, passwordProblem, passwordsOn, verifyPassword } from "../accounts/password";
import { readIdToken, signSignInState, verifySignInState } from "../accounts/signin-state";
import { createUserWithInvite, inviteOpen, linkAllowed, lookUp, normalizeEmail, saveLink, touchLogin, useLink, type Found } from "../accounts/store";
import { emailFrom } from "../email/send";
import { exchangeCode, googleConfig, signInUrl } from "../google/client";
import { parseBody } from "../lib/http";
import { randomToken, sha256Hex } from "../lib/ids";
import { verifyTurnstile } from "../lib/turnstile";
import type { AppEnv, Bindings } from "../types";

export const accounts = new Hono<AppEnv>();
accounts.use("*", async (c, next) => (signupOn(c.env) ? next() : c.notFound()));

const canEmail = (env: Bindings) => !!emailFrom(env) && !!env.EMAIL;

accounts.get("/config", (c) =>
  c.json({ google: !!googleConfig(c.env), email: canEmail(c.env), turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null, public_url: publicBase(c.env) }));

accounts.get("/invite/:token", async (c) =>
  c.json({ valid: await inviteOpen(c.env.DB, await sha256Hex(c.req.param("token")), Date.now()) }));

/** Turnstile when this install has it (production); true otherwise. */
async function humanCheck(c: Context<AppEnv>, token: string | undefined, action: string): Promise<boolean> {
  if (!c.env.TURNSTILE_SECRET) return true;
  const hosts = [...new Set([new URL(publicBase(c.env)).hostname, new URL(c.req.url).hostname])];
  return verifyTurnstile(c.env.TURNSTILE_SECRET, token ?? "", c.req.header("CF-Connecting-IP") ?? null, { action, hostnames: hosts });
}

const LinkInput = z.object({
  email: z.email().max(254),
  invite: z.string().max(200).optional(),
  turnstile_token: z.string().max(2048).optional(),
});

/** Always 202 for a request that passes Turnstile; the work happens after the answer, so timing reveals nothing. */
accounts.post("/email-link", async (c) => {
  const body = await parseBody(c, LinkInput);
  if (!body.ok) return body.response;
  const ip = c.req.header("CF-Connecting-IP") ?? null;
  if (!(await humanCheck(c, body.data.turnstile_token, "login"))) return c.json({ error: "turnstile_failed" }, 400);
  const work = sendLink(c.env, normalizeEmail(body.data.email), body.data.invite ?? null, ip ?? "", Date.now())
    .catch((err) => console.error(JSON.stringify({ event: "login_link_failed", error: String(err).slice(0, 200) })));
  c.executionCtx.waitUntil(work);
  return c.json({ sent: true }, 202);
});

async function sendLink(env: Bindings, email: string, invite: string | null, ip: string, now: number) {
  const from = emailFrom(env);
  if (!from || !env.EMAIL) return;
  const db = env.DB;
  let inviteHash: string | null = null;
  if (!(await lookUp(db, email))) {
    if (!invite) return;
    inviteHash = await sha256Hex(invite);
    if (!(await inviteOpen(db, inviteHash, now))) return;
  }
  if (!(await linkAllowed(db, email, await sha256Hex(`ip:${ip}`), now))) return;
  const token = await saveLink(db, email, inviteHash, await sha256Hex(`ip:${ip}`), now);
  await env.EMAIL.send(signInEmail(from, email, `${publicBase(env)}/login/verify#t=${token}`, !!inviteHash));
}

accounts.post("/email-link/verify", async (c) => {
  const body = await parseBody(c, z.object({ token: z.string().min(1).max(200) }));
  if (!body.ok) return body.response;
  const db = c.env.DB;
  const now = Date.now();
  const link = await useLink(db, body.data.token, now);
  if (!link) return c.json({ error: "link_expired" }, 400);
  let found: Found | { inviteUsed: true } = await lookUp(db, link.email);
  if (!found && link.inviteHash) found = await createUserWithInvite(db, link.email, undefined, link.inviteHash, now);
  if (!found) return c.json({ error: "link_expired" }, 400); // a log-in link for an account deleted since
  if (!("user" in found)) return c.json({ error: "invite_used" }, 400);
  await touchLogin(db, found.user.id, now);
  return c.json({ ...(await hostedSession(c.env, found.user.id, now)), email: found.user.email });
});

/** Password routes take small bodies only, so a huge "password" can't burn CPU. */
export const smallBody = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) });

const PasswordLogin = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
  turnstile_token: z.string().max(2048).optional(),
});

accounts.post("/password-login", smallBody, async (c) => {
  if (!passwordsOn(c.env)) return c.notFound();
  const body = await parseBody(c, PasswordLogin);
  if (!body.ok) return body.response;
  if (!(await humanCheck(c, body.data.turnstile_token, "login"))) return c.json({ error: "turnstile_failed" }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const email = normalizeEmail(body.data.email);
  const ipk = await ipKey(c.env, c.req.header("CF-Connecting-IP"));
  // Limits first: a paused email or network costs no hashing. Unknown emails count the same, so nothing is revealed.
  const attempt = await startAttempt(db, email, ipk, now);
  if (!attempt.allowed) return c.json({ error: "too_many_tries" }, 429);
  const user = await db.prepare("SELECT id, password_hash, client_calendar_id FROM users WHERE email = ?")
    .bind(email).first<{ id: string; password_hash: string | null; client_calendar_id: string | null }>();
  // No account, or no password: check against a dummy so the answer takes the same time.
  const ok = await verifyPassword(c.env, body.data.password, user?.password_hash ?? DUMMY_HASH);
  if (!ok || !user?.password_hash) {
    console.log(JSON.stringify({ event: "password_login_failed", user: user?.id ?? null, reason: !user ? "unknown" : user.password_hash ? "wrong" : "no_password", ip: ipk.slice(0, 12) }));
    return c.json({ error: "wrong_password" }, 401);
  }
  await forgetAttempt(db, attempt.id);
  if (needsRehash(user.password_hash)) {
    await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(c.env, body.data.password), user.id).run();
  }
  await touchLogin(db, user.id, now);
  const slug = user.client_calendar_id
    ? ((await db.prepare("SELECT slug FROM calendars WHERE id = ?").bind(user.client_calendar_id).first<{ slug: string }>())?.slug ?? null)
    : null;
  return c.json({ ...(await hostedSession(c.env, user.id, now)), client_slug: slug });
});

/**
 * Bad invite tokens: their own keys ("#invite:" email, "invite:" network) and their own limit, so they never count
 * toward any email's 5 or the network's 30 sign-in tries, and a few bad links can't block someone's sign-in.
 */
async function inviteTry(c: Context<AppEnv>, now: number) {
  const ipk = await ipKey(c.env, c.req.header("CF-Connecting-IP"));
  return startAttempt(c.env.DB, `#invite:${ipk}`, `invite:${ipk}`, now, INVITE_TOKEN_LIMITS);
}

const InviteToken = z.object({ token: z.string().min(1).max(200) });

accounts.post("/client-invite/check", smallBody, async (c) => {
  if (!passwordsOn(c.env)) return c.notFound();
  const body = await parseBody(c, InviteToken);
  if (!body.ok) return body.response;
  const now = Date.now();
  const attempt = await inviteTry(c, now);
  if (!attempt.allowed) return c.json({ error: "too_many_tries" }, 429);
  const inv = await openInvite(c.env.DB, body.data.token, now);
  const brand = inv && (await clientBrand(c.env.DB, inv.client_calendar_id));
  // One answer for expired, used, revoked, moved to another email and never existed.
  if (!inv || !brand) return c.json({ valid: false });
  await forgetAttempt(c.env.DB, attempt.id);
  return c.json({ valid: true, email: inv.email, ...brand });
});

accounts.post("/client-invite/accept", smallBody, async (c) => {
  if (!passwordsOn(c.env)) return c.notFound();
  const body = await parseBody(c, InviteToken.extend({ password: z.string().max(1024) }));
  if (!body.ok) return body.response;
  const problem = passwordProblem(body.data.password);
  if (problem) return c.json({ error: `password_${problem}` }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const attempt = await inviteTry(c, now);
  if (!attempt.allowed) return c.json({ error: "too_many_tries" }, 429);
  const inv = await openInvite(db, body.data.token, now);
  const brand = inv && (await clientBrand(db, inv.client_calendar_id));
  if (!inv || !brand) return c.json({ error: "invite_invalid" }, 400);
  await forgetAttempt(db, attempt.id);
  // Checked before the invite is used, so a refused password doesn't burn the link.
  if (await weakPassword(body.data.password, [inv.email, brand.name])) return c.json({ error: "password_weak" }, 400);
  // Also stops this sign-in's other open invites and emailed sign-in links (same batch).
  const version = await acceptInvite(db, body.data.token, inv, await hashPassword(c.env, body.data.password), now);
  if (version === null) return c.json({ error: "invite_invalid" }, 400);
  const from = emailFrom(c.env);
  if (from && c.env.EMAIL) {
    c.executionCtx.waitUntil(c.env.EMAIL.send(passwordSetEmail(from, inv.email, false, brand.name))
      .catch((err) => console.error(JSON.stringify({ event: "password_email_failed", error: String(err).slice(0, 200) }))));
  }
  // First-time set-up: signed straight in (the spec's deliberate exception to "no sign-in after a reset").
  return c.json({ ...(await hostedSession(c.env, inv.user_id, now, now, version)), client_slug: brand.slug });
});

const COOKIE = "osc_signin";
const COOKIE_ATTRS = "Path=/api/account/google; HttpOnly; Secure; SameSite=Lax";
const callbackUrl = (env: Bindings) => `${publicBase(env)}/api/account/google/callback`;
function secret(env: Bindings): string {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  return env.SESSION_SECRET;
}

accounts.get("/google/start", async (c) => {
  const cfg = googleConfig(c.env);
  if (!cfg) return c.notFound();
  const here = new URL(c.req.url);
  const home = new URL(publicBase(c.env));
  // The cookie must be set on the host Google sends the browser back to.
  if (here.host !== home.host) return c.redirect(`${home.origin}${here.pathname}${here.search}`, 302);
  const invite = c.req.query("invite");
  const nonce = randomToken();
  const state = await signSignInState(secret(c.env), nonce, invite ? await sha256Hex(invite) : null, Date.now());
  c.header("Set-Cookie", `${COOKIE}=${nonce}; Max-Age=900; ${COOKIE_ATTRS}`);
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  return c.redirect(signInUrl(cfg, callbackUrl(c.env), state), 302);
});

accounts.get("/google/callback", async (c) => {
  const cfg = googleConfig(c.env);
  if (!cfg) return c.notFound();
  c.header("Set-Cookie", `${COOKIE}=; Max-Age=0; ${COOKIE_ATTRS}`);
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  const fail = (error: string) => c.redirect(`${publicBase(c.env)}/login?error=${error}`, 302);
  const now = Date.now();
  const state = await verifySignInState(secret(c.env), c.req.query("state") ?? "", now);
  const cookie = getCookie(c, COOKIE);
  if (!state || !cookie || cookie !== state.nonce) return fail("expired");
  const code = c.req.query("code");
  if (!code) return fail("cancelled");
  let who: { sub: string; email: string } | null = null;
  try {
    who = readIdToken((await exchangeCode(cfg, code, callbackUrl(c.env))).id_token);
  } catch {
    return fail("google");
  }
  if (!who) return fail("google");
  const db = c.env.DB;
  let found: Found | { inviteUsed: true } = await lookUp(db, who.email, who.sub);
  if (!found && state.inviteHash) found = await createUserWithInvite(db, who.email, who.sub, state.inviteHash, now);
  if (!found) return fail("no_account");
  if ("clientOnly" in found) return fail("client_account");
  if ("mismatch" in found) return fail("google_mismatch");
  if ("inviteUsed" in found) return fail("invite_used");
  await touchLogin(db, found.user.id, now);
  const { token } = await hostedSession(c.env, found.user.id, now);
  return c.redirect(`${publicBase(c.env)}/admin#login=${token}`, 302);
});
