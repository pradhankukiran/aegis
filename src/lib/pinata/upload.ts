import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PinataSDK } from "pinata";

import {
  bytesToBase64Url,
  bytesToHex,
  utf8Encode,
} from "../crypto/encoding";
import type { Identity } from "../identity";

/**
 * Browser-side upload helpers.
 *
 * Flow:
 *   1. The browser asks the server for a short-lived signed URL.
 *      The request body carries a BIP-340 Schnorr signature over
 *      `sha256("aegis:pinata-upload-url:v=1:" + pubkey + ":" + ts + ":" + nonce)`
 *      so the route can authenticate the caller (SEC-001).
 *   2. The browser uploads the (already encrypted) blob *directly* to Pinata
 *      using that URL — server bandwidth is never used for the file body.
 *   3. Pinata returns a CID (content hash). That CID is the address of the
 *      ciphertext on IPFS.
 *
 * # Signing identity
 *
 * Without an explicit `opts.identity`, each upload mints a **fresh
 * ephemeral keypair** to sign the request. That keeps Crucible's
 * anonymity property intact (the master identity is never tied to a
 * drop's upload URL) while still raising the bar above an unauthenticated
 * cross-origin POST. Callers that want pubkey-bound rate-limiting can
 * pass their master identity explicitly via `opts.identity`.
 *
 * When the server is configured with a `PINATA_ALLOWLIST`, only signed
 * requests from listed pubkeys are accepted. In that mode the caller MUST
 * pass a master `opts.identity` that's in the allowlist; ephemeral
 * signatures will be rejected.
 *
 * No PINATA_JWT is needed in the browser — the signed URL carries the
 * necessary auth. We initialize PinataSDK without `pinataJwt` here.
 *
 * If Pinata is not configured server-side (no PINATA_JWT env var), the
 * `/api/pinata/upload-url` endpoint returns 503; this module surfaces that
 * as a `PinataNotConfiguredError` so feature code can degrade gracefully
 * (e.g. local-only persistence with a warning) rather than crash.
 */

/**
 * Thrown when the server reports Pinata is not configured (HTTP 503 from
 * `/api/pinata/upload-url`). Feature code should catch this and either fall
 * back to local-only persistence or surface a configuration warning.
 */
export class PinataNotConfiguredError extends Error {
  override readonly name = "PinataNotConfiguredError";
  constructor(message = "Pinata is not configured on this deployment") {
    super(message);
  }
}

let cached: PinataSDK | null = null;

function getBrowserPinata(): PinataSDK {
  if (cached) return cached;
  const gateway = process.env.NEXT_PUBLIC_PINATA_GATEWAY;
  if (!gateway) {
    // We don't actually need the gateway for upload, but the SDK constructor
    // accepts it and we'll need it for retrieval.
    cached = new PinataSDK({ pinataGateway: "" });
  } else {
    cached = new PinataSDK({ pinataGateway: gateway });
  }
  return cached;
}

export type SignedUploadUrl = {
  url: string;
  expiresAt: number;
};

/** Domain-separation prefix matching the server-side route. */
const SIGN_PREFIX = "aegis:pinata-upload-url:v=1";

/**
 * Mint 32 random bytes for the nonce, returned base64url-encoded.
 *
 * `crypto.getRandomValues` is in every browser and Edge runtime. It's the
 * boundary the rest of the browser-side code uses for nonces (Beacon
 * cancellation nonces, quorum vote nonces). No libsodium round-trip needed.
 */
function mintNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/**
 * Convert an Identity's seckey + pubkey into the (sigBytes, pubkeyHex)
 * pair the signed upload-URL request needs. `schnorr.sign` wants the raw
 * 32-byte scalar; `pubkey` is the BIP-340 x-only (32 bytes), which is the
 * Identity's stored compressed key minus the parity prefix.
 */
function signUploadRequest(
  identity: Identity,
  ts: number,
  nonce: string,
): { pubkey: string; sig: string } {
  // x-only pubkey for BIP-340: drop the SEC1 parity byte. Master Identity
  // always stores the 33-byte SEC1-compressed form; ephemeral identities
  // do the same.
  const xOnly = identity.pubkey.length === 33
    ? identity.pubkey.slice(1)
    : identity.pubkey;
  const pubkey = bytesToHex(xOnly);
  const digest = sha256(utf8Encode(`${SIGN_PREFIX}:${pubkey}:${ts}:${nonce}`));
  const sigBytes = schnorr.sign(digest, identity.seckey);
  const sig = bytesToBase64Url(sigBytes);
  return { pubkey, sig };
}

/**
 * Options for the upload helpers. `identity` overrides the
 * fresh-ephemeral default (used by tests, and by callers that want
 * pubkey-bound rate-limiting / allowlist-mode auth); `signal` is forwarded
 * to the underlying fetch.
 */
export type UploadOpts = {
  identity?: Identity;
  signal?: AbortSignal;
};

/**
 * Mint a fresh ephemeral identity for signing one upload-URL request.
 *
 * `crypto.getRandomValues` is available in every browser + Edge runtime
 * Aegis targets. The seckey is wiped from the caller's frame as soon as
 * the request is signed (see `requestUploadUrl`).
 */
function mintEphemeralIdentity(): Identity {
  const seckey = new Uint8Array(32);
  crypto.getRandomValues(seckey);
  const pubkey = secp256k1.getPublicKey(seckey, true);
  return { seckey, pubkey, createdAt: Date.now() };
}

/**
 * Resolve the signing identity: caller's override if any, else a fresh
 * ephemeral identity.
 */
function resolveIdentity(opts: UploadOpts | undefined): Identity {
  if (opts?.identity) return opts.identity;
  return mintEphemeralIdentity();
}

/**
 * Ask the server for a short-lived signed upload URL.
 *
 * @throws {PinataNotConfiguredError} if the server returns 503 (PINATA_JWT
 *   missing on the deployment).
 * @throws {Error} on any other non-2xx response, on missing identity, or
 *   on invalid input.
 */
export async function requestUploadUrl(args: {
  size: number;
} & UploadOpts): Promise<SignedUploadUrl> {
  const { size, identity: identityOverride, signal } = args;
  const identity = resolveIdentity({ identity: identityOverride });
  const ts = Math.floor(Date.now() / 1000);
  const nonce = mintNonce();
  const { pubkey, sig } = signUploadRequest(identity, ts, nonce);
  // If we minted an ephemeral identity, wipe the seckey now — it served
  // its purpose and shouldn't linger in memory longer than needed. The
  // caller-provided identity is the caller's to manage.
  if (!identityOverride) {
    identity.seckey.fill(0);
  }

  const res = await fetch("/api/pinata/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      size,
      mimeType: "application/octet-stream",
      pubkey,
      ts,
      nonce,
      sig,
    }),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 503) {
    const err = await res.json().catch(() => ({}));
    if (err?.error === "pinata-not-configured") {
      throw new PinataNotConfiguredError(
        typeof err?.message === "string"
          ? err.message
          : "Pinata is not configured on this deployment",
      );
    }
    throw new Error(`requestUploadUrl: 503 ${err?.error ?? "unavailable"}`);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `requestUploadUrl: ${res.status} ${err?.error ?? "failed"}`,
    );
  }
  return (await res.json()) as SignedUploadUrl;
}

export type UploadResult = {
  cid: string;
  size: number;
};

/**
 * Upload an opaque ciphertext blob to Pinata using a signed URL.
 * The bytes are application/octet-stream — there's nothing useful to inspect.
 */
export async function uploadEncryptedBlob(
  ciphertext: Uint8Array,
  signedUrl: string,
  filename = "blob.bin",
): Promise<UploadResult> {
  const pinata = getBrowserPinata();
  // Copy into a fresh ArrayBuffer so the resulting Uint8Array's buffer type
  // satisfies BlobPart (ArrayBufferView<ArrayBuffer>, not ArrayBufferLike).
  const buffer = new ArrayBuffer(ciphertext.byteLength);
  new Uint8Array(buffer).set(ciphertext);
  const file = new File([buffer], filename, {
    type: "application/octet-stream",
  });
  const result = await pinata.upload.public.file(file).url(signedUrl);
  if (!result?.cid) {
    throw new Error("uploadEncryptedBlob: no CID returned from Pinata");
  }
  return {
    cid: result.cid,
    size: file.size,
  };
}

/**
 * Convenience: end-to-end "give me a CID for these encrypted bytes".
 * Combines `requestUploadUrl` + `uploadEncryptedBlob`.
 *
 * @throws {PinataNotConfiguredError} if the server cannot mint URLs.
 */
export async function uploadCiphertext(
  ciphertext: Uint8Array,
  filename = "blob.bin",
  opts?: UploadOpts,
): Promise<UploadResult> {
  const signed = await requestUploadUrl({
    size: ciphertext.byteLength,
    ...(opts?.identity ? { identity: opts.identity } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  return await uploadEncryptedBlob(ciphertext, signed.url, filename);
}
