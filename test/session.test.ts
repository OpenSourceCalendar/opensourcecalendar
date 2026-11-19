import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "../src/worker/lib/session";

const SECRET = "s3cret";

describe("session tokens", () => {
  it("round-trips app and user before expiry", async () => {
    const t = await signSession(SECRET, { a: "app_1", u: "user-1" }, 1000, 60_000);
    expect(await verifySession(SECRET, t, 2000)).toEqual({ a: "app_1", u: "user-1", exp: 61_000, v: 0, t: 1000 });
  });

  it("carries a version when given one", async () => {
    const t = await signSession(SECRET, { a: "app_1", u: "user-1", v: 3 }, 1000, 60_000);
    expect(await verifySession(SECRET, t, 2000)).toEqual({ a: "app_1", u: "user-1", exp: 61_000, v: 3, t: 1000 });
  });

  it("a re-issued token keeps the sign-in's issue time", async () => {
    const t = await signSession(SECRET, { a: "app_1", u: "user-1", v: 1, t: 400 }, 1000, 60_000);
    expect(await verifySession(SECRET, t, 2000)).toEqual({ a: "app_1", u: "user-1", exp: 61_000, v: 1, t: 400 });
  });
  it("rejects expired, tampered, wrong-secret and junk tokens", async () => {
    const t = await signSession(SECRET, { a: "app_1", u: "user-1" }, 1000, 60_000);
    expect(await verifySession(SECRET, t, 61_001)).toBeNull();
    const [p, s] = t.split(".");
    const forged = btoa(JSON.stringify({ a: "app_2", u: "user-1", exp: 61_000 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifySession(SECRET, `${forged}.${s}`, 2000)).toBeNull();
    expect(await verifySession("other", t, 2000)).toBeNull();
    expect(await verifySession(SECRET, `${p}`, 2000)).toBeNull();
    expect(await verifySession(SECRET, "not.a-token", 2000)).toBeNull();
  });
});
