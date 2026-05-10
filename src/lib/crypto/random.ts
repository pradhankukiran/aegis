import { getSodium } from "./sodium";
import { bytesToBase64Url, bytesToHex } from "./encoding";

/**
 * Cryptographically secure random bytes via libsodium's randombytes_buf,
 * which uses libsodium's CSPRNG (delegating to /dev/urandom or
 * crypto.getRandomValues depending on platform).
 */

export async function randomBytes(length: number): Promise<Uint8Array> {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("randomBytes: length must be a non-negative integer");
  }
  const sodium = await getSodium();
  return sodium.randombytes_buf(length);
}

/**
 * Random URL-safe base64 string. Useful for short identifiers.
 * `length` is the number of random bytes; the resulting string is ~4/3 longer.
 */
export async function randomBase64Url(length = 16): Promise<string> {
  return bytesToBase64Url(await randomBytes(length));
}

/**
 * Random hex string. Useful for human-readable identifiers.
 * `length` is the number of random bytes; resulting string is 2x longer.
 */
export async function randomHex(length = 16): Promise<string> {
  return bytesToHex(await randomBytes(length));
}
