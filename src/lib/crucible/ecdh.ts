/**
 * Crucible — ECDH key derivation for source ↔ newsroom encryption.
 *
 * # The derivation
 *
 *     shared33 = secp256k1.getSharedSecret(seckey, peerPubkey, /*compressed*\/ true)
 *     xCoord   = shared33.subarray(1)                                 // 32 bytes
 *     CEK      = hkdf(sha256, xCoord, salt=undefined,
 *                     info=utf8("aegis-crucible-ecdh-v1"), 32)        // 32 bytes
 *
 * Both sides agree on this exact recipe, otherwise the produced CEK
 * differs and the XChaCha20-Poly1305 envelope won't decrypt.
 *
 * # Why drop the parity byte
 *
 * `getSharedSecret(..., true)` returns the SEC1-compressed representation
 * (33 bytes) of `seckey * peerPubkey`. The leading byte (0x02 or 0x03) is
 * the parity prefix and depends on the y-coordinate's odd/even-ness. For
 * an ECDH-derived shared key the parity is irrelevant — both parties
 * compute the same point — so we strip it and feed the 32-byte x-coord
 * into HKDF. This matches the NIP-44 v2 and BIP-340 convention of using
 * just the x-coordinate as the canonical pubkey.
 *
 * # Why HKDF and not "use x-coord directly"
 *
 * Raw EC x-coordinates aren't uniformly distributed over 2^256 — they're
 * field elements modulo `p`. HKDF-extract turns a non-uniform IKM into a
 * uniformly random PRK; HKDF-expand then derives the application key.
 * The `info` string also gives us cryptographic domain separation: a
 * future v=2 envelope (or a different feature reusing ECDH on the same
 * secp256k1 keypair) cannot produce a colliding CEK.
 *
 * # Public key form acceptance
 *
 * `getSharedSecret(seckey, peerPubkey, true)` accepts the peer pubkey in
 * either 33-byte SEC1-compressed form (with parity prefix) or 65-byte
 * SEC1-uncompressed form. The 32-byte x-only form (BIP-340) does NOT
 * work — secp256k1 needs the full point to compute scalar multiplication.
 *
 * Crucible policy: callers may supply pubkeys in:
 *   - 64 hex chars (32 bytes, x-only)  → we lift to compressed by
 *                                         prepending 0x02 (even y; works
 *                                         because the resulting shared
 *                                         secret x-coord is the same as
 *                                         for 0x03 — both points share
 *                                         x, only y differs).
 *   - 66 hex chars (33 bytes, SEC1-compressed) → forwarded verbatim.
 *
 * That x-only → compressed lift is what NIP-44 v2 does. It also matches
 * Aegis's identity model: Herald + Atlas surface x-only forms on the
 * wire, so a newsroom that copies its pubkey from one of those features
 * sees a 64-char hex string, and Crucible Just Works.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { hexToBytes, utf8Encode } from "../crypto/encoding";

/**
 * The HKDF `info` string. Single source of truth — every reference to
 * this constant binds the derived key to the Crucible v=1 protocol.
 *
 * Changing this string is a wire-breaking change.
 */
export const CRUCIBLE_KDF_INFO = utf8Encode("aegis-crucible-ecdh-v1");

/** Length of the derived content-encryption-key, in bytes. */
export const CRUCIBLE_CEK_BYTES = 32;

/**
 * Normalize a peer pubkey input into the 33-byte SEC1-compressed form
 * the noble curves API consumes.
 *
 *  - 33-byte input → returned unchanged.
 *  - 32-byte input → prepended with 0x02 (even-y assumption).
 *
 * Returns a fresh Uint8Array. Throws on any other length.
 */
export function normalizePeerPubkey(peerPubkey: Uint8Array): Uint8Array {
  if (peerPubkey.length === 33) {
    return peerPubkey.slice();
  }
  if (peerPubkey.length === 32) {
    // Lift the x-only form to compressed by assuming even-y. ECDH against
    // the alternative point (odd-y) produces the SAME x-coordinate of the
    // shared secret, so the derived CEK is identical. This is the
    // canonical NIP-44 trick.
    const lifted = new Uint8Array(33);
    lifted[0] = 0x02;
    lifted.set(peerPubkey, 1);
    return lifted;
  }
  throw new Error(
    `normalizePeerPubkey: expected 32 or 33 bytes, got ${peerPubkey.length}`,
  );
}

/**
 * Parse a hex pubkey (64 or 66 chars) into bytes and normalize to the
 * 33-byte SEC1-compressed form expected by `deriveSharedKey`. Lowercase /
 * mixed-case input is accepted.
 */
export function peerPubkeyBytesFromHex(hex: string): Uint8Array {
  const trimmed = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(trimmed)) {
    throw new Error("peerPubkeyBytesFromHex: must be hex");
  }
  if (trimmed.length !== 64 && trimmed.length !== 66) {
    throw new Error(
      `peerPubkeyBytesFromHex: expected 64 or 66 hex chars, got ${trimmed.length}`,
    );
  }
  return normalizePeerPubkey(hexToBytes(trimmed));
}

/**
 * Derive a 32-byte content-encryption-key (CEK) from a local seckey and a
 * peer pubkey using ECDH + HKDF-SHA256. Both the source-side encrypt path
 * and the newsroom-side decrypt path call this with the symmetric inputs
 * (own seckey, peer's pubkey) and must produce the SAME 32 bytes.
 *
 * @param seckey      32-byte secp256k1 secret scalar (caller-owned).
 * @param peerPubkey  Peer's pubkey — either 32-byte x-only or 33-byte
 *                    SEC1-compressed. We normalize internally.
 * @returns           32-byte CEK suitable for `encryptBytes`/`decryptBytes`.
 *
 * The function does NOT touch the input seckey beyond passing it to
 * `getSharedSecret`. Caller is responsible for `seckey.fill(0)` after
 * the CEK is no longer needed (the CEK itself can be wiped separately).
 */
export function deriveSharedKey(
  seckey: Uint8Array,
  peerPubkey: Uint8Array,
): Uint8Array {
  if (seckey.length !== 32) {
    throw new Error(`deriveSharedKey: seckey must be 32 bytes, got ${seckey.length}`);
  }
  const peer = normalizePeerPubkey(peerPubkey);
  const shared33 = secp256k1.getSharedSecret(seckey, peer, true);
  if (shared33.length !== 33) {
    throw new Error(
      `deriveSharedKey: unexpected shared secret length ${shared33.length}`,
    );
  }
  // Drop the parity prefix; HKDF over the 32-byte x-coordinate.
  const ikm = shared33.subarray(1);
  return hkdf(sha256, ikm, undefined, CRUCIBLE_KDF_INFO, CRUCIBLE_CEK_BYTES);
}
