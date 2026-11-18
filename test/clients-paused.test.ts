import { describe, it, expect, vi } from "vitest";
import { buildEmail } from "../src/worker/email/send";
import { app } from "../src/worker/index";
import { addClient, adminCall, billingEnv, hostedAccount, setBilling } from "./stripe-fake";

const PUB = "https://book.example.test/api/public";
const json = async <T>(res: Response) => (await res.json()) as T;

/** A White-label agency with one bookable client: open 9–5 every day, no notice, one 30-minute service. */
async function setup() {
  const env = billingEnv({ EMAIL: { send: vi.fn(async () => {}) } }); // booking emails never reach a real sender
  const a = await hostedAccount(env);
  await setBilling(env, a.userId, { plan: "white_label", status: "active" });
  const c = await addClient(env, a.token);
  const as = (path: string, method: string, body: unknown) => adminCall(env, a.token, path, { method, json: body, client: c.calendarId });
  await as("/availability/weekly", "PUT", { days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: true, start_min: 540, end_min: 1020, breaks: [] })) });
  await as("/calendar", "PATCH", { rules: { min_notice_min: 0, max_days_ahead: 730 } });
  const service = await json<{ id: string }>(await as("/services", "POST", { name: "Call", duration_min: 30 }));
  const date = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const get = (path: string) => app.request(`${PUB}/${c.slug}${path}`, {}, env);
  const slots = async () => (await json<{ slots: string[] }>(await get(`/slots?service_id=${service.id}&date=${date}`))).slots;
  const days = async () => (await json<{ days: string[] }>(await get(`/days?service_id=${service.id}&month=${date.slice(0, 7)}`))).days;
  const book = (start: string) => app.request(`${PUB}/${c.slug}/book`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service_id: service.id, start, first_name: "Ann", email: "ann@example.test", phone: "5035550123" }),
  }, env);
  const pause = () => setBilling(env, a.userId, { plan: "white_label", status: "canceled", grace_until: null });
  return { env, a, c, date, get, slots, days, book, pause };
}

describe("a paused client", () => {
  it("says it's paused, offers no times, and refuses new bookings with 409 booking_paused", async () => {
    const t = await setup();
    const [first] = await t.slots();
    expect(first).toBeTruthy();
    expect((await json<{ paused: boolean }>(await t.get(""))).paused).toBe(false);
    await t.pause();
    expect((await json<{ paused: boolean }>(await t.get(""))).paused).toBe(true);
    expect(await t.days()).toEqual([]);
    expect(await t.slots()).toEqual([]);
    const res = await t.book(first);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "booking_paused" });
  });

  it("existing bookings keep working: change times, reminder email, cancel", async () => {
    const t = await setup();
    const [first, second] = await t.slots();
    const booked = await json<{ manage_token: string; appointment: { id: string } }>(await t.book(first));
    await t.pause();
    const m = (path: string, body?: unknown) => app.request(`${PUB}/manage/${booked.manage_token}${path}`,
      body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, t.env);
    expect((await json<{ slots: string[] }>(await m(`/slots?date=${t.date}`))).slots.length).toBeGreaterThan(0);
    expect((await m("/reschedule", { start: second })).status).toBe(200);
    const reminder = await buildEmail(t.env, t.c.calendarId, "email.customer.reminder", { appointment_id: booked.appointment.id, origin: "https://book.example.test", start: Date.parse(second) }, Date.now());
    expect("message" in reminder).toBe(true);
    expect((await m("/cancel", {})).status).toBe(200);
  });

  it("subscribing to White-label again turns online booking back on", async () => {
    const t = await setup();
    const [first] = await t.slots();
    await t.pause();
    await setBilling(t.env, t.a.userId, { status: "active" });
    expect((await json<{ paused: boolean }>(await t.get(""))).paused).toBe(false);
    expect((await t.book(first)).status).toBe(201);
  });

  it("the agency's own calendar is never paused", async () => {
    const t = await setup();
    await setBilling(t.env, t.a.userId, { plan: "pro", status: "active" });
    const own = await app.request(`${PUB}/${t.a.slug}`, {}, t.env);
    expect((await json<{ paused: boolean }>(own)).paused).toBe(false);
  });
});
