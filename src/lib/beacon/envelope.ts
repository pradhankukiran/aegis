/**
 * Beacon envelope — XChaCha20-Poly1305 with AAD `aegis:beacon:v=1`.
 *
 * # One-tier key model (different from Scribe's two-tier)
 *
 * A beacon's plaintext is sealed under a freshly minted 32-byte symmetric
 * key. That key is stored alongside the beacon row (`unwrapKeyHex`) so the
 * watchdog can publish it the instant the deadline trips. There's no
 * master-derived wrap layer because:
 *
 *   - The beacon's whole point is that the key eventually escapes, by
 *     design. Wrapping it under another local-only key would just be one
 *     extra hop for no security gain.
 *   - The slow-path (timelock) release event carries the same key inside a
 *     `tlock-js` envelope — so the network-anchored path doesn't need
 *     access to a Scribe-style master either.
 *
 * # AAD binding
 *
 * Every Beacon ciphertext is sealed with AAD `aegis:beacon:v=1`. This:
 *
 *   - Prevents a Scribe (`aegis:notes:v=1`) or Crucible envelope from being
 *     silently decrypted by a Beacon reader.
 *   - Pins the feature + schema version. A future `v=2` cannot be quietly
 *     downgraded into a `v=1` reader's key path.
 *
 * The AAD is the same string for every beacon; we don't bind the beacon id
 * into AAD because the id is only known *after* the key + ciphertext are
 * built (the id is local-only bookkeeping; the release payload carries the
 * id alongside the CID and key so observers can correlate without AAD).
 */

import { bytesToHex, hexToBytes, utf8Decode, utf8Encode } from "../crypto/encoding";
import {
  decryptBytes,
  encryptBytes,
  generateSymmetricKey,
} from "../crypto/symmetric";

/** AAD bound to every Beacon ciphertext. */
export const BEACON_AAD = utf8Encode("aegis:beacon:v=1");

/** Length of a hex-encoded 32-byte symmetric key (64 chars). */
export const BEACON_KEY_HEX_LENGTH = 64;

/**
 * Encrypt a plaintext message into a Beacon ciphertext.
 *
 *   1. Mint a fresh 32-byte symmetric key.
 *   2. Encrypt UTF-8(plaintext) under that key with AAD `aegis:beacon:v=1`.
 *   3. Return `{ciphertext, keyHex}` — the caller persists `keyHex` locally
 *      (so the fast path can fire) and ships `ciphertext` to Pinata.
 *
 * The bytes returned by `encryptBytes` are `nonce || ciphertext || tag` —
 * see `crypto/symmetric.ts` for the layout.
 */
export async function encryptPayload(
  plaintext: string,
): Promise<{ ciphertext: Uint8Array; keyHex: string }> {
  const key = await generateSymmetricKey();
  const ciphertext = await encryptBytes(key, utf8Encode(plaintext), BEACON_AAD);
  const keyHex = bytesToHex(key);
  return { ciphertext, keyHex };
}

/**
 * Decrypt a Beacon ciphertext using the hex-encoded key from a
 * ReleasePayload. Throws on:
 *   - malformed key hex (wrong length / non-hex chars)
 *   - tampered ciphertext (Poly1305 auth fail)
 *   - wrong AAD (e.g. a Scribe envelope passed in by mistake)
 *
 * Observers call this after fetching the Pinata blob; the user themselves
 * doesn't need to decrypt their own beacon (they wrote it).
 */
export async function decryptPayload(
  ciphertext: Uint8Array,
  keyHex: string,
): Promise<string> {
  if (keyHex.length !== BEACON_KEY_HEX_LENGTH) {
    throw new Error(
      `decryptPayload: keyHex must be ${BEACON_KEY_HEX_LENGTH} chars (got ${keyHex.length})`,
    );
  }
  let key: Uint8Array;
  try {
    key = hexToBytes(keyHex);
  } catch (err) {
    throw new Error(
      `decryptPayload: malformed keyHex (${describeError(err)})`,
    );
  }
  const plaintext = await decryptBytes(key, ciphertext, BEACON_AAD);
  return utf8Decode(plaintext);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
