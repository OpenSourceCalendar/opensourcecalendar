// A host app's webhook settings: one address per app. Mounted on /api/v1 only (API key), never on the
// owner screens' /api/admin: the address and secret belong to the host app, not to a calendar owner.
import { Hono } from "hono";
import { z } from "zod";
import { newId } from "../lib/ids";
import { parseBody } from "../lib/http";
import type { AppEnv } from "../types";
import { buildEvent, sendEvent } from "../webhooks/outbox";
import { webhookSecret } from "../webhooks/secret";

export const webhook = new Hono<AppEnv>();

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Why this address isn't allowed, or null. */
function badUrl(raw: string, ownHosts: string[]): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "must be https";
  if (u.username || u.password) return "no user or password in the address";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  // Workers can't reach private networks through fetch anyway; this is extra caution.
  if (IPV4.test(host) || host.startsWith("[") || host === "localhost") return "use a domain name, not an IP address";
  if (ownHosts.includes(host) || host === "workers.dev" || host.endsWith(".workers.dev")) return "can't point at this calendar";
  return null;
}

const ownHosts = (reqUrl: string, publicUrl?: string) => {
  const hosts = [new URL(reqUrl).hostname.toLowerCase()];
  if (publicUrl) {
    try {
      hosts.push(new URL(publicUrl).hostname.toLowerCase());
    } catch {
      // not a URL; ignore
    }
  }
  return hosts;
};

const appRow = (db: D1Database, appId: string) =>
  db.prepare("SELECT webhook_url, webhook_secret_version FROM apps WHERE id = ?").bind(appId).first<{ webhook_url: string | null; webhook_secret_version: number }>();

webhook.get("/", async (c) => {
  const row = await appRow(c.env.DB, c.var.app.id);
  return c.json({ url: row?.webhook_url ?? null });
});

webhook.put("/", async (c) => {
  const body = await parseBody(c, z.object({ url: z.string().max(2000) }));
  if (!body.ok) return body.response;
  const problem = badUrl(body.data.url, ownHosts(c.req.url, c.env.PUBLIC_URL));
  if (problem) return c.json({ error: "invalid_input", message: problem }, 400);
  const url = new URL(body.data.url).href;
  // Setting an address after none (e.g. after DELETE) starts a fresh secret.
  const row = await c.env.DB.prepare(
    "UPDATE apps SET webhook_secret_version = webhook_secret_version + (webhook_url IS NULL), webhook_url = ? WHERE id = ? RETURNING webhook_secret_version",
  )
    .bind(url, c.var.app.id).first<{ webhook_secret_version: number }>();
  // The secret is only ever shown here and on rotate-secret.
  return c.json({ url, secret: await webhookSecret(c.env, c.var.app.id, row!.webhook_secret_version) });
});

webhook.delete("/", async (c) => {
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE apps SET webhook_url = NULL WHERE id = ?").bind(c.var.app.id),
    db.prepare(
      "UPDATE jobs SET done_at = ?, result = 'skipped:no_webhook' WHERE kind = 'webhook.deliver' AND done_at IS NULL AND calendar_id IN (SELECT id FROM calendars WHERE app_id = ?)",
    ).bind(Date.now(), c.var.app.id),
  ]);
  return c.body(null, 204);
});

webhook.post("/rotate-secret", async (c) => {
  const row = await c.env.DB.prepare(
    "UPDATE apps SET webhook_secret_version = webhook_secret_version + 1 WHERE id = ? AND webhook_url IS NOT NULL RETURNING webhook_secret_version",
  ).bind(c.var.app.id).first<{ webhook_secret_version: number }>();
  if (!row) return c.json({ error: "no_webhook" }, 409);
  return c.json({ secret: await webhookSecret(c.env, c.var.app.id, row.webhook_secret_version) });
});

/** Send a `ping` now and say how it went. Logged as an already-finished job, so no runner retries it. */
webhook.post("/test", async (c) => {
  const db = c.env.DB;
  const row = await appRow(db, c.var.app.id);
  if (!row?.webhook_url) return c.json({ error: "no_webhook" }, 409);
  const cal = await db.prepare("SELECT id FROM calendars WHERE app_id = ? ORDER BY created_at LIMIT 1").bind(c.var.app.id).first<{ id: string }>();
  if (!cal) return c.json({ error: "no_calendar" }, 409);
  const now = Date.now();
  const id = newId("evt");
  const payload = { type: "ping" as const, at: now };
  const built = await buildEvent(db, id, cal.id, payload);
  if ("skip" in built) return c.json({ error: "no_webhook" }, 409);
  const status = await sendEvent(c.env, built);
  const delivered = status >= 200 && status < 300;
  await db.prepare("INSERT INTO jobs (id, calendar_id, kind, payload, run_at, attempts, done_at, result) VALUES (?, ?, 'webhook.deliver', ?, ?, 1, ?, ?)")
    .bind(id, cal.id, JSON.stringify(payload), now, now, delivered ? "done" : `failed:${status || "network"}`).run();
  return c.json({ delivered, status });
});

/** The last 50 events for this app's calendars. No bodies. */
webhook.get("/deliveries", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT j.id, json_extract(j.payload, '$.type') AS type, json_extract(j.payload, '$.at') AS at, j.run_at, j.attempts, j.result, j.done_at
     FROM jobs j JOIN calendars c ON c.id = j.calendar_id
     WHERE c.app_id = ? AND j.kind = 'webhook.deliver' ORDER BY j.rowid DESC LIMIT 50`,
  ).bind(c.var.app.id).all<{ id: string; type: string; at: number; run_at: number; attempts: number; result: string | null; done_at: number | null }>();
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return c.json({
    deliveries: results.map((r) => ({
      id: r.id, type: r.type, created_at: iso(r.at), attempts: r.attempts, result: r.result,
      done_at: iso(r.done_at), next_try_at: r.done_at === null ? iso(r.run_at) : null,
    })),
  });
});
