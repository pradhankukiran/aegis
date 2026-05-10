/**
 * Quorum — sealed-ballot decryption.
 *
 * `unsealVote(sealedB64, drandRound)` reverses `sealVote`:
 *
 *   1. base64url → armored tlock-js ciphertext string.
 *   2. tlock-js fetches the drand signature for `drandRound` and unwraps
 *      the body. If the round hasn't been emitted yet (we ran the tally
 *      before close), this throws — we catch and return null.
 *   3. Parse the inner JSON `{v, vote, sig}`.
 *   4. Verify the embedded Schnorr signature against `vote.voter`. A
 *      forged ballot with someone else's pubkey would fail here.
 *   5. Return `vote` on success, `null` on any failure.
 *
 * # Why a null-on-failure surface (no exceptions)?
 *
 * The tally pipeline runs `unsealVote` once per ballot. We don't want
 * one bad ballot to throw and abort the whole tally — that's exactly the
 * shape a malicious voter would exploit to deny service to the tallier.
 * The function returns null for every recoverable failure mode and the
 * tally bumps `failed`. Real programmer errors (non-string input, wrong
 * type) are the only thing that escape, and even those are caught at the
 * top-level try.
 *
 * # Cross-poll replay defence
 *
 * `pollId` is part of the signed payload — a ballot whose internal
 * `vote.pollId` differs from the poll the tally is processing is dropped
 * by the caller (tally checks `vote.pollId === pollMeta.id` after
 * unseal). The signature wouldn't make sense under a different pubkey
 * either, so even a `pollId`-tampered ballot won't verify.
 */
import { schnorr } from "@noble/curves/secp256k1.js";

import { hexToBytes, utf8Decode } from "../crypto/encoding";
import { timelockDecryptString } from "../crypto/timelock";

import {
  decodeSealedToArmored,
  voteDigest,
  SEALED_VERSION,
  type SealedInner,
} from "./seal";
import type { Vote } from "./types";

/**
 * Attempt to recover the plaintext Vote from a sealed payload. Returns
 * null on any failure (round not yet emitted, malformed envelope, bad
 * signature, etc.). The tally caller treats null as "this ballot didn't
 * count" and bumps the `failed` counter.
 *
 * `drandRound` is informational: tlock-js encodes the round inside the
 * armored payload, so the decrypt path doesn't actually consult our
 * parameter. We still accept it so the function shape mirrors `sealVote`
 * symmetrically and a caller can pass the poll's declared round to a
 * future "round-binding-check" extension without an API change.
 */
export async function unsealVote(
  sealedB64: string,
  drandRound: number,
): Promise<Vote | null> {
  void drandRound; // see comment above — kept for symmetry / future use
  if (typeof sealedB64 !== "string" || sealedB64.length === 0) return null;

  let armored: string;
  try {
    armored = decodeSealedToArmored(sealedB64);
  } catch {
    return null;
  }

  let plaintext: Uint8Array;
  try {
    plaintext = await timelockDecryptString(armored);
  } catch {
    // tlock-js throws when the round has not been signed yet (pre-close
    // tally attempt) and on any malformed armored body. Both surface
    // here as "not recoverable" → null.
    return null;
  }

  let inner: SealedInner;
  try {
    const parsed = JSON.parse(utf8Decode(plaintext));
    if (!parsed || typeof parsed !== "object") return null;
    inner = parsed as SealedInner;
  } catch {
    return null;
  }

  if (inner.v !== SEALED_VERSION) return null;
  if (!inner.vote || typeof inner.vote !== "object") return null;
  if (typeof inner.sig !== "string") return null;

  const v = inner.vote;
  if (typeof v.pollId !== "string" || v.pollId === "") return null;
  if (typeof v.voter !== "string" || v.voter === "") return null;
  if (typeof v.nonce !== "string" || v.nonce === "") return null;
  if (!Number.isInteger(v.optionIndex) || v.optionIndex < 0) return null;

  // Voter pubkey is x-only 64-char hex. Anything else means the inner
  // payload was constructed by a wrong-version client or by a forger
  // who didn't bother to match the canonical form.
  if (!/^[0-9a-f]{64}$/i.test(v.voter)) return null;
  if (!/^[0-9a-f]{128}$/i.test(inner.sig)) return null;

  try {
    const digest = voteDigest(v);
    const sigBytes = hexToBytes(inner.sig.toLowerCase());
    const pubBytes = hexToBytes(v.voter.toLowerCase());
    const ok = schnorr.verify(sigBytes, digest, pubBytes);
    if (!ok) return null;
  } catch {
    return null;
  }

  return {
    pollId: v.pollId,
    optionIndex: v.optionIndex,
    voter: v.voter.toLowerCase(),
    nonce: v.nonce,
  };
}
