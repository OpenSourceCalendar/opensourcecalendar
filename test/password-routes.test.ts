import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { needsRehash } from "../src/worker/accounts/password";
import { ipKey, ipv6Net64 } from "../src/worker/accounts/attempts";
import { hibpClean, PW, req, setup, userWithPassword } from "./password-helpers";
import { clientUser, hostedAccount } from "./stripe-fake";
import { hashPassword } from "../src/worker/accounts/password";
import { uniq } from "./helpers";

const json = async <T>(res: Response) => (await res.json()) as T;
const login = (env: Parameters<typeof req>[0], email: string, password: string, ip?: string) =>
  req(env, "/api/account/password-login", { json: { email, password }, ip });
beforeEach(() => void hibpClean());
afterEach(() => vi.restoreAllMocks());

describe("password sign-in", () => {
  it("the right password signs in", async () => {
    const { env } = setup();
    const u = await userWithPassword(env);
    const res = await login(env, u.email.toUpperCase(), PW);
    expect(res.status).toBe(200);
    const body = await json<{ token: string; client_slug: string | null }>(res);
    expect(body.client_slug).toBeNull();
    expect((await req(env, "/api/admin/calendar", { token: body.token })).status).toBe(200);
  });

  it("a client's sign-in says which calendar's page it belongs to", async () => {
    const { env } = setup();
    const agency = await hostedAccount(env);
    const client = await clientUser(env, agency.calendarId);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(env, PW), client.userId).run();
    const res = await login(env, client.email, PW);
    expect(res.status).toBe(200);
    expect((await json<{ client_slug: string | null }>(res)).client_slug).toBe(agency.slug);
  });

  it("a wrong password, an unknown email and an account without a password get the same answer", async () => {
    const { env } = setup();
    const u = await userWithPassword(env);
    const plain = await hostedAccount(env);
    for (const [email, pw] of [[u.email, `${PW}!`], [`nobody-${uniq()}@example.test`, PW], [`${plain.userId}@example.test`, PW]]) {
      const res = await login(env, email, pw);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "wrong_password" });
    }
  });

  it("pauses an email after 5 wrong tries, even for the right password and for unknown emails", async () => {
    const { env } = setup();
    const u = await userWithPassword(env);
    const nobody = `nobody-${uniq()}@example.test`;
    for (let i = 0; i < 5; i++) {
      expect((await login(env, u.email, "wrong password number x")).status).toBe(401);
      expect((await login(env, nobody, "wrong password number x")).status).toBe(401);
    }
    expect(await json(await login(env, u.email, PW))).toEqual({ error: "too_many_tries" });
    expect((await login(env, nobody, PW)).status).toBe(429);
  });

  it("pauses a network after 30 tries", async () => {
    const { env } = setup();
    const ip = "203.0.113.77";
    for (let i = 0; i < 30; i++) expect((await login(env, `n${i}-${uniq()}@example.test`, PW, ip)).status).toBe(401);
    expect((await login(env, `n-${uniq()}@example.test`, PW, ip)).status).toBe(429);
  });

  it("counts tries sent at the same time", async () => {
    const { env } = setup();
    const u = await userWithPassword(env);
    const all = await Promise.all(Array.from({ length: 8 }, () => login(env, u.email, "wrong password number x")));
    expect(all.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(3);
  });

  it("the emailed link still works while password sign-in is paused", async () => {
    const { env, sent } = setup();
    const u = await userWithPassword(env);
    for (let i = 0; i < 6; i++) await login(env, u.email, "wrong password number x");
    expect((await req(env, "/api/account/email-link", { json: { email: u.email } })).status).toBe(202);
    expect(sent.at(-1)!.to).toBe(u.email);
  });

  it("re-makes a hash with older settings at sign-in", async () => {
    const { env } = setup();
    const u = await userWithPassword(env, PW, { m: 64, t: 1, p: 1 });
    expect((await login(env, u.email, PW)).status).toBe(200);
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(u.userId).first<{ password_hash: string }>();
    expect(needsRehash(row!.password_hash)).toBe(false);
  });

  it("groups IPv6 by /64, whether or not the address is written with ::", async () => {
    expect(ipv6Net64("2001:db8::1")).toBe("2001:db8:0:0");
    expect(ipv6Net64("2001:0DB8:0000:0000:ffff::2")).toBe("2001:db8:0:0");
    expect(ipv6Net64("::1")).toBe("0:0:0:0");
    expect(ipv6Net64("2001:db8:0:1::1")).toBe("2001:db8:0:1");
    const { env } = setup();
    expect(await ipKey(env, "2001:db8::1")).toBe(await ipKey(env, "2001:db8:0:0:aaaa:bbbb:cccc:dddd"));
    expect(await ipKey(env, "2001:db8::1")).not.toBe(await ipKey(env, "2001:db8:0:1::1"));
  });

  it("refuses big bodies and is off without a pepper", async () => {
    const { env } = setup();
    expect((await req(env, "/api/account/password-login", { body: JSON.stringify({ email: "a@example.test", password: "x".repeat(5000) }) })).status).toBe(413);
    const { env: off } = setup({ PASSWORD_PEPPER: undefined });
    expect((await login(off, "a@example.test", PW)).status).toBe(404);
  });
});
