/**
 * Quorum — sealed-ballot construction.
 *
 * `sealVote` produces the base64url string that fills the wire `Ballot.sealedB64`
 * field. The output is the body of a tlock-js armored ciphertext, encoded
 * to base64url so it's safe to embed in Nostr event content / Matrix custom
 * events / SSB messages without further escaping.
 *
 * # The inner payload (sign-then-seal)
 *
 * Inside the sealed envelope we serialize:
 *
 *   {
 *     v: 1,
 *     vote: { pollId, optionIndex, voter, nonce },
 *     sig:  hex(BIP-340-schnorr(seckey, sha256(canonicalize(vote)))),
 *   }
 *
 * Voters sign-then-seal: the Schnorr signature is computed *before* tlock
 * encryption. That way a malicious tallier (or anyone with the post-close
 * round signature) can't insert a forged ballot under someone else's
 * pubkey — they'd need that pubkey's secret key to produce a valid sig.
 *
 * The signature digest uses the project-wide canonicalizer
 * (`transport/index.ts#canonicalize`) so the same vote always hashes the
 * same way regardless of object-key insertion order. Same approach Witness
 * uses for anchors (see `witness/anchor.ts#anchorDigest`).
 *
 * # Why timelock-encrypt the signed payload (not just the vote)?
 *
 * Pre-close, an observer who saw just the signature could not derive the
 * vote because the signed message is `sha256(canonical(vote))` — but the
 * *vote bytes* live next to the signature in the inner payload. Sealing
 * the bundle as a whole means nothing about the vote (option, nonce, sig)
 * is recoverable before the drand round arrives.
 *
 * # AAD-style binding via the canonical inner payload
 *
 * tlock-js's `timelockEncrypt` doesn't expose an AAD parameter — it
 * encrypts arbitrary bytes to a target round. We get the same protection
 * the AAD pattern provides by binding `pollId` and the voter into the
 * signed bytes themselves: a ballot lifted from poll A and replayed under
 * poll B (different id) would have a signature over A's pollId, so the
 * tally rejects it during `unsealVote`. The round itself is enforced by
 * tlock; an attempt to decrypt with the wrong round either fails (round
 * not yet emitted) or produces garbage that doesn't parse as JSON.
 *
 * # Performance note
 *
 * tlock-js encrypt is synchronous-ish (no network) and fast; we don't
 * memoize. The unseal path *does* talk to a drand HTTP endpoint to fetch
 * the round signature, so callers should batch unseal calls per tally
 * pass rather than per ballot if latency matters.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  utf8Decode,
  utf8Encode,
} from "../crypto/encoding";
import { randomBytes } from "../crypto/random";
import { timelockEncryptBytes } from "../crypto/timelock";
import { canonicalize } from "../transport";

import type { Vote } from "./types";

/** Inner payload version. Bump when the shape changes (e.g. add a field). */
const SEALED_VERSION = 1;

/**
 * The plaintext bytes we tlock-encrypt. Exported only because tests stub
 * sealing/unsealing with a fixed payload; production callers should never
 * construct one of these directly.
 */
export type SealedInner = {
  /** Bump on schema change. */
  v: number;
  vote: Vote;
  /** Hex BIP-340 Schnorr signature over sha256(canonicalize(vote)). */
  sig: string;
};

/**
 * Build the digest that the embedded signature covers. Public so tests
 * (and a future verifier on a different platform) can reproduce the exact
 * bytes from a Vote.
 */
export function voteDigest(vote: Vote): Uint8Array {
  const canonical = canonicalize({
    pollId: vote.pollId,
    optionIndex: vote.optionIndex,
    voter: vote.voter,
    nonce: vote.nonce,
  });
  return sha256(utf8Encode(canonical));
}

/**
 * Generate a fresh nonce for a vote. Hex-encoded 16 bytes — 128 bits is
 * plenty for collision resistance across the lifetime of any plausible
 * poll. Exposed so the hook can mint it eagerly (before commit) without
 * having to import randomness machinery.
 */
export async function mintVoteNonce(): Promise<string> {
  const bytes = await randomBytes(16);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Seal a vote for the given drand close round. Returns the base64url-
 * encoded armored ciphertext suitable for `Ballot.sealedB64`.
 *
 * `seckey` is the 32-byte raw secp256k1 secret scalar from the user's
 * Aegis identity. The function never returns it, never logs it, and
 * (deliberately) does not wipe it — the caller owns the secret and its
 * lifecycle (identity storage keeps it the moment the user generates).
 *
 * Throws on programmer errors (non-integer optionIndex, missing fields)
 * — those would indicate a bug in the hook layer rather than runtime
 * faultiness. Network errors from tlock-js propagate as-is.
 */
export async function sealVote(
  vote: Vote,
  drandRound: number,
  seckey: Uint8Array,
): Promise<string> {
  if (!Number.isInteger(vote.optionIndex) || vote.optionIndex < 0) {
    throw new Error("sealVote: optionIndex must be a non-negative integer");
  }
  if (!vote.pollId || !vote.voter || !vote.nonce) {
    throw new Error("sealVote: missing required vote field");
  }
  if (!Number.isInteger(drandRound) || drandRound <= 0) {
    throw new Error("sealVote: drandRound must be a positive integer");
  }
  if (seckey.length !== 32) {
    throw new Error("sealVote: seckey must be 32 bytes");
  }

  const digest = voteDigest(vote);
  const sigBytes = schnorr.sign(digest, seckey);
  let sigHex = "";
  for (let i = 0; i < sigBytes.length; i += 1) {
    sigHex += sigBytes[i].toString(16).padStart(2, "0");
  }

  const inner: SealedInner = { v: SEALED_VERSION, vote, sig: sigHex };
  const innerBytes = utf8Encode(JSON.stringify(inner));
  const armored = await timelockEncryptBytes(innerBytes, drandRound);
  // tlock-js returns a UTF-8 armored string (age-style). We re-encode it
  // to base64url so the wire `sealedB64` field is uniformly base64url
  // regardless of any embedded whitespace / newlines in the armored form.
  return bytesToBase64Url(utf8Encode(armored));
}

/**
 * Decode the base64url back to the armored tlock-js ciphertext string.
 * Exported for the unseal path; not part of the public sealing surface.
 */
export function decodeSealedToArmored(sealedB64: string): string {
  return utf8Decode(base64UrlToBytes(sealedB64));
}

/**
 * Re-export the canonical sealed-inner version so unseal can validate it.
 */
export { SEALED_VERSION };
