import { describe, expect, it } from "vitest";

import { utf8Encode } from "../crypto/encoding";
import { decryptBytes, encryptBytes } from "../crypto/symmetric";

import {
  SCRIBE_AAD,
  deriveMasterKey,
  unwrapNoteContent,
  wrapNoteContent,
} from "./envelope";

/**
 * Build a stub Identity whose `seckey` is a deterministic 32-byte pattern.
 * The two tiers (master key derivation, per-note key generation) make the
 * round-trip deterministic on the master side and random on the per-note
 * side — that's the contract these tests assert.
 */
function stubIdentity(byte: number) {
  return {
    pubkey: new Uint8Array(33),
    seckey: new Uint8Array(32).fill(byte),
    createdAt: 0,
  };
}

describe("scribe / envelope", () => {
  it("derives a 32-byte master key from an identity seckey", () => {
    const id = stubIdentity(0xa1);
    const key = deriveMasterKey(id);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("derives the same master key for the same identity (HKDF determinism)", () => {
    const a = deriveMasterKey(stubIdentity(0xa1));
    const b = deriveMasterKey(stubIdentity(0xa1));
    expect(a).toEqual(b);
  });

  it("derives different master keys for different identities", () => {
    const a = deriveMasterKey(stubIdentity(0xa1));
    const b = deriveMasterKey(stubIdentity(0xb2));
    expect(a).not.toEqual(b);
  });

  it("rejects an identity with a wrong-length seckey", () => {
    const bad = {
      pubkey: new Uint8Array(33),
      seckey: new Uint8Array(16), // wrong
      createdAt: 0,
    };
    expect(() => deriveMasterKey(bad)).toThrow();
  });

  it("round-trips a UTF-8 note body", async () => {
    const masterKey = deriveMasterKey(stubIdentity(0xc3));
    const plaintext = "# Hello\n\nA note with **bold** and a list:\n- one\n- two";
    const envelope = await wrapNoteContent(masterKey, plaintext);
    expect(typeof envelope).toBe("string");
    expect(envelope.length).toBeGreaterThan(0);
    const opened = await unwrapNoteContent(masterKey, envelope);
    expect(opened).toBe(plaintext);
  });

  it("round-trips an empty body", async () => {
    const masterKey = deriveMasterKey(stubIdentity(0xc3));
    const envelope = await wrapNoteContent(masterKey, "");
    const opened = await unwrapNoteContent(masterKey, envelope);
    expect(opened).toBe("");
  });

  it("produces different envelopes for the same plaintext (fresh per-note key + nonce)", async () => {
    const masterKey = deriveMasterKey(stubIdentity(0xc3));
    const a = await wrapNoteContent(masterKey, "same body");
    const b = await wrapNoteContent(masterKey, "same body");
    expect(a).not.toBe(b);
  });

  it("rejects decryption under a different master key (wrong identity)", async () => {
    const keyA = deriveMasterKey(stubIdentity(0xa1));
    const keyB = deriveMasterKey(stubIdentity(0xb2));
    const envelope = await wrapNoteContent(keyA, "only for A");
    await expect(unwrapNoteContent(keyB, envelope)).rejects.toThrow();
  });

  it("binds the AAD: a ciphertext built with a different AAD does not decrypt as a Scribe envelope", async () => {
    const masterKey = deriveMasterKey(stubIdentity(0xc3));
    // Hand-craft an envelope-shaped JSON whose inner ciphertexts are sealed
    // under a *different* AAD. unwrap must reject it because the Scribe
    // unwrap path always passes SCRIBE_AAD ("aegis:notes:v=1").
    const wrongAAD = utf8Encode("aegis:notes:v=2"); // simulated downgrade-target
    // Build a sealed per-note key + payload using the wrong AAD.
    const perNoteKey = new Uint8Array(32).fill(0x42);
    const wrappedKey = await encryptBytes(masterKey, perNoteKey, wrongAAD);
    const payload = await encryptBytes(
      perNoteKey,
      utf8Encode("forged"),
      wrongAAD,
    );
    // Mirror the on-disk JSON shape produced by `wrapNoteContent`.
    const json = JSON.stringify({
      v: 1,
      wrappedKey: bytesToBase64UrlNoPad(wrappedKey),
      payload: bytesToBase64UrlNoPad(payload),
    });
    const envelope = bytesToBase64UrlNoPad(utf8Encode(json));
    await expect(unwrapNoteContent(masterKey, envelope)).rejects.toThrow();
    // Sanity check: the same ciphertext bytes *do* decrypt when you supply
    // the matching AAD directly — proving the failure above is AAD-bound,
    // not key-bound.
    const opened = await decryptBytes(masterKey, wrappedKey, wrongAAD);
    expect(opened).toEqual(perNoteKey);
  });

  it("rejects malformed envelope strings", async () => {
    const masterKey = deriveMasterKey(stubIdentity(0xc3));
    await expect(unwrapNoteContent(masterKey, "")).rejects.toThrow();
    await expect(
      unwrapNoteContent(masterKey, "definitely not base64url JSON"),
    ).rejects.toThrow();
  });

  it("rejects an envelope whose version field is unknown", async () => {
    const masterKey = deriveMasterKey(stubIdentity(0xc3));
    // Build a valid v=1 envelope, then re-serialize with v=99.
    const real = await wrapNoteContent(masterKey, "x");
    const realJson = JSON.parse(
      base64UrlToString(real),
    ) as { v: number; wrappedKey: string; payload: string };
    const tampered = bytesToBase64UrlNoPad(
      utf8Encode(JSON.stringify({ ...realJson, v: 99 })),
    );
    await expect(unwrapNoteContent(masterKey, tampered)).rejects.toThrow();
  });

  it("uses the exact AAD constant `aegis:notes:v=1`", () => {
    // Make the AAD value contract-visible to readers/scanners.
    const decoded = new TextDecoder().decode(SCRIBE_AAD);
    expect(decoded).toBe("aegis:notes:v=1");
  });
});

/* ------------------------------------------------------------------------
 * Local base64url helpers — keep the test file self-contained so a future
 * reader can see exactly what bytes are crossing into and out of the
 * envelope helpers.
 * ---------------------------------------------------------------------- */

function bytesToBase64UrlNoPad(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 =
    typeof btoa !== "undefined"
      ? btoa(bin)
      : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToString(b64url: string): string {
  const stripped = b64url.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padding = (4 - (stripped.length % 4)) % 4;
  const b64 = stripped + "=".repeat(padding);
  const bin =
    typeof atob !== "undefined"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
  return new TextDecoder().decode(
    Uint8Array.from(bin, (c) => c.charCodeAt(0)),
  );
}
