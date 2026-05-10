/**
 * @vitest-environment happy-dom
 *
 * Atlas — position-store unit tests. Covers:
 *   - basic append + read round-trip
 *   - per-peer scoping (one peer's fixes don't leak into another's reads)
 *   - the FIFO cap at MAX_POSITIONS_PER_MEMBER
 *   - latestForMember / latestFixesByMember derived getters
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFakeIdb } from "./fake-idb.test-helpers";
import {
  appendFix,
  latestForMember,
  latestFixesByMember,
  listFixesForMember,
  MAX_POSITIONS_PER_MEMBER,
} from "./position-store";
import { clearAll } from "./idb";
import type { PositionFix } from "./types";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function fix(over: Partial<PositionFix> & { ts: number }): PositionFix {
  return {
    lat: 12.34,
    lon: 56.78,
    accuracy: 10,
    ...over,
  };
}

describe("atlas / position-store", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFakeIdb();
  });

  afterEach(async () => {
    try {
      await clearAll();
    } catch {
      /* nothing stored */
    }
    restore();
  });

  it("listFixesForMember returns [] when nothing is stored", async () => {
    expect(await listFixesForMember(ALICE)).toEqual([]);
    expect(await latestForMember(ALICE)).toBeNull();
  });

  it("appendFix → listFixesForMember round-trips, sorted ascending by ts", async () => {
    await appendFix(ALICE, fix({ ts: 300, lat: 3 }));
    await appendFix(ALICE, fix({ ts: 100, lat: 1 }));
    await appendFix(ALICE, fix({ ts: 200, lat: 2 }));
    const list = await listFixesForMember(ALICE);
    expect(list.map((f) => f.ts)).toEqual([100, 200, 300]);
    expect(list.map((f) => f.lat)).toEqual([1, 2, 3]);
    expect(list.every((f) => f.from === ALICE)).toBe(true);
  });

  it("listFixesForMember scopes results to the requested peer", async () => {
    await appendFix(ALICE, fix({ ts: 100, lat: 1 }));
    await appendFix(BOB, fix({ ts: 200, lat: 9 }));
    await appendFix(ALICE, fix({ ts: 300, lat: 3 }));
    const a = await listFixesForMember(ALICE);
    const b = await listFixesForMember(BOB);
    expect(a.map((f) => f.lat)).toEqual([1, 3]);
    expect(b.map((f) => f.lat)).toEqual([9]);
  });

  it("appendFix caps stored fixes at MAX_POSITIONS_PER_MEMBER (FIFO)", async () => {
    const N = MAX_POSITIONS_PER_MEMBER;
    // Insert N + 5 fixes; the oldest 5 should be evicted.
    for (let i = 0; i < N + 5; i += 1) {
      await appendFix(ALICE, fix({ ts: i + 1, lat: i + 1 }));
    }
    const list = await listFixesForMember(ALICE);
    expect(list).toHaveLength(N);
    expect(list[0].ts).toBe(6); // first 5 evicted
    expect(list[list.length - 1].ts).toBe(N + 5);
  });

  it("appendFix on an existing (from, ts) overwrites without eviction", async () => {
    await appendFix(ALICE, fix({ ts: 1, lat: 1 }));
    await appendFix(ALICE, fix({ ts: 2, lat: 2 }));
    await appendFix(ALICE, fix({ ts: 2, lat: 99 })); // duplicate ts
    const list = await listFixesForMember(ALICE);
    expect(list).toHaveLength(2);
    expect(list.find((f) => f.ts === 2)?.lat).toBe(99);
  });

  it("latestForMember returns the newest fix", async () => {
    await appendFix(ALICE, fix({ ts: 100, lat: 1 }));
    await appendFix(ALICE, fix({ ts: 300, lat: 3 }));
    await appendFix(ALICE, fix({ ts: 200, lat: 2 }));
    const latest = await latestForMember(ALICE);
    expect(latest?.ts).toBe(300);
    expect(latest?.lat).toBe(3);
    expect(latest?.from).toBe(ALICE);
  });

  it("latestFixesByMember returns the newest fix per peer", async () => {
    await appendFix(ALICE, fix({ ts: 100, lat: 1 }));
    await appendFix(ALICE, fix({ ts: 200, lat: 2 }));
    await appendFix(BOB, fix({ ts: 150, lat: 5 }));
    const map = await latestFixesByMember();
    expect(Object.keys(map).sort()).toEqual([ALICE, BOB].sort());
    expect(map[ALICE].ts).toBe(200);
    expect(map[BOB].ts).toBe(150);
  });

  it("latestFixesByMember returns {} when nothing is stored", async () => {
    expect(await latestFixesByMember()).toEqual({});
  });
});
