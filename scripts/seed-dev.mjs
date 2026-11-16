// Create a demo calendar on the local dev server.
//   1. cp .dev.vars.example .dev.vars
//   2. npx wrangler d1 migrations apply booking-calendar --local
//   3. npm run dev          (in one terminal)
//   4. npm run seed         (in another; BASE defaults to http://localhost:5173)
// Staging: BASE=https://booking-calendar-staging.<account>.workers.dev VARS_FILE=.dev.vars.staging npm run seed
import { appendFileSync, readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const SLUG = process.env.SLUG ?? "demo"; // a slug can only be seeded once; pass SLUG=demo2 to seed again
const VARS_URL = new URL(`../${process.env.VARS_FILE ?? ".dev.vars"}`, import.meta.url);
const vars = Object.fromEntries(
  readFileSync(VARS_URL, "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

async function api(path, { method = "GET", headers = {}, json } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...headers, ...(json !== undefined && { "Content-Type": "application/json" }) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const appRes = await api("/api/setup/apps", {
  method: "POST", headers: { Authorization: `Bearer ${vars.SETUP_TOKEN}` }, json: { name: "Demo App" },
});
if (appRes.status !== 201) throw new Error(`setup failed: ${appRes.status} ${JSON.stringify(appRes.body)}`);
const auth = { Authorization: `Bearer ${appRes.body.api_key}`, "X-Calendar-User": "demo-owner" };

const cal = await api("/api/v1/calendar", { method: "POST", headers: auth, json: { slug: SLUG, time_zone: "America/Los_Angeles" } });
if (cal.status !== 201) throw new Error(`calendar failed: ${cal.status} ${JSON.stringify(cal.body)}`);

const step = async (label, path, method, json) => {
  const r = await api(path, { method, headers: auth, json });
  if (r.status >= 300) throw new Error(`${label} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

await step("branding and rules", "/api/v1/calendar", "PATCH", {
  branding: { business_name: "Demo Plumbing", phone: "(503) 555-0100", tagline: "Fast, friendly plumbing", color: "#1d4ed8" },
  rules: { min_notice_min: 60 },
});
const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday, open: weekday >= 1 && weekday <= 6, start_min: 540, end_min: 1020,
  breaks: weekday >= 1 && weekday <= 6 ? [{ start_min: 720, end_min: 780 }] : [],
}));
await step("weekly hours", "/api/v1/availability/weekly", "PUT", { days });
await step("service 1", "/api/v1/services", "POST", { name: "Free estimate", duration_min: 30, price_cents: 0 });
await step("service 2", "/api/v1/services", "POST", { name: "Drain cleaning", duration_min: 60, price_cents: 14900 });

// Keep the app key (the server only stores its hash) so owner sign-in links can be made later.
appendFileSync(VARS_URL, `\nDEMO_API_KEY=${appRes.body.api_key}\n`);
console.log(`Open ${BASE}/book/${SLUG}. The app key was saved as DEMO_API_KEY in the vars file.`);
