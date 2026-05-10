import { describe, expect, it } from "vitest";

import { utf8Decode, utf8Encode } from "./encoding";
import {
  AUTH_TAG_BYTES,
  NONCE_BYTES,
  SYMMETRIC_KEY_BYTES,
  decryptBytes,
  encryptBytes,
  generateSymmetricKey,
} from "./symmetric";

describe("symmetric (XChaCha20-Poly1305)", () => {
  it("generates 32-byte keys", async () => {
    const key = await generateSymmetricKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(SYMMETRIC_KEY_BYTES);
  });

  it("generates unique keys", async () => {
    const a = await generateSymmetricKey();
    const b = await generateSymmetricKey();
    expect(a).not.toEqual(b);
  });

  it("round-trips a UTF-8 message", async () => {
    const key = await generateSymmetricKey();
    const plaintext = utf8Encode("hello, sealed world");
    const sealed = await encryptBytes(key, plaintext);
    const opened = await decryptBytes(key, sealed);
    expect(utf8Decode(opened)).toBe("hello, sealed world");
  });

  it("round-trips binary data", async () => {
    const key = await generateSymmetricKey();
    const plaintext = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const sealed = await encryptBytes(key, plaintext);
    const opened = await decryptBytes(key, sealed);
    expect(opened).toEqual(plaintext);
  });

  it("produces ciphertext with nonce prepended and auth tag appended", async () => {
    const key = await generateSymmetricKey();
    const plaintext = utf8Encode("x");
    const sealed = await encryptBytes(key, plaintext);
    expect(sealed.length).toBe(NONCE_BYTES + plaintext.length + AUTH_TAG_BYTES);
  });

  it("uses a fresh nonce each call (different ciphertexts for same plaintext)", async () => {
    const key = await generateSymmetricKey();
    const plaintext = utf8Encode("same message");
    const sealedA = await encryptBytes(key, plaintext);
    const sealedB = await encryptBytes(key, plaintext);
    expect(sealedA).not.toEqual(sealedB);
  });

  it("rejects ciphertext modified by even one bit", async () => {
    const key = await generateSymmetricKey();
    const sealed = await encryptBytes(key, utf8Encode("integrity"));
    // Flip a bit in the auth tag region
    sealed[sealed.length - 1] ^= 0x01;
    await expect(decryptBytes(key, sealed)).rejects.toThrow();
  });

  it("rejects decryption with the wrong key", async () => {
    const keyA = await generateSymmetricKey();
    const keyB = await generateSymmetricKey();
    const sealed = await encryptBytes(keyA, utf8Encode("for a only"));
    await expect(decryptBytes(keyB, sealed)).rejects.toThrow();
  });

  it("authenticates AAD: tampering with AAD breaks decryption", async () => {
    const key = await generateSymmetricKey();
    const aadA = utf8Encode("capsule:abc");
    const aadB = utf8Encode("capsule:xyz");
    const sealed = await encryptBytes(key, utf8Encode("hi"), aadA);
    await expect(decryptBytes(key, sealed, aadB)).rejects.toThrow();
  });

  it("AAD must match exactly: missing AAD on decrypt fails", async () => {
    const key = await generateSymmetricKey();
    const sealed = await encryptBytes(key, utf8Encode("hi"), utf8Encode("ctx"));
    await expect(decryptBytes(key, sealed)).rejects.toThrow();
  });

  it("rejects truncated ciphertext", async () => {
    const key = await generateSymmetricKey();
    const sealed = await encryptBytes(key, utf8Encode("hi"));
    await expect(decryptBytes(key, sealed.subarray(0, 10))).rejects.toThrow();
  });

  it("rejects wrong-size keys", async () => {
    const tooShort = new Uint8Array(16);
    await expect(encryptBytes(tooShort, utf8Encode("x"))).rejects.toThrow();
    await expect(
      decryptBytes(tooShort, new Uint8Array(NONCE_BYTES + AUTH_TAG_BYTES + 1)),
    ).rejects.toThrow();
  });

  // Mirrors the AAD pattern used by feature envelopes: the envelope version +
  // feature label + any contextual fields are bound via AAD so a forged
  // envelope claiming a different version, feature, or context cannot be
  // silently substituted at decrypt time.
  describe("envelope-style AAD binding", () => {
    it("round-trips when AAD matches; rejects when AAD differs", async () => {
      const key = await generateSymmetricKey();
      const aadA = utf8Encode("aegis:test:v=1:round=42:chain=AAA");
      const aadB = utf8Encode("aegis:test:v=1:round=42:chain=BBB");
      const sealed = await encryptBytes(key, utf8Encode("inside"), aadA);

      const opened = await decryptBytes(key, sealed, aadA);
      expect(utf8Decode(opened)).toBe("inside");

      await expect(decryptBytes(key, sealed, aadB)).rejects.toThrow();
    });

    it("rejects cross-feature confusion (one feature's AAD vs another's)", async () => {
      const key = await generateSymmetricKey();
      const featureAAad = utf8Encode("aegis:feature-a:v=1");
      const featureBAad = utf8Encode("aegis:feature-b:v=1");
      const sealed = await encryptBytes(key, utf8Encode("payload"), featureAAad);

      // Same key, same ciphertext bytes, different feature label → must fail.
      await expect(decryptBytes(key, sealed, featureBAad)).rejects.toThrow();
    });

    it("rejects envelope version downgrade (v=2 → v=1)", async () => {
      const key = await generateSymmetricKey();
      const v2 = utf8Encode("aegis:test:v=2");
      const v1 = utf8Encode("aegis:test:v=1");
      const sealed = await encryptBytes(key, utf8Encode("payload"), v2);

      await expect(decryptBytes(key, sealed, v1)).rejects.toThrow();
    });
  });
});
