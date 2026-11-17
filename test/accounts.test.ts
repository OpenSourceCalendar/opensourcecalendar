import { describe, it, expect, vi, afterEach } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/worker/index";
import { sha256Hex } from "../src/worker/lib/ids";
import { testEnv, uniq } from "./helpers";

const BASE = "https://book.example.test";
type Sent = { to: string; subject: string; text: string };

function envWith(extra: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const env = {
    ...testEnv, SIGNUP: "invite", PUBLIC_URL: BASE, EMAIL_FROM: "hello@example.test",
    EMAIL: { send: vi.fn(async (m: Sent) => void sent.push(m)) }, ...extra,
  } as unknown as typeof testEnv;
  return { env, sent };
}

/** One request with an ExecutionContext, waiting for its background work (emails). */
async function req(env: typeof testEnv, path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const ctx = createExecutionContext();
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await app.request(url, { ...init, headers, body, redirect: "manual" }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function makeInvite(env: typeof testEnv): Promise<string> {
  const res = await req(env, "/api/setup/invites", { method: "POST", headers: { Authorization: "Bearer test-setup-token" }, json: { note: "test" } });
  expect(res.status).toBe(201);
  return new URL(((await res.json()) as { url: string }).url).searchParams.get("invite")!;
}

const email = () => `owner-${uniq()}@example.test`;

afterEach(() => vi.restoreAllMocks());

describe("the switch", () => {
  it("is off without SIGNUP or without PUBLIC_URL", async () => {
    for (const extra of [{ SIGNUP: undefined }, { PUBLIC_URL: undefined }]) {
      const { env } = envWith(extra);
      expect((await req(env, "/api/account/config")).status).toBe(404);
      expect((await req(env, "/api/setup/invites", { method: "POST", headers: { Authorization: "Bearer test-setup-token" }, json: {} })).status).toBe(404);
    }
  });

  it("tells the pages what this install offers", async () => {
    const { env } = envWith();
    const cfg = (await (await req(env, "/api/account/config")).json()) as Record<string, unknown>;
    expect(cfg).toEqual({ google: true, email: true, turnstile_site_key: null, public_url: BASE });
  });
});

describe("invites", () => {
  it("are made only with the setup token, and are valid until used or expired", async () => {
    const { env } = envWith();
    expect((await req(env, "/api/setup/invites", { method: "POST", headers: { Authorization: "Bearer nope" }, json: {} })).status).toBe(401);
    const token = await makeInvite(env);
    expect(((await (await req(env, `/api/account/invite/${token}`)).json()) as { valid: boolean }).valid).toBe(true);
    await env.DB.prepare("UPDATE invites SET expires_at = 0 WHERE token_hash = ?").bind(await sha256Hex(token)).run();
    expect(((await (await req(env, `/api/account/invite/${token}`)).json()) as { valid: boolean }).valid).toBe(false);
  });
});

const linkToken = (m: Sent) => /#t=([A-Za-z0-9_-]+)/.exec(m.text)![1];
// A fresh "network" per call unless a test passes one: D1 is shared by every test in this file, so a fixed IP
// would hit the 10-per-hour network limit partway through.
const askLink = (env: typeof testEnv, json: Record<string, unknown>, ip = `test-${uniq()}`) =>
  req(env, "/api/account/email-link", { method: "POST", json, headers: { "CF-Connecting-IP": ip } });
const verify = (env: typeof testEnv, token: string) => req(env, "/api/account/email-link/verify", { method: "POST", json: { token } });

async function signUp(env: typeof testEnv, sent: Sent[], address = email()) {
  const invite = await makeInvite(env);
  expect((await askLink(env, { email: address, invite })).status).toBe(202);
  const res = await verify(env, linkToken(sent.at(-1)!));
  expect(res.status).toBe(200);
  return { invite, address, ...((await res.json()) as { token: string; email: string }) };
}
const asOwner = (env: typeof testEnv, token: string, path: string, init: RequestInit & { json?: unknown } = {}) =>
  req(env, `/api/admin${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Session ${token}` } });

describe("email sign-in", () => {
  it("sends nothing for an unknown email without an invite, but still answers 202", async () => {
    const { env, sent } = envWith();
    expect((await askLink(env, { email: email() })).status).toBe(202);
    expect(sent).toHaveLength(0);
  });

  it("signs up with an invite, and the session opens the owner screens", async () => {
    const { env, sent } = envWith();
    const s = await signUp(env, sent);
    expect(sent[0].to).toBe(s.address);
    expect(sent[0].text).toContain(`${BASE}/login/verify#t=`);
    expect(s.email).toBe(s.address);
    expect((await asOwner(env, s.token, "/calendar")).status).toBe(404); // signed in, no calendar yet
    const made = await asOwner(env, s.token, "/calendar", { method: "POST", json: { slug: `acct-${uniq()}`, time_zone: "America/Los_Angeles" } });
    expect(made.status).toBe(201);
    expect(await (await asOwner(env, s.token, "/account")).json()).toEqual({ email: s.address });
    expect(((await (await req(env, `/api/account/invite/${s.invite}`)).json()) as { valid: boolean }).valid).toBe(false);
  });

  it("links work once and for 15 minutes", async () => {
    const { env, sent } = envWith();
    const invite = await makeInvite(env);
    await askLink(env, { email: email(), invite });
    const t = linkToken(sent[0]);
    expect((await verify(env, t)).status).toBe(200);
    expect(((await (await verify(env, t)).json()) as { error: string }).error).toBe("link_expired");

    await askLink(env, { email: email(), invite: await makeInvite(env) });
    const t2 = linkToken(sent[1]);
    await env.DB.prepare("UPDATE login_links SET expires_at = 0 WHERE token_hash = ?").bind(await sha256Hex(t2)).run();
    expect((await verify(env, t2)).status).toBe(400);
  });

  it("sends existing accounts a log-in link without an invite", async () => {
    const { env, sent } = envWith();
    const s = await signUp(env, sent);
    await askLink(env, { email: s.address.toUpperCase() });
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain("log in");
    expect((await verify(env, linkToken(sent[1]))).status).toBe(200);
  });

  it("a used invite sends nothing more", async () => {
    const { env, sent } = envWith();
    const s = await signUp(env, sent);
    await askLink(env, { email: email(), invite: s.invite });
    expect(sent).toHaveLength(1);
  });

  it("two sign-ups racing on one invite create one account", async () => {
    const { env, sent } = envWith();
    const invite = await makeInvite(env);
    const [a, b] = [email(), email()];
    await askLink(env, { email: a, invite });
    await askLink(env, { email: b, invite });
    const results = await Promise.all(sent.map((m) => verify(env, linkToken(m))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email IN (?, ?)").bind(a, b).first<{ n: number }>();
    expect(users?.n).toBe(1);
  });

  it("a second sign-up link for an address that already signed up logs in and leaves its invite unused", async () => {
    const { env, sent } = envWith();
    const address = email();
    const [i1, i2] = [await makeInvite(env), await makeInvite(env)];
    await askLink(env, { email: address, invite: i1 });
    await askLink(env, { email: address, invite: i2 });
    expect((await verify(env, linkToken(sent[0]))).status).toBe(200);
    expect((await verify(env, linkToken(sent[1]))).status).toBe(200);
    expect(((await (await req(env, `/api/account/invite/${i2}`)).json()) as { valid: boolean }).valid).toBe(true);
  });

  it("limits links per address, per network and per day", async () => {
    const { env, sent } = envWith();
    const s = await signUp(env, sent); // 1 link so far for this address
    for (let i = 0; i < 3; i++) await askLink(env, { email: s.address }, `198.51.100.${i}`);
    expect(sent).toHaveLength(3); // 3 per address per hour

    const ip = "192.0.2.77";
    const now = Date.now();
    for (let i = 0; i < 11; i++) {
      await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(`usr_lim${i}${uniq()}`, `lim${i}-${uniq()}@example.test`, now).run();
    }
    const known = (await env.DB.prepare("SELECT email FROM users WHERE email LIKE 'lim%' ORDER BY created_at DESC LIMIT 11").all<{ email: string }>()).results;
    const before = sent.length;
    for (const k of known) await askLink(env, { email: k.email }, ip);
    expect(sent.length - before).toBe(10); // 10 per network per hour

    const rows = Array.from({ length: 300 }, (_, i) =>
      env.DB.prepare("INSERT INTO login_links (token_hash, email, ip_hash, created_at, expires_at) VALUES (?, 'x@example.test', 'x', ?, ?)").bind(`cap${i}${uniq()}`, now, now));
    await env.DB.batch(rows);
    try {
      const n = sent.length;
      await askLink(env, { email: known[0].email }, "192.0.2.200");
      expect(sent.length).toBe(n); // install-wide daily cap
    } finally {
      await env.DB.prepare("DELETE FROM login_links WHERE email = 'x@example.test'").run(); // later tests share D1
    }
  });

  it("checks Turnstile with the login action when a secret is set", async () => {
    const { env, sent } = envWith({ TURNSTILE_SECRET: "ts-secret" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ success: false })));
    expect((await askLink(env, { email: email(), turnstile_token: "x" })).status).toBe(400);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, action: "login", hostname: "book.example.test" })));
    expect((await askLink(env, { email: email(), turnstile_token: "x" })).status).toBe(202);
    expect(sent).toHaveLength(0);
  });

  it("signs out a deleted account at once", async () => {
    const { env, sent } = envWith();
    const s = await signUp(env, sent);
    await env.DB.prepare("DELETE FROM users WHERE email = ?").bind(s.address).run();
    expect((await asOwner(env, s.token, "/calendar")).status).toBe(401);
  });

  it("createUserWithInvite: a sign-up that loses the race to the same person logs in to their account", async () => {
    const { env } = envWith();
    const { createUserWithInvite } = await import("../src/worker/accounts/store");
    const invite = await makeInvite(env);
    const hash = await sha256Hex(invite);
    const address = email();
    // The winner already took the invite and created the user.
    await env.DB.prepare("UPDATE invites SET used_at = 1, used_by = 'usr_winner' WHERE token_hash = ?").bind(hash).run();
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(`usr_w${uniq()}`, address, Date.now()).run();
    const r = await createUserWithInvite(env.DB, address, undefined, hash, Date.now());
    expect(r && "user" in r && r.user.email).toBe(address);
  });

  it("createUserWithInvite: a failed insert gives the invite back", async () => {
    const { env } = envWith();
    const { createUserWithInvite } = await import("../src/worker/accounts/store");
    const invite = await makeInvite(env);
    const hash = await sha256Hex(invite);
    const address = email();
    // Same email, different Google account: the INSERT fails on the unique email and the look-up says mismatch.
    await env.DB.prepare("INSERT INTO users (id, email, google_sub, created_at) VALUES (?, ?, ?, ?)").bind(`usr_m${uniq()}`, address, `g-a-${uniq()}`, Date.now()).run();
    const r = await createUserWithInvite(env.DB, address, `g-b-${uniq()}`, hash, Date.now() + 1);
    expect(r).toEqual({ mismatch: true });
    const row = await env.DB.prepare("SELECT used_at FROM invites WHERE token_hash = ?").bind(hash).first<{ used_at: number | null }>();
    expect(row?.used_at).toBeNull();
  });

  it("answers /api/admin/account only for hosted accounts", async () => {
    const { env } = envWith();
    const { createApp } = await import("./helpers");
    const key = await createApp();
    const link = await req(env, "/api/v1/admin-sessions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "X-Calendar-User": "u1" } });
    const { token } = (await link.json()) as { token: string };
    expect((await asOwner(env, token, "/account")).status).toBe(404);
  });
});
