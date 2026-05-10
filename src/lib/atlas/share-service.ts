/**
 * Atlas — interval-driven encrypt-and-broadcast loop.
 *
 * The service is a tiny state machine:
 *
 *      stopped ──start()──► active (interval running)
 *      active  ──stop()───► stopped (interval cleared)
 *
 * `start` is idempotent: calling it twice replaces the previous interval
 * (with the new member list and intervalMs). `stop` is idempotent too —
 * calling it on a stopped service is a no-op.
 *
 * # Per-tick contract
 *
 *   1. Fetch the current `PositionFix` via the geolocation wrapper.
 *   2. JSON-serialize a `LocationMessage` envelope `{type, fix}`.
 *   3. For each member, fire `transport.directMessage(pubkey, plaintext)`.
 *      These run in parallel via `Promise.allSettled`; per-recipient errors
 *      are surfaced through `onError` but do not stop the loop.
 *
 * # Fan-out cost
 *
 * Each tick costs N transport.directMessage calls, where N = circle size.
 * `directMessage` returns after the first network in the fallback chain
 * (Matrix → Nostr → SSB) accepts the send, so per-recipient latency is
 * bounded by whichever transport is healthiest. For a 10-member circle on
 * a 5-minute interval that's 2 calls/minute — well within rate limits even
 * on the slowest of the three networks.
 *
 * # Geolocation permission interaction
 *
 * The first tick triggers the permission prompt if it hasn't already been
 * granted. We do NOT block `start` on a pre-flight permission check —
 * letting the geolocation call itself raise the prompt is the most
 * browser-idiomatic UX and gives the caller a clean error path via
 * `onError`. The hook layer surfaces "permission-denied" so the UI can
 * flip the toggle back to off and explain.
 *
 * # Why setInterval and not requestAnimationFrame / chained timeouts?
 *
 * `setInterval` drifts under tab-throttling but the 5-minute cadence is
 * far below the throttle threshold; we don't need RAF precision. Chained
 * `setTimeout` would survive long pauses better but compounds the drift
 * issue without buying us anything — sharing 5-minutely is the user
 * intent regardless of micro-jitter.
 */

import { GeolocationFetchError, getCurrentPosition } from "./geolocation";
import {
  LOCATION_MESSAGE_TYPE,
  type CircleMember,
  type LocationMessage,
  type PositionFix,
} from "./types";

import type { AegisTransport } from "../transport";

/** Default interval for live share (plan §3.3 "5-min update interval"). */
export const DEFAULT_SHARE_INTERVAL_MS = 5 * 60 * 1000;

/** Optional lifecycle hooks the caller can wire up. */
export type ShareServiceHooks = {
  /** Called after each successful position fetch, before fan-out. */
  onTick?: (fix: PositionFix) => void;
  /** Called whenever a tick fails or any per-recipient send fails. */
  onError?: (err: Error) => void;
  /** Called when start() / stop() flip the running state. */
  onStateChange?: (active: boolean) => void;
};

export type ShareServiceStart = {
  transport: AegisTransport;
  members: ReadonlyArray<CircleMember>;
  /** Tick cadence in ms. Defaults to {@link DEFAULT_SHARE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Run a tick synchronously on start (default true so the map populates fast). */
  fireImmediately?: boolean;
};

/**
 * A handle returned by `createShareService` — stateful, owned by the caller.
 * The same instance can be `start()`-ed and `stop()`-ed across multiple
 * sessions; idempotent on both edges.
 */
export interface ShareService {
  /** Begin (or restart) the broadcast loop with a fresh member list. */
  start(opts: ShareServiceStart): void;
  /** Stop the loop. No-op if already stopped. */
  stop(): void;
  /** True iff a loop is currently scheduled. */
  isActive(): boolean;
}

/**
 * Build a fresh share service. The service is stateless across sessions
 * (no internal IDB writes; that's the bridge's job) — it just owns the
 * interval handle and the latest config.
 *
 * Hooks may be `undefined`; we wrap them in optional chaining so the hot
 * path is allocation-free.
 */
export function createShareService(
  hooks?: ShareServiceHooks,
): ShareService {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  // Capture the latest config in module-private state so `tick` can read
  // it without reallocating closures every interval. `start(...)` writes;
  // `tick` reads.
  let activeOpts: ShareServiceStart | null = null;
  // Bumped on every start() so an in-flight tick from a stale session can
  // detect "I was stopped or restarted" and bail without firing.
  let generation = 0;

  const setActive = (active: boolean): void => {
    hooks?.onStateChange?.(active);
  };

  const tick = async (gen: number): Promise<void> => {
    // Bail if start() ran again (gen mismatch) or stop() cleared the loop.
    if (gen !== generation || !activeOpts) return;
    const opts = activeOpts;
    try {
      const fix = await getCurrentPosition();
      // Re-check generation after the async getCurrentPosition — stop()
      // during the wait should suppress the fan-out cleanly.
      if (gen !== generation || activeOpts !== opts) return;
      hooks?.onTick?.(fix);
      if (opts.members.length === 0) return;
      const envelope: LocationMessage = {
        type: LOCATION_MESSAGE_TYPE,
        fix,
      };
      const plaintext = JSON.stringify(envelope);
      const results = await Promise.allSettled(
        opts.members.map((m) =>
          opts.transport.directMessage(m.pubkey, plaintext),
        ),
      );
      // Each rejected per-recipient send surfaces as one onError call so the
      // UI can render a "delivery failed to N/M" badge. We deliberately
      // don't aggregate — the caller may want per-recipient context.
      for (let i = 0; i < results.length; i += 1) {
        const r = results[i];
        if (r.status === "rejected") {
          const reason = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
          hooks?.onError?.(
            new Error(
              `aegis-atlas: directMessage to ${opts.members[i].pubkey} failed: ${reason.message}`,
            ),
          );
        }
      }
    } catch (err) {
      if (err instanceof GeolocationFetchError) {
        hooks?.onError?.(err);
      } else {
        hooks?.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  };

  return {
    start(opts: ShareServiceStart): void {
      // Replace any previous interval atomically. Bumping `generation`
      // ensures a tick currently mid-flight (between getCurrentPosition
      // resolution and fan-out) discards itself instead of using the old
      // members list.
      generation += 1;
      activeOpts = opts;
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      const cadence = opts.intervalMs ?? DEFAULT_SHARE_INTERVAL_MS;
      const gen = generation;
      // Fire-and-forget the first tick so the map populates immediately.
      // `fireImmediately !== false` lets a test or special caller opt out.
      if (opts.fireImmediately !== false) {
        void tick(gen);
      }
      intervalHandle = setInterval(() => {
        void tick(gen);
      }, cadence);
      setActive(true);
    },
    stop(): void {
      if (intervalHandle === null) return;
      clearInterval(intervalHandle);
      intervalHandle = null;
      activeOpts = null;
      generation += 1; // invalidate any in-flight tick
      setActive(false);
    },
    isActive(): boolean {
      return intervalHandle !== null;
    },
  };
}
