/**
 * @vitest-environment happy-dom
 *
 * Quorum — IndexedDB persistence tests. Exercises both stores
 * (`polls` keyed on `id`, `ballots` keyed on `[pollId, voter]` with a
 * `by-poll` index) through their public CRUD surface.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFakeIdb } from "./fake-idb.test-helpers";
import {
  clearAll,
  getBallot,
  getPoll,
  loadBallots,
  loadPolls,
  saveBallot,
  savePoll,
} from "./poll-store";
import type { Ballot, PollMeta } from "./types";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const OWNER = "1".repeat(64);

function makePoll(over: Partial<PollMeta> = {}): PollMeta {
  return {
    id: "poll-1",
    title: "what's for lunch?",
    options: ["pizza", "salad", "tacos"],
    voters: [],
    closeUnix: 2_000_000_000_000,
    drandRound: 1_000_000,
    owner: OWNER,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function makeBallot(over: Partial<Ballot> = {}): Ballot {
  return {
    pollId: "poll-1",
    voter: ALICE,
    sealedB64: "AAAA",
    submittedAt: 1_700_000_100_000,
    ...over,
  };
}

describe("quorum / poll-store (polls)", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFakeIdb();
  });

  afterEach(async () => {
    try {
      await clearAll();
    } catch {
      /* nothing stored yet */
    }
    restore();
  });

  it("loadPolls returns [] when nothing stored", async () => {
    expect(await loadPolls()).toEqual([]);
  });

  it("savePoll → getPoll round-trips", async () => {
    const p = makePoll({ id: "p-abc", title: "hello" });
    await savePoll(p);
    const got = await getPoll("p-abc");
    expect(got).toEqual(p);
  });

  it("loadPolls returns every stored poll", async () => {
    await savePoll(makePoll({ id: "p-1" }));
    await savePoll(makePoll({ id: "p-2", title: "second" }));
    const list = await loadPolls();
    expect(list).toHaveLength(2);
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get("p-1")?.title).toBe("what's for lunch?");
    expect(byId.get("p-2")?.title).toBe("second");
  });

  it("savePoll on an existing id overwrites in place", async () => {
    await savePoll(makePoll({ id: "p-x", title: "old" }));
    await savePoll(makePoll({ id: "p-x", title: "new" }));
    const got = await getPoll("p-x");
    expect(got?.title).toBe("new");
    const list = await loadPolls();
    expect(list.filter((p) => p.id === "p-x")).toHaveLength(1);
  });

  it("getPoll returns null for unknown ids", async () => {
    expect(await getPoll("nope")).toBeNull();
  });
});

describe("quorum / poll-store (ballots)", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFakeIdb();
  });

  afterEach(async () => {
    try {
      await clearAll();
    } catch {
      /* nothing stored yet */
    }
    restore();
  });

  it("saveBallot → getBallot round-trips on [pollId, voter]", async () => {
    const b = makeBallot({ pollId: "p-1", voter: ALICE, sealedB64: "XYZ" });
    await saveBallot(b);
    const got = await getBallot("p-1", ALICE);
    expect(got).toEqual(b);
  });

  it("getBallot returns null when the voter hasn't submitted", async () => {
    expect(await getBallot("p-1", ALICE)).toBeNull();
  });

  it("saveBallot on the same (pollId, voter) overwrites the prior entry", async () => {
    await saveBallot(makeBallot({ sealedB64: "first", submittedAt: 1 }));
    await saveBallot(makeBallot({ sealedB64: "second", submittedAt: 2 }));
    const got = await getBallot("poll-1", ALICE);
    expect(got?.sealedB64).toBe("second");
    expect(got?.submittedAt).toBe(2);
    const all = await loadBallots("poll-1");
    expect(all.filter((b) => b.voter === ALICE)).toHaveLength(1);
  });

  it("ballots for different voters in the same poll coexist", async () => {
    await saveBallot(makeBallot({ pollId: "p-1", voter: ALICE, sealedB64: "A" }));
    await saveBallot(makeBallot({ pollId: "p-1", voter: BOB, sealedB64: "B" }));
    const all = await loadBallots("p-1");
    expect(all).toHaveLength(2);
    const byVoter = new Map(all.map((b) => [b.voter, b]));
    expect(byVoter.get(ALICE)?.sealedB64).toBe("A");
    expect(byVoter.get(BOB)?.sealedB64).toBe("B");
  });

  it("loadBallots filters by pollId via the `by-poll` index", async () => {
    await saveBallot(makeBallot({ pollId: "p-1", voter: ALICE }));
    await saveBallot(makeBallot({ pollId: "p-2", voter: ALICE }));
    await saveBallot(makeBallot({ pollId: "p-1", voter: BOB }));
    const p1 = await loadBallots("p-1");
    expect(p1).toHaveLength(2);
    const p2 = await loadBallots("p-2");
    expect(p2).toHaveLength(1);
    expect(p2[0].voter).toBe(ALICE);
  });

  it("loadBallots returns [] for a poll with no ballots", async () => {
    await saveBallot(makeBallot({ pollId: "p-other", voter: ALICE }));
    expect(await loadBallots("p-empty")).toEqual([]);
  });
});
