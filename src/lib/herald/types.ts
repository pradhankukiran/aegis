/**
 * Herald — type definitions for the Phase 3 real-time chat feature.
 *
 * Conversations are keyed by the recipient's x-only Nostr pubkey (32 bytes,
 * 64 hex chars). When the user adds a conversation by pasting a 66-char SEC1
 * compressed pubkey, we strip the parity byte at the input boundary so every
 * downstream call (transport, IndexedDB key, UI render) sees a single
 * canonical 64-hex-char form.
 *
 * Why x-only? Because the wire formats Aegis crosses (Nostr, Matrix MXID
 * derivation) all consume the x-coordinate alone. The caller supplies
 * whatever form is convenient; we normalize once and keep it.
 */
import type { Network } from "../transport";

/** Lifecycle states a Message progresses through. */
export type MessageStatus =
  | "sending"
  | "sent"
  | "failed"
  | "received";

/**
 * A single chat message — outbound or inbound.
 *
 *  - Outbound:  `id` is a UUID we mint optimistically before the transport
 *               returns. Status walks `sending → sent` (with `via` populated)
 *               or `sending → failed`.
 *  - Inbound:   `id` is the AegisEvent id (sha256 of sender:type:content). We
 *               could also use a uuid; using AegisEvent id makes inbound dedup
 *               trivial since IndexedDB rejects duplicate keys.
 */
export type Message = {
  /** Unique id (UUID v4 for outbound, AegisEvent id for inbound). */
  id: string;
  /** The conversation this message belongs to (x-only 64-hex pubkey). */
  convId: string;
  /** Plaintext body. (Crypto happens inside the transport, not here.) */
  body: string;
  /** Unix milliseconds — JS Date.now() for outbound, derived for inbound. */
  ts: number;
  /** True iff we authored this message. */
  mine: boolean;
  /** Current status. */
  status: MessageStatus;
  /**
   * The network the message went out over (outbound) or arrived from
   * (inbound). Undefined while still `sending`.
   */
  via?: Network;
};

/**
 * A conversation — one row per remote pubkey we've ever talked to. The
 * pubkey is the canonical x-only 64-hex form. Display names / avatars are
 * deferred (the user pastes a hex; we render a truncated form).
 */
export type Conversation = {
  /** x-only 64-hex pubkey of the remote party. Primary key. */
  pubkey: string;
  /** Unix ms when this conversation was first added. */
  createdAt: number;
  /** Unix ms of the most recent message either way (sort key for the list). */
  lastMessageAt: number;
};
