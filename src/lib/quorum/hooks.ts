"use client";

/**
 * Quorum — React hooks layered on top of storage + seal + transport bridge.
 *
 * ## Page lifecycle
 *
 *   useIdentity()          load-or-mint the local Identity (mirrors Herald / Atlas)
 *   useTransport(id)       lazy build of AegisTransport + per-network status
 *   useQuorumBridge(tr)    mount the poll/ballot discovery listener
 *   usePolls()             live list of polls (mine + discovered)
 *   useCreatePoll(tr)      create + publish + persist a new poll
 *   usePoll(pollId)        single poll + ballots + computed tally + reveal flag
 *   useSubmitBallot(...)   seal-and-publish a ballot for the active poll
 *
 * IDB-touching hooks defer to useEffect, never run during SSR, and gate every
 * read on `typeof indexedDB`. The transport is dynamic-imported so the heavy
 * matrix-js-sdk WASM payload stays out of the SSR bundle (same pattern as
 * Atlas / Herald).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generateIdentity, loadIdentity, saveIdentity } from "../identity";
import type { Identity } from "../identity";
import { signerHexFromIdentity } from "../witness";
import type { AegisTransport } from "../transport";

import { dateForRound } from "../crypto/timelock";

import { roundForUnixTs } from "./drand";
import {
  getBallot,
  getPoll,
  loadBallots,
  loadPolls,
  savePoll,
  saveBallot as persistBallot,
} from "./poll-store";
import { mintVoteNonce, sealVote } from "./seal";
import { tallyFromBallots } from "./tally";
import { attachQuorumBridge } from "./transport-bridge";
import {
  BALLOT_EVENT_TYPE,
  POLL_EVENT_TYPE,
  type Ballot,
  type PollMeta,
  type Tally,
  type Vote,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Identity / transport (mirrors Herald + Atlas)                                */
/* -------------------------------------------------------------------------- */

export function useIdentity(): {
  identity: Identity | null;
  ready: boolean;
  generate: () => Promise<Identity>;
} {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    loadIdentity()
      .then((id) => {
        if (cancelled) return;
        setIdentity(id);
      })
      .catch(() => {
        if (cancelled) return;
        setIdentity(null);
      })
      .finally(() => {
        if (cancelled) return;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = useCallback(async () => {
    const fresh = await generateIdentity();
    await saveIdentity(fresh);
    setIdentity(fresh);
    return fresh;
  }, []);

  return { identity, ready, generate };
}

export type TransportStatus = {
  nostr: boolean | null;
  matrix: boolean | null;
  ssb: boolean | null;
};

const INITIAL_STATUS: TransportStatus = {
  nostr: null,
  matrix: null,
  ssb: null,
};

function readTransportConfig() {
  const matrixHs =
    process.env.NEXT_PUBLIC_AEGIS_MATRIX_HOMESERVER ?? "https://matrix.aegis.app";
  const ssbUrl =
    process.env.NEXT_PUBLIC_AEGIS_SSB_URL ?? "wss://ssb.aegis.app/aegis-ws";
  const matrixToken =
    process.env.NEXT_PUBLIC_AEGIS_MATRIX_REGISTRATION_TOKEN ?? undefined;
  return { matrixHs, ssbUrl, matrixToken };
}

export function useTransport(identity: Identity | null): {
  transport: AegisTransport | null;
  status: TransportStatus;
  ready: boolean;
} {
  const [transport, setTransport] = useState<AegisTransport | null>(null);
  const [status, setStatus] = useState<TransportStatus>(INITIAL_STATUS);
  const liveRef = useRef<AegisTransport | null>(null);

  useEffect(() => {
    if (!identity) return;
    if (typeof window === "undefined") return;
    let cancelled = false;
    let local: AegisTransport | null = null;

    (async () => {
      const { AegisTransport } = await import("../transport");
      const { matrixHs, ssbUrl, matrixToken } = readTransportConfig();
      local = new AegisTransport(identity, {
        nostr: {},
        matrix: {
          homeserver: matrixHs,
          ...(matrixToken ? { registrationToken: matrixToken } : {}),
        },
        ssb: { pubUrl: ssbUrl },
      });
      try {
        const connected = await local.connect();
        if (cancelled) {
          local.close().catch(() => undefined);
          return;
        }
        liveRef.current = local;
        setTransport(local);
        setStatus({
          nostr: connected.nostr,
          matrix: connected.matrix,
          ssb: connected.ssb,
        });
      } catch {
        if (cancelled) return;
        setStatus({ nostr: false, matrix: false, ssb: false });
      }
    })();

    return () => {
      cancelled = true;
      const t = liveRef.current;
      liveRef.current = null;
      setTransport(null);
      if (t) {
        t.close().catch(() => undefined);
      }
    };
  }, [identity]);

  const ready = useMemo(
    () =>
      Boolean(transport) &&
      (status.nostr === true || status.matrix === true || status.ssb === true),
    [transport, status],
  );

  return { transport, status, ready };
}

/* -------------------------------------------------------------------------- */
/* useQuorumBridge                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Mount the poll/ballot bridge on the active transport. Calls back with
 * each newly persisted poll / ballot so the page can refresh dependent
 * lists.
 */
export function useQuorumBridge(
  transport: AegisTransport | null,
  hooks?: {
    onPoll?: (poll: PollMeta) => void;
    onBallot?: (ballot: Ballot) => void;
  },
): void {
  const hooksRef = useRef(hooks);
  useEffect(() => {
    hooksRef.current = hooks;
  }, [hooks]);

  useEffect(() => {
    if (!transport) return;
    const unsub = attachQuorumBridge(transport, {
      onPoll: (p) => hooksRef.current?.onPoll?.(p),
      onBallot: (b) => hooksRef.current?.onBallot?.(b),
    });
    return () => {
      try {
        unsub();
      } catch {
        /* ignore — transport may already be closed */
      }
    };
  }, [transport]);
}

/* -------------------------------------------------------------------------- */
/* usePolls                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Live list of polls (both ones I created and ones discovered through the
 * bridge). Sorted by createdAt desc.
 */
export function usePolls(): {
  polls: PollMeta[];
  refresh: () => Promise<void>;
} {
  const [polls, setPolls] = useState<PollMeta[]>([]);

  const refresh = useCallback((): Promise<void> => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return loadPolls().then((list) => {
      list.sort((a, b) => b.createdAt - a.createdAt);
      setPolls(list);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    loadPolls().then((list) => {
      if (cancelled) return;
      list.sort((a, b) => b.createdAt - a.createdAt);
      setPolls(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { polls, refresh };
}

/* -------------------------------------------------------------------------- */
/* useCreatePoll                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Input shape the CreatePollForm hands us — sanitized but pre-projection.
 * `closeUnix` is wall-clock Unix ms; we'll project it to the drand round.
 */
export type CreatePollInput = {
  title: string;
  options: string[];
  voters: string[]; // x-only 64-hex lowercase (caller normalizes)
  closeUnix: number;
};

export function useCreatePoll(
  transport: AegisTransport | null,
  identity: Identity | null,
): {
  create: (input: CreatePollInput) => Promise<PollMeta>;
  isWorking: boolean;
  error: string | null;
} {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(
    async (input: CreatePollInput): Promise<PollMeta> => {
      if (!identity) throw new Error("identity required");
      if (!transport) throw new Error("transport not ready");
      setIsWorking(true);
      setError(null);
      try {
        const title = input.title.trim();
        if (!title) throw new Error("title required");
        const options = input.options.map((o) => o.trim()).filter((o) => o);
        if (options.length < 2) throw new Error("at least 2 options required");
        if (options.length > 10) throw new Error("at most 10 options allowed");
        if (input.closeUnix <= Date.now()) {
          throw new Error("close time must be in the future");
        }
        const voters = input.voters
          .map((v) => v.trim().toLowerCase())
          .filter((v) => /^[0-9a-f]{64}$/.test(v));

        const drandRound = await roundForUnixTs(input.closeUnix);
        const owner = signerHexFromIdentity(identity);
        const id = mintPollId();
        const poll: PollMeta = {
          id,
          title,
          options,
          voters,
          closeUnix: input.closeUnix,
          drandRound,
          owner,
          createdAt: Date.now(),
        };
        // Persist locally first so the UI immediately reflects the new
        // row even before publish settles.
        await savePoll(poll);
        // Fan out across all connected networks. Failures on individual
        // networks are tolerated — `publish` is per-network resilient.
        await transport.publish({
          type: POLL_EVENT_TYPE,
          content: poll,
        });
        return poll;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "failed to create poll";
        setError(msg);
        throw err;
      } finally {
        setIsWorking(false);
      }
    },
    [identity, transport],
  );

  return { create, isWorking, error };
}

/* -------------------------------------------------------------------------- */
/* usePoll                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Load a single poll (from IDB) and its cached ballots. Computes the
 * "is the close round revealed?" flag by comparing `dateForRound` of the
 * poll's `drandRound` against now — once `dateForRound` is in the past,
 * the tally is meaningful.
 *
 * Tally is recomputed locally from the cached ballots whenever those
 * change. Callers that want a fresh cross-network tally should call
 * `tallyPoll` from `./tally` directly with their live transport.
 */
export function usePoll(pollId: string | null): {
  poll: PollMeta | null;
  ballots: Ballot[];
  tally: Tally | null;
  isRevealed: boolean;
  refresh: () => Promise<void>;
} {
  const [poll, setPoll] = useState<PollMeta | null>(null);
  const [ballots, setBallots] = useState<Ballot[]>([]);
  const [tally, setTally] = useState<Tally | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick once a second so the "is revealed" derived value flips on close.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (!pollId) {
      // Promise-then boundary keeps the setStates outside the synchronous
      // effect body (matches the react-hooks/set-state-in-effect rule the
      // Herald hooks follow).
      return Promise.resolve().then(() => {
        setPoll(null);
        setBallots([]);
        setTally(null);
      });
    }
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return Promise.all([getPoll(pollId), loadBallots(pollId)]).then(
      ([p, bs]) => {
        setPoll(p);
        setBallots(bs);
        if (p) {
          return tallyFromBallots(p, bs).then((t) => {
            setTally(t);
          });
        }
        setTally(null);
      },
    );
  }, [pollId]);

  // Inline load — match Herald's pattern: do the IDB read inside the
  // effect body and only setState inside the `.then` callback. That keeps
  // the setState "outside" the synchronous effect body per the lint rule.
  useEffect(() => {
    let cancelled = false;
    if (!pollId) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setPoll(null);
        setBallots([]);
        setTally(null);
      });
      return () => {
        cancelled = true;
      };
    }
    if (typeof indexedDB === "undefined") return;
    Promise.all([getPoll(pollId), loadBallots(pollId)]).then(([p, bs]) => {
      if (cancelled) return;
      setPoll(p);
      setBallots(bs);
      if (p) {
        tallyFromBallots(p, bs).then((t) => {
          if (cancelled) return;
          setTally(t);
        });
      } else {
        setTally(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pollId]);

  const isRevealed = useMemo<boolean>(() => {
    if (!poll) return false;
    const revealAt = dateForRound(poll.drandRound).getTime();
    return now >= revealAt;
  }, [poll, now]);

  return { poll, ballots, tally, isRevealed, refresh };
}

/* -------------------------------------------------------------------------- */
/* useSubmitBallot                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Seal + publish a ballot for `poll`. The hook reads the active identity
 * via `identity`; the caller is responsible for gating the UI on identity
 * presence.
 *
 * `mySubmittedAt` returns the timestamp of the *local* ballot record (if
 * any), letting the VotePane show "submitted at HH:MM — sealed" once the
 * user has voted.
 */
export function useSubmitBallot(
  transport: AegisTransport | null,
  identity: Identity | null,
  poll: PollMeta | null,
): {
  submit: (optionIndex: number) => Promise<void>;
  isWorking: boolean;
  error: string | null;
  mySubmittedAt: number | null;
  refresh: () => Promise<void>;
} {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mySubmittedAt, setMySubmittedAt] = useState<number | null>(null);

  const myVoter = useMemo<string | null>(
    () => (identity ? signerHexFromIdentity(identity) : null),
    [identity],
  );

  const refresh = useCallback((): Promise<void> => {
    if (!poll || !myVoter) {
      return Promise.resolve().then(() => {
        setMySubmittedAt(null);
      });
    }
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return getBallot(poll.id, myVoter).then((b) => {
      setMySubmittedAt(b ? b.submittedAt : null);
    });
  }, [poll, myVoter]);

  useEffect(() => {
    let cancelled = false;
    if (!poll || !myVoter) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setMySubmittedAt(null);
      });
      return () => {
        cancelled = true;
      };
    }
    if (typeof indexedDB === "undefined") return;
    getBallot(poll.id, myVoter).then((b) => {
      if (cancelled) return;
      setMySubmittedAt(b ? b.submittedAt : null);
    });
    return () => {
      cancelled = true;
    };
  }, [poll, myVoter]);

  const submit = useCallback(
    async (optionIndex: number): Promise<void> => {
      if (!transport) throw new Error("transport not ready");
      if (!identity) throw new Error("identity required");
      if (!poll) throw new Error("poll not loaded");
      if (!myVoter) throw new Error("voter pubkey unavailable");
      if (
        !Number.isInteger(optionIndex) ||
        optionIndex < 0 ||
        optionIndex >= poll.options.length
      ) {
        throw new Error("invalid option");
      }
      if (Date.now() >= poll.closeUnix) {
        throw new Error("poll is closed");
      }
      // If the poll has a whitelist, gate at the client too (the tally
      // will drop non-members anyway — this just gives faster feedback).
      if (poll.voters.length > 0 && !poll.voters.includes(myVoter)) {
        throw new Error("you are not on the voter list for this poll");
      }
      setIsWorking(true);
      setError(null);
      try {
        const nonce = await mintVoteNonce();
        const vote: Vote = {
          pollId: poll.id,
          optionIndex,
          voter: myVoter,
          nonce,
        };
        const sealedB64 = await sealVote(vote, poll.drandRound, identity.seckey);
        const ballot: Ballot = {
          pollId: poll.id,
          voter: myVoter,
          sealedB64,
          submittedAt: Date.now(),
        };
        await persistBallot(ballot);
        setMySubmittedAt(ballot.submittedAt);
        // Tag the published event with `["e", pollId]` so a tallier can
        // filter Nostr replays to just this poll's ballots.
        await transport.publish({
          type: BALLOT_EVENT_TYPE,
          content: ballot,
          tags: [["e", poll.id]],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "failed to submit";
        setError(msg);
        throw err;
      } finally {
        setIsWorking(false);
      }
    },
    [transport, identity, poll, myVoter],
  );

  return { submit, isWorking, error, mySubmittedAt, refresh };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                      */
/* -------------------------------------------------------------------------- */

/** Mint a new poll id. UUID v4 when available, fallback in older runtimes. */
function mintPollId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return (
    Math.random().toString(16).slice(2) +
    "-" +
    Date.now().toString(16) +
    "-" +
    Math.random().toString(16).slice(2)
  );
}

/**
 * Normalize a user-supplied pubkey hex to canonical 64-char lowercase x-only.
 * Accepts 64 hex chars or 66 (SEC1-compressed, parity byte + x). Used by
 * the CreatePollForm voter list input.
 */
export function normalizePubkey(input: string): string {
  const trimmed = input.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error("pubkey must be hex");
  }
  if (trimmed.length === 64) return trimmed.toLowerCase();
  if (trimmed.length === 66) return trimmed.slice(2).toLowerCase();
  throw new Error(`pubkey must be 64 or 66 hex chars (got ${trimmed.length})`);
}

/** True iff `input` is a valid 64- or 66-char hex pubkey. */
export function isValidPubkeyHex(input: string): boolean {
  const trimmed = input.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return false;
  return trimmed.length === 64 || trimmed.length === 66;
}

/** Format a 64-char x-only pubkey as `abcd1234…ef01` (8 + 4 chars). */
export function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}
