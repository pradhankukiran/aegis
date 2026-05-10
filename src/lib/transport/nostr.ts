/**
 * Aegis Nostr transport — a focused wrapper around `nostr-tools`.
 *
 * One `NostrTransport` instance owns:
 *   - the user's Aegis identity (secp256k1, x-only Nostr-form pubkey is derived)
 *   - a single `SimplePool` (per nostr-tools README: "you always should be using
 *     a SimplePool")
 *   - the set of relays we're currently connected to
 *
 * Public surface (intentionally small — Aegis features compose on top):
 *   - `connect(relays?)`    open relays; returns the URLs we successfully reached
 *   - `publish(event)`      sign + fan out; returns per-relay success/failure
 *   - `subscribe(filter, fn)` deduped multi-relay subscription; returns unsubscribe()
 *   - `directMessage(toPubkey, plaintext)` NIP-44 v2 encrypted DM (kind 14)
 *   - `decryptDirectMessage(event)` reverse of the above
 *   - `close()` shut down all relays
 *   - `pubkey` accessor — x-only 32-byte hex (Nostr's pubkey format)
 *
 * # DM scheme
 *
 * Aegis sends DMs as **NIP-44 v2 encrypted content inside `kind 14`** (the
 * "Private Direct Message" kind from NIP-17). We deliberately do *not* wrap
 * these in NIP-59 gift-wrap (`kind 1059`) yet — the plain NIP-44 v2 ciphertext
 * payload is what `nostr-tools` exposes most directly and what plan §3.1
 * specifies as the Nostr fallback for `directMessage`. NIP-17 gift-wrapping
 * (which adds metadata privacy by hiding `pubkey` / `created_at` of the inner
 * event) is a future enhancement; the *content layer* is forward-compatible
 * because the inner ciphertext is the same NIP-44 v2 payload either way.
 *
 * NIP-04 (`kind 4`) is intentionally not used — deprecated upstream.
 *
 * # Identity → Nostr pubkey mapping
 *
 * Aegis identities use 33-byte SEC1-compressed secp256k1 pubkeys (parity byte
 * 0x02/0x03 + 32-byte x). Nostr (BIP-340 schnorr) uses the bare 32-byte x —
 * "x-only" pubkeys. We strip the parity byte to convert. Valid because the
 * x-coordinate alone uniquely determines the BIP-340-canonical (even-Y) point.
 *
 * # Signing
 *
 * BIP-340 schnorr from `@noble/curves/secp256k1`. Crucially **NOT** the
 * `src/lib/crypto/schnorr.ts` Σ-protocol proof-of-knowledge — that's a
 * different primitive that doesn't produce a Nostr-compatible signature.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as nip44 from "nostr-tools/nip44";
import { SimplePool } from "nostr-tools/pool";

import { bytesToHex, hexToBytes, utf8Encode } from "../crypto";
import type { Identity } from "../identity";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** Caller-supplied event: kind + content + optional tags + optional timestamp. */
export type NostrEventInput = {
  kind: number;
  content: string;
  tags?: string[][];
  created_at?: number;
};

/** A signed Nostr event (BIP-340 schnorr signature, hex-encoded fields). */
export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

/**
 * Filter type. Strings prefixed `#` (e.g. `#e`, `#p`, `#t`) are tag filters
 * matching events whose first tag-element equals the prefix and second
 * element is in the supplied list.
 */
export type NostrFilter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  "#e"?: string[];
  "#p"?: string[];
  // Allow arbitrary tag filters (`#t`, `#d`, …) and any future fields.
  [key: string]: unknown;
};

/** Per-relay result of a `publish` call. */
export type PublishResult = {
  relay: string;
  ok: boolean;
  /** Server-provided reason (success message or failure description). */
  reason?: string;
};

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Relays used when `connect()` is called without arguments. First entry is
 * our own relay (plan §6); the others are well-known public relays for
 * resilience while ours is bootstrapping.
 */
export const DEFAULT_RELAYS: readonly string[] = [
  "wss://relay.aegis.app",
  "wss://relay.damus.io",
  "wss://relay.snort.social",
  "wss://nos.lol",
];

/**
 * NIP-17 "Private Direct Message" event kind. We populate `content` with a
 * NIP-44 v2 encrypted payload. (The inner-event/gift-wrap layers from NIP-59
 * are not applied here — see file-level docs.)
 */
export const DM_KIND = 14;

/** SEC1-compressed prefix length (parity byte). */
const COMPRESSED_PREFIX_BYTES = 1;
/** x-only schnorr pubkey length (the x-coordinate alone). */
const X_ONLY_PUBKEY_BYTES = 32;
/** Default max-wait used when opening relays (ms). */
const RELAY_CONNECT_TIMEOUT_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Convert a 33-byte SEC1-compressed secp256k1 pubkey to a 64-char hex string
 * containing only the x-coordinate (the Nostr / BIP-340 form). Throws on any
 * unexpected length / parity byte so we fail loud at the boundary.
 */
function compressedToXOnlyHex(compressed: Uint8Array): string {
  if (compressed.length !== COMPRESSED_PREFIX_BYTES + X_ONLY_PUBKEY_BYTES) {
    throw new Error(
      `compressedToXOnlyHex: expected ${
        COMPRESSED_PREFIX_BYTES + X_ONLY_PUBKEY_BYTES
      } bytes, got ${compressed.length}`,
    );
  }
  const prefix = compressed[0];
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new Error(
      `compressedToXOnlyHex: invalid SEC1 parity byte 0x${prefix
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  return bytesToHex(compressed.subarray(COMPRESSED_PREFIX_BYTES));
}

/**
 * Compute the BIP-340 / NIP-01 event id: SHA-256 of the canonical
 * serialization `[0, pubkey, created_at, kind, tags, content]` (JSON,
 * UTF-8). Returned as a hex string — id and sig fields are hex everywhere
 * in the Nostr wire format.
 */
function computeEventId(unsigned: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): string {
  const serialized = JSON.stringify([
    0,
    unsigned.pubkey,
    unsigned.created_at,
    unsigned.kind,
    unsigned.tags,
    unsigned.content,
  ]);
  return bytesToHex(sha256(utf8Encode(serialized)));
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export class NostrTransport {
  private readonly identity: Identity;
  private readonly _pubkey: string;
  private readonly pool: SimplePool;
  private readonly connectedRelays: Set<string> = new Set();

  constructor(identity: Identity) {
    this.identity = identity;
    this._pubkey = compressedToXOnlyHex(identity.pubkey);
    // SimplePool with conservative defaults. We don't enable ping or
    // reconnect by default — callers (Aegis features) can layer those on if
    // they need long-running subscriptions.
    this.pool = new SimplePool();
  }

  /** x-only Nostr pubkey hex (64 chars). Stable for the lifetime of this transport. */
  get pubkey(): string {
    return this._pubkey;
  }

  /**
   * Open WebSocket connections to the supplied relays (or {@link DEFAULT_RELAYS}
   * if none given). Returns the subset of URLs that connected successfully —
   * caller can decide whether the resulting set is acceptable.
   *
   * Relays are normalized by nostr-tools (lower-cased host, default-port
   * stripped, etc.) and the normalized form is what's stored / returned.
   */
  async connect(relays?: string[]): Promise<string[]> {
    const targets = (relays ?? [...DEFAULT_RELAYS]).slice();
    const results = await Promise.allSettled(
      targets.map(async (url) => {
        // ensureRelay either resolves to a connected AbstractRelay or rejects.
        const r = await this.pool.ensureRelay(url, {
          connectionTimeout: RELAY_CONNECT_TIMEOUT_MS,
        });
        return r.url;
      }),
    );
    const ok: string[] = [];
    for (const res of results) {
      if (res.status === "fulfilled") {
        this.connectedRelays.add(res.value);
        ok.push(res.value);
      }
    }
    return ok;
  }

  /**
   * Sign and publish an event to every currently-connected relay. The result
   * array contains one entry per relay attempted (success or failure).
   * Resolves once all per-relay publish promises have settled.
   */
  async publish(event: NostrEventInput): Promise<PublishResult[]> {
    const signed = this.signEvent(event);
    const relays = [...this.connectedRelays];
    if (relays.length === 0) {
      return [];
    }
    const promises = this.pool.publish(relays, signed);
    const settled = await Promise.allSettled(promises);
    return settled.map((res, i) => {
      if (res.status === "fulfilled") {
        // pool.publish has two success shapes:
        //   - relay accepted: resolved with the OK reason (often "" / "ok").
        //   - connection failure: resolved with a "connection failure: …"
        //     string (no exception thrown).
        // We treat the connection-failure prefix as ok=false.
        const reason = res.value;
        if (
          typeof reason === "string" &&
          reason.startsWith("connection failure:")
        ) {
          return { relay: relays[i], ok: false, reason };
        }
        return { relay: relays[i], ok: true, reason: reason || undefined };
      }
      // Rejected: relay said NO (kind blocked, rate-limited, auth needed, …)
      // or the publish timed out.
      const reason =
        res.reason instanceof Error
          ? res.reason.message
          : typeof res.reason === "string"
            ? res.reason
            : String(res.reason);
      return { relay: relays[i], ok: false, reason };
    });
  }

  /**
   * Subscribe to events matching `filter` across all currently-connected
   * relays. The pool dedupes by event id, so callers see each unique event
   * exactly once across the relay set.
   *
   * Returns an unsubscribe function. Call it to close the subscription on
   * every relay; safe to call multiple times.
   */
  subscribe(
    filter: NostrFilter,
    onEvent: (e: NostrEvent) => void,
  ): () => void {
    const relays = [...this.connectedRelays];
    // SimplePool typings expect the `Filter` shape; ours is structurally
    // compatible (extra-properties superset). The pool itself just iterates
    // the filter fields, so any extra keys are passed through to the relay.
    const sub = this.pool.subscribe(relays, filter as never, {
      onevent: (e) => onEvent(e as NostrEvent),
    });
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      sub.close();
    };
  }

  /**
   * Send a NIP-44 v2 encrypted direct message to `toPubkey` (x-only hex,
   * 64 chars). Publishes a `kind 14` event tagged `["p", toPubkey]` so the
   * recipient's relay subscription can filter for it.
   *
   * Returns the signed event for caller-side bookkeeping (e.g. local outbox).
   */
  async directMessage(
    toPubkey: string,
    plaintext: string,
  ): Promise<NostrEvent> {
    if (!/^[0-9a-f]{64}$/.test(toPubkey)) {
      throw new Error(
        "directMessage: toPubkey must be 64-char lowercase hex (x-only)",
      );
    }
    const conversationKey = nip44.v2.utils.getConversationKey(
      this.identity.seckey,
      toPubkey,
    );
    const ciphertext = nip44.v2.encrypt(plaintext, conversationKey);
    const signed = this.signEvent({
      kind: DM_KIND,
      content: ciphertext,
      tags: [["p", toPubkey]],
    });

    // Best-effort publish: don't block on relay results, but kick the fan-out
    // off. Callers wanting per-relay status should use the lower-level
    // `publish` directly.
    if (this.connectedRelays.size > 0) {
      const relays = [...this.connectedRelays];
      // Trigger publish; we only need to ensure each promise is consumed so
      // unhandled rejections don't surface.
      this.pool.publish(relays, signed).forEach((p) => {
        p.catch(() => {
          /* ignore — caller can call publish() for explicit error handling */
        });
      });
    }
    return signed;
  }

  /**
   * Subscribe to incoming NIP-17 / NIP-44 v2 DMs (kind 14) addressed to us.
   *
   * Each matching event is decrypted via {@link decryptDirectMessage} and the
   * resulting `{ from, plaintext, ts, eventId }` shape is handed to
   * `onIncoming`. Decryption failures are caught and logged (the subscription
   * survives) — relays sometimes ship malformed or stale ciphertexts and we
   * don't want a single bad event to tear down DM reception.
   *
   * Returns an idempotent unsubscribe closure that closes the underlying
   * SimplePool subscription.
   */
  subscribeIncomingDMs(
    onIncoming: (dm: {
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
    }) => void,
  ): () => void {
    const filter: NostrFilter = {
      kinds: [DM_KIND],
      "#p": [this._pubkey],
    };
    return this.subscribe(filter, (event) => {
      // Skip our own DM echoes — the recipient's wire-format `p` tag matches
      // us so the relay will surface our own outgoing kind-14 events on this
      // subscription. Letting them through would double-count Herald-side.
      if (event.pubkey === this._pubkey) return;
      this.decryptDirectMessage(event).then(
        (plaintext) => {
          onIncoming({
            from: event.pubkey,
            plaintext,
            ts: event.created_at,
            eventId: event.id,
          });
        },
        (err) => {
          // Decrypt failures are normal-ish (someone else's kind-14, malformed
          // ciphertext, etc.). Warn so devtools see it but never throw.
          console.warn(
            "[nostr] subscribeIncomingDMs: decrypt failed for event",
            event.id,
            err instanceof Error ? err.message : err,
          );
        },
      );
    });
  }

  /**
   * Decrypt an incoming NIP-44 v2 DM (`kind 14`). The conversation key is
   * symmetric — ECDH(my_seckey, their_pubkey) — so we use the event's
   * `pubkey` field (the sender) to derive it.
   */
  async decryptDirectMessage(event: NostrEvent): Promise<string> {
    if (!/^[0-9a-f]{64}$/.test(event.pubkey)) {
      throw new Error(
        "decryptDirectMessage: event.pubkey must be 64-char hex",
      );
    }
    // If the event is *outgoing* (we authored it), derive the conversation
    // key from the recipient pubkey on the `p` tag instead. NIP-44 v2 keys
    // are symmetric so either works, but the sender's view of their own
    // outbox needs the recipient as the counterparty.
    const counterparty =
      event.pubkey === this._pubkey
        ? extractFirstPTag(event)
        : event.pubkey;
    if (!counterparty) {
      throw new Error(
        "decryptDirectMessage: cannot find counterparty pubkey on event",
      );
    }
    const conversationKey = nip44.v2.utils.getConversationKey(
      this.identity.seckey,
      counterparty,
    );
    return nip44.v2.decrypt(event.content, conversationKey);
  }

  /**
   * Close all relay connections held by the underlying pool. The transport
   * is unusable after this — callers must construct a new one to reconnect.
   */
  async close(): Promise<void> {
    if (this.connectedRelays.size === 0) return;
    const relays = [...this.connectedRelays];
    this.pool.close(relays);
    this.connectedRelays.clear();
  }

  /* ---- internals --------------------------------------------------- */

  /** Sign an unsigned event template into a wire-format `NostrEvent`. */
  private signEvent(event: NostrEventInput): NostrEvent {
    const created_at = event.created_at ?? Math.floor(Date.now() / 1000);
    const tags = event.tags ?? [];
    const unsigned = {
      pubkey: this._pubkey,
      created_at,
      kind: event.kind,
      tags,
      content: event.content,
    };
    const id = computeEventId(unsigned);
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), this.identity.seckey));
    return { ...unsigned, id, sig };
  }
}

/** Return the first `["p", pubkey]` tag value, or null if absent. */
function extractFirstPTag(event: NostrEvent): string | null {
  for (const t of event.tags) {
    if (t.length >= 2 && t[0] === "p") return t[1];
  }
  return null;
}
