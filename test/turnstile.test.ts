import { afterEach, describe, it, expect, vi } from "vitest";
import { app } from "../src/worker/index";
import { verifyTurnstile } from "../src/worker/lib/turnstile";
import { bookableOwner, testEnv } from "./helpers";

const fakeFetch = (body: unknown, capture?: (init: RequestInit) => void) =>
  (async (_url: string, init: RequestInit) => {
    capture?.(init);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

const E = { action: "book", hostnames: ["cal.example.com"] };

describe("verifyTurnstile", () => {
  it("passes a successful token and sends secret, token and IP", async () => {
    let sent = "";
    const ok = await verifyTurnstile("sek", "tok", "1.2.3.4", E, fakeFetch({ success: true, action: "book", hostname: "cal.example.com" }, (i) => (sent = String(i.body))));
    expect(ok).toBe(true);
    expect(sent).toContain("secret=sek");
    expect(sent).toContain("response=tok");
    expect(sent).toContain("remoteip=1.2.3.4");
  });
  it("fails a rejected or missing token without calling out", async () => {
    expect(await verifyTurnstile("sek", "tok", null, E, fakeFetch({ success: false }))).toBe(false);
    let called = false;
    expect(await verifyTurnstile("sek", "", null, E, fakeFetch({ success: true }, () => (called = true)))).toBe(false);
    expect(called).toBe(false);
  });
  it("fails a token made for another action or another site, or a bad answer", async () => {
    expect(await verifyTurnstile("sek", "tok", null, E, fakeFetch({ success: true, action: "login", hostname: "cal.example.com" }))).toBe(false);
    expect(await verifyTurnstile("sek", "tok", null, E, fakeFetch({ success: true, action: "book", hostname: "evil.example" }))).toBe(false);
    expect(await verifyTurnstile("sek", "tok", null, E, fakeFetch({ success: true, action: "book" }))).toBe(false);
    const broken = (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    expect(await verifyTurnstile("sek", "tok", null, E, broken)).toBe(false);
  });
});

describe("booking with Turnstile on two addresses", () => {
  afterEach(() => vi.restoreAllMocks());

  // PUBLIC_URL is the new address; the old one keeps serving the same booking page.
  const env = { ...testEnv, TURNSTILE_SECRET: "sek", PUBLIC_URL: "https://book.new.example" };
  const tokenFrom = (hostname: string) =>
    vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ success: true, action: "book", hostname }), { headers: { "Content-Type": "application/json" } })) as typeof fetch);
  const book = (origin: string, slug: string, json: Record<string, unknown>) =>
    app.request(`${origin}/api/public/${slug}/book`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }, env);

  it("accepts a token from the new address and from the old address it's served on", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    tokenFrom("book.new.example");
    expect((await book("https://book.new.example", owner.slug, { service_id: serviceId, start: slots[0], first_name: "A", phone: "5035550901", turnstile_token: "t" })).status).toBe(201);
    tokenFrom("book.old.example");
    expect((await book("https://book.old.example", owner.slug, { service_id: serviceId, start: slots[slots.length - 1], first_name: "B", phone: "5035550902", turnstile_token: "t" })).status).toBe(201);
  });

  it("still refuses a token made on some other site", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    tokenFrom("evil.example");
    const res = await book("https://book.old.example", owner.slug, { service_id: serviceId, start: slots[0], first_name: "C", phone: "5035550903", turnstile_token: "t" });
    expect(res.status).toBe(400);
  });
});
