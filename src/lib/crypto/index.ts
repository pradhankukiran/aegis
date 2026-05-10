/**
 * Aegis crypto primitives — barrel exports.
 *
 * All primitives run in the browser. The server only ever sees the outputs
 * (ciphertext, hashes, base64-encoded blobs); it cannot decrypt or recover keys.
 *
 * Crypto choices:
 *  - Symmetric AEAD:  XChaCha20-Poly1305 (24-byte nonce → safe to randomize)
 *  - Password KDF:    Argon2id (RFC 9106), via @noble/hashes
 *  - Random:          libsodium randombytes_buf (CSPRNG)
 *  - Hash:            SHA-256, via @noble/hashes
 *
 * Don't add new ciphers here without an explicit justification — every
 * additional primitive is one more thing to audit.
 */

export {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8Decode,
  utf8Encode,
} from "./encoding";

export {
  AUTH_TAG_BYTES,
  NONCE_BYTES,
  SYMMETRIC_KEY_BYTES,
  decryptBytes,
  encryptBytes,
  generateSymmetricKey,
} from "./symmetric";

export {
  DERIVED_KEY_BYTES,
  SALT_BYTES,
  deriveKey,
  generateSalt,
  getKdfParams,
} from "./kdf";
export type { KdfParams, KdfStrength } from "./kdf";

export { randomBase64Url, randomBytes, randomHex } from "./random";

export { hashEmail, sha256 } from "./hash";

export { getSodium } from "./sodium";
export type { Sodium } from "./sodium";
