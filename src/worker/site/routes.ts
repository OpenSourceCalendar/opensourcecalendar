import { Hono } from "hono";
import { z } from "zod";
import { homePage, type WaitlistState } from "./home";
import { privacyPage } from "./privacy";
import { termsPage } from "./terms";
import { publicBase, signupOn, signupOpen } from "../accounts/config";
import { billingOn } from "../billing/config";
import type { AppEnv } from "../types";

/** Enough for any real launch list; stops a script filling the table. */
export const WAITLIST_MAX = 5000;

const WaitEmail = z.email().max(254);

export const site = new Hono<AppEnv>();

const SITE_ORIGIN = "https://opensourcecalendar.com";
const on = (env: AppEnv["Bindings"]) => env.MARKETING_SITE === "on";
/** The header's Log in link, only while hosted sign-up is on. */
const loginUrl = (env: AppEnv["Bindings"]) => (signupOn(env) ? `${publicBase(env)}/login` : undefined);
/** The sign-up page, only while anyone may sign up (SIGNUP = "open"); otherwise the pages show the waitlist. */
const signupUrl = (env: AppEnv["Bindings"]) => (signupOpen(env) ? `${publicBase(env)}/signup` : undefined);

/** Front page of a self-hosted copy: no branding of ours, kept out of search. */
const PLAIN_HOME = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Online booking</title>
<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:32em;background:#fff;border:1px solid #e2e8f0;border-radius:20px;padding:28px}h1{margin:0 0 8px;font-size:24px}p{margin:0;color:#475569;line-height:1.6}</style>
</head>
<body><main><h1>Online booking</h1><p>To book an appointment, use the link the business gave you. It looks like <strong>/book/business-name</strong>.</p></main></body>
</html>`;

function html(body: string) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

site.get("/", (c) => {
  if (!on(c.env)) return html(PLAIN_HOME);
  const w = c.req.query("waitlist");
  const state: WaitlistState = w === "joined" || w === "bad" ? w : null;
  const res = html(homePage(state, loginUrl(c.env), signupUrl(c.env), billingOn(c.env)));
  if (state) res.headers.set("cache-control", "no-store");
  return res;
});
site.get("/privacy", (c) => (on(c.env) ? html(privacyPage(loginUrl(c.env), signupUrl(c.env))) : c.notFound()));
site.get("/terms", (c) => (on(c.env) ? html(termsPage(loginUrl(c.env), signupUrl(c.env))) : c.notFound()));

site.get("/robots.txt", (c) => {
  const lines = ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /admin", "Disallow: /m/"];
  if (on(c.env)) lines.push("", `Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  return c.text(lines.join("\n") + "\n", 200, { "cache-control": "public, max-age=3600" });
});
site.get("/sitemap.xml", (c) => {
  if (!on(c.env)) return c.notFound();
  const urls = ["/", "/privacy", "/terms"].map((p) => `  <url><loc>${SITE_ORIGIN}${p}</loc></url>`).join("\n");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, 200, {
    "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600",
  });
});

/** The home page's waitlist form: a plain form post, so it works without JavaScript. Stores the email only. */
site.post("/api/waitlist", async (c) => {
  if (!on(c.env)) return c.notFound();
  const back = (state: WaitlistState) => c.redirect(`/?waitlist=${state}#waitlist`, 303);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  // Bots fill every field; people never see this one. Look like it worked.
  if (typeof form.website === "string" && form.website !== "") return back("joined");
  const parsed = WaitEmail.safeParse(typeof form.email === "string" ? form.email.trim().toLowerCase() : "");
  if (!parsed.success) return back("bad");
  const db = c.env.DB;
  const count = await db.prepare("SELECT COUNT(*) AS n FROM waitlist").first<{ n: number }>();
  if ((count?.n ?? 0) < WAITLIST_MAX) {
    await db.prepare("INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)").bind(parsed.data, Date.now()).run();
  } else {
    console.error(JSON.stringify({ event: "waitlist_full" }));
  }
  return back("joined");
});
