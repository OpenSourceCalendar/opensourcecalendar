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
