// Hosted sign-up and log-in (invite-only). Everything here 404s unless signupOn(env).
import { Hono } from "hono";
import { z } from "zod";
import { hostedSession } from "../auth";
import { publicBase, signupOn } from "../accounts/config";
import { signInEmail } from "../accounts/email";
import { createUserWithInvite, inviteOpen, linkAllowed, lookUp, normalizeEmail, saveLink, touchLogin, useLink, type Found } from "../accounts/store";
import { emailFrom } from "../email/send";
import { googleConfig } from "../google/client";
import { parseBody } from "../lib/http";
import { sha256Hex } from "../lib/ids";
import { verifyTurnstile } from "../lib/turnstile";
import type { AppEnv, Bindings } from "../types";

export const accounts = new Hono<AppEnv>();
accounts.use("*", async (c, next) => (signupOn(c.env) ? next() : c.notFound()));

const canEmail = (env: Bindings) => !!emailFrom(env) && !!env.EMAIL;

accounts.get("/config", (c) =>
  c.json({ google: !!googleConfig(c.env), email: canEmail(c.env), turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null, public_url: publicBase(c.env) }));

accounts.get("/invite/:token", async (c) =>
  c.json({ valid: await inviteOpen(c.env.DB, await sha256Hex(c.req.param("token")), Date.now()) }));

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
  if (c.env.TURNSTILE_SECRET) {
    const hosts = [...new Set([new URL(publicBase(c.env)).hostname, new URL(c.req.url).hostname])];
    const ok = await verifyTurnstile(c.env.TURNSTILE_SECRET, body.data.turnstile_token ?? "", ip, { action: "login", hostnames: hosts });
    if (!ok) return c.json({ error: "turnstile_failed" }, 400);
  }
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
