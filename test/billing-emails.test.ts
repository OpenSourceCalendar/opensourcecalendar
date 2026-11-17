import { describe, it, expect, vi } from "vitest";
import { buildEmail } from "../src/worker/email/send";
import { billingEnv, hostedAccount } from "./stripe-fake";

describe("account emails", () => {
  it("limit email goes to the account's sign-in address, names the month and links the Plan page", async () => {
    const env = billingEnv({ EMAIL: { send: vi.fn() } });
    const a = await hostedAccount(env);
    const built = await buildEmail(env, a.calendarId, "email.account.limit", { appointment_id: "", origin: "", user_id: a.userId, month: "2026-11" }, Date.now());
    expect("message" in built).toBe(true);
    if (!("message" in built)) return;
    expect(built.message.to).toBe(`${a.userId}@example.test`);
    expect(built.message.subject).toContain("10 free bookings");
    expect(built.message.text).toContain("December 1");
    expect(built.message.text).toContain("https://book.example.test/admin/plan");
  });
  it("grace start and grace end emails", async () => {
    const env = billingEnv({ EMAIL: { send: vi.fn() } });
    const a = await hostedAccount(env);
    const until = Date.UTC(2026, 11, 8, 20);
    const start = await buildEmail(env, a.calendarId, "email.account.grace_start", { appointment_id: "", origin: "", user_id: a.userId, until }, Date.now());
    const end = await buildEmail(env, a.calendarId, "email.account.grace_end", { appointment_id: "", origin: "", user_id: a.userId, until }, Date.now());
    if (!("message" in start) || !("message" in end)) throw new Error("expected messages");
    expect(start.message.text).toContain("Is everything okay");
    expect(start.message.replyTo).toBe("support@example.test");
    expect(end.message.text).toContain("December 8");
  });
  it("is skipped when the account is gone", async () => {
    const env = billingEnv();
    const a = await hostedAccount(env);
    const built = await buildEmail(env, a.calendarId, "email.account.limit", { appointment_id: "", origin: "", user_id: "usr_missing", month: "2026-11" }, Date.now());
    expect(built).toEqual({ skip: "no_account" });
  });
});
