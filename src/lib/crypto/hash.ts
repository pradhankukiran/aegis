import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

import { utf8Encode } from "./encoding";

/**
 * SHA-256. Use for:
 *  - Email hashing for trustees (server stores hash, not plaintext email)
 *  - Content fingerprinting (compare two ciphertexts equal)
 *  - General-purpose digest where collision-resistance is needed
 *
 * Do NOT use for password hashing — use deriveKey from kdf.ts for that.
 */

export function sha256(input: string | Uint8Array): Uint8Array {
  const bytes = typeof input === "string" ? utf8Encode(input) : input;
  return nobleSha256(bytes);
}

/**
 * Hash an email for storage/comparison.
 * Lowercases and trims to normalize before hashing.
 */
export function hashEmail(email: string): Uint8Array {
  const normalized = email.trim().toLowerCase();
  return sha256(normalized);
}
