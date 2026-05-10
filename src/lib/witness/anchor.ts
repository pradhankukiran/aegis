/**
 * Witness — anchor signing + cross-network publish.
 *
 * # The signed digest
 *
 * `signAnchor(identity, hash, ts)` produces a BIP-340 Schnorr signature over
 * the digest:
 *
 *     digest = SHA-256( canonicalize({ hash, ts }) )
 *
 * where `canonicalize` is the same recursive-sorted-keys JSON used by
 * `AegisTransport` (see `transport/index.ts#canonicalize`). Both fields are
 * scalars with fixed names, so the canonical form is effectively:
 *
 *     `{"hash":"<hex>","ts":<seconds>}`
 *
 * but we still route through the canonicalizer so the format documented for
 * verifiers is the exact production code path — no chance of drift if we
 * ever add a third field.
 *
 * # Why BIP-340 and not the `lib/crypto/schnorr` Σ-protocol
 *
 * The `lib/crypto/schnorr` module implements a Fiat–Shamir proof-of-
 * knowledge that's NOT signature-compatible. Witness needs the actual
 * BIP-340 signature (so other Nostr clients could verify it, and so the
 * recovered event on any network round-trips against the same well-known
 * primitive). We reach for `@noble/curves/secp256k1.schnorr` directly,
 * mirroring `NostrTransport.signEvent`.
 *
 * # publishAnchor — return the local-bookkeeping record
 *
 * `publishAnchor` fans the anchor out across every network and folds the
 * per-network outcome into an `AnchorRecord`. Per-network failures never
 * block one another (each path runs independently inside a Promise.all
 * settle).
 *
 * ## Per-hash NIP-78 d-tag (Phase 6 Wave 6b fix)
 *
 * Nostr's kind 30078 is parameterized-replaceable: relays keep only the
 * latest event per (pubkey, d-tag) tuple. The unified `AegisTransport.publish`
 * uses one shared d-tag per Aegis logical type — `aegis:aegis.witness` — so
 * every new witness anchor would silently overwrite the user's prior anchors
 * on a fresh subscriber's view of the relay. Anchors are supposed to be
 * permanent (plan §3.4), so we need a *per-hash* d-tag.
 *
 * We picked option (a) from the design discussion: bypass the facade for
 * the Nostr leg and call `transport.nostr.publish` directly with a
 * hand-crafted kind 30078 event whose d-tag is
 * `aegis:aegis.witness:<hash>`. Matrix and SSB still go through the facade
 * because they don't have the replaceable-key problem and the facade's
 * mapping for those two is already correct.
 *
 * The alternative (b) would have been to extend `AegisTransport.publish`
 * with an optional `nostrDTag` parameter that gets interpolated into the
 * `d` tag. That's more reusable but invasive — we'd be reshaping a
 * cross-cutting transport API just for witness's edge case. (a) keeps the
 * blast radius to this file + verify.ts and leaves the transport facade
 * untouched. If a second feature ever needs per-event d-tags, lift this
 * back into the facade.
 *
 * Caller is expected to persist the record to IndexedDB (see `storage.ts`)
 * and surface the network status to the UI.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToHex, hexToBytes, utf8Encode } from "../crypto/encoding";
import type { Identity } from "../identity";
import type { AegisTransport, Network, PublishResult } from "../transport";
import { canonicalize } from "../transport";

import type {
  Anchor,
  AnchorNetworkResult,
  AnchorRecord,
} from "./types";
import { WITNESS_EVENT_TYPE } from "./types";

/**
 * NIP-78 kind used for Aegis events. Mirrors the constant in
 * `transport/index.ts#NOSTR_AEGIS_KIND` — kept local here so the witness
 * publish path doesn't pull a private export from the transport module.
 * If the transport's choice ever changes this constant must be updated to
 * match (covered by the round-trip test in `verify.ts` tests).
 */
const NOSTR_AEGIS_KIND = 30078;

/**
 * Build the per-hash NIP-78 `d` tag for a witness anchor.
 *
 * Public so verify.ts can re-derive the exact same value when subscribing
 * with `#d` — the relay-side filter must match the publish-side d-tag
 * literally or the event won't be returned.
 */
export function witnessNostrDTag(hash: string): string {
  return "aegis:" + WITNESS_EVENT_TYPE + ":" + hash.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Identity → x-only signer hex                                                */
/* -------------------------------------------------------------------------- */

const COMPRESSED_PREFIX_BYTES = 1;
const X_ONLY_PUBKEY_BYTES = 32;

/**
 * Strip the SEC1 parity byte off the master Aegis pubkey to produce the
 * x-only 32-byte form BIP-340 uses. Matches the conversion
 * `NostrTransport.constructor` does on the same identity — same canonical
 * key everywhere.
 */
export function signerHexFromIdentity(identity: Identity): string {
  const compressed = identity.pubkey;
  if (
    compressed.length !==
    COMPRESSED_PREFIX_BYTES + X_ONLY_PUBKEY_BYTES
  ) {
    throw new Error(
      `signerHexFromIdentity: expected ${
        COMPRESSED_PREFIX_BYTES + X_ONLY_PUBKEY_BYTES
      }-byte SEC1-compressed pubkey, got ${compressed.length}`,
    );
  }
  return bytesToHex(compressed.subarray(COMPRESSED_PREFIX_BYTES));
}

/* -------------------------------------------------------------------------- */
/* Signing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the canonical 32-byte digest the BIP-340 signature is computed over.
 *
 * Public so verify-side code can re-derive the exact bytes; both code paths
 * MUST end up at the same `Uint8Array` for the signature to verify.
 */
export function anchorDigest(hash: string, ts: number): Uint8Array {
  const canonical = canonicalize({ hash, ts });
  return sha256(utf8Encode(canonical));
}

/**
 * Sign a `(hash, ts)` pair under the given identity. Returns the wire-form
 * `Anchor` (hex `sig` + hex `signer`). The `ts` field is included in the
 * digest, so changing it after signing invalidates the signature — that's
 * what makes the timestamp tamper-evident.
 */
export function signAnchor(
  identity: Identity,
  hash: string,
  ts: number,
): Anchor {
  const digest = anchorDigest(hash, ts);
  const sigBytes = schnorr.sign(digest, identity.seckey);
  return {
    hash,
    ts,
    sig: bytesToHex(sigBytes),
    signer: signerHexFromIdentity(identity),
  };
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Metadata the local-history pipeline carries alongside the anchor. None of
 * it goes on the wire; it's purely for the user's history view.
 */
export type LocalAnchorMeta = {
  fileName?: string;
  fileSize?: number;
};

/**
 * Publish an anchor across every configured network and fold the per-network
 * outcome into an `AnchorRecord`. The record is the caller's signal of
 * "what happened, network by network" — UI badges read straight off
 * `networkResults`.
 *
 * Implementation notes:
 *  - We forward exactly the wire fields `{hash, sig, signer, ts}` as the
 *    payload on every network. Everything else stays local.
 *  - The Nostr leg bypasses `transport.publish` so we can stamp a per-hash
 *    `d` tag (`aegis:aegis.witness:<hash>`). See the file header for why.
 *    Matrix and SSB still go through `transport.publish({ channels: [...] })`.
 *  - Both legs run concurrently inside `Promise.allSettled`, so a failure
 *    on one network never blocks the other.
 *  - Networks that aren't connected don't appear in the publish result;
 *    we surface a synthetic `{ ok: false, reason: "not connected" }` entry
 *    for each so the UI can render a definitive "tried 3 / 3 networks"
 *    badge rather than silently dropping rows.
 */
export async function publishAnchor(
  transport: AegisTransport,
  anchor: Anchor,
  meta: LocalAnchorMeta = {},
): Promise<AnchorRecord> {
  const wire: Anchor = {
    hash: anchor.hash,
    sig: anchor.sig,
    signer: anchor.signer,
    ts: anchor.ts,
  };

  // Two-leg fan-out. The nostr leg gets the per-hash d-tag treatment; the
  // matrix+ssb leg goes through the facade where the shared-d-tag behaviour
  // is already correct (neither transport is parameterized-replaceable).
  const [nostrSettled, facadeSettled] = await Promise.allSettled([
    publishNostrAnchor(transport, wire),
    publishMatrixAndSsbAnchor(transport, wire),
  ]);

  const raw: PublishResult[] = [];
  let fatal: string | null = null;

  if (nostrSettled.status === "fulfilled") {
    if (nostrSettled.value) raw.push(nostrSettled.value);
  } else {
    fatal = describeError(nostrSettled.reason);
  }
  if (facadeSettled.status === "fulfilled") {
    raw.push(...facadeSettled.value);
  } else if (fatal === null) {
    fatal = describeError(facadeSettled.reason);
  }

  return assembleRecord(wire, meta, raw, fatal);
}

/**
 * Publish the anchor to Nostr with a per-hash NIP-78 d-tag so future
 * anchors on the same identity don't overwrite this one. Returns null if
 * Nostr is not connected — assembleRecord will backfill a "not connected"
 * stub for that network.
 *
 * Errors thrown here are bubbled up to `publishAnchor` so the wrapping
 * `Promise.allSettled` can surface them as the fatal reason.
 */
async function publishNostrAnchor(
  transport: AegisTransport,
  wire: Anchor,
): Promise<PublishResult | null> {
  try {
    const relayResults = await transport.nostr.publish({
      kind: NOSTR_AEGIS_KIND,
      content: JSON.stringify(wire),
      tags: [
        ["d", witnessNostrDTag(wire.hash)],
        ["aegis-type", WITNESS_EVENT_TYPE],
      ],
    });
    if (relayResults.length === 0) {
      return { network: "nostr", ok: false, reason: "not connected" };
    }
    const okAny = relayResults.some((r) => r.ok);
    if (!okAny) {
      const reason =
        relayResults.find((r) => r.reason)?.reason ??
        "all relays rejected publish";
      return { network: "nostr", ok: false, reason };
    }
    return {
      network: "nostr",
      ok: true,
      reason: `relays ok: ${relayResults.filter((r) => r.ok).length}/${relayResults.length}`,
    };
  } catch (err) {
    return {
      network: "nostr",
      ok: false,
      reason: describeError(err),
    };
  }
}

/**
 * Publish the anchor to Matrix and SSB through the facade. We let the
 * facade handle channel-selection: it filters out unconnected networks and
 * returns at-most one entry per connected channel.
 */
async function publishMatrixAndSsbAnchor(
  transport: AegisTransport,
  wire: Anchor,
): Promise<PublishResult[]> {
  const channels: Network[] = ["matrix", "ssb"];
  try {
    return await transport.publish({
      type: WITNESS_EVENT_TYPE,
      content: wire,
      channels,
    });
  } catch (err) {
    // Facade.publish is already per-network-resilient, but a whole-call
    // rejection still needs to surface as failure on both networks rather
    // than disappearing.
    const reason = describeError(err);
    return channels.map((network) => ({ network, ok: false, reason }));
  }
}

function assembleRecord(
  anchor: Anchor,
  meta: LocalAnchorMeta,
  raw: PublishResult[],
  fatal: string | null,
): AnchorRecord {
  const seen = new Set<string>();
  const results: AnchorNetworkResult[] = [];
  for (const r of raw) {
    seen.add(r.network);
    results.push({
      network: r.network,
      ok: r.ok,
      ...(r.id ? { eventId: r.id } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    });
  }
  // Backfill the networks that didn't return a result at all (not connected,
  // or a global publish failure). Order: nostr, matrix, ssb — matches the
  // order the badges appear in the UI.
  for (const n of ["nostr", "matrix", "ssb"] as const) {
    if (seen.has(n)) continue;
    results.push({
      network: n,
      ok: false,
      reason: fatal ?? "not connected",
    });
  }
  return {
    ...anchor,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    networkResults: results,
    createdAt: Date.now(),
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Hash normalization                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Accept either a 64-char hex hash or an `0x`-prefixed 66-char form, return
 * the canonical 64-char lowercase form. Used at the proof-URL boundary so
 * a pasted hash with either form resolves to the same record.
 *
 * Throws on anything else — callers should pre-validate when they want a
 * friendlier error.
 */
export function normalizeHash(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const withoutPrefix = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{64}$/.test(withoutPrefix)) {
    throw new Error(
      `normalizeHash: expected 64 hex chars (optionally 0x-prefixed), got ${withoutPrefix.length}`,
    );
  }
  return withoutPrefix;
}

/**
 * Validity check without throwing. Mirrors `normalizeHash` so the UI can
 * gate the verify route on this before navigating.
 */
export function isValidHash(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  const withoutPrefix = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  return /^[0-9a-f]{64}$/.test(withoutPrefix);
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Convenience for verify-side code: convert the hex sig back to the bytes
 * shape `schnorr.verify` wants. Centralized so the conversion lives in one
 * place. (`schnorr.verify` itself is in `verify.ts`.)
 */
export function sigBytesFromHex(sigHex: string): Uint8Array {
  if (!/^[0-9a-f]{128}$/.test(sigHex.toLowerCase())) {
    throw new Error(
      `sigBytesFromHex: expected 128 lowercase hex chars, got ${sigHex.length}`,
    );
  }
  return hexToBytes(sigHex.toLowerCase());
}

/** Inverse of `signerHexFromIdentity`: hex → bytes, with shape validation. */
export function signerBytesFromHex(signerHex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(signerHex.toLowerCase())) {
    throw new Error(
      `signerBytesFromHex: expected 64 lowercase hex chars, got ${signerHex.length}`,
    );
  }
  return hexToBytes(signerHex.toLowerCase());
}
