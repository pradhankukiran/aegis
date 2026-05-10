"use client";

/**
 * Crucible — React hooks layered on top of the submit + receive primitives.
 *
 * # Hooks composed here
 *
 *   Source side (anonymous):
 *     useSubmitDrop(transport)   — `submit(newsroomPubkey, message, file?)`.
 *
 *   Newsroom side (signed in):
 *     useIdentity()              — load-or-generate the master identity.
 *     useTransport(identity)     — dynamic AegisTransport + connect.
 *     useDrops()                 — live decrypted drop list (sorted desc by ts).
 *     useDropReceiver(transport, identity)
 *                                — wires the subscribe + decrypt loop.
 *
 * The identity / transport hooks mirror Herald's so the newsroom-side
 * bootstrap pattern is identical to every other Aegis feature. They are
 * kept local (rather than importing from `../herald`) per the strict-file
 * constraint that Crucible must be self-contained.
 *
 * Hooks that touch IndexedDB defer to `useEffect`, never run during SSR,
 * and gate every read on `typeof indexedDB !== "undefined"`. The
 * transport (which pulls in matrix-js-sdk WASM) is dynamic-imported so
 * it never lands in the SSR bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  generateIdentity,
  loadIdentity,
  saveIdentity,
  type Identity,
} from "../identity";
import type { AegisTransport } from "../transport";

import { createDropReceiver } from "./receive";
import { loadDrops, markDropRead } from "./store";
import { submitDrop, describeSubmitError, type SubmitResult } from "./submit";
import type { DecryptedDrop } from "./types";

/* -------------------------------------------------------------------------- */
/* Newsroom — identity / transport (mirrors Herald)                            */
/* -------------------------------------------------------------------------- */

/**
 * Newsroom-only: load (or, on first run, require the user to generate)
 * the master identity from IndexedDB. The source side does NOT use this
 * hook — the source page never imports it.
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
 * status. Mirrors Herald's `useTransport` so the /crucible/newsroom route's
 * bootstrap pattern matches the rest of Aegis. The duplication is
 * intentional and constrained: a future shared hook can replace all of
 * them once the strict-file constraints loosen.
 *
 * Source-side: the source page also calls this — that's fine because the
 * source publishes its pointer event via the same transport facade. The
 * pubkey identity inside the source's transport instance is irrelevant
 * (the ephemeral keypair handles all crypto); only the ability to
 * `transport.publish(...)` matters. We accept a null identity argument so
 * the source page can render a "no transport yet" CTA when needed.
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
/* Source — useSubmitDrop                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Source-side submit hook. Returns `submit(newsroomPubkey, message, file?)`
 * plus `isWorking` and `error` for UI plumbing.
 *
 * The hook itself NEVER touches IDB. On success it returns the
 * `SubmitResult` (drop id + CID + ephemeral pubkey + ts + per-network
 * publish results) so the page can render the success screen.
 *
 * `transport` may be null while the source page is still bringing it up;
 * `submit` rejects with a clear error in that case so the UI doesn't
 * silently swallow.
 */
export function useSubmitDrop(
  transport: AegisTransport | null,
): {
  submit: (
    newsroomPubkey: string,
    message: string,
    file?: File,
  ) => Promise<SubmitResult | null>;
  isWorking: boolean;
  error: string | null;
  reset: () => void;
} {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const reset = useCallback(() => {
    setError(null);
    setIsWorking(false);
  }, []);

  const submit = useCallback(
    async (
      newsroomPubkey: string,
      message: string,
      file?: File,
    ): Promise<SubmitResult | null> => {
      if (!transport) {
        setError("Drop service is connecting — try again in a moment.");
        return null;
      }
      const mySeq = ++seqRef.current;
      setIsWorking(true);
      setError(null);
      try {
        const result = await submitDrop({
          transport,
          newsroomPubkeyHex: newsroomPubkey,
          message,
          file,
        });
        return result;
      } catch (err) {
        const message = describeSubmitError(err);
        if (seqRef.current === mySeq) {
          setError(message);
        }
        return null;
      } finally {
        if (seqRef.current === mySeq) {
          setIsWorking(false);
        }
      }
    },
    [transport],
  );

  return { submit, isWorking, error, reset };
}

/* -------------------------------------------------------------------------- */
/* Newsroom — useDrops                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Live list of decrypted drops from IndexedDB, sorted newest-first.
 * `refresh()` re-reads from IDB — the bridge calls onDrop, which the
 * caller wires up to bump `refresh` so the new row appears immediately.
 */
export function useDrops(): {
  drops: DecryptedDrop[];
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
} {
  const [drops, setDrops] = useState<DecryptedDrop[]>([]);

  const refresh = useCallback((): Promise<void> => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return loadDrops().then((list) => {
      // loadDrops already sorts desc by ts.
      setDrops(list);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    loadDrops().then((list) => {
      if (cancelled) return;
      setDrops(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const markRead = useCallback(
    async (id: string): Promise<void> => {
      await markDropRead(id);
      await refresh();
    },
    [refresh],
  );

  return { drops, refresh, markRead };
}

/* -------------------------------------------------------------------------- */
/* Newsroom — useDropReceiver                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Start the newsroom subscribe + decrypt loop. Returns no value; the
 * caller wires `onDrop` to refresh the drop list. The effect cleans up
 * on transport change / identity change / unmount.
 *
 * `onDrop` is captured into a ref so the caller can hand a new closure
 * on each render without tearing down the subscription.
 */
export function useDropReceiver(
  transport: AegisTransport | null,
  identity: Identity | null,
  onDrop: (drop: DecryptedDrop) => void,
): void {
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    if (!transport || !identity) return;
    const receiver = createDropReceiver(transport, identity);
    const unsub = receiver.subscribe((drop) => {
      onDropRef.current(drop);
    });
    return () => {
      try {
        unsub();
      } catch {
        /* ignore — the underlying transport may already be closed */
      }
    };
  }, [transport, identity]);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a user-supplied pubkey hex to lowercase, trimmed. Accepts
 * 64- or 66-char hex. Does NOT strip the parity prefix — the caller
 * decides which form to display (the source page accepts either, the
 * newsroom subscriber accepts both forms simultaneously).
 *
 * Throws on non-hex / wrong length input. Use `isValidPubkeyHex` for a
 * predicate without exceptions.
 */
export function normalizePubkeyInput(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(trimmed)) {
    throw new Error("pubkey must be hex");
  }
  if (trimmed.length !== 64 && trimmed.length !== 66) {
    throw new Error(`pubkey must be 64 or 66 hex chars (got ${trimmed.length})`);
  }
  return trimmed;
}

/** True iff `input` is a 64- or 66-char hex string. */
export function isValidPubkeyHex(input: string): boolean {
  const trimmed = input.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return false;
  return trimmed.length === 64 || trimmed.length === 66;
}

/** Format a 64- or 66-char pubkey as `abcd1234…ef01` (8 + 4 chars). */
export function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/**
 * Tor detection — `window.location.hostname.endsWith('.onion')`. SSR-safe:
 * returns `false` when `window` is undefined.
 *
 * `useTorIndicator` wraps this in a hook so the UI only commits the
 * decision after mount (avoiding a hydration mismatch where SSR rendered
 * "not on Tor" and the client immediately changed to "on Tor").
 */
export function isOnTor(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hostname.endsWith(".onion");
}

/**
 * Tor indicator hook. `null` until the post-mount effect runs (so SSR
 * and the first client render match); then `true` or `false`.
 *
 * The setState is deferred through a microtask so it fires outside the
 * effect's synchronous boundary — matches the pattern useConversations /
 * useMessages use to satisfy `react-hooks/set-state-in-effect`.
 */
export function useTorIndicator(): boolean | null {
  const [onTor, setOnTor] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setOnTor(isOnTor());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return onTor;
}
