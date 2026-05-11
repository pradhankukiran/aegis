// Aegis master identity is a single secp256k1 keypair: Nostr-native (BIP-340)
// and the seed for everything else. Matrix uses its own device-key protocol
// (Curve25519 + Ed25519 + cross-signing) layered on top — NOT derived from
// this keypair directly.

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { bytesToBase64Url, bytesToHex } from "../crypto/encoding";
import { randomBytes } from "../crypto/random";

/** Length of a secp256k1 secret scalar. */
export const SECKEY_BYTES = 32;
/** Length of a compressed secp256k1 public point (SEC1: 0x02/0x03 prefix + x). */
export const PUBKEY_BYTES = 33;

/**
 * The master identity for an Aegis app instance.
 *
 *  - `pubkey`    33-byte compressed secp256k1 public key
 *  - `seckey`    32-byte secp256k1 secret scalar (raw bytes — keep secret!)
 *  - `createdAt` Unix milliseconds at the moment of generation
 */
export type Identity = {
  pubkey: Uint8Array;
  seckey: Uint8Array;
  createdAt: number;
};

/**
 * Generate a fresh master identity. Uses libsodium's CSPRNG (via
 * `randomBytes`) to sample the secret scalar, then derives the compressed
 * public key via @noble/curves.
 *
 * The `randomSecretKey` helper is not used here so the call goes through our
 * project-wide `randomBytes` boundary (one auditable randomness source).
 */
export async function generateIdentity(): Promise<Identity> {
  const seckey = await randomBytes(SECKEY_BYTES);
  const pubkey = secp256k1.getPublicKey(seckey, true);
  if (pubkey.length !== PUBKEY_BYTES) {
    throw new Error(
      `generateIdentity: unexpected pubkey length ${pubkey.length}`,
    );
  }
  return { pubkey, seckey, createdAt: Date.now() };
}

/**
 * Hex-encode the public key (66 hex chars: 1-byte prefix + 32-byte x).
 * Useful for logs, URLs, and debug display.
 */
export function pubkeyHex(id: Identity): string {
  return bytesToHex(id.pubkey);
}

/**
 * URL-safe base64 of the compressed public key (44 chars, no padding).
 */
export function pubkeyBase64Url(id: Identity): string {
  return bytesToBase64Url(id.pubkey);
}

// TODO Phase 2: npub() — bech32 NIP-19 encoding once nostr-tools is installed.
//                      Will encode the x-only (32-byte) form expected by Nostr.
