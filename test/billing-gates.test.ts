import { describe, it, expect } from "vitest";
import { buildEmail } from "../src/worker/email/send";
import { app } from "../src/worker/index";
import { addClient, billingEnv, clientCalendar, hostedAccount, setBilling } from "./stripe-fake";

/** One booked appointment straight in the table (an hour from tomorrow), with a customer email. */
async function appt(env: ReturnType<typeof billingEnv>, calendarId: string, extra = "") {
  const svc = `svc_${crypto.randomUUID()}`;
  const cus = `cus_${crypto.randomUUID()}`;
  const id = `apt_${crypto.randomUUID()}`;
  const start = Date.now() + 86_400_000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO services (id, calendar_id, name, duration_min, color, location_type, created_at) VALUES (?, ?, 'Call', 30, '#2d6a4f', 'business', 0)").bind(svc, calendarId),
    env.DB.prepare("INSERT INTO customers (id, calendar_id, first_name, email, created_at) VALUES (?, ?, 'Ann', 'ann@example.test', 0)").bind(cus, calendarId),
    env.DB.prepare(`INSERT INTO appointments (id, calendar_id, service_id, customer_id, start_at, end_at, status, source, manage_token_hash, created_at, updated_at, contact_first_name, contact_email${extra ? ", emails_off" : ""})
      VALUES (?, ?, ?, ?, ?, ?, 'booked', 'booking_page', ?, 0, 0, 'Ann', 'ann@example.test'${extra ? ", 1" : ""})`).bind(id, calendarId, svc, cus, start, start + 1_800_000, id),
  ]);
  return { id, start };
}

describe("gates", () => {
  it("a client's owner email goes to the client's address and has no dashboard link", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "white_label", status: "active" });
    const c = await addClient(env, a.token);
    const { id } = await appt(env, c.calendarId);
    const built = await buildEmail(env, c.calendarId, "email.owner.new", { appointment_id: id, origin: "https://book.example.test" }, Date.now());
    if (!("message" in built)) throw new Error("expected a message");
    expect(built.message.to).toBe("client@example.test");
    expect(built.message.text).not.toContain("/admin/schedule");
    await env.DB.prepare("UPDATE calendars SET notifications = json_set(notifications, '$.owner_email', 'agency@example.test') WHERE id = ?").bind(a.calendarId).run();
    const own = await appt(env, a.calendarId);
    const home = await buildEmail(env, a.calendarId, "email.owner.new", { appointment_id: own.id, origin: "https://book.example.test" }, Date.now());
    if (!("message" in home)) throw new Error("expected a message");
    expect(home.message.text).toContain("/admin/schedule");
  });
  it("an emails_off booking sends nothing", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const { id } = await appt(env, a.calendarId, "off");
    expect(await buildEmail(env, a.calendarId, "email.customer.booked", { appointment_id: id, origin: "https://book.example.test" }, Date.now())).toEqual({ skip: "free_limit" });
  });
  it("Free: customer reminders are skipped and the email footer is forced on", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await env.DB.prepare("UPDATE calendars SET rules = json_set(rules, '$.powered_by', json('false')) WHERE id = ?").bind(a.calendarId).run();
    const { id, start } = await appt(env, a.calendarId);
    expect(await buildEmail(env, a.calendarId, "email.customer.reminder", { appointment_id: id, origin: "https://book.example.test", start }, Date.now())).toEqual({ skip: "plan" });
    const booked = await buildEmail(env, a.calendarId, "email.customer.booked", { appointment_id: id, origin: "https://book.example.test" }, Date.now());
    if (!("message" in booked)) throw new Error("expected a message");
    // The footer line only appears when poweredBy is on.
    expect(booked.message.text).toContain("using Open Source Calendar (opensourcecalendar.com)");
  });
  it("Pro: reminders go out and the footer follows the setting", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await setBilling(env, a.userId, { plan: "pro", status: "active" });
    await env.DB.prepare("UPDATE calendars SET rules = json_set(rules, '$.powered_by', json('false')) WHERE id = ?").bind(a.calendarId).run();
    const { id, start } = await appt(env, a.calendarId);
    const reminder = await buildEmail(env, a.calendarId, "email.customer.reminder", { appointment_id: id, origin: "https://book.example.test", start }, Date.now());
    if (!("message" in reminder)) throw new Error("expected a message");
    expect(reminder.message.text).not.toContain("using Open Source Calendar");
  });
  it("Free: the public page shows the footer even when the owner turned it off", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    await env.DB.prepare("UPDATE calendars SET rules = json_set(rules, '$.powered_by', json('false')) WHERE id = ?").bind(a.calendarId).run();
    const res = await app.request(`https://book.example.test/api/public/${a.slug}`, {}, env);
    expect(((await res.json()) as { booking: { powered_by: boolean } }).booking.powered_by).toBe(true);
    await setBilling(env, a.userId, { plan: "pro", status: "active" });
    const res2 = await app.request(`https://book.example.test/api/public/${a.slug}`, {}, env);
    expect(((await res2.json()) as { booking: { powered_by: boolean } }).booking.powered_by).toBe(false);
  });
  it("White-label: no footer on the page or in emails even with the setting on; back on Free the own page shows it again", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const c = await clientCalendar(env, a.userId);
    await setBilling(env, a.userId, { plan: "white_label", status: "active" });
    await env.DB.prepare("UPDATE calendars SET rules = json_set(rules, '$.powered_by', json('true')) WHERE id IN (?, ?)").bind(a.calendarId, c.calendarId).run();
    const footer = async (slug: string) =>
      ((await (await app.request(`https://book.example.test/api/public/${slug}`, {}, env)).json()) as { booking: { powered_by: boolean } }).booking.powered_by;
    expect(await footer(a.slug)).toBe(false);
    expect(await footer(c.slug)).toBe(false);
    const { id } = await appt(env, a.calendarId);
    const booked = await buildEmail(env, a.calendarId, "email.customer.booked", { appointment_id: id, origin: "https://book.example.test" }, Date.now());
    if (!("message" in booked)) throw new Error("expected a message");
    expect(booked.message.text).not.toContain("using Open Source Calendar");
    await setBilling(env, a.userId, { plan: "white_label", status: "canceled" });
    expect(await footer(a.slug)).toBe(true);
  });
});
