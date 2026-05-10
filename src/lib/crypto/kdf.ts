import { argon2idAsync } from "@noble/hashes/argon2.js";

import { utf8Encode } from "./encoding";
import { getSodium } from "./sodium";

/**
 * Password-based key derivation using Argon2id (RFC 9106).
 *
 * - Always 32-byte (256-bit) output, suitable as a symmetric key
 * - 16-byte random salt per derivation; salt must be stored alongside ciphertext
 *   (it is *not* secret, but it must be unique per user/passphrase)
 *
 * Strength presets (browser-friendly, all parallelism=1):
 *  - light:    t=2, m=19 MiB.   **Recovery-code-only.** Below OWASP minimums
 *                               for typical passphrases — pair with a
 *                               high-entropy input (>=128 bits) or use
 *                               `balanced`.
 *  - balanced: t=3, m=64 MiB.   Sane default for typical passphrases.
 *  - strong:   t=4, m=128 MiB.  Use for highest-value secrets on capable devices.
 *
 * The async variant of Argon2id is used so the main thread isn't blocked.
 */

export const SALT_BYTES = 16;
export const DERIVED_KEY_BYTES = 32;

export type KdfStrength = "light" | "balanced" | "strong";

export type KdfParams = {
  t: number;
  m: number;
  p: number;
  dkLen: number;
};

const STRENGTH_PARAMS: Record<KdfStrength, KdfParams> = {
  light: { t: 2, m: 19_456, p: 1, dkLen: DERIVED_KEY_BYTES },
  balanced: { t: 3, m: 65_536, p: 1, dkLen: DERIVED_KEY_BYTES },
  strong: { t: 4, m: 131_072, p: 1, dkLen: DERIVED_KEY_BYTES },
};

export function getKdfParams(strength: KdfStrength): KdfParams {
  return STRENGTH_PARAMS[strength];
}

export async function generateSalt(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(SALT_BYTES);
}

export async function deriveKey(
  passphrase: string | Uint8Array,
  salt: Uint8Array,
  strength: KdfStrength = "balanced",
): Promise<Uint8Array> {
  if (salt.length !== SALT_BYTES) {
    throw new Error(`deriveKey: salt must be ${SALT_BYTES} bytes`);
  }
  const params = getKdfParams(strength);
  const passphraseBytes =
    typeof passphrase === "string" ? utf8Encode(passphrase) : passphrase;
  const result = await argon2idAsync(passphraseBytes, salt, params);
  return result;
}
