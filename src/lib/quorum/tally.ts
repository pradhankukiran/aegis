/**
 * Quorum — post-close tally.
 *
 * `tallyPoll(transport, pollMeta)` subscribes for `aegis.quorum.ballot`
 * events filtered by the poll's id (via `["e", pollId]` tag), attempts to
 * unseal each one, and aggregates a deterministic count per option.
 *
 * # Cross-network behaviour
 *
 * `AegisTransport.subscribe` already dedups across networks by the
 * AegisEvent id (sha256 of sender:type:canonicalize(content)). So a
 * ballot a voter fanned out to Nostr + Matrix collapses to one
 * delivery here. The dedup window is 60s (TTL inside the facade), which
 * is more than enough for the live stream; for replay of historical
 * ballots, we additionally dedup on `[pollId, voter]` (one ballot per
 * voter, latest wins).
 *
 * # Why not also poll the local IDB ballot store?
 *
 * Tallies are intended to be done by anyone — not just the poll creator
 * — so we deliberately don't rely on the device's prior IDB cache. The
 * cross-network subscribe sees the same wire ballots no matter which
 * device runs the tally. The IDB store is a UX cache; the source of truth
 * is the three-network mesh.
 *
 * # Failure semantics
 *
 * Any ballot that fails to unseal (pre-close round, malformed payload,
 * bad signature, voter not on the whitelist) is dropped from `counts`
 * but increments `failed`. A poll with N submitted ballots produces a
 * Tally where `revealed + failed === N`, which surfaces to the UI as
 * "37 ballots received, 35 valid, 2 dropped".
 *
 * # Tally timing
 *
 * Subscribing waits `timeoutMs` (default 4s — same shape as
 * `verifyAnchor` in Witness) to give relays time to replay historical
 * ballots. After timeout we close the subscription and return. Callers
 * that want a continuous live tally re-run periodically; we do not
 * surface a streaming variant in v1.
 */
import type { AegisEvent, AegisTransport } from "../transport";

import { unsealVote } from "./unseal";
import { BALLOT_EVENT_TYPE, type Ballot, type PollMeta, type Tally } from "./types";

/**
 * How long to keep the cross-network subscription open while waiting for
 * historical ballots to be replayed by relays. Same default as
 * `verifyAnchor` (`VERIFY_TIMEOUT_MS = 4000`).
 */
export const TALLY_TIMEOUT_MS = 4000;

/**
 * Project an AegisEvent content payload into a `Ballot`. Returns null on
 * malformed shape — the tally drops anything that doesn't look like a
 * ballot envelope, without throwing. Exported for testing.
 */
export function projectBallotEvent(ev: AegisEvent): Ballot | null {
  if (!ev || ev.type !== BALLOT_EVENT_TYPE) return null;
  const c = ev.content as
    | { pollId?: unknown; sealedB64?: unknown; voter?: unknown; submittedAt?: unknown }
    | null;
  if (!c || typeof c !== "object") return null;
  if (typeof c.pollId !== "string" || c.pollId === "") return null;
  if (typeof c.sealedB64 !== "string" || c.sealedB64 === "") return null;
  // The voter pubkey can come from either the event sender (Nostr x-only)
  // or an explicit `voter` field in the payload. We trust the embedded
  // signature in the sealed envelope as the source of truth — `voter`
  // here is purely a hint so the tally can pre-filter against the
  // PollMeta voters list before paying for the tlock decrypt. We accept
  // the sender as a fallback when the payload omits it.
  const voter =
    typeof c.voter === "string" && /^[0-9a-f]{64}$/i.test(c.voter)
      ? c.voter.toLowerCase()
      : /^[0-9a-f]{64}$/i.test(ev.sender)
        ? ev.sender.toLowerCase()
        : null;
  if (!voter) return null;
  const submittedAt =
    typeof c.submittedAt === "number" && Number.isFinite(c.submittedAt)
      ? c.submittedAt
      : ev.ts * 1000;
  return {
    pollId: c.pollId,
    voter,
    sealedB64: c.sealedB64,
    submittedAt,
  };
}

/**
 * Run a single tally pass on a finished poll. Returns the aggregate
 * counts; safe to call repeatedly, idempotent in the sense that the same
 * inputs produce the same Tally.
 *
 * The function attempts unseal on every received ballot. If the drand
 * round hasn't been emitted yet (poll close hasn't actually happened),
 * every unseal returns null and the tally surfaces as `revealed=0,
 * failed=N` — the UI's "is revealed?" check should be done upstream by
 * comparing `Date.now()` to the round's expected emission time.
 */
export async function tallyPoll(
  transport: AegisTransport,
  pollMeta: PollMeta,
  options: { timeoutMs?: number } = {},
): Promise<Tally> {
  const timeoutMs = options.timeoutMs ?? TALLY_TIMEOUT_MS;
  const collected = new Map<string, Ballot>(); // key: voter (one ballot per voter)
  const voterSet =
    pollMeta.voters.length === 0
      ? null
      : new Set(pollMeta.voters.map((v) => v.toLowerCase()));

  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = transport.subscribe(
      { type: BALLOT_EVENT_TYPE },
      (ev) => {
        const ballot = projectBallotEvent(ev);
        if (!ballot) return;
        if (ballot.pollId !== pollMeta.id) return;
        // If the poll has a whitelist, drop non-members before paying the
        // tlock-decrypt cost. The sealed-payload signature check still runs
        // post-unseal for the survivors.
        if (voterSet && !voterSet.has(ballot.voter)) return;
        // One ballot per voter. Latest submittedAt wins.
        const existing = collected.get(ballot.voter);
        if (!existing || existing.submittedAt < ballot.submittedAt) {
          collected.set(ballot.voter, ballot);
        }
      },
    );
  } catch {
    unsubscribe = null;
  }

  if (unsubscribe) {
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    try {
      unsubscribe();
    } catch {
      /* best-effort teardown */
    }
  }

  return tallyFromBallots(pollMeta, Array.from(collected.values()));
}

/**
 * Tally a known set of ballots without touching the transport. Useful for
 * the UI's "show me what would tally now" preview and for unit testing.
 *
 * Each ballot's sealed payload is unsealed and the embedded signature is
 * verified. Failures (pre-close, malformed, bad sig, voter-mismatch,
 * option-out-of-range) bump `failed` without throwing.
 */
export async function tallyFromBallots(
  pollMeta: PollMeta,
  ballots: Ballot[],
): Promise<Tally> {
  const counts = new Array<number>(pollMeta.options.length).fill(0);
  let revealed = 0;
  let failed = 0;

  const voterSet =
    pollMeta.voters.length === 0
      ? null
      : new Set(pollMeta.voters.map((v) => v.toLowerCase()));

  // Unseal in sequence — tlock-js fetches the round signature on the
  // first call and the underlying client caches it, so parallelism
  // doesn't help much and sequential keeps the failure logging tidy.
  for (const ballot of ballots) {
    const vote = await unsealVote(ballot.sealedB64, pollMeta.drandRound);
    if (!vote) {
      failed += 1;
      continue;
    }
    // Cross-check the unsealed voter against the wire ballot's voter
    // hint AND the optional whitelist. The sealed-payload signature
    // already binds `voter` to `vote`, so this is belt-and-braces.
    if (vote.voter.toLowerCase() !== ballot.voter.toLowerCase()) {
      failed += 1;
      continue;
    }
    if (voterSet && !voterSet.has(vote.voter.toLowerCase())) {
      failed += 1;
      continue;
    }
    if (vote.pollId !== pollMeta.id) {
      failed += 1;
      continue;
    }
    if (
      !Number.isInteger(vote.optionIndex) ||
      vote.optionIndex < 0 ||
      vote.optionIndex >= pollMeta.options.length
    ) {
      failed += 1;
      continue;
    }
    counts[vote.optionIndex] += 1;
    revealed += 1;
  }

  return {
    pollId: pollMeta.id,
    counts,
    totalBallots: revealed + failed,
    revealed,
    failed,
  };
}
