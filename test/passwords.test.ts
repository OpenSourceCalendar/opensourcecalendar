import { describe, it, expect } from "vitest";
import { DUMMY_HASH, hashPassword, needsRehash, passwordProblem, passwordsOn, verifyPassword } from "../src/worker/accounts/password";
import { testEnv } from "./helpers";

const PW = "correct horse battery staple";

describe("hashing", () => {
  it("round trip; a wrong password fails; the stored form says how it was made", async () => {
    const h = await hashPassword(testEnv, PW);
    expect(h).toMatch(/^argon2id\$m=19456,t=2,p=1\$p1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword(testEnv, PW, h)).toBe(true);
    expect(await verifyPassword(testEnv, `${PW}!`, h)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword(testEnv, PW)).not.toBe(await hashPassword(testEnv, PW));
  });

  it("needs the pepper: the same hash fails with another one", async () => {
    const h = await hashPassword(testEnv, PW);
    expect(await verifyPassword({ ...testEnv, PASSWORD_PEPPER: "another-pepper" }, PW, h)).toBe(false);
  });

  it("normalizes to NFC: composed and decomposed accents are the same password", async () => {
    const composed = "café au lait every single morning";
    const h = await hashPassword(testEnv, composed);
    expect(await verifyPassword(testEnv, composed.normalize("NFD"), h)).toBe(true);
  });

  it("re-hash: older settings yes, current no; weaker settings still verify; garbage never does", async () => {
    const old = await hashPassword(testEnv, PW, { m: 1024, t: 1, p: 1 });
    expect(old).toMatch(/^argon2id\$m=1024,t=1,p=1\$p1\$/);
    expect(needsRehash(old)).toBe(true);
    expect(await verifyPassword(testEnv, PW, old)).toBe(true);
    expect(needsRehash(await hashPassword(testEnv, PW))).toBe(false);
    // A PBKDF2-style row (the plan's fallback format) or another pepper id is re-made at the next sign-in.
    expect(needsRehash(`pbkdf2-sha256$i=100000$p1$${"A".repeat(22)}$${"A".repeat(43)}`)).toBe(true);
    expect(needsRehash(`argon2id$m=19456,t=2,p=1$p2$${"A".repeat(22)}$${"A".repeat(43)}`)).toBe(true);
    const salt = "A".repeat(22);
    const hash = "A".repeat(43);
    for (const bad of [
      "",
      "nope",
      `pbkdf2-sha256$i=100000$p1$${salt}$${hash}`,
      `argon2id$m=99999,t=2,p=1$p1$${salt}$${hash}`, // stronger than we make: refused, not run
      `argon2id$m=19456,t=9,p=1$p1$${salt}$${hash}`,
      `argon2id$m=19456,t=2,p=1$p9$${salt}$${hash}`,
      `argon2id$m=19456,t=2,p=1$p1$AAAA$${hash}`,
      `argon2id$m=19456,t=2,p=1$p1$${salt}$${hash}$extra`,
    ]) {
      expect(await verifyPassword(testEnv, PW, bad)).toBe(false);
    }
  });

  it("the dummy hash is well-formed (full work) and never matches a real try", async () => {
    expect(DUMMY_HASH).toBe(`argon2id$m=19456,t=2,p=1$p1$${"A".repeat(22)}$${"A".repeat(43)}`);
    expect(needsRehash(DUMMY_HASH)).toBe(false); // same format and settings as a real hash, so the same work
    for (const pw of [PW, "", "a".repeat(15)]) expect(await verifyPassword(testEnv, pw, DUMMY_HASH)).toBe(false);
  });
});

describe("rules", () => {
  it("15 to 256 characters, counted as characters", () => {
    expect(passwordProblem("a".repeat(14))).toBe("too_short");
    expect(passwordProblem("a".repeat(15))).toBeNull();
    expect(passwordProblem("a".repeat(256))).toBeNull();
    expect(passwordProblem("a".repeat(257))).toBe("too_long");
    expect(passwordProblem("😀".repeat(15))).toBeNull(); // 30 UTF-16 units, 15 characters
  });

  it("is on only for the hosted service with a pepper", () => {
    const hosted = { ...testEnv, SIGNUP: "invite", PUBLIC_URL: "https://book.example.test" };
    expect(passwordsOn(hosted)).toBe(true);
    expect(passwordsOn({ ...hosted, PASSWORD_PEPPER: undefined })).toBe(false);
    expect(passwordsOn(testEnv)).toBe(false);
  });
});
