/**
 * Aegis unified transport — the single surface Aegis features speak through.
 *
 * One `AegisTransport` instance owns one each of:
 *   - `NostrTransport`  (relay-based event log)
 *   - `MatrixTransport` (homeserver-based rooms + E2EE)
 *
 * The facade exposes three primitives:
 *   - `publish(event)`         fan out across selected networks (default: all
 *                              that connected successfully).
 *   - `subscribe(filter, fn)`  cross-network aggregator with id-based dedup.
 *   - `directMessage(to, txt)` Matrix → Nostr fallback chain (plan §2 /
 *                              aegis-plan.md §3.1).
 *
 * # AegisEvent id (the dedup key)
 *
 * The id is `sha256(sender + ":" + type + ":" + canonicalize(content))` in hex.
 * `canonicalize` is JSON with recursively sorted object keys, so the same
 * logical content produces the same id regardless of key insertion order or
 * which network the event arrived on. That id is what feeds the cross-network
 * dedup set inside `subscribe`.
 *
 * # Nostr kind choice (outbound)
 *
 * Every Aegis publish becomes a NIP-78 "Application-specific Data" event
 * (kind 30078 — parameterized replaceable) with a `d` tag of `aegis:<type>`
 * and an explicit `["aegis-type", <type>]` tag for filtering. NIP-78 was
 * chosen because:
 *   - It's parameterized replaceable, so users can carry a single "latest"
 *     event per logical type without flooding relays. (Phase 4 may revisit
 *     for some types that want full history; the kind is centralized in
 *     `NOSTR_AEGIS_KIND` for that reason.)
 *   - It's an addressable kind, so we can dedup on the `d` tag at the relay
 *     level if we ever build a self-relay query layer.
 *
 * # Matrix mapping (outbound)
 *
 * Each Aegis logical `type` maps to a "topic room" alias
 * `#aegis-<type>:<homeserver-domain>`. On first publish the topic room is
 * lazily created (private, encrypted, no invites — we only consume our own
 * timeline for now). Each Aegis event is sent as a custom event type
 * `aegis.<type>` whose content is `{ aegisType, payload, ts }`.
 *
 * Note: as of Phase 2 the topic-room subscription model only sees events we
 * authored ourselves (no invites yet). Multi-author topic rooms are a
 * Phase 4 expansion — the inbound mapping below is forward-compatible.
 *
 * # directMessage fallback chain
 *
 *   1. Matrix (encrypted DM room, recipient resolved from pubkey hex).
 *   2. Nostr  (NIP-44 v2 kind-14 DM).
 *
 * If both fail, an aggregate error is thrown listing each failure.
 *
 * # SSB
 *
 * SSB was a third leg in v1 but the browser-bridge pub turned out to be
 * unmaintainable. The transport facade now ships with Matrix + Nostr only;
 * offline-mesh resilience is deferred. The `infra/docker/ssb-pub/`
 * directory is kept on disk so a future replacement can pick up where we
 * left off, but nothing here references it.
 */

import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToHex, utf8Encode } from "../crypto/encoding";
import type { Identity } from "../identity";

import { MatrixTransport } from "./matrix";
import { NostrTransport } from "./nostr";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** The set of underlying networks the facade knows about. */
export type Network = "nostr" | "matrix";

/**
 * Per-network configuration. A missing entry means "don't even try" — the
 * facade will report that network as never-connected (and `publish` /
 * `subscribe` will skip it).
 */
export type TransportConfig = {
  nostr?: { relays?: string[] };
  matrix?: { homeserver: string; registrationToken?: string };
};

/** Caller-supplied event to publish across networks. */
export type AegisEventInput = {
  /** Logical event type, e.g. `aegis.message`, `aegis.location`. */
  type: string;
  /** Arbitrary JSON-serializable payload. */
  content: unknown;
  /** If set, publish only to these networks. Default: every connected one. */
  channels?: Network[];
  /**
   * Per-event tags. Forwarded to Nostr as raw `string[][]` tags, mapped onto
   * Matrix room state in a future enhancement.
   */
  tags?: string[][];
};

/**
 * A normalized direct-message delivered to `subscribeDM` callbacks.
 *
 * # `from` canonicalization gotcha
 *
 * Nostr-origin DMs carry an x-only 64-char hex `from` (the Aegis canonical
 * conversation key). Matrix-origin DMs surface an MXID string
 * (`@xxxxxxxxxxxx:domain`) because we don't yet have an MXID → pubkey
 * resolver — the localpart is 24 hex chars derived from the sender's pubkey
 * (see `matrix.ts#deriveLocalpart`) but a one-way truncation, so we can't
 * recover the full pubkey at receive time.
 *
 * Herald's bridge therefore treats each `from` form as a separate addressing
 * space until Phase 4 wires up a directory lookup. The dedup id below
 * canonicalizes by `from + ":" + plaintext + ":" + minute`, so a DM that
 * arrives via two networks with two different `from` forms will currently
 * land twice — but in practice each Aegis user advertises a single primary
 * channel and the cross-network duplicate path is rare.
 */
export type IncomingDM = {
  /** Dedup key: sha256(from + ":" + plaintext + ":" + floor(ts/60)). */
  id: string;
  /**
   * Sender id in the origin network's canonical form:
   *  - nostr  → x-only 64-char hex
   *  - matrix → MXID string (`@localpart:domain`)
   */
  from: string;
  /** Decrypted message body. */
  plaintext: string;
  /** Which network this DM arrived on. */
  network: Network;
  /** Unix seconds. */
  ts: number;
};

/** A normalized event delivered to `subscribe` callbacks. */
export type AegisEvent = {
  /** Dedup id: `sha256(sender + ':' + type + ':' + canonicalize(content))`. */
  id: string;
  /** Which network we received this event from. */
  origin: Network;
  /** Sender id (pubkey hex / mxid), in the origin network's form. */
  sender: string;
  /** Logical Aegis event type. */
  type: string;
  /** Decoded payload. */
  content: unknown;
  /** Unix seconds (network-supplied — Nostr `created_at`, Matrix `origin/1000`). */
  ts: number;
};

/** Cross-network filter. Each per-transport subscription maps it as best it can. */
export type AegisFilter = {
  /** Match the Aegis logical type exactly. */
  type?: string;
  /**
   * Authors to accept (pubkey hex in Nostr x-only form). Matrix subscribers
   * see all events and we post-filter; cross-network identity correlation
   * is a Phase 4 expansion.
   */
  authors?: string[];
  /** Unix seconds (inclusive). */
  since?: number;
  /** Unix seconds (inclusive). */
  until?: number;
};

/** Outcome of a single per-network publish attempt. */
export type PublishResult = {
  network: Network;
  ok: boolean;
  /** Network-native id when `ok` (Nostr event id, Matrix event_id). */
  id?: string;
  /** Free-form reason on failure (or success info from the network). */
  reason?: string;
};

/* -------------------------------------------------------------------------- */
/* Dedup helpers                                                               */
/* -------------------------------------------------------------------------- */

/** TTL for the cross-network dedup set, in ms. */
const DEDUP_TTL_MS = 60_000;

/**
 * Tiny FIFO-with-TTL set. We don't need a full LRU because the eviction
 * driver is time, not capacity — events older than `DEDUP_TTL_MS` are pruned
 * on every `seen` check. A cap is enforced as a safety belt.
 */
class DedupCache {
  private readonly seenAt = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 10_000, ttlMs = DEDUP_TTL_MS) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /** Returns `true` if `id` is new (and records it); `false` if it's a dup. */
  recordIfNew(id: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.seenAt.has(id)) {
      // Refresh the timestamp so a stream of dup hits keeps it alive.
      this.seenAt.set(id, now);
      return false;
    }
    this.seenAt.set(id, now);
    if (this.seenAt.size > this.maxEntries) {
      // Evict the oldest insertion. Map iteration order is insertion order.
      const oldest = this.seenAt.keys().next().value;
      if (typeof oldest === "string") this.seenAt.delete(oldest);
    }
    return true;
  }

  private prune(now: number): void {
    if (this.seenAt.size === 0) return;
    const cutoff = now - this.ttlMs;
    for (const [id, ts] of this.seenAt) {
      if (ts >= cutoff) break; // entries are insertion-ordered ≈ time-ordered
      this.seenAt.delete(id);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Canonicalization                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Order-independent JSON canonicalization. Object keys are emitted in sorted
 * order recursively; arrays preserve order; primitives stringify as
 * `JSON.stringify` would. Used to make the AegisEvent id stable across hosts
 * and runtime engines (which otherwise might emit keys in different orders
 * even though spec-wise the spec says insertion order).
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) return "null";
    return JSON.stringify(value);
  }
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      // Skip undefined values to match JSON.stringify behaviour for own keys.
      if (obj[k] === undefined) continue;
      parts.push(JSON.stringify(k) + ":" + canonicalize(obj[k]));
    }
    return "{" + parts.join(",") + "}";
  }
  // Functions / bigints / symbols — coerce to null.
  return "null";
}

/** Compute the AegisEvent id from its (sender, type, content) triple. */
export function aegisEventId(
  sender: string,
  type: string,
  content: unknown,
): string {
  const serialized = sender + ":" + type + ":" + canonicalize(content);
  return bytesToHex(sha256(utf8Encode(serialized)));
}

/* -------------------------------------------------------------------------- */
/* Nostr mapping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Default Nostr kind for Aegis events. See file-level docs.
 *
 * Centralized as a constant so a future per-type override (e.g. some types
 * want non-replaceable history) lives in exactly one place. When that
 * happens, replace this with a `pickNostrKind(type)` helper.
 */
const NOSTR_AEGIS_KIND = 30078;

/** Build the NIP-78 `d`-tag value for an Aegis type. */
function nostrDTag(type: string): string {
  return "aegis:" + type;
}

/* -------------------------------------------------------------------------- */
/* Matrix mapping                                                              */
/* -------------------------------------------------------------------------- */

/** Aegis Matrix custom event type prefix. */
const MATRIX_EVENT_TYPE_PREFIX = "aegis.";

/* -------------------------------------------------------------------------- */
/* Facade                                                                      */
/* -------------------------------------------------------------------------- */

type Connected = { nostr: boolean; matrix: boolean };

export class AegisTransport {
  /** Per-transport accessors — feature code can drop into the native API. */
  public readonly nostr: NostrTransport;
  public readonly matrix: MatrixTransport;

  private readonly config: TransportConfig;
  private readonly connected: Connected = {
    nostr: false,
    matrix: false,
  };
  /** Aegis logical type → Matrix room id, populated lazily on first publish. */
  private readonly matrixRoomByType: Map<string, string> = new Map();
  /**
   * Optional override; injected by tests via the second constructor argument's
   * `__deps` field. Kept off the public surface intentionally.
   */
  constructor(identity: Identity, config: TransportConfig, deps?: TransportDeps) {
    this.config = config;
    this.nostr = deps?.nostr ?? new NostrTransport(identity);
    // MatrixTransport requires a homeserver URL up front. If the caller didn't
    // supply one we still need a placeholder instance to keep `.matrix`
    // non-null — but we'll never call `connect()` on it, so its internal
    // network paths stay dormant.
    const matrixHs =
      config.matrix?.homeserver ?? PLACEHOLDER_MATRIX_HOMESERVER;
    this.matrix = deps?.matrix ?? new MatrixTransport(identity, matrixHs);
  }

  /**
   * Open every configured network. Per-network connection runs in parallel
   * via `Promise.allSettled`; a network without config is skipped.
   *
   * Returns a `{ nostr, matrix }` map of booleans — `true` means the
   * connect call resolved without throwing AND, for Nostr, at least one
   * relay accepted the socket.
   */
  async connect(): Promise<Connected> {
    const tasks: Array<Promise<void>> = [];
    if (this.config.nostr) {
      tasks.push(
        this.nostr
          .connect(this.config.nostr.relays)
          .then((relays) => {
            this.connected.nostr = relays.length > 0;
          })
          .catch(() => {
            this.connected.nostr = false;
          }),
      );
    }
    if (this.config.matrix) {
      tasks.push(
        this.matrix
          .connect({
            registrationToken: this.config.matrix.registrationToken,
          })
          .then(() => {
            this.connected.matrix = true;
          })
          .catch(() => {
            this.connected.matrix = false;
          }),
      );
    }
    await Promise.allSettled(tasks);
    return { ...this.connected };
  }

  /**
   * Publish an event across the requested networks. By default uses every
   * network that connected successfully. Each per-network attempt runs
   * independently — a failure on one network does not affect the others.
   */
  async publish(event: AegisEventInput): Promise<PublishResult[]> {
    const targets = (event.channels ?? this.activeNetworks()).filter((n) =>
      this.isActive(n),
    );
    if (targets.length === 0) return [];

    const tasks = targets.map(async (network): Promise<PublishResult> => {
      try {
        switch (network) {
          case "nostr": {
            const kind = NOSTR_AEGIS_KIND;
            const tags: string[][] = [
              ["d", nostrDTag(event.type)],
              ["aegis-type", event.type],
              ...(event.tags ?? []),
            ];
            const content = JSON.stringify(event.content ?? null);
            const results = await this.nostr.publish({ kind, content, tags });
            const okAny = results.some((r) => r.ok);
            if (!okAny) {
              const reason =
                results.length === 0
                  ? "no connected relays"
                  : (results.find((r) => r.reason)?.reason ??
                    "all relays rejected publish");
              return { network, ok: false, reason };
            }
            // Re-derive the Nostr event id from the canonical NIP-01 hash. We
            // don't get it back from publish() directly, but we can recompute
            // it via the same canonical form `signEvent` used. Easier: just
            // surface the relay-side success count instead — feature code
            // that needs the wire id can subscribe.
            return {
              network,
              ok: true,
              reason: `relays ok: ${results.filter((r) => r.ok).length}/${results.length}`,
            };
          }
          case "matrix": {
            const roomId = await this.ensureMatrixRoomForType(event.type);
            const eventId = await this.matrix.sendMessage(roomId, {
              type: MATRIX_EVENT_TYPE_PREFIX + event.type,
              aegisType: event.type,
              payload: event.content,
              ts: Math.floor(Date.now() / 1000),
            });
            return { network, ok: true, id: eventId };
          }
        }
      } catch (err) {
        return {
          network,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    });

    const settled = await Promise.allSettled(tasks);
    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      return {
        network: targets[i],
        ok: false,
        reason:
          s.reason instanceof Error ? s.reason.message : String(s.reason),
      };
    });
  }

  /**
   * Subscribe to events matching `filter` across every connected network.
   *
   * The callback fires exactly once per unique AegisEvent id (within the
   * dedup TTL window). Returns an `unsubscribe` function that tears down
   * every per-network subscription; safe to call repeatedly.
   */
  subscribe(
    filter: AegisFilter,
    onEvent: (e: AegisEvent) => void,
  ): () => void {
    const dedup = new DedupCache();
    const unsubs: Array<() => void> = [];

    const forward = (ev: AegisEvent): void => {
      if (filter.type && ev.type !== filter.type) return;
      if (filter.since && ev.ts < filter.since) return;
      if (filter.until && ev.ts > filter.until) return;
      if (filter.authors && filter.authors.length > 0) {
        // Author filtering uses the Nostr x-only pubkey hex as the canonical
        // form. Matrix events come through unfiltered at this layer —
        // upper layers map MXIDs back to Aegis pubkeys if they need
        // cross-network identity correlation.
        if (ev.origin === "nostr" && !filter.authors.includes(ev.sender)) {
          return;
        }
      }
      if (!dedup.recordIfNew(ev.id)) return;
      onEvent(ev);
    };

    if (this.isActive("nostr")) {
      const unsub = this.subscribeNostr(filter, forward);
      unsubs.push(unsub);
    }
    if (this.isActive("matrix")) {
      const unsub = this.subscribeMatrix(filter, forward);
      unsubs.push(unsub);
    }

    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ignore — individual unsubscribe errors must not block the rest */
        }
      }
    };
  }

  /**
   * Subscribe to incoming direct messages across every connected transport.
   *
   * This is the **inbound** half of the directMessage send chain. It hooks
   * each transport's `subscribeIncomingDMs` and forwards normalized
   * {@link IncomingDM} records to the caller. The same dedup window the
   * cross-network `subscribe` uses (~60s TTL) is applied here — keyed on
   * `sha256(from + ":" + plaintext + ":" + Math.floor(ts/60))` — so a DM
   * that arrives on Matrix AND Nostr within the same wall-clock minute
   * fires the callback exactly once.
   *
   * Returns an aggregate unsubscribe closure that detaches all underlying
   * per-network listeners. Safe to call repeatedly.
   */
  subscribeDM(onIncoming: (dm: IncomingDM) => void): () => void {
    const dedup = new DedupCache();
    const unsubs: Array<() => void> = [];

    const forward = (
      from: string,
      plaintext: string,
      ts: number,
      network: Network,
    ): void => {
      const id = dmDedupId(from, plaintext, ts);
      if (!dedup.recordIfNew(id)) return;
      onIncoming({ id, from, plaintext, ts, network });
    };

    if (this.isActive("nostr")) {
      try {
        unsubs.push(
          this.nostr.subscribeIncomingDMs((dm) =>
            forward(dm.from, dm.plaintext, dm.ts, "nostr"),
          ),
        );
      } catch {
        /* nostr not ready — skip */
      }
    }
    if (this.isActive("matrix")) {
      try {
        unsubs.push(
          this.matrix.subscribeIncomingDMs((dm) =>
            forward(dm.from, dm.plaintext, dm.ts, "matrix"),
          ),
        );
      } catch {
        /* matrix not ready — skip */
      }
    }

    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ignore — individual unsubscribe errors must not block the rest */
        }
      }
    };
  }

  /**
   * Send a private message to another Aegis user using the fallback chain:
   *
   *     Matrix DM (encrypted room) → Nostr NIP-44 v2 DM.
   *
   * Each step is attempted in order; the first success returns. If every
   * step fails, an aggregate error is thrown that lists every failure.
   *
   * `toPubkey` is the 66-char SEC1-compressed hex form of the recipient's
   * master Aegis identity pubkey. Each transport maps it to its native id:
   *   - Matrix: localpart derived via `mxidFromPubkeyHex`.
   *   - Nostr:  x-only 64-char hex (parity byte stripped).
   */
  async directMessage(
    toPubkey: string,
    plaintext: string,
  ): Promise<{ network: Network; id: string }> {
    const failures: string[] = [];

    if (this.isActive("matrix")) {
      try {
        const id = await this.matrix.directMessage(toPubkey, plaintext);
        return { network: "matrix", id };
      } catch (err) {
        failures.push(`matrix: ${describeError(err)}`);
      }
    } else {
      failures.push("matrix: not connected");
    }

    if (this.isActive("nostr")) {
      try {
        // Nostr wants the x-only 64-char hex. Strip the SEC1 parity byte.
        const xOnly = toXOnlyHex(toPubkey);
        const ev = await this.nostr.directMessage(xOnly, plaintext);
        return { network: "nostr", id: ev.id };
      } catch (err) {
        failures.push(`nostr: ${describeError(err)}`);
      }
    } else {
      failures.push("nostr: not connected");
    }

    throw new Error(
      "AegisTransport.directMessage: all networks failed — " +
        failures.join("; "),
    );
  }

  /** Tear down every per-transport connection. Errors per-network are swallowed. */
  async close(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    if (this.connected.nostr) {
      tasks.push(this.nostr.close().catch(() => undefined));
    }
    if (this.connected.matrix) {
      tasks.push(this.matrix.close().catch(() => undefined));
    }
    await Promise.allSettled(tasks);
    this.connected.nostr = false;
    this.connected.matrix = false;
    this.matrixRoomByType.clear();
  }

  /* ---- internals -------------------------------------------------------- */

  /** List of networks the caller configured (independent of connect outcome). */
  private activeNetworks(): Network[] {
    const out: Network[] = [];
    if (this.connected.nostr) out.push("nostr");
    if (this.connected.matrix) out.push("matrix");
    return out;
  }

  private isActive(network: Network): boolean {
    return this.connected[network];
  }

  /**
   * Find-or-create the Matrix "topic room" for a given Aegis type, then cache
   * the room id for subsequent publishes of the same type.
   *
   * For Phase 2 the room is private + encrypted with no invitees — we only
   * publish into it ourselves. Multi-author topic rooms are Phase 4 work.
   */
  private async ensureMatrixRoomForType(type: string): Promise<string> {
    const cached = this.matrixRoomByType.get(type);
    if (cached) return cached;
    const name = "aegis-" + type;
    const roomId = await this.matrix.createRoom({
      name,
      encrypted: true,
    });
    this.matrixRoomByType.set(type, roomId);
    return roomId;
  }

  private subscribeNostr(
    filter: AegisFilter,
    forward: (ev: AegisEvent) => void,
  ): () => void {
    const nostrFilter: Record<string, unknown> = {
      kinds: [NOSTR_AEGIS_KIND],
    };
    if (filter.authors && filter.authors.length > 0) {
      nostrFilter.authors = filter.authors;
    }
    if (filter.type) {
      nostrFilter["#d"] = [nostrDTag(filter.type)];
    }
    if (filter.since !== undefined) nostrFilter.since = filter.since;
    if (filter.until !== undefined) nostrFilter.until = filter.until;
    return this.nostr.subscribe(nostrFilter, (ne) => {
      const aegisType = extractAegisType(ne.tags);
      if (!aegisType) return;
      let parsed: unknown = null;
      try {
        parsed = ne.content === "" ? null : JSON.parse(ne.content);
      } catch {
        parsed = ne.content;
      }
      const id = aegisEventId(ne.pubkey, aegisType, parsed);
      forward({
        id,
        origin: "nostr",
        sender: ne.pubkey,
        type: aegisType,
        content: parsed,
        ts: ne.created_at,
      });
    });
  }

  private subscribeMatrix(
    _filter: AegisFilter,
    forward: (ev: AegisEvent) => void,
  ): () => void {
    return this.matrix.subscribe({}, (me) => {
      if (!me.type.startsWith(MATRIX_EVENT_TYPE_PREFIX)) return;
      const aegisType = me.type.slice(MATRIX_EVENT_TYPE_PREFIX.length);
      const content = me.content as
        | { payload?: unknown; ts?: number }
        | undefined;
      const payload = content?.payload ?? null;
      const ts = content?.ts ?? Math.floor(me.origin / 1000);
      const id = aegisEventId(me.sender, aegisType, payload);
      forward({
        id,
        origin: "matrix",
        sender: me.sender,
        type: aegisType,
        content: payload,
        ts,
      });
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Module-private helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Test/DI seam: callers can pass pre-built transport instances. Kept off the
 * public types so production code path is one constructor.
 */
type TransportDeps = {
  nostr?: NostrTransport;
  matrix?: MatrixTransport;
};

/**
 * Placeholder homeserver URL used when no Matrix config was supplied. The
 * placeholder transport instance is constructed but never `connect()`-ed, so
 * the URL is purely a structural requirement of `MatrixTransport`.
 */
const PLACEHOLDER_MATRIX_HOMESERVER = "https://matrix.invalid";

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Compute the cross-network DM dedup id.
 *
 * Keyed on `from + ":" + plaintext + ":" + Math.floor(ts/60)` so the same
 * logical message that arrives on two networks within the same wall-clock
 * minute collapses to one delivery. The minute bucket matches the cache TTL
 * (60s) so two networks racing across the boundary still merge in practice.
 */
function dmDedupId(from: string, plaintext: string, ts: number): string {
  const minute = Math.floor(ts / 60);
  const serialized = from + ":" + plaintext + ":" + minute;
  return bytesToHex(sha256(utf8Encode(serialized)));
}

/** Strip the SEC1 parity byte from a 66-char compressed pubkey hex. */
function toXOnlyHex(pubkeyHex: string): string {
  if (pubkeyHex.length === 64) return pubkeyHex;
  if (pubkeyHex.length === 66) return pubkeyHex.slice(2);
  throw new Error(
    `toXOnlyHex: expected 64 or 66 hex chars, got ${pubkeyHex.length}`,
  );
}

/** Pull the `aegis-type` tag value off a Nostr event's tag array. */
function extractAegisType(tags: string[][]): string | null {
  for (const t of tags) {
    if (t.length >= 2 && t[0] === "aegis-type") return t[1];
  }
  // Fallback: parse from `d` tag of the form `aegis:<type>`.
  for (const t of tags) {
    if (t.length >= 2 && t[0] === "d" && t[1].startsWith("aegis:")) {
      return t[1].slice("aegis:".length);
    }
  }
  return null;
}
