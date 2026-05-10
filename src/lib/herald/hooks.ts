"use client";

/**
 * Herald — React hooks layered on top of the storage and transport-bridge
 * primitives.
 *
 * ## Lifecycle
 *
 * The page's lifecycle is roughly:
 *
 *   useIdentity()      → load-or-generate the local Identity from IndexedDB
 *   useTransport(id)   → lazily build an AegisTransport, connect, subscribe
 *   useConversations() → live list of conversations, plus addConversation()
 *   useMessages(conv)  → live list of messages for one conversation
 *   useSendMessage()   → returns a `send(plaintext)` with optimistic insert
 *
 * Hooks that touch IndexedDB defer to `useEffect`, never run during SSR,
 * and gate every read on `typeof indexedDB !== "undefined"`. The transport
 * (which pulls in matrix-js-sdk WASM) is dynamically imported so it never
 * lands in the SSR bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generateIdentity, loadIdentity, saveIdentity } from "../identity";
import type { Identity } from "../identity";
import type { AegisTransport } from "../transport";

import {
  appendMessage,
  loadConversations,
  loadMessages,
  saveConversation,
  updateMessageStatus,
} from "./store";
import { attachIncomingBridge } from "./transport-bridge";
import type { Conversation, Message } from "./types";

/* -------------------------------------------------------------------------- */
/* useIdentity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Loads (or, on first run, requires the user to generate) the master
 * identity from IndexedDB.
 *
 * Returns:
 *   - `identity`: the loaded identity, or `null` while we're still checking
 *                 storage, or `null` if no identity exists yet.
 *   - `ready`:    true once the initial load attempt has settled (success
 *                 or "no record"). Drives the page's "loading shell" gate.
 *   - `generate`: mints a fresh identity, persists it, and updates state.
 *   - `regenerate`: same as `generate` but overwrites any existing record.
 */
export function useIdentity(): {
  identity: Identity | null;
  ready: boolean;
  generate: () => Promise<Identity>;
  regenerate: () => Promise<Identity>;
} {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") {
      // Server pass — leave `identity` as null and `ready` as false. The
      // client mount will run the effect for real.
      return;
    }
    loadIdentity()
      .then((id) => {
        if (cancelled) return;
        setIdentity(id);
      })
      .catch(() => {
        // A storage failure shouldn't block the UI from offering "Generate".
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

  // `regenerate` is intentionally identical to `generate` for now —
  // `saveIdentity` is `put` (upsert), so it overwrites. We keep the alias so
  // a future "are you sure?" flow can hang behavior off it without API churn.
  const regenerate = generate;

  return { identity, ready, generate, regenerate };
}

/* -------------------------------------------------------------------------- */
/* useTransport                                                                 */
/* -------------------------------------------------------------------------- */

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

/**
 * Read defaults from `process.env.NEXT_PUBLIC_AEGIS_*`, falling back to the
 * production hostnames in the spec. NEXT_PUBLIC_* vars are inlined at build
 * time, so this is safe to call at module scope.
 */
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
 * status. The transport is held in a ref so it survives re-renders without
 * being torn down and rebuilt — building it triggers matrix-js-sdk WASM
 * loading and Nostr socket setup, both expensive.
 *
 * The `transport` returned is `null` until the build+connect promise has
 * resolved. `ready` is true once at least one network has successfully
 * connected (i.e. the user can do *something*).
 *
 * Cleanup: when the identity changes or the component unmounts, we close
 * the transport. Closing is best-effort (it swallows per-network errors).
 */
export function useTransport(identity: Identity | null): {
  transport: AegisTransport | null;
  status: TransportStatus;
  ready: boolean;
} {
  const [transport, setTransport] = useState<AegisTransport | null>(null);
  const [status, setStatus] = useState<TransportStatus>(INITIAL_STATUS);
  // Hold the live instance in a ref so cleanup can call close() without
  // racing the state setter.
  const liveRef = useRef<AegisTransport | null>(null);

  useEffect(() => {
    // No identity → leave transport at the initial null/INITIAL_STATUS.
    // (Returning the cleanup from the *previous* render already handled
    // resetting state if `identity` flipped from non-null to null.)
    if (!identity) return;
    if (typeof window === "undefined") return; // SSR safety
    let cancelled = false;
    let local: AegisTransport | null = null;

    (async () => {
      // Dynamic import: matrix-js-sdk pulls in WASM and IndexedDB code that
      // can't be bundled into the SSR pass. Importing here keeps the page's
      // initial JS lean, too.
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
          // Identity changed mid-connect — discard.
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
    () => Boolean(transport) && (status.nostr === true || status.matrix === true || status.ssb === true),
    [transport, status],
  );

  return { transport, status, ready };
}

/* -------------------------------------------------------------------------- */
/* useConversations                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Live conversation list, sorted by `lastMessageAt` desc.
 *
 * The list is maintained as React state. `addConversation` writes through
 * to IndexedDB and updates state synchronously so the UI reflects the new
 * row immediately. A periodic `refresh` lets external mutators (the
 * transport bridge in particular) push their changes back into the list.
 */
export function useConversations(): {
  conversations: Conversation[];
  addConversation: (pubkey: string) => Promise<Conversation>;
  refresh: () => Promise<void>;
} {
  const [conversations, setConversations] = useState<Conversation[]>([]);

  // `refresh` does the IndexedDB read and only calls setState from inside a
  // .then() callback. The intermediate Promise hop is what tells the
  // react-hooks/set-state-in-effect rule "this setState fires outside the
  // effect body" — calling .then with a separate function literal makes the
  // boundary visually and statically obvious.
  const refresh = useCallback((): Promise<void> => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return loadConversations().then((list) => {
      list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      setConversations(list);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadConversations().then((list) => {
      if (cancelled) return;
      list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      setConversations(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const addConversation = useCallback(
    async (pubkey: string): Promise<Conversation> => {
      const normalized = normalizePubkey(pubkey);
      const now = Date.now();
      const c: Conversation = {
        pubkey: normalized,
        createdAt: now,
        lastMessageAt: now,
      };
      await saveConversation(c);
      await refresh();
      return c;
    },
    [refresh],
  );

  return { conversations, addConversation, refresh };
}

/* -------------------------------------------------------------------------- */
/* useMessages                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Live message list for a single conversation. Returns an empty list if
 * `convId` is null.
 *
 * Like `useConversations`, this exposes a `refresh()` so external mutators
 * (the transport bridge) can ask the hook to re-read from IndexedDB.
 */
export function useMessages(convId: string | null): {
  messages: Message[];
  refresh: () => Promise<void>;
  appendOptimistic: (m: Message) => void;
  patch: (id: string, partial: Partial<Message>) => void;
} {
  const [messages, setMessages] = useState<Message[]>([]);

  // External-facing `refresh` (UI-side cache invalidator). Re-uses the same
  // promise-then pattern as useConversations.refresh so the setState is
  // clearly inside the .then() callback rather than the synchronous body.
  const refresh = useCallback((): Promise<void> => {
    if (!convId) {
      return Promise.resolve().then(() => {
        setMessages([]);
      });
    }
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return loadMessages(convId).then((list) => {
      setMessages(list);
    });
  }, [convId]);

  useEffect(() => {
    let cancelled = false;
    if (!convId) {
      // No conversation selected: drop any messages from the previous one.
      // We chain through a microtask so the setState boundary is .then-side.
      Promise.resolve().then(() => {
        if (!cancelled) setMessages([]);
      });
      return () => {
        cancelled = true;
      };
    }
    loadMessages(convId).then((list) => {
      if (cancelled) return;
      setMessages(list);
    });
    return () => {
      cancelled = true;
    };
  }, [convId]);

  const appendOptimistic = useCallback((m: Message) => {
    setMessages((prev) => {
      // Skip duplicates if the bridge somehow beat us.
      if (prev.some((p) => p.id === m.id)) return prev;
      const next = [...prev, m];
      next.sort((a, b) => a.ts - b.ts);
      return next;
    });
  }, []);

  const patch = useCallback((id: string, partial: Partial<Message>) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...partial } : m)),
    );
  }, []);

  return { messages, refresh, appendOptimistic, patch };
}

/* -------------------------------------------------------------------------- */
/* useSendMessage                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Returns a `send(plaintext)` function that:
 *
 *   1. Mints a UUID for the message.
 *   2. Inserts a `sending` row into IndexedDB and pushes it onto local state.
 *   3. Calls `transport.directMessage(convId, plaintext)` (Matrix → Nostr →
 *      SSB fallback chain — see `transport/index.ts`).
 *   4. On success: marks the row `sent` and stamps `via` with the network
 *      that won the race.
 *   5. On failure: marks `failed`. Reason is logged to console; we don't
 *      surface a toast yet (TODO when we wire up `sonner`).
 *
 * The message id needs to be unique across this conversation. We use
 * `crypto.randomUUID()` when available and fall back to a Math.random()
 * stem in environments that lack it (older test runners). UUIDs are not
 * security-sensitive here — they're just IndexedDB primary keys.
 */
export function useSendMessage(
  transport: AegisTransport | null,
  convId: string | null,
  hooks?: {
    appendOptimistic?: (m: Message) => void;
    patch?: (id: string, partial: Partial<Message>) => void;
  },
): {
  send: (plaintext: string) => Promise<void>;
  sending: boolean;
} {
  const [sending, setSending] = useState(false);

  const send = useCallback(
    async (plaintext: string) => {
      if (!transport) throw new Error("transport not ready");
      if (!convId) throw new Error("no conversation selected");
      const trimmed = plaintext.trim();
      if (!trimmed) return;
      setSending(true);
      const id = mintId();
      const optimistic: Message = {
        id,
        convId,
        body: trimmed,
        ts: Date.now(),
        mine: true,
        status: "sending",
      };
      try {
        await appendMessage(optimistic);
        hooks?.appendOptimistic?.(optimistic);
        try {
          const result = await transport.directMessage(convId, trimmed);
          await updateMessageStatus(id, "sent", result.network);
          hooks?.patch?.(id, { status: "sent", via: result.network });
        } catch (err) {
          await updateMessageStatus(id, "failed");
          hooks?.patch?.(id, { status: "failed" });
          console.error("[herald] send failed:", err);
        }
      } finally {
        setSending(false);
      }
    },
    [transport, convId, hooks],
  );

  return { send, sending };
}

/* -------------------------------------------------------------------------- */
/* useIncomingBridge                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mount the transport-bridge subscription. Whenever an inbound aegis.message
 * lands in IndexedDB, calls `onMessage` so the page can refresh the active
 * conversation's message list.
 */
export function useIncomingBridge(
  transport: AegisTransport | null,
  onMessage: (m: Message) => void,
): void {
  const onMessageRef = useRef(onMessage);
  // Always use the latest callback without re-subscribing.
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!transport) return;
    const unsub = attachIncomingBridge(transport, (m) => {
      onMessageRef.current(m);
    });
    return () => {
      try {
        unsub();
      } catch {
        /* ignore — the underlying transport may already be closed */
      }
    };
  }, [transport]);
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a user-supplied pubkey hex to the canonical x-only 64-char form.
 * Accepts:
 *   - 64 hex chars  → returned lowercase as-is.
 *   - 66 hex chars  → SEC1-compressed; strip the parity byte and lowercase.
 *
 * Throws on anything else. Callers should validate up-front so this is just
 * a final guard.
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

/** True iff `input` is a 64- or 66-char hex string. */
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

function mintId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Cheap fallback for environments without crypto.randomUUID.
  return (
    Math.random().toString(16).slice(2) +
    "-" +
    Date.now().toString(16) +
    "-" +
    Math.random().toString(16).slice(2)
  );
}
