/**
 * Beacon — slow-path (Layer B) release wrapper.
 *
 * Builds a single timelock-encrypted release envelope using `tlock-js`
 * against `beacon.drandRound`, then publishes it on every connected
 * network. After this call resolves (and at least one network accepted
 * the publish), the slow path is "armed" — when the drand round arrives,
 * any subscribing node can decrypt the envelope and recover the
 * `ReleasePayload` without the user being online.
 *
 * # Why one envelope, not one per network
 *
 * The envelope is identical content-wise regardless of which network it
 * traverses — same drand round, same payload. We publish a single
 * pre-built string to both networks via `transport.publish` (which fans
 * out) and the resulting AegisEvent ids canonicalize the same way.
 * That's the v1 shape.
 *
 * (Per-network bespoke envelopes are reserved for a future enhancement
 * where, e.g., we want to route the Nostr envelope to a different relay
 * set than the default. v1 doesn't need that — we just want fan-out.)
 *
 * # Status side-effects
 *
 * On any successful per-network publish, we stamp
 * `timelockedReleasesPublished = true` on the beacon row. The UI surfaces
 * this as "Slow path anchored ✓" or "Slow path not anchored — only fast
 * path will fire" depending on the boolean.
 *
 * # drand round projection
 *
 * The caller provides `beacon.drandRound` directly; the create flow
 * computes it once via `roundForDate(new Date((deadline + grace) * 1000))`
 * and stores it on the row. We don't recompute here because (a) the round
 * is part of the beacon's authoritative state and (b) tlock-js is fine
 * encrypting against a round that's already partially in the past — drand
 * decryption simply succeeds the moment that round's signature is
 * published.
 */
import { utf8Encode } from "../crypto/encoding";
import { timelockEncryptBytes } from "../crypto/timelock";
import type { AegisTransport, PublishResult } from "../transport";

import { saveBeacon } from "./storage";
import {
  BEACON_TIMELOCKED_RELEASE_TYPE,
  type Beacon,
  type ReleasePayload,
} from "./types";

/**
 * Build the inner `ReleasePayload` for a beacon — the same shape `fire.ts`
 * publishes in the cleartext path. Exported so callers (tests / future
 * tooling) can inspect what's inside the timelock envelope before
 * publishing.
 */
export function buildTimelockedReleasePayload(beacon: Beacon): ReleasePayload {
  return {
    beaconId: beacon.id,
    payloadCid: beacon.payloadCid,
    unwrapKeyHex: beacon.unwrapKeyHex,
    // For the slow path, `firedAt` is the drand-round trigger, not a
    // wall-clock fire-time. Carry the round-projected timestamp so
    // observers have a single shape; `(deadlineUnix + graceSeconds)` is
    // the natural value since that's exactly when the round becomes
    // signable.
    firedAt: beacon.deadlineUnix + beacon.graceSeconds,
  };
}

/**
 * Build the tlock-encrypted release envelope (an age-armored string from
 * `tlock-js#timelockEncrypt`). Separated from publish so tests / dev
 * tooling can hold the envelope without crossing a transport boundary.
 */
export async function buildTimelockedReleaseEnvelope(
  beacon: Beacon,
): Promise<string> {
  const payload = buildTimelockedReleasePayload(beacon);
  const plaintext = utf8Encode(JSON.stringify(payload));
  return timelockEncryptBytes(plaintext, beacon.drandRound);
}

/**
 * Publish the timelock-encrypted release envelope on every connected
 * network. On any successful per-network publish, mark
 * `timelockedReleasesPublished = true` on the row and persist.
 *
 * Returns the per-network publish results so the UI can surface a "tried
 * 3 networks, anchored on N/3" breakdown.
 */
export async function publishTimelockedRelease(
  transport: AegisTransport,
  beacon: Beacon,
): Promise<{ beacon: Beacon; envelope: string; results: PublishResult[] }> {
  const envelope = await buildTimelockedReleaseEnvelope(beacon);
  let results: PublishResult[] = [];
  try {
    results = await transport.publish({
      type: BEACON_TIMELOCKED_RELEASE_TYPE,
      content: envelope,
    });
  } catch {
    results = [];
  }
  const anyOk = results.some((r) => r.ok);
  // Only stamp the boolean if at least one network actually accepted —
  // otherwise the user gets a misleading "slow path anchored" indicator.
  const updated: Beacon =
    anyOk && !beacon.timelockedReleasesPublished
      ? { ...beacon, timelockedReleasesPublished: true }
      : beacon;
  if (anyOk && !beacon.timelockedReleasesPublished) {
    await saveBeacon(updated);
  }
  return { beacon: updated, envelope, results };
}
