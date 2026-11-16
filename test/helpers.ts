import { env } from "cloudflare:workers";
import { app } from "../src/worker/index";
import type { Bindings } from "../src/worker/types";

export const testEnv = env as unknown as Bindings;

export type Who = { key: string; user: string };

let counter = 0;
/** Unique suffix so tests never collide, whether or not storage is shared between tests. */
export const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function call(path: string, init: RequestInit & { who?: Who; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.who) {
    headers.set("Authorization", `Bearer ${init.who.key}`);
    headers.set("X-Calendar-User", init.who.user);
  }
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.request(path, { ...init, headers, body }, testEnv);
}

export async function createApp(name = "Test App"): Promise<string> {
  const res = await call("/api/setup/apps", {
    method: "POST",
    headers: { Authorization: "Bearer test-setup-token" },
    json: { name },
  });
  if (res.status !== 201) throw new Error(`createApp failed: ${res.status}`);
  return ((await res.json()) as { api_key: string }).api_key;
}

/** A fresh app + user with a calendar (America/Los_Angeles). */
export async function newOwner(): Promise<Who & { slug: string }> {
  const key = await createApp();
  const user = `user-${uniq()}`;
  const slug = `cal-${uniq()}`;
  const res = await call("/api/v1/calendar", {
    method: "POST",
    who: { key, user },
    json: { slug, time_zone: "America/Los_Angeles" },
  });
  if (res.status !== 201) throw new Error(`newOwner failed: ${res.status} ${await res.text()}`);
  return { key, user, slug };
}

/** A calendar open 09:00-17:00 every day, no notice, 2 years ahead, with one 30-min service. */
export async function bookableOwner() {
  const owner = await newOwner();
  const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: true, start_min: 540, end_min: 1020, breaks: [] }));
  await call("/api/v1/availability/weekly", { method: "PUT", who: owner, json: { days } });
  await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { min_notice_min: 0, max_days_ahead: 730 } } });
  const service = (await (await call("/api/v1/services", { method: "POST", who: owner, json: { name: "Call", duration_min: 30 } })).json()) as { id: string };
  const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const slots = ((await (await call(`/api/v1/slots?service_id=${service.id}&date=${date}`, { who: owner })).json()) as { slots: string[] }).slots;
  return { owner, serviceId: service.id, date, slots };
}
