import { describe, expect, it } from "vitest";

import { DERIVED_KEY_BYTES, SALT_BYTES, deriveKey, generateSalt } from "./kdf";

describe("kdf (Argon2id)", () => {
  it("generates a 16-byte salt", async () => {
    const salt = await generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(SALT_BYTES);
  });

  it("salts are unique", async () => {
    const a = await generateSalt();
    const b = await generateSalt();
    expect(a).not.toEqual(b);
  });

  it("derives a 32-byte key with the light preset", async () => {
    const salt = await generateSalt();
    const key = await deriveKey("secret passphrase", salt, "light");
    expect(key.length).toBe(DERIVED_KEY_BYTES);
  });

  it("same input produces same output (deterministic given salt)", async () => {
    const salt = await generateSalt();
    const a = await deriveKey("hello", salt, "light");
    const b = await deriveKey("hello", salt, "light");
    expect(a).toEqual(b);
  });

  it("different salts produce different keys for the same passphrase", async () => {
    const saltA = await generateSalt();
    const saltB = await generateSalt();
    const a = await deriveKey("same passphrase", saltA, "light");
    const b = await deriveKey("same passphrase", saltB, "light");
    expect(a).not.toEqual(b);
  });

  it("different passphrases produce different keys for the same salt", async () => {
    const salt = await generateSalt();
    const a = await deriveKey("passphrase a", salt, "light");
    const b = await deriveKey("passphrase b", salt, "light");
    expect(a).not.toEqual(b);
  });

  it("rejects wrong-size salt", async () => {
    const badSalt = new Uint8Array(8);
    await expect(deriveKey("x", badSalt, "light")).rejects.toThrow();
  });
});
