/**
 * Beacon — observe inbound `aegis.beacon.fired` and `aegis.beacon.cancelled`
 * events.
 *
 * Why we observe events for our own beacons:
 *
 *   - The Layer-A watchdog fires through `transport.publish`. The transport
 *     dedup cache covers a 60-second window across networks, so even if
 *     three relays echo our fire back to us we collapse to one observation.
 *     But "we" might be a different tab / different device that didn't run
 *     the fire — that tab learns the fire happened by hearing the same
 *     event via subscribe, and updates its local IDB row to `fired`.
 *   - The Layer-B timelocked release becomes a cleartext `aegis.beacon.fired`
 *     once a peer decrypts it (or once Aegis itself fetches the timelocked
 *     event after the round arrives — but v1 has no "fetch + tlock-decrypt"
 *     observer loop; that's the live-infra deferred item below). For now,
 *     a peer who does the decrypt + republish lets us see our own fire.
 *
 * # Observing OTHERS' beacons
 *
 * Stub. A future enhancement subscribes to `aegis.beacon.fired` events for
 * beacons we DIDN'T create — e.g. a journalist watching a whistleblower's
 * pre-encoded dead-man's broadcast — and surfaces them in a separate
 * "received" panel with the decrypted payload. The plumbing is the same
 * (`transport.subscribe`), but the UX and trust model (which peers'
 * beacons do we trust? do we honour their cancellations? what's the
 * threat-model around timelocked releases that arrived without the
 * matching beacon row in our store?) is non-trivial. Documented here, not
 * built in v1.
 */
import {
  loadBeacon,
  saveBeacon,
} from "./storage";
import {
  BEACON_CANCELLED_TYPE,
  BEACON_FIRED_TYPE,
  type Beacon,
  type CancellationPayload,
  type ReleasePayload,
} from "./types";
import { verifyCancellation } from "./cancel";

import type { AegisEvent, AegisTransport } from "../transport";

/**
 * Attach the bridge: subscribe to both event types via `transport.subscribe`
 * and update local rows when our own beacon's events arrive. Returns a
 * compound unsubscribe handle.
 *
 * `onUpdate` lets the UI react beyond the IDB write (refresh list, show
 * a toast). It fires AFTER the row is persisted.
 */
export function attachBeaconBridge(
  transport: AegisTransport,
  onUpdate?: (beacon: Beacon) => void,
): () => void {
  const unsubFired = transport.subscribe(
    { type: BEACON_FIRED_TYPE },
    (ev) => {
      handleFired(ev, onUpdate).catch((err) => {
        console.error("[beacon] fired bridge error:", err);
      });
    },
  );
  const unsubCancelled = transport.subscribe(
    { type: BEACON_CANCELLED_TYPE },
    (ev) => {
      handleCancelled(ev, onUpdate).catch((err) => {
        console.error("[beacon] cancelled bridge error:", err);
      });
    },
  );
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      unsubFired();
    } catch {
      /* ignore */
    }
    try {
      unsubCancelled();
    } catch {
      /* ignore */
    }
  };
}

/**
 * Validate that an AegisEvent payload looks like a `ReleasePayload`. Returns
 * the typed payload on success, null on shape mismatch. Exported for unit
 * testing.
 */
export function projectReleasePayload(
  content: unknown,
): ReleasePayload | null {
  if (!content || typeof content !== "object") return null;
  const obj = content as Record<string, unknown>;
  if (typeof obj.beaconId !== "string" || obj.beaconId === "") return null;
  if (typeof obj.payloadCid !== "string" || obj.payloadCid === "") return null;
  if (typeof obj.unwrapKeyHex !== "string" || obj.unwrapKeyHex === "") {
    return null;
  }
  if (typeof obj.firedAt !== "number" || !Number.isFinite(obj.firedAt)) {
    return null;
  }
  return {
    beaconId: obj.beaconId,
    payloadCid: obj.payloadCid,
    unwrapKeyHex: obj.unwrapKeyHex,
    firedAt: obj.firedAt,
  };
}

/**
 * Validate that an AegisEvent payload looks like a `CancellationPayload`.
 * Returns the typed payload on success, null on shape mismatch. Exported
 * for unit testing.
 */
export function projectCancellationPayload(
  content: unknown,
): CancellationPayload | null {
  if (!content || typeof content !== "object") return null;
  const obj = content as Record<string, unknown>;
  if (typeof obj.beaconId !== "string" || obj.beaconId === "") return null;
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) return null;
  if (typeof obj.sigHex !== "string" || obj.sigHex === "") return null;
  if (typeof obj.signerHex !== "string" || obj.signerHex === "") return null;
  return {
    beaconId: obj.beaconId,
    ts: obj.ts,
    sigHex: obj.sigHex,
    signerHex: obj.signerHex,
  };
}

async function handleFired(
  ev: AegisEvent,
  onUpdate?: (beacon: Beacon) => void,
): Promise<void> {
  const payload = projectReleasePayload(ev.content);
  if (!payload) return;
  // We only update local rows we already know about — that's what makes
  // this "observing OUR OWN beacons". Other-author beacons are a future
  // surface (see file header).
  const existing = await loadBeacon(payload.beaconId);
  if (!existing) return;
  // Don't re-fire-on-fired and don't override cancellation: the user
  // already pressed cancel, and a later relay echo of the original fire
  // shouldn't unmask it.
  if (existing.status === "fired" || existing.status === "cancelled") return;
  const updated: Beacon = { ...existing, status: "fired" };
  await saveBeacon(updated);
  onUpdate?.(updated);
}

async function handleCancelled(
  ev: AegisEvent,
  onUpdate?: (beacon: Beacon) => void,
): Promise<void> {
  const payload = projectCancellationPayload(ev.content);
  if (!payload) return;
  // Verify before honouring. Without this gate, anyone could forge a
  // cancellation for someone else's beacon and silence them.
  if (!verifyCancellation(payload)) return;
  const existing = await loadBeacon(payload.beaconId);
  if (!existing) return;
  // Honour the cancellation only while the beacon is still pending /
  // checked-in. Once it has fired, a later cancellation is a "regret"
  // event with no remediation power.
  if (existing.status !== "pending" && existing.status !== "checked-in") {
    return;
  }
  const updated: Beacon = { ...existing, status: "cancelled" };
  await saveBeacon(updated);
  onUpdate?.(updated);
}
