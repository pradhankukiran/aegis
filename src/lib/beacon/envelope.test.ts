import { describe, expect, it } from "vitest";

import {
  hexToBytes,
  utf8Decode,
  utf8Encode,
} from "../crypto/encoding";
import { decryptBytes, encryptBytes } from "../crypto/symmetric";

import {
  BEACON_AAD,
  BEACON_KEY_HEX_LENGTH,
  decryptPayload,
  encryptPayload,
} from "./envelope";

describe("beacon / envelope", () => {
  it("AAD constant binds to `aegis:beacon:v=1`", () => {
    expect(utf8Decode(BEACON_AAD)).toBe("aegis:beacon:v=1");
  });

  it("encryptPayload yields a key + ciphertext that round-trip", async () => {
    const { ciphertext, keyHex } = await encryptPayload("hello world");
    expect(keyHex).toHaveLength(BEACON_KEY_HEX_LENGTH);
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    // nonce (24) + tag (16) + body (11)
    expect(ciphertext.length).toBeGreaterThanOrEqual(24 + 16 + 1);
    const opened = await decryptPayload(ciphertext, keyHex);
    expect(opened).toBe("hello world");
  });

  it("encrypts an empty body round-trip", async () => {
    const { ciphertext, keyHex } = await encryptPayload("");
    const opened = await decryptPayload(ciphertext, keyHex);
    expect(opened).toBe("");
  });

  it("encrypts a UTF-8 multibyte body round-trip", async () => {
    const body = "丂 emoji 🚨 unicode";
    const { ciphertext, keyHex } = await encryptPayload(body);
    const opened = await decryptPayload(ciphertext, keyHex);
    expect(opened).toBe(body);
  });

  it("two encrypts of the same plaintext produce different ciphertexts (fresh nonce + key)", async () => {
    const a = await encryptPayload("same body");
    const b = await encryptPayload("same body");
    expect(a.keyHex).not.toBe(b.keyHex);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("rejects a key of the wrong length", async () => {
    const { ciphertext } = await encryptPayload("x");
    await expect(decryptPayload(ciphertext, "abc")).rejects.toThrow(/keyHex/);
  });

  it("rejects malformed key hex", async () => {
    const { ciphertext } = await encryptPayload("x");
    // 64 chars but not hex.
    const bogus = "z".repeat(BEACON_KEY_HEX_LENGTH);
    await expect(decryptPayload(ciphertext, bogus)).rejects.toThrow();
  });

  it("rejects decryption under a different key", async () => {
    const { ciphertext } = await encryptPayload("locked");
    const wrong = await encryptPayload("decoy");
    await expect(decryptPayload(ciphertext, wrong.keyHex)).rejects.toThrow();
  });

  it("AAD binding: ciphertext sealed with a different AAD does not decrypt as a Beacon", async () => {
    // Hand-craft a ciphertext sealed with the *wrong* AAD using the same
    // underlying symmetric primitive. Then ask the Beacon path to open
    // it — it must reject because Beacon always passes BEACON_AAD.
    const { keyHex } = await encryptPayload("seed-for-key-extraction");
    const key = hexToBytes(keyHex);
    const wrongAAD = utf8Encode("aegis:beacon:v=2"); // simulated downgrade-target
    const tampered = await encryptBytes(
      key,
      utf8Encode("forged"),
      wrongAAD,
    );
    await expect(decryptPayload(tampered, keyHex)).rejects.toThrow();
    // Sanity check: decrypting the same bytes WITH the wrong AAD succeeds —
    // proving the failure above is AAD-bound, not key-bound.
    const opened = await decryptBytes(key, tampered, wrongAAD);
    expect(utf8Decode(opened)).toBe("forged");
  });

  it("encrypted bytes carry the 24-byte nonce prefix + 16-byte auth tag", async () => {
    const { ciphertext } = await encryptPayload("xx");
    // nonce: 24, tag: 16, body: 2 → total ≥ 42
    expect(ciphertext.length).toBe(24 + 16 + 2);
  });
});
