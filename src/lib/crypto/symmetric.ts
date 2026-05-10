import { getSodium } from "./sodium";

/**
 * Symmetric authenticated encryption using XChaCha20-Poly1305 (IETF).
 *
 * - 32-byte key (256-bit)
 * - 24-byte nonce — random per encryption, prepended to the ciphertext
 * - 16-byte Poly1305 tag — appended to the ciphertext (handled by libsodium)
 *
 * The 24-byte nonce makes random nonces safe: birthday-bound collision
 * probability is negligible (~2^-96) even after 2^48 messages with the
 * same key.
 *
 * AAD (additional authenticated data) is optional but recommended when there
 * is context worth binding to the ciphertext (e.g. capsule id, drand round).
 * AAD is authenticated but not encrypted.
 */

export const SYMMETRIC_KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const AUTH_TAG_BYTES = 16;

export async function generateSymmetricKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
}

export async function encryptBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== SYMMETRIC_KEY_BYTES) {
    throw new Error(`encryptBytes: key must be ${SYMMETRIC_KEY_BYTES} bytes`);
  }
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad ?? null,
    null,
    nonce,
    key,
  );
  const out = new Uint8Array(NONCE_BYTES + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, NONCE_BYTES);
  return out;
}

export async function decryptBytes(
  key: Uint8Array,
  sealed: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== SYMMETRIC_KEY_BYTES) {
    throw new Error(`decryptBytes: key must be ${SYMMETRIC_KEY_BYTES} bytes`);
  }
  if (sealed.length < NONCE_BYTES + AUTH_TAG_BYTES) {
    throw new Error("decryptBytes: ciphertext too short");
  }
  const sodium = await getSodium();
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    aad ?? null,
    nonce,
    key,
  );
}
