"use client";

/**
 * Beacon — React hooks layered on top of storage, envelope, pinata,
 * timelock-release, fire, cancel, watchdog, and transport-bridge.
 *
 * ## Lifecycle
 *
 * The page mirrors Herald/Scribe:
 *
 *   useIdentity()        → reuse Herald's hook to load the local identity.
 *   useTransport(id)     → reuse Herald's hook to build the AegisTransport.
 *   useBeacons()         → live list of locally-persisted beacons.
 *   useCreateBeacon(t)   → build + seal + upload + persist + tlock-publish.
 *   useCheckin(beacon)   → bump deadline forward; refresh.
 *   useCancelBeacon(t,b) → sign + publish cancellation; status → cancelled.
 *   useWatchdog(t)       → start a 60s watchdog; clear on unmount.
 *   useFireBeacon(t,b)   → manual "fire now (test)" affordance.
 *
 * All hooks that touch IndexedDB defer to `useEffect` and gate every read
 * on `typeof indexedDB !== "undefined"` so SSR is a no-op.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { roundForDate } from "../crypto/timelock";
import type { Identity } from "../identity";
import type { AegisTransport } from "../transport";

import { cancelBeacon as cancelBeaconImpl } from "./cancel";
import { encryptPayload } from "./envelope";
import { fireBeacon as fireBeaconImpl } from "./fire";
import {
  PinataNotConfiguredError,
  uploadBeaconCiphertext,
} from "./pinata-blob";
import {
  deleteBeacon as deleteBeaconImpl,
  loadBeacons,
  saveBeacon,
} from "./storage";
import { publishTimelockedRelease } from "./timelock-release";
import { attachBeaconBridge } from "./transport-bridge";
import {
  type Beacon,
  type NewBeaconInput,
} from "./types";
import {
  DEFAULT_WATCHDOG_INTERVAL_MS,
  startWatchdog,
} from "./watchdog";

/** Default grace seconds for `NewBeaconInput.graceSeconds`. */
export const DEFAULT_GRACE_SECONDS = 3600;

/* -------------------------------------------------------------------------- */
/* useBeacons                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Live beacons list. Maintained as React state — `refresh()` re-reads from
 * IndexedDB after any mutation. Sorted asc by `deadlineUnix` (soonest
 * first) at the storage layer.
 */
export function useBeacons(): {
  beacons: Beacon[];
  refresh: () => Promise<void>;
} {
  const [beacons, setBeacons] = useState<Beacon[]>([]);

  // Re-uses Herald/Scribe's "setState always inside .then() callback"
  // pattern to satisfy the react-hooks/set-state-in-effect lint without
  // disabling the rule.
  const refresh = useCallback((): Promise<void> => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return loadBeacons().then((list) => {
      setBeacons(list);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    loadBeacons().then((list) => {
      if (cancelled) return;
      setBeacons(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { beacons, refresh };
}

/* -------------------------------------------------------------------------- */
/* useCreateBeacon                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns a `create(input)` that:
 *
 *   1. Validates the input (deadline in the future, non-empty title/body).
 *   2. Encrypts the body under a fresh symmetric key (AAD = "aegis:beacon:v=1").
 *   3. Uploads the ciphertext to Pinata. Surfaces
 *      `PinataNotConfiguredError` as a clear error rather than persisting a
 *      half-built row.
 *   4. Computes the drand round from `deadline + grace` via tlock-js
 *      defaults.
 *   5. Persists the Beacon row locally.
 *   6. Builds and publishes the timelock-encrypted release event on every
 *      connected network. If that fails on every network, the row is still
 *      saved with `timelockedReleasesPublished = false`; the UI surfaces
 *      this as "Slow path not anchored".
 *
 * The create flow is *not* wrapped in a transaction across IDB + Pinata —
 * a Pinata upload failure rolls back via the early throw, so no row is
 * written. A timelock-publish failure rolls FORWARD: the local row is the
 * source of truth and the slow path can be re-attempted later (live-infra
 * deferred).
 */
export function useCreateBeacon(transport: AegisTransport | null): {
  create: (input: NewBeaconInput) => Promise<Beacon>;
  isWorking: boolean;
  error: string | null;
} {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(
    async (input: NewBeaconInput): Promise<Beacon> => {
      setError(null);
      const title = input.title.trim();
      const message = input.message;
      if (!title) {
        throw new Error("title is required");
      }
      if (!message.trim()) {
        throw new Error("message body is required");
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (input.deadlineUnix <= nowSec) {
        throw new Error("deadline must be in the future");
      }
      const graceSeconds = input.graceSeconds ?? DEFAULT_GRACE_SECONDS;
      if (graceSeconds < 0) {
        throw new Error("grace seconds must be non-negative");
      }
      const checkinIntervalSeconds =
        input.checkinIntervalSeconds ?? Math.max(60, input.deadlineUnix - nowSec);
      setIsWorking(true);
      try {
        const { ciphertext, keyHex } = await encryptPayload(message);
        let cid: string;
        try {
          const result = await uploadBeaconCiphertext(ciphertext);
          cid = result.cid;
        } catch (err) {
          if (err instanceof PinataNotConfiguredError) {
            const msg =
              "Pinata not configured — Beacon needs IPFS pinning to persist release payloads.";
            setError(msg);
            throw new Error(msg);
          }
          throw err;
        }

        // Project deadline + grace onto a drand quicknet round. tlock-js's
        // `roundForDate` expects a Date.
        const drandRound = roundForDate(
          new Date((input.deadlineUnix + graceSeconds) * 1000),
        );

        const beacon: Beacon = {
          id: mintBeaconId(),
          title,
          payloadCid: cid,
          unwrapKeyHex: keyHex,
          deadlineUnix: input.deadlineUnix,
          graceSeconds,
          drandRound,
          checkinIntervalSeconds,
          timelockedReleasesPublished: false,
          status: "pending",
          lastCheckinUnix: 0,
          createdAt: nowSec,
        };
        await saveBeacon(beacon);

        // Best-effort tlock fan-out. We update the row's
        // `timelockedReleasesPublished` flag inside `publishTimelockedRelease`
        // if any network accepted, so the caller's view of the beacon needs
        // to re-read after this resolves.
        let finalBeacon = beacon;
        if (transport) {
          try {
            const { beacon: anchored } = await publishTimelockedRelease(
              transport,
              beacon,
            );
            finalBeacon = anchored;
          } catch (err) {
            // Already swallowed inside the helper; this catch is the
            // belt-and-suspenders for unexpected throws.
            console.error("[beacon] timelock publish failed:", err);
          }
        }
        return finalBeacon;
      } finally {
        setIsWorking(false);
      }
    },
    [transport],
  );

  return { create, isWorking, error };
}

/* -------------------------------------------------------------------------- */
/* useCheckin                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Returns a `checkin()` that updates `lastCheckinUnix` to now and bumps
 * `deadlineUnix` forward by `checkinIntervalSeconds`. Status briefly flips
 * to `"checked-in"` for one render, then back to `"pending"` so the
 * watchdog continues to evaluate it normally.
 *
 * The dual-status flip is purely UI sugar — the watchdog already treats
 * `"checked-in"` as pending (see `trigger-check.ts`). The reset happens
 * inside `checkin` via two sequential `saveBeacon` calls; we don't bother
 * with a long-lived "checked-in" state because the UI just wants to flash
 * confirmation, not encode a long-lived sub-state.
 */
export function useCheckin(beacon: Beacon | null): {
  checkin: () => Promise<Beacon | null>;
  isWorking: boolean;
} {
  const [isWorking, setIsWorking] = useState(false);

  const checkin = useCallback(async (): Promise<Beacon | null> => {
    if (!beacon) return null;
    if (beacon.status !== "pending" && beacon.status !== "checked-in") {
      return null;
    }
    setIsWorking(true);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const bumped: Beacon = {
        ...beacon,
        status: "pending",
        deadlineUnix: nowSec + beacon.checkinIntervalSeconds,
        lastCheckinUnix: nowSec,
      };
      await saveBeacon(bumped);
      return bumped;
    } finally {
      setIsWorking(false);
    }
  }, [beacon]);

  return { checkin, isWorking };
}

/* -------------------------------------------------------------------------- */
/* useCancelBeacon                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns a `cancel()` that signs + publishes a cancellation, then stamps
 * the local row as cancelled.
 */
export function useCancelBeacon(
  transport: AegisTransport | null,
  identity: Identity | null,
  beacon: Beacon | null,
): {
  cancel: () => Promise<Beacon | null>;
  isWorking: boolean;
  error: string | null;
} {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(async (): Promise<Beacon | null> => {
    if (!transport || !identity || !beacon) return null;
    if (beacon.status !== "pending" && beacon.status !== "checked-in") {
      return null;
    }
    setIsWorking(true);
    setError(null);
    try {
      const result = await cancelBeaconImpl(transport, identity, beacon);
      return result.beacon;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setIsWorking(false);
    }
  }, [transport, identity, beacon]);

  return { cancel, isWorking, error };
}

/* -------------------------------------------------------------------------- */
/* useFireBeacon                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Manual "fire now (test)" affordance for the detail pane. Bypasses the
 * watchdog and the deadline check — used to validate the fan-out path
 * against live networks.
 */
export function useFireBeacon(
  transport: AegisTransport | null,
  beacon: Beacon | null,
): {
  fireNow: () => Promise<Beacon | null>;
  isWorking: boolean;
  error: string | null;
} {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fireNow = useCallback(async (): Promise<Beacon | null> => {
    if (!transport || !beacon) return null;
    if (beacon.status !== "pending" && beacon.status !== "checked-in") {
      return null;
    }
    setIsWorking(true);
    setError(null);
    try {
      const result = await fireBeaconImpl(transport, beacon);
      return result.beacon;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setIsWorking(false);
    }
  }, [transport, beacon]);

  return { fireNow, isWorking, error };
}

/* -------------------------------------------------------------------------- */
/* useDeleteBeacon                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns a `remove(id)` that deletes a beacon row. Used for fired /
 * cancelled / expired beacons the user wants to clear out of their list.
 *
 * No network side effects — deleting a row locally does NOT republish a
 * cancellation. To "stop" a still-pending beacon use `useCancelBeacon`.
 */
export function useDeleteBeacon(): {
  remove: (id: string) => Promise<void>;
  isWorking: boolean;
} {
  const [isWorking, setIsWorking] = useState(false);
  const remove = useCallback(async (id: string): Promise<void> => {
    setIsWorking(true);
    try {
      await deleteBeaconImpl(id);
    } finally {
      setIsWorking(false);
    }
  }, []);
  return { remove, isWorking };
}

/* -------------------------------------------------------------------------- */
/* useWatchdog                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Mount the client-side watchdog and tear it down on unmount or transport
 * change. The `onTick` callback fires after each evaluation pass so the
 * page can refresh its visible list when a beacon flips to `fired`.
 */
export function useWatchdog(
  transport: AegisTransport | null,
  intervalMs: number = DEFAULT_WATCHDOG_INTERVAL_MS,
  onUpdate?: () => void,
): void {
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    if (!transport) return;
    if (typeof indexedDB === "undefined") return;
    const stop = startWatchdog(transport, intervalMs);
    // Wire the bridge alongside the watchdog: the bridge listens for our
    // own fire/cancel events arriving back through subscribe and keeps
    // the row in sync (e.g. another tab fired the beacon).
    const detachBridge = attachBeaconBridge(transport, () => {
      onUpdateRef.current?.();
    });
    return () => {
      try {
        stop();
      } catch {
        /* ignore */
      }
      try {
        detachBridge();
      } catch {
        /* ignore */
      }
    };
  }, [transport, intervalMs]);
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mint a fresh beacon id. Uses `crypto.randomUUID()` when available, with
 * a Math.random()-stem fallback for older runtimes — same pattern Herald
 * uses for message ids. Beacon ids cross the wire (release events,
 * cancellations) but are NOT security-sensitive: ownership is established
 * by the Schnorr signature on cancellation, not by the id itself.
 */
export function mintBeaconId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return (
    Math.random().toString(16).slice(2) +
    "-" +
    Date.now().toString(16) +
    "-" +
    Math.random().toString(16).slice(2)
  );
}

/**
 * Compute the time remaining (in seconds) until a beacon's deadline. May
 * be negative if the deadline has passed. Used by the countdown UI and
 * the status badge.
 */
export function secondsUntilDeadline(
  beacon: Beacon,
  now: number = Date.now() / 1000,
): number {
  return Math.floor(beacon.deadlineUnix - now);
}

/**
 * Format a positive or negative second-count as a brutalist countdown
 * label: `Dd HH:MM:SS` (days suppressed under 1) or `-HH:MM:SS` if
 * elapsed past the deadline.
 */
export function formatCountdown(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  const abs = Math.abs(totalSeconds);
  const days = Math.floor(abs / 86_400);
  const rem1 = abs - days * 86_400;
  const hours = Math.floor(rem1 / 3600);
  const rem2 = rem1 - hours * 3600;
  const minutes = Math.floor(rem2 / 60);
  const seconds = rem2 - minutes * 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hhmmss = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (days > 0) return `${sign}${days}d ${hhmmss}`;
  return `${sign}${hhmmss}`;
}

/** Format a Unix-seconds timestamp as a short ISO label (UTC). */
export function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}
