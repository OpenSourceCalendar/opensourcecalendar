// Shared by the password and client-login tests: requests with an ExecutionContext (the routes send email in
// waitUntil), a HaveIBeenPwned stub that finds nothing, and accounts with a password.
import { vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/worker/index";
import { hashPassword, type KdfParams } from "../src/worker/accounts/password";
import { billingEnv, hostedAccount } from "./stripe-fake";
import { testEnv, uniq } from "./helpers";

export const BASE = "https://book.example.test";
export const PW = "correct horse battery staple";
export type Sent = { to: string; from: { email: string; name: string }; subject: string; text: string; html: string };

export function setup(extra: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const env = billingEnv({ EMAIL: { send: vi.fn(async (m: Sent) => void sent.push(m)) }, ...extra });
  return { env, sent };
}

/** HaveIBeenPwned answers "nothing found" (and nothing else is fetched). */
export const hibpClean = () => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(""));

export async function req(
  env: typeof testEnv, path: string,
  init: { method?: string; json?: unknown; token?: string; client?: string; ip?: string; body?: string } = {},
) {
  const headers: Record<string, string> = { "CF-Connecting-IP": init.ip ?? `198.51.100.${uniq()}` };
  if (init.token) headers.Authorization = `Session ${init.token}`;
  if (init.client) headers["X-Client"] = init.client;
  if (init.json !== undefined || init.body !== undefined) headers["Content-Type"] = "application/json";
  const ctx = createExecutionContext();
  const res = await app.request(`${BASE}${path}`, {
    method: init.method ?? (init.json !== undefined || init.body !== undefined ? "POST" : "GET"),
    headers, body: init.body ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A hosted account (with its calendar) that has a password. */
export async function userWithPassword(env: typeof testEnv, password = PW, params?: KdfParams) {
  const a = await hostedAccount(env);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(env, password, params), a.userId).run();
  return { ...a, email: `${a.userId}@example.test` };
}

export const linkToken = (m: Sent) => /#t=([A-Za-z0-9_-]+)/.exec(m.text)![1];
