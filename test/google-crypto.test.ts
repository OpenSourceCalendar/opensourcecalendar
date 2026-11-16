import { describe, it, expect } from "vitest";
import { openToken, sealToken } from "../src/worker/google/crypto";

const KEY = "Sup-0NtMrEdeKvsoT-KgoFcaYvo7wQYpM5igPaPCaeY";
const OTHER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("token encryption", () => {
  it("round-trips, and never stores the token in clear", async () => {
    const sealed = await sealToken(KEY, "cal_1", "1//refresh-token");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("refresh");
    expect(await openToken(KEY, "cal_1", sealed)).toBe("1//refresh-token");
  });
  it("gives a different result each time (random IV)", async () => {
    expect(await sealToken(KEY, "cal_1", "x")).not.toBe(await sealToken(KEY, "cal_1", "x"));
  });
  it("won't open for another calendar, another key, or damaged text", async () => {
    const sealed = await sealToken(KEY, "cal_1", "secret");
    expect(await openToken(KEY, "cal_2", sealed)).toBeNull();
    expect(await openToken(OTHER, "cal_1", sealed)).toBeNull();
    const [v, iv, ct] = sealed.split(".");
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(await openToken(KEY, "cal_1", `${v}.${iv}.${flipped}`)).toBeNull();
    expect(await openToken(KEY, "cal_1", "garbage")).toBeNull();
  });
  it("accepts a standard base64 key too", async () => {
    const std = "Sup+0NtMrEdeKvsoT+KgoFcaYvo7wQYpM5igPaPCaeY=";
    expect(await openToken(std, "c", await sealToken(KEY, "c", "t"))).toBe("t");
  });
  it("throws on a key of the wrong size (a setup mistake should be loud)", async () => {
    await expect(sealToken("c2hvcnQ", "c", "t")).rejects.toThrow(/GOOGLE_TOKEN_KEY/);
  });
});
