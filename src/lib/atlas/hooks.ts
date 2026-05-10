"use client";

/**
 * Atlas — React hooks layered on top of storage + share-service + bridge.
 *
 * ## Lifecycle (page side)
 *
 *   useIdentity()       — same as Herald (re-exposed so /atlas can match
 *                         Herald's identity-required UX).
 *   useTransport(id)    — same as Herald (re-exposed; the AegisTransport
 *                         lifetime is per-identity).
 *   useCircle()         — live list of circle members.
 *   useReceivedFixes()  — live map of latest fix per peer.
 *   useShare()          — controls the share-service interval.
 *
 * Hooks that touch IndexedDB defer to `useEffect`, never run during SSR,
 * and gate every read on `typeof indexedDB !== "undefined"`. The transport
 * (dynamically imported in the hook) never lands in the SSR bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generateIdentity, loadIdentity, saveIdentity } from "../identity";
import type { Identity } from "../identity";
import type { AegisTransport } from "../transport";

import {
  deleteMember,
  loadCircle,
  putMember,
} from "./circle-store";
import { GeolocationFetchError, queryPermission } from "./geolocation";
import { latestFixesByMember } from "./position-store";
import {
  createShareService,
  DEFAULT_SHARE_INTERVAL_MS,
  type ShareService,
} from "./share-service";
import { attachLocationBridge } from "./transport-bridge";
import type {
  CircleMember,
  GeolocationPermissionState,
  PositionFix,
  ReceivedFix,
  ShareSession,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Identity / transport (mirrors Herald's hooks)                                */
/* -------------------------------------------------------------------------- */

/**
 * Load (or, on first run, require the user to generate) the master
 * identity from IndexedDB. Mirrors Herald's `useIdentity` so the /atlas
 * route's bootstrap pattern is identical.
 */
export function useIdentity(): {
  identity: Identity | null;
  ready: boolean;
  generate: () => Promise<Identity>;
} {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    loadIdentity()
      .then((id) => {
        if (cancelled) return;
        setIdentity(id);
      })
      .catch(() => {
        if (cancelled) return;
        setIdentity(null);
      })
      .finally(() => {
        if (cancelled) return;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = useCallback(async () => {
    const fresh = await generateIdentity();
    await saveIdentity(fresh);
    setIdentity(fresh);
    return fresh;
  }, []);

  return { identity, ready, generate };
}

/** Per-network connection status. `null` means "not yet attempted". */
export type TransportStatus = {
  nostr: boolean | null;
  matrix: boolean | null;
  ssb: boolean | null;
};

const INITIAL_STATUS: TransportStatus = {
  nostr: null,
  matrix: null,
  ssb: null,
};

function readTransportConfig() {
  const matrixHs =
    process.env.NEXT_PUBLIC_AEGIS_MATRIX_HOMESERVER ?? "https://matrix.aegis.app";
  const ssbUrl =
    process.env.NEXT_PUBLIC_AEGIS_SSB_URL ?? "wss://ssb.aegis.app/aegis-ws";
  const matrixToken =
    process.env.NEXT_PUBLIC_AEGIS_MATRIX_REGISTRATION_TOKEN ?? undefined;
  return { matrixHs, ssbUrl, matrixToken };
}

/**
 * Lazily construct an `AegisTransport`, connect it, and report per-network
 * status. The transport is held in a ref so it survives re-renders.
 * Building it dynamic-imports matrix-js-sdk (WASM, IndexedDB) — keeping
 * the SSR pass clean.
 *
 * Mirrors Herald's `useTransport` so a future shared hook can replace
 * both. Until that refactor lands, the duplication is intentional —
 * keeps Atlas self-contained per the strict file constraints.
 */
export function useTransport(identity: Identity | null): {
  transport: AegisTransport | null;
  status: TransportStatus;
  ready: boolean;
} {
  const [transport, setTransport] = useState<AegisTransport | null>(null);
  const [status, setStatus] = useState<TransportStatus>(INITIAL_STATUS);
  const liveRef = useRef<AegisTransport | null>(null);

  useEffect(() => {
    if (!identity) return;
    if (typeof window === "undefined") return;
    let cancelled = false;
    let local: AegisTransport | null = null;

    (async () => {
      const { AegisTransport } = await import("../transport");
      const { matrixHs, ssbUrl, matrixToken } = readTransportConfig();
      local = new AegisTransport(identity, {
        nostr: {},
        matrix: {
          homeserver: matrixHs,
          ...(matrixToken ? { registrationToken: matrixToken } : {}),
        },
        ssb: { pubUrl: ssbUrl },
      });
      try {
        const connected = await local.connect();
        if (cancelled) {
          local.close().catch(() => undefined);
          return;
        }
        liveRef.current = local;
        setTransport(local);
        setStatus({
          nostr: connected.nostr,
          matrix: connected.matrix,
          ssb: connected.ssb,
        });
      } catch {
        if (cancelled) return;
        setStatus({ nostr: false, matrix: false, ssb: false });
      }
    })();

    return () => {
      cancelled = true;
      const t = liveRef.current;
      liveRef.current = null;
      setTransport(null);
      if (t) {
        t.close().catch(() => undefined);
      }
    };
  }, [identity]);

  const ready = useMemo(
    () =>
      Boolean(transport) &&
      (status.nostr === true || status.matrix === true || status.ssb === true),
    [transport, status],
  );

  return { transport, status, ready };
}

/* -------------------------------------------------------------------------- */
/* useCircle                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Live circle list. Mutations go through IndexedDB and immediately refresh
 * the in-memory copy. Pubkey is normalized to canonical 64-hex lowercase
 * before storage so the keyPath is stable.
 */
export function useCircle(): {
  members: CircleMember[];
  addMember: (pubkey: string, nickname?: string) => Promise<CircleMember>;
  removeMember: (pubkey: string) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [members, setMembers] = useState<CircleMember[]>([]);

  const refresh = useCallback((): Promise<void> => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return loadCircle().then((list) => {
      list.sort((a, b) => b.addedAt - a.addedAt);
      setMembers(list);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    loadCircle().then((list) => {
      if (cancelled) return;
      list.sort((a, b) => b.addedAt - a.addedAt);
      setMembers(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const addMember = useCallback(
    async (pubkey: string, nickname?: string): Promise<CircleMember> => {
      const normalized = normalizePubkey(pubkey);
      const member: CircleMember = {
        pubkey: normalized,
        nickname: nickname?.trim() || undefined,
        addedAt: Date.now(),
      };
      await putMember(member);
      await refresh();
      return member;
    },
    [refresh],
  );

  const removeMember = useCallback(
    async (pubkey: string): Promise<void> => {
      await deleteMember(pubkey);
      await refresh();
    },
    [refresh],
  );

  return { members, addMember, removeMember, refresh };
}

/* -------------------------------------------------------------------------- */
/* useReceivedFixes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Live map of `{from → latestFix}`. Caller can pass a `version` (or rely
 * on the auto-mount initial load) and call `refresh()` after the bridge
 * has dispatched a new fix.
 *
 * The bridge writes IDB then calls `onFix` → caller calls `refresh()`. We
 * don't subscribe directly to the bridge inside this hook because the
 * page already owns the bridge (via `attachLocationBridge`) and we want
 * to avoid double-subscription.
 */
export function useReceivedFixes(): {
  fixesByMember: Record<string, ReceivedFix>;
  refresh: () => Promise<void>;
} {
  const [fixesByMember, setFixesByMember] = useState<Record<string, ReceivedFix>>({});

  const refresh = useCallback((): Promise<void> => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return latestFixesByMember().then((map) => {
      setFixesByMember(map);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    latestFixesByMember().then((map) => {
      if (cancelled) return;
      setFixesByMember(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { fixesByMember, refresh };
}

/* -------------------------------------------------------------------------- */
/* useShare                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Drive the share-service loop. `members` is the live circle; the hook
 * restarts the service whenever the list changes (so a freshly-added peer
 * gets the next tick's fix without the user toggling off/on).
 *
 * `session.active` is the source of truth for the toggle UI. `lastError`
 * surfaces the most recent error from any of:
 *   - Geolocation permission denied / timeout / unavailable
 *   - Per-recipient transport.directMessage failures
 *
 * Errors are *categorical* (we keep the friendly enum from
 * GeolocationFetchError) so the UI can render stable copy without
 * substring-matching error.message.
 */
export function useShare(
  transport: AegisTransport | null,
  members: CircleMember[],
  intervalMs: number = DEFAULT_SHARE_INTERVAL_MS,
): {
  session: ShareSession;
  lastTickAt: number | null;
  lastError: Error | null;
  start: () => void;
  stop: () => void;
} {
  const [session, setSession] = useState<ShareSession>({
    active: false,
    intervalMs,
  });
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<Error | null>(null);

  // The service is a per-hook singleton. We build it once via useState's
  // lazy-init form so the factory runs exactly once for the lifetime of
  // the hook instance — useRef-with-conditional-write would trip the
  // "no ref access during render" lint and is structurally identical.
  //
  // On SSR we substitute a no-op stub so the hook returns without ever
  // touching `setInterval`. The real service is built client-side via
  // the effect below (so the first render returns a stub and the
  // second render gets the real service through state).
  const [service] = useState<ShareService>(() => {
    if (typeof window === "undefined") {
      return makeStubShareService();
    }
    return createShareService({
      onTick: (fix: PositionFix) => {
        setLastTickAt(fix.ts);
      },
      onError: (err: Error) => {
        setLastError(err);
      },
      onStateChange: (active: boolean) => {
        setSession((prev) => ({
          ...prev,
          active,
          startedAt: active ? Date.now() : undefined,
        }));
      },
    });
  });

  // Refs for the latest members + transport. We sync them inside an
  // effect (not during render) so the React 19 lint rule
  // "no-refs-during-render" is satisfied. The service's tick callback
  // reads these on each interval, so a member added between ticks lands
  // on the next tick without a hot-restart.
  const membersRef = useRef(members);
  const transportRef = useRef(transport);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);
  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  // If the member list changes while the loop is running, hot-swap. We
  // don't want a freshly-added peer to wait a full interval for their
  // first fix.
  useEffect(() => {
    if (!service.isActive()) return;
    const t = transportRef.current;
    if (!t) return;
    service.start({
      transport: t,
      members,
      intervalMs,
      // Don't double-fire when just members changed; the existing interval
      // will pick them up on the next tick.
      fireImmediately: false,
    });
  }, [members, intervalMs, service]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      service.stop();
    };
  }, [service]);

  // If transport drops mid-session, stop the loop so we don't burn
  // geolocation reads firing into a dead transport.
  useEffect(() => {
    if (!transport && service.isActive()) {
      service.stop();
    }
  }, [transport, service]);

  const start = useCallback(() => {
    const t = transportRef.current;
    if (!t) {
      setLastError(new Error("transport not ready"));
      return;
    }
    setLastError(null);
    service.start({
      transport: t,
      members: membersRef.current,
      intervalMs,
      fireImmediately: true,
    });
  }, [intervalMs, service]);

  const stop = useCallback(() => {
    service.stop();
  }, [service]);

  return { session, lastTickAt, lastError, start, stop };
}

/**
 * No-op ShareService for the SSR pass (returned from `useShare` when
 * `window` is undefined). The page never invokes start/stop server-side
 * — the user only sees the client-mounted instance — so the stub just
 * needs to satisfy the type without firing any browser APIs.
 */
function makeStubShareService(): ShareService {
  return {
    start: () => undefined,
    stop: () => undefined,
    isActive: () => false,
  };
}

/* -------------------------------------------------------------------------- */
/* usePermissionState                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort live readback of the geolocation permission state.
 *
 * Initial render returns `"unknown"` (we haven't asked yet). After mount,
 * `queryPermission()` resolves with the actual state. If the browser
 * supports `PermissionStatus.onchange` we hook it so denials/revokes
 * propagate without a manual refresh; otherwise the hook returns the
 * last-known value and the user can call `refresh()` after toggling
 * share.
 */
export function usePermissionState(): {
  permission: GeolocationPermissionState;
  refresh: () => Promise<void>;
} {
  const [permission, setPermission] = useState<GeolocationPermissionState>("unknown");

  const refresh = useCallback(async (): Promise<void> => {
    const p = await queryPermission();
    setPermission(p);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let status: PermissionStatus | null = null;
    let onChange: (() => void) | null = null;
    (async () => {
      const p = await queryPermission();
      if (cancelled) return;
      setPermission(p);
      // Hook onchange where supported so revokes propagate without polling.
      if (
        typeof navigator !== "undefined" &&
        (navigator as { permissions?: Permissions }).permissions
      ) {
        try {
          status = await navigator.permissions.query({
            name: "geolocation" as PermissionName,
          });
          if (cancelled) return;
          onChange = () => {
            const next = status?.state;
            if (next === "granted" || next === "denied" || next === "prompt") {
              setPermission(next);
            }
          };
          status.addEventListener?.("change", onChange);
        } catch {
          /* unsupported descriptor — initial value stands */
        }
      }
    })();
    return () => {
      cancelled = true;
      if (status && onChange) {
        try {
          status.removeEventListener?.("change", onChange);
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  return { permission, refresh };
}

/* -------------------------------------------------------------------------- */
/* useLocationBridge                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mount the transport-bridge subscription on the active transport. The
 * `onFix` callback fires after each persisted location DM so the page can
 * refresh `useReceivedFixes`.
 *
 * Same shape as Herald's `useIncomingBridge` so the page-level wiring is
 * one-liner.
 */
export function useLocationBridge(
  transport: AegisTransport | null,
  onFix: (fix: ReceivedFix) => void,
): void {
  const onFixRef = useRef(onFix);
  useEffect(() => {
    onFixRef.current = onFix;
  }, [onFix]);

  useEffect(() => {
    if (!transport) return;
    const unsub = attachLocationBridge(transport, (fix) => {
      onFixRef.current(fix);
    });
    return () => {
      try {
        unsub();
      } catch {
        /* ignore — underlying transport may already be closed */
      }
    };
  }, [transport]);
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a user-supplied pubkey hex to canonical 64-char lowercase x-only.
 * Accepts:
 *   - 64 hex chars → returned lowercase as-is
 *   - 66 hex chars (SEC1-compressed) → strip the parity byte and lowercase
 *
 * Throws on anything else. The dialog input layer validates first; this
 * function is the final guard before IDB.
 */
export function normalizePubkey(input: string): string {
  const trimmed = input.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error("pubkey must be hex");
  }
  if (trimmed.length === 64) return trimmed.toLowerCase();
  if (trimmed.length === 66) return trimmed.slice(2).toLowerCase();
  throw new Error(`pubkey must be 64 or 66 hex chars (got ${trimmed.length})`);
}

/** True iff `input` is a valid 64- or 66-char hex pubkey. */
export function isValidPubkeyHex(input: string): boolean {
  const trimmed = input.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return false;
  return trimmed.length === 64 || trimmed.length === 66;
}

/** Format a 64-char x-only pubkey as `abcd1234…ef01` (8 + 4 chars). */
export function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/**
 * Surface a friendly description for a `GeolocationFetchError`. Used by
 * the UI to render stable copy without coupling to the underlying
 * `error.message` strings.
 */
export function describeGeolocationError(err: Error): string {
  if (err instanceof GeolocationFetchError) {
    switch (err.kind) {
      case "permission-denied":
        return "Permission denied. Allow location access in your browser settings.";
      case "unavailable":
        return "Location is unavailable right now. Try again in a moment.";
      case "timeout":
        return "Location request timed out. Your device may have weak GPS reception.";
      case "unsupported":
        return "This browser does not support geolocation.";
    }
  }
  return err.message;
}
