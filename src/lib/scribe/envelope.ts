/**
 * Scribe envelope — XChaCha20-Poly1305 with AAD `aegis:notes:v=1`.
 *
 * # Two-tier key model
 *
 *   master key  = HKDF-SHA256(identity.seckey, salt=∅, info="aegis-scribe-notes-v1", 32)
 *   per-note key = randomly generated, 32 bytes
 *   wrappedKey  = encryptBytes(masterKey, perNoteKey, AAD)
 *   payload     = encryptBytes(perNoteKey, utf8(content), AAD)
 *
 * Storing a per-note key (instead of encrypting everything with the master
 * directly) lets us hand a single note to a collaborator by sharing just the
 * unwrapped per-note key, without ever exposing the master. That capability
 * isn't wired in v1 (shared notes go through Y.js + Matrix instead), but the
 * shape is forward-compatible.
 *
 * # AAD binding
 *
 * Both wrap and content use the same AAD: `aegis:notes:v=1`. This binds the
 * envelope to its feature + version, so:
 *   - A ciphertext from a different feature (Herald, capsules) won't decrypt
 *     here even if the master keys happen to coincide.
 *   - A future v=2 envelope (different layout / different scope) cannot be
 *     silently downgraded into v=1 readers.
 *
 * # On-disk shape (JSON in `contentEnvelope: string`)
 *
 *   {
 *     v: 1,                     // envelope schema version
 *     wrappedKey: <base64url>,  // sealed per-note key
 *     payload:    <base64url>,  // sealed plaintext
 *   }
 *
 * The whole struct is base64url(JSON.stringify(...)) so it lives in IDB as
 * a single ASCII string — matches the `Note.contentEnvelope` type and keeps
 * the on-disk shape grep-able.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  utf8Decode,
  utf8Encode,
} from "../crypto/encoding";
import {
  decryptBytes,
  encryptBytes,
  generateSymmetricKey,
} from "../crypto/symmetric";
import type { Identity } from "../identity";

/** AAD bound to every Scribe envelope. */
export const SCRIBE_AAD = utf8Encode("aegis:notes:v=1");

/** HKDF info string used to derive the Scribe master key from `identity.seckey`. */
const HKDF_INFO = utf8Encode("aegis-scribe-notes-v1");

/** Current envelope schema version. */
const ENVELOPE_VERSION = 1;

/** JSON shape inside the base64url-encoded envelope string. */
type EnvelopeStruct = {
  v: number;
  wrappedKey: string;
  payload: string;
};

/**
 * Derive the Scribe master key from the user's identity.
 *
 * - ikm  = identity.seckey (32 bytes)
 * - salt = empty (RFC 5869: HKDF-Extract treats omitted salt as a zero block)
 * - info = "aegis-scribe-notes-v1"
 * - L    = 32
 *
 * Deterministic from the identity — so a user who restores their identity on
 * a new device can also restore note plaintexts (once the envelope blobs are
 * synced from Pinata, the live-infra path).
 */
export function deriveMasterKey(identity: Identity): Uint8Array {
  if (!identity?.seckey || identity.seckey.length !== 32) {
    throw new Error("deriveMasterKey: identity.seckey must be 32 bytes");
  }
  return hkdf(sha256, identity.seckey, undefined, HKDF_INFO, 32);
}

/**
 * Wrap `plaintext` (UTF-8 string content of a note) under a fresh per-note
 * key, then wrap that key under `masterKey`. Returns the base64url-encoded
 * envelope string ready to drop into `Note.contentEnvelope`.
 */
export async function wrapNoteContent(
  masterKey: Uint8Array,
  plaintext: string,
): Promise<string> {
  const perNoteKey = await generateSymmetricKey();
  const wrappedKey = await encryptBytes(masterKey, perNoteKey, SCRIBE_AAD);
  const payload = await encryptBytes(
    perNoteKey,
    utf8Encode(plaintext),
    SCRIBE_AAD,
  );
  const struct: EnvelopeStruct = {
    v: ENVELOPE_VERSION,
    wrappedKey: bytesToBase64Url(wrappedKey),
    payload: bytesToBase64Url(payload),
  };
  return bytesToBase64Url(utf8Encode(JSON.stringify(struct)));
}

/**
 * Unwrap an envelope produced by `wrapNoteContent`. Throws on any of:
 *   - malformed base64 / JSON
 *   - unknown version
 *   - tampered wrapped key
 *   - wrong master key (different identity)
 *   - wrong AAD (different feature / version)
 */
export async function unwrapNoteContent(
  masterKey: Uint8Array,
  envelope: string,
): Promise<string> {
  let struct: EnvelopeStruct;
  try {
    const json = utf8Decode(base64UrlToBytes(envelope));
    struct = JSON.parse(json) as EnvelopeStruct;
  } catch (err) {
    throw new Error(
      `unwrapNoteContent: malformed envelope (${describeError(err)})`,
    );
  }
  if (struct.v !== ENVELOPE_VERSION) {
    throw new Error(
      `unwrapNoteContent: unsupported envelope version ${String(struct.v)}`,
    );
  }
  const wrappedKey = base64UrlToBytes(struct.wrappedKey);
  const payload = base64UrlToBytes(struct.payload);
  const perNoteKey = await decryptBytes(masterKey, wrappedKey, SCRIBE_AAD);
  const plaintext = await decryptBytes(perNoteKey, payload, SCRIBE_AAD);
  return utf8Decode(plaintext);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
