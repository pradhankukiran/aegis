/**
 * Quorum — discover polls peers publish on the network.
 *
 * Subscribes via `AegisTransport.subscribe({type: "aegis.quorum.poll"})`
 * and persists every well-formed PollMeta it sees into the local IDB
 * `polls` store. The PollList UI reads from that store, so a poll a peer
 * created on another device shows up automatically once the transport
 * lands the event here.
 *
 * Also subscribes to `aegis.quorum.ballot` events so the local device
 * caches ballots it's received — useful for "ballots in flight" UX
 * before the close round. The tally itself re-subscribes on demand
 * (it's the authoritative source) but having the cache means the UI can
 * show "N ballots submitted so far" without an extra network round-trip.
 *
 * # Co-existence with other Aegis features
 *
 * We subscribe by exact `type`, so Atlas / Herald / Scribe / Beacon
 * events are filtered out at the transport layer. No silent dispatch
 * clashes.
 *
 * # Resilience
 *
 * Both subscriptions wrap their handler in try/catch; a malformed event
 * (bad JSON content, missing field) is logged once and dropped without
 * tearing down the listener.
 */
import { savePoll, saveBallot } from "./poll-store";
import { projectBallotEvent } from "./tally";
import {
  BALLOT_EVENT_TYPE,
  POLL_EVENT_TYPE,
  type Ballot,
  type PollMeta,
} from "./types";

import type { AegisEvent, AegisTransport } from "../transport";

/**
 * Attach the poll + ballot listeners. Returns a single unsubscribe
 * closure that detaches both. Optional callbacks let the UI react
 * (refresh the list, scroll to a new ballot) after each successful
 * persist.
 */
export function attachQuorumBridge(
  transport: AegisTransport,
  hooks?: {
    onPoll?: (poll: PollMeta) => void;
    onBallot?: (ballot: Ballot) => void;
  },
): () => void {
  const unsubPolls = transport.subscribe(
    { type: POLL_EVENT_TYPE },
    (ev) => {
      handlePoll(ev, hooks?.onPoll).catch((err) => {
        console.error("[quorum] poll bridge error:", err);
      });
    },
  );

  const unsubBallots = transport.subscribe(
    { type: BALLOT_EVENT_TYPE },
    (ev) => {
      handleBallot(ev, hooks?.onBallot).catch((err) => {
        console.error("[quorum] ballot bridge error:", err);
      });
    },
  );

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      unsubPolls();
    } catch {
      /* ignore */
    }
    try {
      unsubBallots();
    } catch {
      /* ignore */
    }
  };
}

async function handlePoll(
  ev: AegisEvent,
  onPoll?: (poll: PollMeta) => void,
): Promise<void> {
  const poll = projectPollEvent(ev);
  if (!poll) return;
  await savePoll(poll);
  onPoll?.(poll);
}

async function handleBallot(
  ev: AegisEvent,
  onBallot?: (ballot: Ballot) => void,
): Promise<void> {
  const ballot = projectBallotEvent(ev);
  if (!ballot) return;
  await saveBallot(ballot);
  onBallot?.(ballot);
}

/**
 * Project an AegisEvent into a PollMeta. Returns null on any shape
 * mismatch. Exported for unit testing — the bridge itself only consumes
 * the result.
 *
 * We accept polls with up to 10 options and at least 2 (matches the
 * `CreatePollForm` validation). Polls with `voters` populated must list
 * x-only hex pubkeys; non-hex entries are scrubbed (rather than rejecting
 * the whole poll) since a peer's malformed entry shouldn't poison the
 * shared event.
 */
export function projectPollEvent(ev: AegisEvent): PollMeta | null {
  if (!ev || ev.type !== POLL_EVENT_TYPE) return null;
  const c = ev.content as
    | {
        id?: unknown;
        title?: unknown;
        options?: unknown;
        voters?: unknown;
        closeUnix?: unknown;
        drandRound?: unknown;
        owner?: unknown;
        createdAt?: unknown;
      }
    | null;
  if (!c || typeof c !== "object") return null;
  if (typeof c.id !== "string" || c.id === "") return null;
  if (typeof c.title !== "string" || c.title === "") return null;
  if (!Array.isArray(c.options)) return null;
  if (c.options.length < 2 || c.options.length > 10) return null;
  const options: string[] = [];
  for (const o of c.options) {
    if (typeof o !== "string" || o.trim() === "") return null;
    options.push(o);
  }
  const voters: string[] = [];
  if (Array.isArray(c.voters)) {
    for (const v of c.voters) {
      if (typeof v === "string" && /^[0-9a-f]{64}$/i.test(v)) {
        voters.push(v.toLowerCase());
      }
    }
  }
  if (!Number.isFinite(c.closeUnix as number)) return null;
  if (!Number.isInteger(c.drandRound as number) || (c.drandRound as number) <= 0) {
    return null;
  }
  // Owner pubkey: accept the explicit `owner` field, fall back to the
  // event sender when the payload omitted it.
  let owner: string | null = null;
  if (typeof c.owner === "string" && /^[0-9a-f]{64}$/i.test(c.owner)) {
    owner = c.owner.toLowerCase();
  } else if (/^[0-9a-f]{64}$/i.test(ev.sender)) {
    owner = ev.sender.toLowerCase();
  }
  if (!owner) return null;
  const createdAt = Number.isFinite(c.createdAt as number)
    ? (c.createdAt as number)
    : ev.ts * 1000;
  return {
    id: c.id,
    title: c.title,
    options,
    voters,
    closeUnix: c.closeUnix as number,
    drandRound: c.drandRound as number,
    owner,
    createdAt,
  };
}
