import { describe, expect, it } from "vitest";

import { utf8Encode } from "../crypto/encoding";
import { encryptBytes } from "../crypto/symmetric";

import {
  CRUCIBLE_AAD,
  CRUCIBLE_MAX_ATTACHMENT_BYTES,
  decryptDrop,
  encryptDrop,
  packPayload,
  unpackPayload,
} from "./envelope";

/* ---------------------------------------------------------------------------
 * Crucible envelope round-trip
 * --------------------------------------------------------------------------
 * Covers:
 *   - text-only round-trip
 *   - text + single-file attachment round-trip
 *   - AAD-mismatch decrypt failure (binds the envelope to the v=1 scope)
 *   - Wrong-CEK decrypt failure
 *   - Pack/unpack format determinism + truncation rejection
 * ------------------------------------------------------------------------ */

function fixedCek(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function fakeFile(name: string, content: string | Uint8Array): File {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  // Copy into a fresh ArrayBuffer so the File constructor accepts it
  // cleanly on every runtime (happy-dom + node).
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return new File([buf], name, { type: "application/octet-stream" });
}

describe("crucible / envelope", () => {
  it("text-only round-trip", async () => {
    const cek = fixedCek(0xa1);
    const plaintext = "leaked memo: the project is over budget";
    const sealed = await encryptDrop(plaintext, undefined, cek);
    const opened = await decryptDrop(sealed, cek);
    expect(opened.plaintext).toBe(plaintext);
    expect(opened.attachments).toBeUndefined();
  });

  it("text + single file round-trip", async () => {
    const cek = fixedCek(0xb2);
    const plaintext = "# Title\n\nbody with markdown";
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
    const file = fakeFile("evidence.bin", bytes);
    const sealed = await encryptDrop(plaintext, file, cek);
    const opened = await decryptDrop(sealed, cek);
    expect(opened.plaintext).toBe(plaintext);
    expect(opened.attachments?.length).toBe(1);
    expect(opened.attachments?.[0].name).toBe("evidence.bin");
    expect(opened.attachments?.[0].size).toBe(bytes.length);
    expect(opened.attachments?.[0].bytes).toEqual(bytes);
  });

  it("AAD-mismatch decrypt fails", async () => {
    const cek = fixedCek(0xc3);
    // Hand-craft a payload sealed under a different AAD and verify that
    // `decryptDrop` (which always supplies CRUCIBLE_AAD) refuses to open it.
    const wrongAad = utf8Encode("aegis:crucible:v=2");
    const sealedWrongAad = await encryptBytes(
      cek,
      utf8Encode("hello"),
      wrongAad,
    );
    await expect(decryptDrop(sealedWrongAad, cek)).rejects.toBeDefined();
  });

  it("wrong-CEK decrypt fails", async () => {
    const sealed = await encryptDrop("secret", undefined, fixedCek(0xd4));
    await expect(decryptDrop(sealed, fixedCek(0xe5))).rejects.toBeDefined();
  });

  it("two encryptions of the same plaintext under the same CEK differ (random nonce)", async () => {
    const cek = fixedCek(0xf6);
    const a = await encryptDrop("same body", undefined, cek);
    const b = await encryptDrop("same body", undefined, cek);
    expect(a).not.toEqual(b);
  });

  it("packPayload / unpackPayload round-trip is byte-perfect", () => {
    const text = "👋 hello — with unicode";
    const att1 = {
      name: "a.bin",
      size: 5,
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
    };
    const att2 = {
      name: "b.bin",
      size: 3,
      bytes: new Uint8Array([9, 9, 9]),
    };
    const packed = packPayload(text, [att1, att2]);
    const { text: text2, attachments } = unpackPayload(packed);
    expect(text2).toBe(text);
    expect(attachments.length).toBe(2);
    expect(attachments[0]).toEqual(att1);
    expect(attachments[1]).toEqual(att2);
  });

  it("unpackPayload rejects a truncated buffer", () => {
    const packed = packPayload("hello", [
      { name: "x", size: 3, bytes: new Uint8Array([1, 2, 3]) },
    ]);
    // Drop the last byte → attachment body is truncated.
    const truncated = packed.subarray(0, packed.length - 1);
    expect(() => unpackPayload(truncated)).toThrow();
  });

  it("unpackPayload rejects a wrong magic prefix", () => {
    const packed = packPayload("x", []);
    const tampered = packed.slice();
    tampered[0] = 0x00; // first byte of "ACV1"
    expect(() => unpackPayload(tampered)).toThrow();
  });

  it("encryptDrop refuses a wrong-length CEK", async () => {
    await expect(
      encryptDrop("x", undefined, new Uint8Array(16)),
    ).rejects.toThrow();
  });

  it("decryptDrop refuses a wrong-length CEK", async () => {
    const sealed = await encryptDrop("x", undefined, fixedCek(0x77));
    await expect(decryptDrop(sealed, new Uint8Array(16))).rejects.toThrow();
  });

  it("the CRUCIBLE_AAD constant decodes to 'aegis:crucible:v=1'", () => {
    expect(new TextDecoder().decode(CRUCIBLE_AAD)).toBe("aegis:crucible:v=1");
  });

  it("CRUCIBLE_MAX_ATTACHMENT_BYTES is 100 MiB (cap shown to source UI)", () => {
    expect(CRUCIBLE_MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
  });
});
