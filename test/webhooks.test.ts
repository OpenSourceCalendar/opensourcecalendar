import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDueJobs } from "../src/worker/email/outbox";
import { runWebhookJobs } from "../src/worker/webhooks/outbox";
import { signBody, webhookSecret } from "../src/worker/webhooks/secret";
import { bookableOwner, call, newOwner, testEnv, type Who } from "./helpers";

const db = () => testEnv.DB;
const HOOK = "https://hooks.example.com/cal";

type Received = { url: string; headers: Headers; body: string };
let received: Received[];
let answer: number | "network";
beforeEach(() => {
  received = [];
  answer = 200;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    received.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
    if (answer === "network") throw new TypeError("down");
    return new Response("ok", { status: answer });
  });
});
afterEach(() => vi.restoreAllMocks());

const appIdOf = async (slug: string) =>
  (await db().prepare("SELECT app_id FROM calendars WHERE slug = ?").bind(slug).first<{ app_id: string }>())!.app_id;
const calIdOf = async (slug: string) => (await db().prepare("SELECT id FROM calendars WHERE slug = ?").bind(slug).first<{ id: string }>())!.id;
const setHook = (who: Who, url = HOOK) => call("/api/v1/webhook", { method: "PUT", who, json: { url } });
type Job = { id: string; payload: string; attempts: number; run_at: number; done_at: number | null; result: string | null };
const hookJobs = async (calId: string) =>
  (await db().prepare("SELECT id, payload, attempts, run_at, done_at, result FROM jobs WHERE calendar_id = ? AND kind = 'webhook.deliver' ORDER BY rowid").bind(calId).all<Job>()).results;
const types = async (calId: string) => (await hookJobs(calId)).map((j) => JSON.parse(j.payload).type as string);

/** Run webhook jobs until this calendar has none due. */
async function drain(calId: string) {
  for (let i = 0; i < 10; i++) {
    if (!(await hookJobs(calId)).some((j) => j.done_at === null && j.run_at <= Date.now())) return;
    await runWebhookJobs(testEnv, Date.now());
  }
}
const mine = async (calId: string) => {
  const ids = new Set((await hookJobs(calId)).map((j) => j.id));
  return received.filter((r) => ids.has(JSON.parse(r.body).id));
};

let phone = 5035550500;
async function bookPublic(slug: string, serviceId: string, start: string, p = String(phone++)) {
  const res = await call(`/api/public/${slug}/book`, { method: "POST", json: { service_id: serviceId, start, first_name: "Wes", phone: p } });
  expect(res.status).toBe(201);
  return (await res.json()) as { appointment: { id: string }; manage_token: string };
}

describe("signing", () => {
  it("derives a stable secret per app and version", async () => {
    const a1 = await webhookSecret(testEnv, "app_a", 1);
    expect(a1).toMatch(/^whsec_/);
    expect(await webhookSecret(testEnv, "app_a", 1)).toBe(a1);
    expect(await webhookSecret(testEnv, "app_b", 1)).not.toBe(a1);
    expect(await webhookSecret(testEnv, "app_a", 2)).not.toBe(a1);
  });
  it("signs <t>.<body> with HMAC-SHA256, keyed by the whole whsec_ string", async () => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_x"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const raw = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode('1700000000.{"a":1}')));
    const hex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await signBody("whsec_x", 1700000000, '{"a":1}')).toBe(hex);
  });
});

describe("webhook settings", () => {
  it("sets an address and shows the secret only when set or rotated", async () => {
    const o = await newOwner();
    expect(await (await call("/api/v1/webhook", { who: o })).json()).toEqual({ url: null });
    const put = (await (await setHook(o)).json()) as { url: string; secret: string };
    expect(put).toEqual({ url: HOOK, secret: await webhookSecret(testEnv, await appIdOf(o.slug), 2) }); // every set-after-none starts a fresh version
    expect(await (await call("/api/v1/webhook", { who: o })).json()).toEqual({ url: HOOK });
    const rot = (await (await call("/api/v1/webhook/rotate-secret", { method: "POST", who: o })).json()) as { secret: string };
    expect(rot.secret).toBe(await webhookSecret(testEnv, await appIdOf(o.slug), 3));
    // Removing and setting again starts a fresh secret; changing the address keeps it.
    const same = (await (await setHook(o, "https://other.example.com/x")).json()) as { secret: string };
    expect(same.secret).toBe(rot.secret);
    await call("/api/v1/webhook", { method: "DELETE", who: o });
    const fresh = (await (await setHook(o)).json()) as { secret: string };
    expect(fresh.secret).toBe(await webhookSecret(testEnv, await appIdOf(o.slug), 4));
  });

  it("refuses unsafe addresses", async () => {
    const o = await newOwner();
    for (const url of ["http://hooks.example.com/x", "https://1.2.3.4/x", "https://[::1]/x", "https://localhost/x", "https://u:p@hooks.example.com/x", "not a url", `https://hooks.example.com/${"x".repeat(2000)}`,
      "https://localhost./x", "https://other.example.workers.dev/x"]) {
      expect((await setHook(o, url)).status, url).toBe(400);
    }
  });

  it("the owner screens can't reach webhook settings", async () => {
    const o = await newOwner();
    const { token } = (await (await call("/api/v1/admin-sessions", { method: "POST", who: o })).json()) as { token: string };
    const res = await call("/api/admin/webhook", { headers: { Authorization: `Session ${token}` } });
    expect(res.status).toBe(404);
  });

  it("a ping says how it went, and is logged", async () => {
    const o = await newOwner();
    expect((await call("/api/v1/webhook/test", { method: "POST", who: o })).status).toBe(409);
    await setHook(o);
    expect(await (await call("/api/v1/webhook/test", { method: "POST", who: o })).json()).toEqual({ delivered: true, status: 200 });
    answer = 500;
    expect(await (await call("/api/v1/webhook/test", { method: "POST", who: o })).json()).toEqual({ delivered: false, status: 500 });
    const log = (await (await call("/api/v1/webhook/deliveries", { who: o })).json()) as { deliveries: { type: string; result: string; next_try_at: string | null; created_at: string }[] };
    expect(log.deliveries.map((d) => [d.type, d.result, d.next_try_at])).toEqual([["ping", "failed:500", null], ["ping", "done", null]]);
    expect(Date.parse(log.deliveries[0].created_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("removing the address stops pending events; apps can't see each other's", async () => {
    const a = await bookableOwner();
    const b = await newOwner();
    await setHook(a.owner);
    await bookPublic(a.owner.slug, a.serviceId, a.slots[0]);
    expect((await (await call("/api/v1/webhook/deliveries", { who: b })).json())).toEqual({ deliveries: [] });
    expect(await (await call("/api/v1/webhook", { who: b })).json()).toEqual({ url: null });
    expect((await call("/api/v1/webhook", { method: "DELETE", who: a.owner })).status).toBe(204);
    const calId = await calIdOf(a.owner.slug);
    expect((await hookJobs(calId)).every((j) => j.result === "skipped:no_webhook")).toBe(true);
  });
});

describe("delivery", () => {
  it("queues nothing without an address", async () => {
    const s = await bookableOwner();
    await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    expect(await hookJobs(await calIdOf(s.owner.slug))).toEqual([]);
  });

  it("a booking sends booking.created (and customer.created for a new customer), signed", async () => {
    const s = await bookableOwner();
    const calId = await calIdOf(s.owner.slug);
    const { secret } = (await (await setHook(s.owner)).json()) as { secret: string };
    const { appointment } = await bookPublic(s.owner.slug, s.serviceId, s.slots[0], "5035559000");
    await bookPublic(s.owner.slug, s.serviceId, s.slots[2], "5035559000"); // same person: no second customer.created
    expect((await types(calId)).sort()).toEqual(["booking.created", "booking.created", "customer.created"]);
    await drain(calId);
    const got = await mine(calId);
    expect(got).toHaveLength(3);
    const first = got.find((r) => JSON.parse(r.body).data.appointment?.id === appointment.id)!;
    expect(first.url).toBe(HOOK);
    expect(first.headers.get("Content-Type")).toBe("application/json");
    expect(first.headers.get("User-Agent")).toBe("BookingCalendar-Webhook/1");
    const [, t, v1] = first.headers.get("X-Calendar-Signature")!.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    expect(await signBody(secret, Number(t), first.body)).toBe(v1);
    const body = JSON.parse(first.body);
    expect(body.type).toBe("booking.created");
    expect(body.id).toMatch(/^evt_/);
    expect(body.calendar.slug).toBe(s.owner.slug);
    expect((await hookJobs(calId)).every((j) => j.result === "done")).toBe(true);
  });

  it("every booking change sends the right event", async () => {
    const s = await bookableOwner();
    const calId = await calIdOf(s.owner.slug);
    await setHook(s.owner);
    const own = ((await (await call("/api/v1/appointments", { method: "POST", who: s.owner, json: { service_id: s.serviceId, start: s.slots[0], customer: { first_name: "Ow", phone: "5035559100" } } })).json()) as { appointment: { id: string } }).appointment;
    const patch = (json: unknown) => call(`/api/v1/appointments/${own.id}`, { method: "PATCH", who: s.owner, json });
    await patch({ start: s.slots[2] });
    await call(`/api/v1/appointments/${own.id}/cancel`, { method: "POST", who: s.owner, json: {} });
    await patch({ status: "booked" });
    const pub = await bookPublic(s.owner.slug, s.serviceId, s.slots[6]);
    const m = (path: string, json: unknown = {}) => call(`/api/public/manage/${pub.manage_token}/${path}`, { method: "POST", json });
    await m("reschedule", { start: s.slots[8] });
    await m("delete-my-data");
    expect((await types(calId)).filter((t) => t.startsWith("booking."))).toEqual([
      "booking.created", "booking.changed", "booking.cancelled", "booking.created",
      "booking.created", "booking.changed", "booking.cancelled",
    ]);
  });

  it("deleting a customer sends customer.deleted with its ids, taken before the erase", async () => {
    const o = await newOwner();
    const calId = await calIdOf(o.slug);
    await setHook(o);
    const { customer } = (await (await call("/api/v1/customers", { method: "POST", who: o, json: { first_name: "Del", phone: "5035559200", external_ref: "lead_42" } })).json()) as { customer: { id: string } };
    await call(`/api/v1/customers/${customer.id}`, { method: "DELETE", who: o });
    await drain(calId);
    const del = (await mine(calId)).map((r) => JSON.parse(r.body)).find((b) => b.type === "customer.deleted");
    expect(del.data).toEqual({ customer: { id: customer.id, external_ref: "lead_42" } });
  });

  it("a late customer.created for a customer deleted since sends nothing", async () => {
    const o = await newOwner();
    const calId = await calIdOf(o.slug);
    await setHook(o);
    const { customer } = (await (await call("/api/v1/customers", { method: "POST", who: o, json: { first_name: "Gh", phone: "5035559250" } })).json()) as { customer: { id: string } };
    await call(`/api/v1/customers/${customer.id}`, { method: "DELETE", who: o });
    await drain(calId);
    const results = Object.fromEntries((await hookJobs(calId)).map((j) => [JSON.parse(j.payload).type, j.result]));
    expect(results).toEqual({ "customer.created": "skipped:gone", "customer.deleted": "done" });
    // And the finished customer.deleted job no longer keeps the outside reference.
    expect((await hookJobs(calId)).every((j) => JSON.parse(j.payload).external_ref === undefined)).toBe(true);
  });

  it("delete-my-data on an already-cancelled booking still tells the host app", async () => {
    const s = await bookableOwner();
    const calId = await calIdOf(s.owner.slug);
    await setHook(s.owner);
    const pub = await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await call(`/api/public/manage/${pub.manage_token}/cancel`, { method: "POST", json: {} });
    await call(`/api/public/manage/${pub.manage_token}/delete-my-data`, { method: "POST", json: {} });
    expect((await types(calId)).filter((t) => t.startsWith("booking."))).toEqual(["booking.created", "booking.cancelled", "booking.changed"]);
    await drain(calId);
    const last = (await mine(calId)).map((r) => JSON.parse(r.body)).filter((b) => b.type === "booking.changed").at(-1);
    expect(last.data.appointment.contact.first_name).toBe("Deleted");
  });

  it("retries failures with the same id, stops on 410, and never counts as sent email", async () => {
    const s = await bookableOwner();
    const calId = await calIdOf(s.owner.slug);
    await setHook(s.owner);
    const sentBefore = (await db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE result = 'sent'").first<{ n: number }>())!.n;
    await call("/api/v1/appointments", { method: "POST", who: s.owner, json: { service_id: s.serviceId, start: s.slots[0], customer: { first_name: "R", phone: "5035559300" } } });
    const [job] = (await hookJobs(calId)).filter((j) => JSON.parse(j.payload).type === "booking.created");
    answer = 500;
    await runWebhookJobs(testEnv, Date.now());
    let j = (await hookJobs(calId)).find((x) => x.id === job.id)!;
    expect([j.attempts, j.done_at]).toEqual([1, null]);
    expect(j.run_at - Date.now()).toBeGreaterThan(50_000);
    for (let i = 0; i < 6; i++) {
      await db().prepare("UPDATE jobs SET run_at = ? WHERE id = ?").bind(Date.now() - 1, job.id).run();
      await runWebhookJobs(testEnv, Date.now());
    }
    j = (await hookJobs(calId)).find((x) => x.id === job.id)!;
    expect(j.result).toBe("failed:500");
    const ids = (await mine(calId)).filter((r) => JSON.parse(r.body).id === job.id);
    expect(ids).toHaveLength(7);

    answer = 410;
    await call("/api/v1/appointments", { method: "POST", who: s.owner, json: { service_id: s.serviceId, start: s.slots[4], customer: { first_name: "R2", phone: "5035559301" } } });
    await drain(calId);
    expect((await hookJobs(calId)).filter((x) => x.result === "failed:410").length).toBeGreaterThan(0);

    answer = "network";
    await call("/api/v1/appointments", { method: "POST", who: s.owner, json: { service_id: s.serviceId, start: s.slots[8], customer: { first_name: "R3", phone: "5035559302" } } });
    await runWebhookJobs(testEnv, Date.now());
    expect((await hookJobs(calId)).some((x) => x.done_at === null && x.attempts === 1)).toBe(true);

    expect((await db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE result = 'sent'").first<{ n: number }>())!.n).toBe(sentBefore);
  });

  it("reads the address when sending, and the email runner leaves webhooks alone", async () => {
    const s = await bookableOwner();
    const calId = await calIdOf(s.owner.slug);
    await setHook(s.owner);
    await bookPublic(s.owner.slug, s.serviceId, s.slots[0]);
    await runDueJobs(testEnv, Date.now(), async () => {});
    expect((await hookJobs(calId)).every((j) => j.attempts === 0)).toBe(true);
    await setHook(s.owner, "https://new.example.com/hook");
    await drain(calId);
    expect((await mine(calId)).every((r) => r.url === "https://new.example.com/hook")).toBe(true);
  });
});
