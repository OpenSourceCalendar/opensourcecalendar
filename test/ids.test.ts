import { describe, it, expect } from "vitest";
import { newId, randomToken, sha256Hex } from "../src/worker/lib/ids";

describe("ids", () => {
  it("makes prefixed unique ids", () => {
    const a = newId("svc");
    expect(a).toMatch(/^svc_[a-z0-9]{20}$/);
    expect(newId("svc")).not.toBe(a);
  });
  it("makes url-safe tokens of 43 characters", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("hashes with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
