/**
 * Beacon — cancellation.
 *
 * A cancellation event is a signed claim that says "for beacon `id` owned
 * by signer `signerHex`, ignore any release published after timestamp
 * `ts`." Observers MUST verify the signature before honouring it — without
 * that gate, anyone could silence anyone else's beacon by publishing a
 * forged cancellation.
 *
 * # Signature shape
 *
 * The signature is BIP-340 Schnorr (x-only pubkey, 64-byte signature) over
 * the digest:
 *
 *     digest = SHA-256( canonicalize({ beaconId, ts }) )
 *
 * — the same canonicalize-then-hash pattern Witness uses for anchors. Same
 * primitive (`@noble/curves/secp256k1.schnorr`), same digest construction,
 * same x-only signer derivation. Verifiers re-derive the digest from the
 * payload and check the signature against the embedded `signerHex`.
 *
 * # Why we don't bind the beacon's CID/key into the signature
 *
 * A cancellation is a "stop the beacon" statement, not a "the release was
 * X" statement. The CID and key are not the user's intent to communicate;
 * the *id and timestamp* are. Including the CID would mean we'd have to
 * republish a fresh signed cancellation any time we wanted to relate the
 * cancellation back to a particular blob — pointless complexity.
 *
 * # Where the timestamp lands
 *
 * Observers should treat the cancellation as authoritative for *future*
 * release events — i.e. if you saw a `fired` event with `firedAt > ts` you
 * should still honour the fire (the user fired and then tried to cancel
 * after the fact). If you saw a cancellation first and then a fire whose
 * `firedAt > cancellation.ts`, drop the fire. v1 doesn't enforce this
 * server-side because there is no server; observers (us, today, in
 * `transport-bridge.ts`) honour cancellations by status.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  bytesToHex,
  hexToBytes,
  utf8Encode,
} from "../crypto/encoding";
import type { Identity } from "../identity";
import type { AegisTransport, PublishResult } from "../transport";
import { canonicalize } from "../transport";

import { saveBeacon } from "./storage";
import {
  BEACON_CANCELLED_TYPE,
  type Beacon,
  type CancellationPayload,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Identity → x-only signer hex                                                */
/* -------------------------------------------------------------------------- */

const COMPRESSED_PREFIX_BYTES = 1;
const X_ONLY_PUBKEY_BYTES = 32;

/**
 * Strip the SEC1 parity byte off the master Aegis pubkey to produce the
 * x-only 32-byte form BIP-340 uses. Mirrors Witness's
 * `signerHexFromIdentity` — same conversion, same canonical key
 * everywhere.
 */
export function signerHexFromIdentity(identity: Identity): string {
  const compressed = identity.pubkey;
  if (
    compressed.length !==
    COMPRESSED_PREFIX_BYTES + X_ONLY_PUBKEY_BYTES
  ) {
    throw new Error(
      `signerHexFromIdentity: expected ${
        COMPRESSED_PREFIX_BYTES + X_ONLY_PUBKEY_BYTES
      }-byte SEC1-compressed pubkey, got ${compressed.length}`,
    );
  }
  return bytesToHex(compressed.subarray(COMPRESSED_PREFIX_BYTES));
}

/* -------------------------------------------------------------------------- */
/* Digest                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compute the 32-byte digest that the cancellation signature covers. Public
 * so verifiers can re-derive the exact bytes — both paths MUST reach the
 * same `Uint8Array` for the signature to verify.
 */
export function cancellationDigest(beaconId: string, ts: number): Uint8Array {
  const canonical = canonicalize({ beaconId, ts });
  return sha256(utf8Encode(canonical));
}

/* -------------------------------------------------------------------------- */
/* Sign + verify                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a signed `CancellationPayload` for a beacon. The caller is
 * expected to pass their own beacon's id (we don't gate on local
 * ownership here — the signature itself is the authorization).
 */
export function signCancellation(
  identity: Identity,
  beaconId: string,
  ts: number = Math.floor(Date.now() / 1000),
): CancellationPayload {
  const digest = cancellationDigest(beaconId, ts);
  const sigBytes = schnorr.sign(digest, identity.seckey);
  return {
    beaconId,
    ts,
    sigHex: bytesToHex(sigBytes),
    signerHex: signerHexFromIdentity(identity),
  };
}

/**
 * Verify a cancellation payload's BIP-340 Schnorr signature.
 *
 * Returns false on any of:
 *   - malformed sig hex (wrong length, non-hex)
 *   - malformed signer hex
 *   - signature doesn't verify against the recomputed digest
 *
 * Observers MUST call this before honouring a cancellation. Without it,
 * any peer could silence anyone else's beacon by publishing a forged
 * event.
 */
export function verifyCancellation(payload: CancellationPayload): boolean {
  if (!/^[0-9a-fA-F]{128}$/.test(payload.sigHex)) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(payload.signerHex)) return false;
  let sigBytes: Uint8Array;
  let signerBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(payload.sigHex.toLowerCase());
    signerBytes = hexToBytes(payload.signerHex.toLowerCase());
  } catch {
    return false;
  }
  const digest = cancellationDigest(payload.beaconId, payload.ts);
  try {
    return schnorr.verify(sigBytes, digest, signerBytes);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Publish                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Publish a signed cancellation event for `beacon` across every connected
 * network, then stamp the local row as `cancelled`. Order matters:
 *
 *   1. Build + sign the cancellation (fails fast on malformed identity).
 *   2. Persist `status = "cancelled"` locally so a tab-refresh races no
 *      longer see the beacon as pending.
 *   3. Publish across the transport. Per-network failures are surfaced in
 *      the return value but don't roll back the local status — the user
 *      meant to cancel, the local store reflects that, and the timelocked
 *      release is the worst-case fallback (and itself observable as a
 *      mistake by anyone watching).
 */
export async function cancelBeacon(
  transport: AegisTransport,
  identity: Identity,
  beacon: Beacon,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ beacon: Beacon; payload: CancellationPayload; results: PublishResult[] }> {
  const payload = signCancellation(identity, beacon.id, now);
  const cancelled: Beacon = {
    ...beacon,
    status: "cancelled",
  };
  await saveBeacon(cancelled);
  let results: PublishResult[] = [];
  try {
    results = await transport.publish({
      type: BEACON_CANCELLED_TYPE,
      content: payload,
    });
  } catch (err) {
    // Same trade-off as fire: the local status is already terminal; we
    // don't want to crash the page if the transport is down. The
    // network-anchored timelocked release is the remaining risk; in v1
    // we just surface "couldn't fan-out cancellation" via the empty
    // results array.
    void err;
  }
  return { beacon: cancelled, payload, results };
}
