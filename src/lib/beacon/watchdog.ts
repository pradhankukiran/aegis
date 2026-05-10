/**
 * Beacon — client-side watchdog (Layer A).
 *
 * Periodically scans every persisted beacon row and fires any whose
 * deadline has passed. The interval is `setInterval`-driven with a
 * configurable cadence (default 60s).
 *
 * # Cadence
 *
 *   60s is short enough that a user who reopens the app shortly after a
 *   deadline sees the fire happen within a minute, but long enough that
 *   we don't churn IDB every couple of frames. Test runs can pass a
 *   smaller `intervalMs` to drive the loop deterministically.
 *
 *   We schedule an immediate evaluation on `start()` so a beacon whose
 *   deadline lapsed while Aegis was closed fires the instant the page
 *   mounts — no 60-second wait for the first tick.
 *
 * # Reentrancy
 *
 *   Each tick reads the full beacon list, evaluates `shouldFire` against
 *   the current clock, and awaits `fireBeacon` per match. `fireBeacon`
 *   writes `status = "fired"` BEFORE publishing (see `fire.ts` header),
 *   so a subsequent tick reads the updated status and short-circuits.
 *   The watchdog itself does not gate against concurrent ticks beyond
 *   that — ticks are sequential because we await the IDB read.
 *
 * # Returns
 *
 *   `start()` returns a `stop()` closure that clears the interval. Safe
 *   to call repeatedly. The watchdog never throws synchronously; per-
 *   tick errors are logged and swallowed so a single bad row doesn't
 *   take the whole loop down.
 */
import { fireBeacon } from "./fire";
import { loadBeacons } from "./storage";
import { shouldFire } from "./trigger-check";

import type { AegisTransport } from "../transport";

export const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Start the watchdog. Returns a `stop()` closure.
 *
 * @param transport   the AegisTransport to publish fires through.
 * @param intervalMs  the polling cadence; defaults to 60 000 ms.
 */
export function startWatchdog(
  transport: AegisTransport,
  intervalMs: number = DEFAULT_WATCHDOG_INTERVAL_MS,
): () => void {
  let stopped = false;
  // Schedule a first tick on the next microtask so callers can store the
  // stop handle before any I/O begins. (Without this hop the very first
  // tick could fire-and-forget before the caller has a chance to react
  // to the return value, which is fine in production but trips tests
  // expecting deterministic event ordering.)
  const tick = (): void => {
    if (stopped) return;
    runTick(transport).catch((err) => {
      // Log + swallow: a single bad row mustn't kill the loop.
      console.error("[beacon] watchdog tick error:", err);
    });
  };
  // Kick once immediately so a stale beacon doesn't sit unfired for up
  // to `intervalMs` after page mount.
  queueMicrotask(tick);
  const handle = setInterval(tick, intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * One iteration of the watchdog loop. Exported so tests can drive the
 * loop without a real setInterval (and the page-level integration test
 * can step it deterministically).
 *
 * Loads every persisted beacon, evaluates `shouldFire` against the
 * current clock, and fires any that match. Per-fire errors are caught
 * and logged so one failing beacon doesn't block the others.
 */
export async function runTick(
  transport: AegisTransport,
  now: number = Date.now() / 1000,
): Promise<{ fired: string[] }> {
  if (typeof indexedDB === "undefined") {
    // Watchdog has no work to do in non-browser environments. Returning
    // an empty list is the right answer; SSR pages shouldn't run this.
    return { fired: [] };
  }
  const beacons = await loadBeacons();
  const fired: string[] = [];
  for (const b of beacons) {
    if (!shouldFire(b, now)) continue;
    try {
      await fireBeacon(transport, b, Math.floor(now));
      fired.push(b.id);
    } catch (err) {
      console.error(`[beacon] failed to fire beacon ${b.id}:`, err);
    }
  }
  return { fired };
}
