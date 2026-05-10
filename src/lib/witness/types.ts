/**
 * Witness — type definitions for the Phase 4 multi-network notary feature.
 *
 * # The anchor lifecycle
 *
 *   1. User picks a file → browser SHA-256-hashes it client-side.
 *   2. Aegis identity signs the hash (BIP-340 Schnorr) → produces an `Anchor`.
 *   3. The Anchor is fanned out across Nostr + Matrix + SSB via
 *      `AegisTransport.publish({ type: "aegis.witness", content: anchor })`.
 *   4. Per-network outcomes plus the local file metadata get stored as an
 *      `AnchorRecord` in IndexedDB so the history UI can render later.
 *
 * # Why we split `Anchor` from `AnchorRecord`
 *
 * `Anchor` is the wire-stable shape — exactly what we publish on every
 * transport. `AnchorRecord` is the local-bookkeeping superset: it carries the
 * filename, file size, per-network results, and createdAt timestamp that we
 * keep only in the local history list. Keeping the two apart means the wire
 * format never drifts even as we extend local-only fields.
 *
 * Schnorr signature is BIP-340 (x-only pubkey, 64-byte signature), so
 * `signer` is the 32-byte x-only form in hex (64 chars). Mirrors what
 * `NostrTransport.pubkey` returns and what every other Aegis cross-network
 * identity field uses.
 */
import type { Network } from "../transport";

/**
 * The canonical wire-form anchor. Same shape on every network — what feature
 * code publishes and what verifiers re-derive the signature digest from.
 */
export type Anchor = {
  /** SHA-256 of the witnessed file, lowercase hex (64 chars). */
  hash: string;
  /** BIP-340 Schnorr signature over `sha256(canonicalize({hash, ts}))`, hex (128 chars). */
  sig: string;
  /** Signer's x-only secp256k1 pubkey, hex (64 chars). */
  signer: string;
  /** Unix seconds — included in the signed digest. */
  ts: number;
};

/**
 * Per-network outcome of a publish attempt. `eventId` is the wire-native id
 * when the underlying transport surfaces one (Matrix `event_id`, SSB `msg_id`
 * — Nostr's `publish()` does not return its event id from the SimplePool
 * fan-out so it's left undefined on success; see the open-questions note in
 * `anchor.ts`).
 */
export type AnchorNetworkResult = {
  network: Network;
  ok: boolean;
  eventId?: string;
  /** Free-form failure reason, or success metadata from the network. */
  reason?: string;
};

/**
 * Locally-persisted record of an anchor we created. The wire-form `Anchor`
 * fields are embedded directly; the extras are local-only bookkeeping.
 */
export type AnchorRecord = Anchor & {
  fileName?: string;
  fileSize?: number;
  networkResults: AnchorNetworkResult[];
  /** Unix ms — local clock at the moment we finished the publish fan-out. */
  createdAt: number;
};

/**
 * Per-network verification outcome. `found` reflects whether we observed an
 * `aegis.witness` event with the requested hash on that network; if found,
 * `signatureValid` is the result of re-deriving the BIP-340 digest and
 * checking it against the event's `sig`/`signer`. `ts` is the timestamp on
 * the recovered event (in seconds, matching `Anchor.ts`).
 */
export type NetworkVerification = {
  network: Network;
  found: boolean;
  signatureValid?: boolean;
  ts?: number;
};

/**
 * Aggregate verification result returned by `verifyAnchor`.
 *
 *  - `overallOk`     — signature valid AND found on at least one network.
 *                       This is the "the anchor is real" answer.
 *  - `fullyAnchored` — found on every configured network (3/3). The
 *                       three-network resilience promise the plan §3.4
 *                       sketches the proof against.
 */
export type Verification = {
  hash: string;
  networks: NetworkVerification[];
  overallOk: boolean;
  fullyAnchored: boolean;
};

/**
 * Logical event type used on every transport when publishing or filtering
 * anchors. Kept as a named constant so the page, hooks, and verify path all
 * agree on one string.
 */
export const WITNESS_EVENT_TYPE = "aegis.witness";
