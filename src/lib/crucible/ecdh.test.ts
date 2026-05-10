import { describe, expect, it } from "vitest";

import { bytesToHex } from "../crypto/encoding";
import { generateIdentity } from "../identity";

import {
  CRUCIBLE_CEK_BYTES,
  CRUCIBLE_KDF_INFO,
  deriveSharedKey,
  normalizePeerPubkey,
  peerPubkeyBytesFromHex,
} from "./ecdh";
import { generateEphemeralIdentity } from "./ephemeral";

/* ---------------------------------------------------------------------------
 * ECDH reciprocity — the core property
 * --------------------------------------------------------------------------
 * The source and newsroom must derive the SAME 32-byte CEK from their
 * reciprocal (seckey, peer-pubkey) pairings. If this round-trips, the rest
 * of the envelope round-trip is a property of XChaCha20-Poly1305 (already
 * tested in lib/crypto/symmetric).
 * ------------------------------------------------------------------------ */

describe("crucible / ecdh", () => {
  it("the source-side and newsroom-side derivations produce the same CEK", async () => {
    // Newsroom = persistent Aegis identity. Source = one-shot ephemeral.
    const newsroom = await generateIdentity();
    const ephemeral = await generateEphemeralIdentity();

    const sourceSideCek = deriveSharedKey(ephemeral.seckey, newsroom.pubkey);
    const newsroomSideCek = deriveSharedKey(newsroom.seckey, ephemeral.pubkey);

    expect(sourceSideCek).toEqual(newsroomSideCek);
    expect(sourceSideCek.length).toBe(CRUCIBLE_CEK_BYTES);
  });

  it("different ephemerals against the same newsroom produce different CEKs", async () => {
    const newsroom = await generateIdentity();
    const e1 = await generateEphemeralIdentity();
    const e2 = await generateEphemeralIdentity();
    const k1 = deriveSharedKey(e1.seckey, newsroom.pubkey);
    const k2 = deriveSharedKey(e2.seckey, newsroom.pubkey);
    expect(k1).not.toEqual(k2);
  });

  it("the x-only (32-byte) form of the peer pubkey produces the same CEK", async () => {
    // NIP-44-style: a 64-char x-only hex lifts to compressed (with even-y
    // assumption) and ECDH against the alternative point produces the same
    // x-coordinate, so the derived CEK matches the 66-char-form derivation.
    const newsroom = await generateIdentity();
    const ephemeral = await generateEphemeralIdentity();
    const xOnly = newsroom.pubkey.subarray(1); // strip parity prefix
    const cekViaCompressed = deriveSharedKey(ephemeral.seckey, newsroom.pubkey);
    const cekViaXOnly = deriveSharedKey(ephemeral.seckey, xOnly);
    expect(cekViaXOnly).toEqual(cekViaCompressed);
  });

  it("rejects a wrong-length seckey", async () => {
    const newsroom = await generateIdentity();
    expect(() => deriveSharedKey(new Uint8Array(16), newsroom.pubkey)).toThrow();
  });

  it("normalizePeerPubkey lifts 32→33 by prepending 0x02", () => {
    const x = new Uint8Array(32).fill(0xab);
    const lifted = normalizePeerPubkey(x);
    expect(lifted.length).toBe(33);
    expect(lifted[0]).toBe(0x02);
    expect(lifted.subarray(1)).toEqual(x);
  });

  it("normalizePeerPubkey returns a fresh copy for 33-byte input", () => {
    const c = new Uint8Array(33).fill(0x42);
    c[0] = 0x03;
    const out = normalizePeerPubkey(c);
    expect(out).not.toBe(c);
    expect(out).toEqual(c);
  });

  it("normalizePeerPubkey rejects wrong lengths", () => {
    expect(() => normalizePeerPubkey(new Uint8Array(31))).toThrow();
    expect(() => normalizePeerPubkey(new Uint8Array(34))).toThrow();
  });

  it("peerPubkeyBytesFromHex accepts both 64- and 66-char hex", async () => {
    const id = await generateIdentity();
    const hex66 = bytesToHex(id.pubkey);
    expect(hex66.length).toBe(66);
    const hex64 = hex66.slice(2);
    const from66 = peerPubkeyBytesFromHex(hex66);
    const from64 = peerPubkeyBytesFromHex(hex64);
    expect(from66.length).toBe(33);
    expect(from64.length).toBe(33);
    // Note: the 64-char path lifts with 0x02 parity; the 66-char path
    // preserves whichever parity was in the input. They MAY differ here
    // in the prefix byte; what matters is that ECDH derives the same CEK
    // (covered by the x-only test above).
    expect(from66.subarray(1)).toEqual(from64.subarray(1));
  });

  it("peerPubkeyBytesFromHex is case-insensitive", () => {
    const lower = "02" + "ab".repeat(32);
    const upper = lower.toUpperCase();
    const lo = peerPubkeyBytesFromHex(lower);
    const up = peerPubkeyBytesFromHex(upper);
    expect(lo).toEqual(up);
  });

  it("peerPubkeyBytesFromHex rejects non-hex / wrong-length input", () => {
    expect(() => peerPubkeyBytesFromHex("not-hex!!")).toThrow();
    expect(() => peerPubkeyBytesFromHex("aa".repeat(31))).toThrow();
    expect(() => peerPubkeyBytesFromHex("aa".repeat(40))).toThrow();
  });

  it("exposes the canonical KDF info string 'aegis-crucible-ecdh-v1'", () => {
    const decoded = new TextDecoder().decode(CRUCIBLE_KDF_INFO);
    expect(decoded).toBe("aegis-crucible-ecdh-v1");
  });
});
