/**
 * Quorum — type definitions for the Phase 5 sealed-ballot voting feature
 * (plan §3.6).
 *
 * Quorum is the civic cousin of Hermetic Echo: every ballot is timelock-
 * encrypted to the same drand quicknet round (computed from the poll's
 * close time), so no party — not the poll creator, not the relays, not
 * other voters — can peek at any vote before close. After the close round
 * is signed by drand, anyone can decrypt every ballot simultaneously and
 * compute a deterministic tally.
 *
 * # The two wire envelopes
 *
 * Quorum publishes two distinct Aegis event types through the unified
 * transport facade:
 *
 *   - `aegis.quorum.poll`   — poll metadata (PollMeta). Public; anyone can
 *                             see what's being voted on.
 *   - `aegis.quorum.ballot` — a single voter's sealed ballot (Ballot). The
 *                             `sealed` field is timelock-encrypted to the
 *                             poll's `drandRound`; nobody can recover
 *                             `optionIndex` before then.
 *
 * Both events fan out across Nostr and Matrix via the standard
 * two-network mesh. Ballots carry an `["e", pollId]` Nostr tag so a
 * tallier can subscribe to just one poll's ballots without seeing
 * unrelated traffic.
 *
 * # Pubkey canonicalization
 *
 * `voters`, `voter`, and `owner` are all x-only 64-char lowercase hex (the
 * BIP-340 Schnorr form Nostr uses). The UI accepts user-pasted 66-char
 * SEC1-compressed hex and strips the parity byte at the input boundary, so
 * every downstream surface (IDB key, sealed-payload AAD, tally membership
 * check) sees a single canonical form.
 *
 * # Why commit-reveal and not Paillier (plan §10 open)
 *
 * Paillier homomorphic addition would let a tallier sum ciphertexts and
 * reveal only the final tally, hiding individual votes even post-close.
 * It's appealing but adds material complexity: per-poll Paillier key pairs,
 * range proofs to keep voters honest, and a trusted decryption ceremony.
 * For Quorum v1 we commit to the simpler timelock primitive: every ballot
 * reveals its `optionIndex` post-close, but nobody (including the creator)
 * can peek pre-close. Plan §10 left Paillier for Phase 6+.
 */

/**
 * Poll metadata. Owned by the creator, fanned out once via
 * `aegis.quorum.poll`. Stored verbatim in IDB on every device that
 * received the poll so the UI can render it without re-fetching.
 */
export type PollMeta = {
  /** Unique poll id. We use crypto.randomUUID() so two creators can't collide. */
  id: string;
  /** Free-form poll title. Trimmed at the input boundary. */
  title: string;
  /** Choice list. 2..10 entries. Trimmed at input. */
  options: string[];
  /**
   * Eligible voter pubkeys (x-only 64-char lowercase hex). Empty array
   * means "open poll" — anyone can submit a ballot, and the tally accepts
   * every well-signed entry. Non-empty: tally drops ballots whose
   * `voter` is not in this list.
   */
  voters: string[];
  /** Wall-clock close time in Unix milliseconds (advisory only). */
  closeUnix: number;
  /**
   * Drand quicknet round derived from `closeUnix`. The single round
   * every ballot is timelock-encrypted to. Same chain hash as Hermetic
   * (mainnetClient → defaultChainInfo).
   */
  drandRound: number;
  /** Owner pubkey (x-only 64-char lowercase hex). */
  owner: string;
  /** Unix ms the poll was created (creator's clock). */
  createdAt: number;
};

/**
 * A single sealed ballot. Voters publish one of these per poll. The
 * payload inside `sealedB64` is a Vote-shaped object encrypted under
 * `tlock-js` to `pollMeta.drandRound`, then signed; see `seal.ts` for the
 * exact wire format.
 *
 * One ballot per voter per poll: the IDB store keys on `[pollId, voter]`
 * so a re-submission overwrites the prior entry (caller may interpret
 * that as "latest replaces").
 */
export type Ballot = {
  /** Poll this ballot belongs to. */
  pollId: string;
  /** Submitter pubkey (x-only 64-char lowercase hex). */
  voter: string;
  /** base64url of the sealed payload bytes. ~200-400 bytes typical. */
  sealedB64: string;
  /** Unix ms the ballot was minted (submitter's clock; advisory only). */
  submittedAt: number;
};

/**
 * The plaintext payload that lives *inside* the sealed envelope. Recovered
 * post-close via tlock-js + sealed-payload signature verification.
 *
 * The `nonce` is required: without it, two voters who happened to pick the
 * same option would produce ciphertexts that — while not directly equal
 * thanks to tlock's randomness — could still leak vote-equality through
 * traffic analysis. The nonce randomizes the inner payload bytes too.
 */
export type Vote = {
  pollId: string;
  /** Index into PollMeta.options. 0 ≤ optionIndex < options.length. */
  optionIndex: number;
  /** Submitter pubkey, x-only 64-char lowercase hex. */
  voter: string;
  /** Anti-replay nonce, hex-encoded random bytes. */
  nonce: string;
};

/**
 * Aggregated tally for a single poll. Produced by `tallyPoll` after the
 * drand close round has been emitted.
 *
 * `revealed` is the count of ballots that decrypted cleanly AND whose
 * embedded signature matched the claimed voter. `failed` is anything that
 * didn't make it: malformed sealed payload, wrong round, signature
 * mismatch, voter-not-in-list (when the poll has a whitelist), or any
 * tlock-js decrypt error. `totalBallots` is `revealed + failed`.
 */
export type Tally = {
  pollId: string;
  /** counts.length === poll.options.length; counts[i] is the number of revealed ballots for option i. */
  counts: number[];
  totalBallots: number;
  revealed: number;
  failed: number;
};

/**
 * Aegis logical event types for the Quorum feature. Centralized so
 * subscribers and publishers reference the same string everywhere.
 */
export const POLL_EVENT_TYPE = "aegis.quorum.poll" as const;
export const BALLOT_EVENT_TYPE = "aegis.quorum.ballot" as const;
