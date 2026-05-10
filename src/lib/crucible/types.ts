/**
 * Crucible — type definitions for the Phase 5 anonymous whistleblower drop
 * feature (plan §3.5).
 *
 * Crucible has two surfaces in the same Aegis app, distinguished by route:
 *
 *  - **Source side** (`/crucible`)   — anonymous. The source generates a
 *    one-shot ephemeral secp256k1 keypair in memory only, runs ECDH against
 *    the newsroom's published pubkey to derive a content-encryption-key
 *    (CEK), and uploads a sealed ciphertext to Pinata. A pointer event is
 *    then published to all three Aegis networks. The ephemeral seckey is
 *    zeroed in a `finally` block — there is NO IDB persistence on the
 *    source side.
 *
 *  - **Newsroom side** (`/crucible/newsroom`) — signed in. The newsroom's
 *    Aegis identity *is* the newsroom pubkey. It subscribes to the
 *    `aegis.crucible.drop` event type, filters by `to === pubkeyHex(self)`,
 *    fetches the ciphertext for each matching drop, re-derives the same
 *    CEK via ECDH against the source's `ephemeralPubkey`, decrypts, and
 *    persists the *plaintext* drop in IndexedDB for later review.
 *
 * # ECDH KDF — single canonical info string
 *
 * Both sides derive the CEK as:
 *
 *     shared = secp256k1.getSharedSecret(seckey, peerPubkey, /*compressed*\/ true)
 *     // shared is 33 bytes (compressed point); drop the parity prefix.
 *     ikm  = shared.subarray(1)              // 32 bytes of x-coord
 *     CEK  = hkdf(sha256, ikm, salt=empty,   // 32 bytes
 *                info="aegis-crucible-ecdh-v1", 32)
 *
 * That info string is the single canonical contract between source and
 * newsroom — see `CRUCIBLE_KDF_INFO` in `ecdh.ts`.
 *
 * # Pointer event content
 *
 * `aegis.crucible.drop` events carry a `CruciblePointer` body (the wire
 * type below). Every field is JSON-serializable; the canonical form matches
 * the `CrucibleDrop` runtime type minus the synthetic `id`.
 */

/**
 * Wire form of the `aegis.crucible.drop` event content. Both sides agree on
 * this shape — the source publishes it, the newsroom subscribes and reads
 * it. Hex strings are lowercase; `cid` is whatever Pinata returned.
 */
export type CruciblePointer = {
  /**
   * Newsroom's pubkey, in either form:
   *   - 66 hex chars: SEC1-compressed (33-byte form, parity prefix + x)
   *   - 64 hex chars: x-only (32-byte form)
   * Source-side input accepts either; we keep whatever the source typed
   * so the matching subscriber on the newsroom side can compare without
   * pre-canonicalization mistakes.
   */
  to: string;
  /** Source's one-shot ephemeral pubkey, lowercase hex (66 chars). */
  ephemeralPubkey: string;
  /** Pinata CID for the sealed ciphertext blob. */
  cid: string;
  /** Unix seconds (source wall-clock). */
  ts: number;
};

/**
 * Normalized in-memory drop record. Same fields as the pointer plus a
 * stable synthetic id used as the IDB primary key on the newsroom side
 * (and as the user-visible "drop ID" the source saves for status check).
 *
 * `id = bytesToHex(sha256(utf8(cid + ":" + ephemeralPubkey)))`. Stable
 * across networks because both inputs are wire-canonical hex strings.
 */
export type CrucibleDrop = CruciblePointer & {
  /** sha256(cid + ":" + ephemeralPubkey) hex. Stable across networks. */
  id: string;
};

/**
 * A drop after the newsroom has fetched the ciphertext and decrypted it.
 * `attachments` is undefined for text-only drops.
 *
 * `read` is a local-only flag the newsroom flips when reviewing a drop;
 * it doesn't go on the wire.
 */
export type DecryptedDrop = CrucibleDrop & {
  plaintext: string;
  attachments?: DecryptedAttachment[];
  /** Local-only review flag, defaults to `false`. */
  read?: boolean;
};

/**
 * Decrypted attachment. `bytes` is the raw file content; the UI builds a
 * Blob URL for download. We keep the original filename + byte size for
 * display and to round-trip the upload metadata.
 */
export type DecryptedAttachment = {
  name: string;
  size: number;
  bytes: Uint8Array;
};

/**
 * Logical event type used on every transport when publishing or filtering
 * Crucible drops. Kept as a named constant so source/newsroom/page/hooks
 * all agree on one string.
 */
export const CRUCIBLE_EVENT_TYPE = "aegis.crucible.drop";
