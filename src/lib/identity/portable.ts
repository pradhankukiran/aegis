/**
 * Portable, versioned identity envelope for export / import flows.
 *
 * Format (v=1):
 *   "aegis:id:v=1:" + base64url(JSON.stringify({ seckey, createdAt }))
 *
 * The body carries only the secret scalar plus its creation timestamp. The
 * public key is re-derived from the secret on import — keeping the exported
 * blob smaller and ensuring importer-side consistency (you cannot import a
 * pubkey that doesn't match its seckey).
 *
 * The blob is NOT encrypted. It is identity material — protect it the way
 * you would protect a master password (paper, keychain, hardware token).
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  utf8Decode,
  utf8Encode,
} from "../crypto/encoding";

import { PUBKEY_BYTES, SECKEY_BYTES, type Identity } from "./keypair";

const PREFIX = "aegis:id:v=1:";

type EnvelopeBody = {
  seckey: string; // base64url of 32-byte scalar
  createdAt: number;
};

function isEnvelopeBody(x: unknown): x is EnvelopeBody {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.seckey === "string" && typeof o.createdAt === "number";
}

/**
 * Serialize an identity to a transportable string. Round-trips with
 * `importIdentity`.
 */
export function exportIdentity(id: Identity): string {
  if (id.seckey.length !== SECKEY_BYTES) {
    throw new Error(
      `exportIdentity: seckey must be ${SECKEY_BYTES} bytes, got ${id.seckey.length}`,
    );
  }
  const body: EnvelopeBody = {
    seckey: bytesToBase64Url(id.seckey),
    createdAt: id.createdAt,
  };
  const json = JSON.stringify(body);
  return PREFIX + bytesToBase64Url(utf8Encode(json));
}

/**
 * Parse a previously-exported envelope. Throws on:
 *   - missing or wrong version prefix (future-proofing for v=2 onward)
 *   - malformed base64url / JSON / shape
 *   - seckey of the wrong length
 *   - any error during pubkey derivation (= invalid scalar)
 */
export function importIdentity(blob: string): Identity {
  if (typeof blob !== "string" || !blob.startsWith(PREFIX)) {
    throw new Error("importIdentity: missing or unsupported version prefix");
  }
  const payload = blob.slice(PREFIX.length);
  if (payload.length === 0) {
    throw new Error("importIdentity: empty payload");
  }

  let body: unknown;
  try {
    const json = utf8Decode(base64UrlToBytes(payload));
    body = JSON.parse(json);
  } catch {
    throw new Error("importIdentity: malformed envelope payload");
  }

  if (!isEnvelopeBody(body)) {
    throw new Error("importIdentity: envelope shape invalid");
  }

  let seckey: Uint8Array;
  try {
    seckey = base64UrlToBytes(body.seckey);
  } catch {
    throw new Error("importIdentity: malformed seckey encoding");
  }
  if (seckey.length !== SECKEY_BYTES) {
    throw new Error(
      `importIdentity: seckey must be ${SECKEY_BYTES} bytes, got ${seckey.length}`,
    );
  }

  let pubkey: Uint8Array;
  try {
    pubkey = secp256k1.getPublicKey(seckey, true);
  } catch {
    throw new Error("importIdentity: invalid secret scalar");
  }
  if (pubkey.length !== PUBKEY_BYTES) {
    throw new Error(
      `importIdentity: derived pubkey wrong length: ${pubkey.length}`,
    );
  }

  return { pubkey, seckey, createdAt: body.createdAt };
}
