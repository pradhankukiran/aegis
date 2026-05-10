/**
 * Beacon — fast-path fire helper.
 *
 * Publishes the cleartext `ReleasePayload` (CID + key + firedAt) on every
 * connected network via the transport facade. Subscribers see the release
 * immediately, fetch the Pinata blob, and decrypt with the inlined key.
 *
 * This is the Layer-A code path: invoked by the watchdog when a beacon's
 * deadline is reached and an Aegis tab is open. The slow path (Layer B —
 * `timelock-release.ts`) handles the case where no tab is open by relying
 * on drand to unlock a tlock-encrypted release event published at create
 * time.
 *
 * # Status transition
 *
 * After a successful publish, the caller writes `status = "fired"` to the
 * row. We could do the storage update inside this function, but the
 * trade-off is:
 *
 *   - Pro: one fewer step in the watchdog loop.
 *   - Con: a fire-but-not-persist race window where the watchdog might
 *     try to fire again on the next tick.
 *
 * We persist *before* publishing (`fireBeacon` sets the status and saves
 * the row, then publishes) so a duplicate watchdog tick reads the new
 * status and short-circuits. If the publish fails the row is already in
 * `fired` state; that's the deliberate trade — better one event we
 * thought we published than a duplicate broadcast.
 */
import { saveBeacon } from "./storage";
import {
  BEACON_FIRED_TYPE,
  type Beacon,
  type ReleasePayload,
} from "./types";

import type { AegisTransport, PublishResult } from "../transport";

/**
 * Build the `ReleasePayload` content for a beacon. Extracted so the slow
 * path (`timelock-release.ts`) can wrap the exact same shape inside the
 * tlock envelope — observers see one logical payload either way.
 */
export function buildReleasePayload(
  beacon: Beacon,
  firedAt: number,
): ReleasePayload {
  return {
    beaconId: beacon.id,
    payloadCid: beacon.payloadCid,
    unwrapKeyHex: beacon.unwrapKeyHex,
    firedAt,
  };
}

/**
 * Fire a beacon: stamp `status = "fired"`, persist, then publish the
 * cleartext release on every connected network.
 *
 * Returns the per-network publish results — caller (watchdog) logs them
 * but doesn't act on individual failures. If `publish` itself throws (rare;
 * it's already per-network resilient), we surface an empty results array so
 * the watchdog doesn't crash.
 */
export async function fireBeacon(
  transport: AegisTransport,
  beacon: Beacon,
  firedAt: number = Math.floor(Date.now() / 1000),
): Promise<{ beacon: Beacon; results: PublishResult[] }> {
  // Persist the terminal status FIRST so a watchdog re-entry on the next
  // tick reads `fired` and short-circuits. See the file header for the
  // trade-off rationale.
  const fired: Beacon = {
    ...beacon,
    status: "fired",
  };
  await saveBeacon(fired);

  let results: PublishResult[] = [];
  try {
    results = await transport.publish({
      type: BEACON_FIRED_TYPE,
      content: buildReleasePayload(fired, firedAt),
    });
  } catch (err) {
    // Per-network failures are surfaced as ok:false rows by `publish`; a
    // whole-call rejection (e.g. transport torn down mid-publish) lands
    // here. We swallow because the row is already `fired` — re-firing on
    // the next tick would be incorrect, and crashing the watchdog would
    // stop every other pending beacon.
    void err;
  }
  return { beacon: fired, results };
}
