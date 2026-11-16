import { describe, it, expect } from "vitest";
import { signState, verifyState } from "../src/worker/google/state";
import { signSession, verifySession } from "../src/worker/lib/session";

const S = "test-session-secret";

describe("OAuth state", () => {
  it("carries the calendar id and nonce, and expires after 15 minutes", async () => {
    const t = await signState(S, "cal_9", "nonce-1", 1_000);
    expect(await verifyState(S, t, 1_000 + 14 * 60_000)).toEqual({ calendarId: "cal_9", nonce: "nonce-1" });
    expect(await verifyState(S, t, 1_000 + 16 * 60_000)).toBeNull();
  });
  it("rejects tampering and another secret", async () => {
    const t = await signState(S, "cal_9", "n", 1_000);
    const [p, sig] = t.split(".");
    const forged = btoa(JSON.stringify({ c: "cal_other", exp: 9e15, n: "n" })).replace(/=+$/, "");
    expect(await verifyState(S, `${forged}.${sig}`, 1_000)).toBeNull();
    expect(await verifyState("other", t, 1_000)).toBeNull();
    expect(await verifyState(S, `${p}.${sig}.x`, 1_000)).toBeNull();
  });
  it("a state is not a session and a session is not a state", async () => {
    const state = await signState(S, "cal_9", "n", 1_000);
    expect(await verifySession(S, state, 1_000)).toBeNull();
    const session = await signSession(S, { a: "cal_9", u: "x" }, 1_000, 60_000);
    expect(await verifyState(S, session, 1_000)).toBeNull();
  });
});
