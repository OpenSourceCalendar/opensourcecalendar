import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { needsRehash } from "../src/worker/accounts/password";
import { ipKey, ipv6Net64 } from "../src/worker/accounts/attempts";
import { hibpClean, linkToken, PW, req, setup, userWithPassword } from "./password-helpers";
import { hostedSession } from "../src/worker/auth";
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
    expect(await ipKey(env, "::ffff:203.0.113.5")).toBe(await ipKey(env, "203.0.113.5"));
    expect(await ipKey(env, "::FFFF:203.0.113.5")).toBe(await ipKey(env, "203.0.113.5"));
    expect(await ipKey(env, "::ffff:203.0.113.5")).not.toBe(await ipKey(env, "::ffff:203.0.113.6"));
  });

  it("refuses big bodies and is off without a pepper", async () => {
    const { env } = setup();
    expect((await req(env, "/api/account/password-login", { body: JSON.stringify({ email: "a@example.test", password: "x".repeat(5000) }) })).status).toBe(413);
    const { env: off } = setup({ PASSWORD_PEPPER: undefined });
    expect((await login(off, "a@example.test", PW)).status).toBe(404);
  });
});

describe("setting and changing a password", () => {
  const set = (env: Parameters<typeof req>[0], token: string, json: Record<string, unknown>) => req(env, "/api/admin/password", { token, json });
  const NEW = "a brand new long passphrase";

  it("a fresh sign-in sets a first password; other devices are signed out; an email says so", async () => {
    const { env, sent } = setup();
    const a = await hostedAccount(env);
    const other = (await hostedSession(env, a.userId, Date.now())).token;
    const res = await set(env, a.token, { password: NEW });
    expect(res.status).toBe(200);
    const { token } = await json<{ token: string }>(res);
    expect((await req(env, "/api/admin/calendar", { token: other })).status).toBe(401);
    expect((await req(env, "/api/admin/calendar", { token })).status).toBe(200);
    expect((await login(env, `${a.userId}@example.test`, NEW)).status).toBe(200);
    expect(sent.at(-1)!.subject).toBe("Your password was set");
  });

  it("an older sign-in needs the current password", async () => {
    const { env, sent } = setup();
    const u = await userWithPassword(env);
    const old = (await hostedSession(env, u.userId, Date.now() - 20 * 60_000)).token;
    expect(await json(await set(env, old, { password: NEW }))).toEqual({ error: "reauth_required" });
    expect(await json(await set(env, old, { password: NEW, current_password: "not the right one at all" }))).toEqual({ error: "wrong_password" });
    expect((await set(env, old, { password: NEW, current_password: PW })).status).toBe(200);
    expect(sent.at(-1)!.subject).toBe("Your password was changed");
  });

  it("wrong current passwords count toward the sign-in limits", async () => {
    const { env } = setup();
    const u = await userWithPassword(env);
    const old = (await hostedSession(env, u.userId, Date.now() - 20 * 60_000)).token;
    for (let i = 0; i < 5; i++) expect((await set(env, old, { password: NEW, current_password: "not the right one at all" })).status).toBe(403);
    expect(await json(await set(env, old, { password: NEW, current_password: PW }))).toEqual({ error: "too_many_tries" });
    expect((await login(env, u.email, PW)).status).toBe(429);
  });

  it("an older sign-in without a password can't add one", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const old = (await hostedSession(env, a.userId, Date.now() - 20 * 60_000)).token;
    expect((await set(env, old, { password: NEW })).status).toBe(403);
  });

  it("refuses short, long, guessable and breached passwords", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    expect(await json(await set(env, a.token, { password: "fourteen chars" }))).toEqual({ error: "password_too_short" });
    expect(await json(await set(env, a.token, { password: "x".repeat(257) }))).toEqual({ error: "password_too_long" });
    expect(await json(await set(env, a.token, { password: `${a.userId} is my long password` }))).toEqual({ error: "password_weak" });
    vi.restoreAllMocks();
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(NEW)))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(`${sha.slice(5)}:40`));
    expect(await json(await set(env, a.token, { password: NEW }))).toEqual({ error: "password_weak" });
  });

  it("an open sign-in link stops working once the password changes", async () => {
    const { env, sent } = setup();
    const a = await hostedAccount(env);
    await req(env, "/api/account/email-link", { json: { email: `${a.userId}@example.test` } });
    const link = linkToken(sent.at(-1)!);
    expect((await set(env, a.token, { password: NEW })).status).toBe(200);
    expect((await req(env, "/api/account/email-link/verify", { json: { token: link } })).status).toBe(400);
  });

  it("sign out of all devices ends every other session and keeps this one", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const res = await req(env, "/api/admin/sign-out-everywhere", { token: a.token, method: "POST" });
    const { token } = await json<{ token: string }>(res);
    expect((await req(env, "/api/admin/calendar", { token: a.token })).status).toBe(401);
    expect((await req(env, "/api/admin/calendar", { token })).status).toBe(200);
  });

  it("a stolen old token can't make itself fresh: sign out everywhere, then no password without the current one", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    const old = (await hostedSession(env, a.userId, Date.now() - 20 * 60_000)).token;
    const { token } = await json<{ token: string }>(await req(env, "/api/admin/sign-out-everywhere", { token: old, method: "POST" }));
    expect(await json(await set(env, token, { password: NEW }))).toEqual({ error: "reauth_required" });
  });

  it("a token whose version was bumped can't sign out everywhere or set a password", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    await env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").bind(a.userId).run();
    expect((await req(env, "/api/admin/sign-out-everywhere", { token: a.token, method: "POST" })).status).toBe(401);
    expect((await set(env, a.token, { password: NEW })).status).toBe(401);
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(a.userId).first<{ password_hash: string | null }>();
    expect(row!.password_hash).toBeNull();
  });

  it("a password change racing another sign-out writes nothing and renews nothing", async () => {
    const { env, sent } = setup();
    const a = await hostedAccount(env);
    await req(env, "/api/account/email-link", { json: { email: `${a.userId}@example.test` } });
    const link = linkToken(sent.at(-1)!);
    // The breach check runs after requireSession let the request in: bump the version right then.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").bind(a.userId).run();
      return new Response("");
    });
    expect(await json(await set(env, a.token, { password: NEW }))).toEqual({ error: "unauthorized" });
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(a.userId).first<{ password_hash: string | null }>();
    expect(row!.password_hash).toBeNull();
    expect((await req(env, "/api/account/email-link/verify", { json: { token: link } })).status).toBe(200);
  });

  it("sign out everywhere racing another sign-out renews nothing", async () => {
    const { env } = setup();
    const a = await hostedAccount(env);
    // Bump the version just before the route's own bump runs (after requireSession checked it).
    const real = env.DB;
    const DB = new Proxy(real, {
      get(t, k) {
        if (k === "prepare") {
          return (sql: string) => sql.startsWith("UPDATE users SET session_version") && sql.includes("AND session_version = ?")
            ? { bind: (...args: unknown[]) => ({ first: async () => {
              await t.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").bind(a.userId).run();
              return t.prepare(sql).bind(...args).first();
            } }) }
            : t.prepare(sql);
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect((await req({ ...env, DB }, "/api/admin/sign-out-everywhere", { token: a.token, method: "POST" })).status).toBe(401);
  });

  it("a client's notice email is in the client's name only", async () => {
    const { env, sent } = setup();
    const agency = await hostedAccount(env);
    await env.DB.prepare("UPDATE calendars SET branding = ? WHERE id = ?").bind(JSON.stringify({ business_name: "Acme Plumbing" }), agency.calendarId).run();
    const client = await clientUser(env, agency.calendarId);
    expect((await set(env, client.token, { password: NEW })).status).toBe(200);
    const mail = sent.at(-1)!;
    expect(mail.from.name).toBe("Acme Plumbing");
    expect(mail.text).toContain("your booking calendar for Acme Plumbing");
    expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toContain("Open Source Calendar");
  });

  it("a client whose calendar is gone gets neutral wording", async () => {
    const { env, sent } = setup();
    const client = await clientUser(env, `cal_gone_${uniq()}`);
    expect((await set(env, client.token, { password: NEW })).status).toBe(200);
    const mail = sent.at(-1)!;
    expect(mail.from.name).toBe("Your booking calendar");
    expect(mail.text).toContain("The password for your booking calendar was just set.");
    expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toContain("Open Source Calendar");
  });

  it("a password change re-issues this device's token with the old sign-in time", async () => {
    const { env } = setup();
    const u = await userWithPassword(env);
    const old = (await hostedSession(env, u.userId, Date.now() - 20 * 60_000)).token;
    const { token } = await json<{ token: string }>(await set(env, old, { password: NEW, current_password: PW }));
    expect(await json(await set(env, token, { password: "yet another long passphrase" }))).toEqual({ error: "reauth_required" });
  });
});
