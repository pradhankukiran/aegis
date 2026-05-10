/**
 * @vitest-environment happy-dom
 *
 * Quorum — tally tests. Exercises two surfaces:
 *
 *   1. `tallyFromBallots(pollMeta, ballots)` — given pre-sealed ballots,
 *      unseal each one and aggregate counts. Uses the same tlock mock as
 *      `seal.test.ts` so the path is deterministic.
 *
 *   2. `tallyPoll(transport, pollMeta)` — drive a fake transport that
 *      streams synthesized `aegis.quorum.ballot` events at the tally,
 *      assert the resulting counts.
 *
 *   3. `projectBallotEvent(ev)` — covers shape-validation edge cases
 *      (missing fields, wrong type, malformed voter hex, sender fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
} from "../crypto/encoding";
import type { AegisEvent, AegisTransport } from "../transport";

/* tlock mock — same shape as seal.test.ts. */
const TLOCK_PREFIX = "tlock|";
vi.mock("../crypto/timelock", () => ({
  DRAND_CHAIN_HASH: "mock-chain-hash",
  DRAND_PERIOD_SECONDS: 3,
  DRAND_GENESIS_SECONDS: 0,
  roundForDate: (d: Date): number => Math.floor(d.getTime() / 1000),
  dateForRound: (round: number): Date => new Date(round * 1000),
  timelockEncryptBytes: async (
    bytes: Uint8Array,
    round: number,
  ): Promise<string> => `${TLOCK_PREFIX}${round}|${bytesToBase64Url(bytes)}`,
  timelockDecryptString: async (str: string): Promise<Uint8Array> => {
    if (!str.startsWith(TLOCK_PREFIX)) throw new Error("mock tlock: bad prefix");
    const rest = str.slice(TLOCK_PREFIX.length);
    const sep = rest.indexOf("|");
    if (sep === -1) throw new Error("mock tlock: malformed");
    return base64UrlToBytes(rest.slice(sep + 1));
  },
}));

import { sealVote, mintVoteNonce } from "./seal";
import {
  projectBallotEvent,
  tallyFromBallots,
  tallyPoll,
} from "./tally";
import {
  BALLOT_EVENT_TYPE,
  POLL_EVENT_TYPE,
  type Ballot,
  type PollMeta,
  type Vote,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function makeIdentitySeeded(seed: number): {
  seckey: Uint8Array;
  voterHex: string;
} {
  const seckey = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) seckey[i] = (seed + i) & 0xff;
  // Avoid the all-zero scalar (vanishingly unlikely with seed in [1, 255]).
  if (seckey.every((b) => b === 0)) seckey[0] = 1;
  const compressed = secp256k1.getPublicKey(seckey, true);
  return { seckey, voterHex: bytesToHex(compressed.subarray(1)) };
}

const POLL_ID = "poll-tally-1";
const DRAND_ROUND = 9000;

function makePoll(over: Partial<PollMeta> = {}): PollMeta {
  return {
    id: POLL_ID,
    title: "what to ship next?",
    options: ["beacon", "crucible", "quorum"],
    voters: [],
    closeUnix: 2_000_000_000_000,
    drandRound: DRAND_ROUND,
    owner: "0".repeat(64),
    createdAt: 1,
    ...over,
  };
}

async function sealedBallot(
  optionIndex: number,
  seed: number,
  pollId = POLL_ID,
  round = DRAND_ROUND,
): Promise<Ballot> {
  const { seckey, voterHex } = makeIdentitySeeded(seed);
  const vote: Vote = {
    pollId,
    optionIndex,
    voter: voterHex,
    nonce: await mintVoteNonce(),
  };
  const sealedB64 = await sealVote(vote, round, seckey);
  return {
    pollId,
    voter: voterHex,
    sealedB64,
    submittedAt: Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/* projectBallotEvent                                                          */
/* -------------------------------------------------------------------------- */

describe("quorum / projectBallotEvent", () => {
  it("projects a well-formed ballot event", () => {
    const ev: AegisEvent = {
      id: "e1",
      origin: "nostr",
      sender: "a".repeat(64),
      type: BALLOT_EVENT_TYPE,
      content: {
        pollId: "p-1",
        voter: "a".repeat(64),
        sealedB64: "ABC",
        submittedAt: 1700000000000,
      },
      ts: 1700000000,
    };
    const b = projectBallotEvent(ev);
    expect(b).not.toBeNull();
    expect(b!.pollId).toBe("p-1");
    expect(b!.voter).toBe("a".repeat(64));
    expect(b!.sealedB64).toBe("ABC");
  });

  it("falls back to ev.sender when content.voter is absent", () => {
    const ev: AegisEvent = {
      id: "e2",
      origin: "nostr",
      sender: "b".repeat(64),
      type: BALLOT_EVENT_TYPE,
      content: { pollId: "p-2", sealedB64: "ABC" },
      ts: 1,
    };
    expect(projectBallotEvent(ev)?.voter).toBe("b".repeat(64));
  });

  it("returns null when the wrong type is supplied", () => {
    const ev: AegisEvent = {
      id: "e3",
      origin: "nostr",
      sender: "c".repeat(64),
      type: POLL_EVENT_TYPE, // not a ballot event
      content: { pollId: "p-1", sealedB64: "x" },
      ts: 1,
    };
    expect(projectBallotEvent(ev)).toBeNull();
  });

  it("returns null when sealedB64 is empty", () => {
    const ev: AegisEvent = {
      id: "e4",
      origin: "nostr",
      sender: "c".repeat(64),
      type: BALLOT_EVENT_TYPE,
      content: { pollId: "p-1", sealedB64: "" },
      ts: 1,
    };
    expect(projectBallotEvent(ev)).toBeNull();
  });

  it("returns null when no usable voter hex is recoverable", () => {
    const ev: AegisEvent = {
      id: "e5",
      origin: "matrix",
      sender: "@bob:matrix.aegis.app", // not hex
      type: BALLOT_EVENT_TYPE,
      content: { pollId: "p-1", sealedB64: "x" /* no `voter` field */ },
      ts: 1,
    };
    expect(projectBallotEvent(ev)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* tallyFromBallots                                                            */
/* -------------------------------------------------------------------------- */

describe("quorum / tallyFromBallots", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts each option correctly for a clean run", async () => {
    const poll = makePoll();
    const ballots = await Promise.all([
      sealedBallot(0, 1),
      sealedBallot(0, 2),
      sealedBallot(1, 3),
      sealedBallot(2, 4),
    ]);
    const t = await tallyFromBallots(poll, ballots);
    expect(t.pollId).toBe(POLL_ID);
    expect(t.counts).toEqual([2, 1, 1]);
    expect(t.revealed).toBe(4);
    expect(t.failed).toBe(0);
    expect(t.totalBallots).toBe(4);
  });

  it("counts a ballot whose unseal fails (malformed) under `failed`", async () => {
    const poll = makePoll();
    const good = await sealedBallot(0, 5);
    const broken: Ballot = {
      pollId: poll.id,
      voter: "1".repeat(64),
      sealedB64: "not-a-real-sealed-payload",
      submittedAt: 1,
    };
    const t = await tallyFromBallots(poll, [good, broken]);
    expect(t.counts).toEqual([1, 0, 0]);
    expect(t.revealed).toBe(1);
    expect(t.failed).toBe(1);
    expect(t.totalBallots).toBe(2);
  });

  it("drops ballots from voters not on the whitelist", async () => {
    const onListBallot = await sealedBallot(0, 11);
    const offListBallot = await sealedBallot(1, 12);
    const poll = makePoll({ voters: [onListBallot.voter] });
    const t = await tallyFromBallots(poll, [onListBallot, offListBallot]);
    expect(t.counts).toEqual([1, 0, 0]);
    expect(t.revealed).toBe(1);
    expect(t.failed).toBe(1);
  });

  it("drops a ballot whose envelope voter disagrees with the sealed inner voter", async () => {
    const ballot = await sealedBallot(0, 21);
    // Forge the wire `voter` field while leaving the sealed payload's
    // (signature-bound) voter unchanged. The cross-check in
    // tallyFromBallots catches this even before signature verification
    // gets to weigh in.
    const tampered: Ballot = { ...ballot, voter: "9".repeat(64) };
    const poll = makePoll();
    const t = await tallyFromBallots(poll, [tampered]);
    expect(t.revealed).toBe(0);
    expect(t.failed).toBe(1);
  });

  it("drops a ballot whose unsealed pollId disagrees with the running poll", async () => {
    const ballot = await sealedBallot(0, 31, "other-poll");
    const poll = makePoll();
    const t = await tallyFromBallots(poll, [ballot]);
    expect(t.revealed).toBe(0);
    expect(t.failed).toBe(1);
  });

  it("drops a ballot whose optionIndex is out of range for the poll", async () => {
    // Sealed with optionIndex 5, but the poll has only 3 options.
    const ballot = await sealedBallot(5, 41);
    const poll = makePoll();
    const t = await tallyFromBallots(poll, [ballot]);
    expect(t.revealed).toBe(0);
    expect(t.failed).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* tallyPoll (transport-driven)                                                */
/* -------------------------------------------------------------------------- */

describe("quorum / tallyPoll", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  function makeFakeTransport(events: AegisEvent[]): AegisTransport {
    const subscribe = (
      _filter: unknown,
      onEvent: (ev: AegisEvent) => void,
    ): (() => void) => {
      // Synchronously deliver every event so the tally completes within
      // the timeout. The real facade fans events out asynchronously over
      // a network listener; firing inline keeps the test deterministic.
      for (const ev of events) {
        onEvent(ev);
      }
      return () => undefined;
    };
    return { subscribe } as unknown as AegisTransport;
  }

  it("aggregates a stream of ballots into counts", async () => {
    const poll = makePoll();
    const b1 = await sealedBallot(0, 51);
    const b2 = await sealedBallot(0, 52);
    const b3 = await sealedBallot(2, 53);
    const events: AegisEvent[] = [b1, b2, b3].map((b, i) => ({
      id: "e" + i,
      origin: "nostr",
      sender: b.voter,
      type: BALLOT_EVENT_TYPE,
      content: b,
      ts: 1,
    }));
    const transport = makeFakeTransport(events);
    const t = await tallyPoll(transport, poll, { timeoutMs: 1 });
    expect(t.counts).toEqual([2, 0, 1]);
    expect(t.revealed).toBe(3);
    expect(t.failed).toBe(0);
  });

  it("skips ballots tagged for a different poll", async () => {
    const poll = makePoll();
    const onMatch = await sealedBallot(1, 61);
    const offMatch = await sealedBallot(2, 62, "other-poll");
    const events: AegisEvent[] = [onMatch, offMatch].map((b, i) => ({
      id: "e" + i,
      origin: "nostr",
      sender: b.voter,
      type: BALLOT_EVENT_TYPE,
      content: b,
      ts: 1,
    }));
    const transport = makeFakeTransport(events);
    const t = await tallyPoll(transport, poll, { timeoutMs: 1 });
    expect(t.counts).toEqual([0, 1, 0]);
    expect(t.revealed).toBe(1);
    expect(t.failed).toBe(0);
  });

  it("deduplicates re-submissions per voter (latest wins)", async () => {
    const poll = makePoll();
    const { seckey, voterHex } = makeIdentitySeeded(71);
    const v1: Vote = {
      pollId: POLL_ID,
      optionIndex: 0,
      voter: voterHex,
      nonce: await mintVoteNonce(),
    };
    const v2: Vote = { ...v1, optionIndex: 2, nonce: await mintVoteNonce() };
    const sealed1 = await sealVote(v1, DRAND_ROUND, seckey);
    const sealed2 = await sealVote(v2, DRAND_ROUND, seckey);
    const b1: Ballot = {
      pollId: POLL_ID,
      voter: voterHex,
      sealedB64: sealed1,
      submittedAt: 1,
    };
    const b2: Ballot = {
      pollId: POLL_ID,
      voter: voterHex,
      sealedB64: sealed2,
      submittedAt: 2, // newer
    };
    const events: AegisEvent[] = [b1, b2].map((b, i) => ({
      id: "e" + i,
      origin: "nostr",
      sender: voterHex,
      type: BALLOT_EVENT_TYPE,
      content: b,
      ts: 1,
    }));
    const transport = makeFakeTransport(events);
    const t = await tallyPoll(transport, poll, { timeoutMs: 1 });
    // Only the latest submission (option 2) survives.
    expect(t.counts).toEqual([0, 0, 1]);
    expect(t.revealed).toBe(1);
    expect(t.failed).toBe(0);
  });
});
