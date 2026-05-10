/**
 * Atlas — wires `AegisTransport.subscribeDM` to the position store.
 *
 * The unified subscribeDM channel surfaces every inbound DM regardless of
 * Aegis feature. We co-exist with Herald's bridge: both call subscribeDM,
 * both inspect the plaintext, and each skips messages that don't belong
 * to its feature. The dispatch key is the envelope's `type` field —
 * Atlas messages have `"aegis.location"`, Herald messages have plain
 * conversational text and no `type` field.
 *
 * Parse failures (non-JSON plaintext, missing `type`, missing `fix`) are
 * silently skipped — that's the correct behaviour because Herald DMs are
 * also raw plaintext and we MUST NOT log every Herald message as a
 * "malformed location DM".
 */

import { appendFix } from "./position-store";
import { LOCATION_MESSAGE_TYPE, type LocationMessage, type ReceivedFix } from "./types";

import type { AegisTransport, IncomingDM } from "../transport";

/**
 * Attach the location bridge. Returns the unsubscribe handle from the
 * underlying `transport.subscribeDM` — callers should hold onto it for
 * cleanup on transport close / identity change.
 *
 * `onFix` lets the UI react beyond the store update (refresh map markers,
 * bump a "last update" indicator). It runs AFTER `appendFix` resolves so
 * subsequent `latestForMember` reads will reflect the new sample.
 */
export function attachLocationBridge(
  transport: AegisTransport,
  onFix?: (fix: ReceivedFix) => void,
): () => void {
  return transport.subscribeDM((dm) => {
    handleIncoming(dm, onFix).catch((err) => {
      // Swallow IDB errors so a single bad write doesn't tear down the
      // entire subscription. Logged to console for devtools triage.
      console.error("[atlas] location bridge error:", err);
    });
  });
}

async function handleIncoming(
  dm: IncomingDM,
  onFix?: (fix: ReceivedFix) => void,
): Promise<void> {
  const parsed = parseLocationDM(dm);
  if (!parsed) return;
  const { from, fix } = parsed;
  const record: ReceivedFix = { from, ...fix };
  await appendFix(from, fix);
  onFix?.(record);
}

/**
 * Validate that an IncomingDM is a well-formed location envelope. Returns
 * the projected `{from, fix}` on success or `null` on any mismatch —
 * including:
 *   - non-string `from`
 *   - non-JSON plaintext
 *   - JSON missing `type === "aegis.location"` (e.g. a Herald chat DM)
 *   - `fix` missing one of {lat, lon, accuracy, ts}, or any of those
 *     fields being a non-finite number (NaN / Infinity sneaking through
 *     bad JSON).
 *
 * Exported for unit testing; the bridge itself only consumes the result.
 */
export function parseLocationDM(
  dm: IncomingDM,
): { from: string; fix: LocationMessage["fix"] } | null {
  if (!dm || typeof dm.from !== "string" || dm.from === "") return null;
  if (typeof dm.plaintext !== "string" || dm.plaintext === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dm.plaintext);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { type?: unknown; fix?: unknown };
  if (obj.type !== LOCATION_MESSAGE_TYPE) return null;
  if (!obj.fix || typeof obj.fix !== "object") return null;
  const fix = obj.fix as Record<string, unknown>;
  const { lat, lon, accuracy, ts } = fix;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return null;
  if (!isFiniteNumber(accuracy) || !isFiniteNumber(ts)) return null;
  // Bound-check lat/lon to legal WGS-84 ranges. A peer publishing
  // out-of-range coordinates is either misconfigured or hostile; in
  // either case we don't want a Leaflet marker at (lat=4242, lon=NaN).
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  return {
    from: dm.from,
    fix: {
      lat,
      lon,
      accuracy,
      ts,
    },
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
