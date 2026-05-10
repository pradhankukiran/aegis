/**
 * @vitest-environment happy-dom
 *
 * Atlas — circle-store unit tests. Covers basic CRUD plus the cross-store
 * side effect on `deleteMember` (it sweeps positions belonging to the
 * removed peer).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFakeIdb } from "./fake-idb.test-helpers";
import {
  deleteMember,
  getMember,
  loadCircle,
  putMember,
} from "./circle-store";
import { appendFix, listFixesForMember } from "./position-store";
import { clearAll } from "./idb";
import type { CircleMember } from "./types";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function makeMember(over: Partial<CircleMember> = {}): CircleMember {
  return {
    pubkey: ALICE,
    nickname: undefined,
    addedAt: Date.now(),
    ...over,
  };
}

describe("atlas / circle-store", () => {
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

  it("loadCircle returns [] when nothing is stored", async () => {
    expect(await loadCircle()).toEqual([]);
  });

  it("putMember → getMember round-trips", async () => {
    const m = makeMember({ nickname: "Alice", addedAt: 1000 });
    await putMember(m);
    const got = await getMember(ALICE);
    expect(got).toEqual(m);
  });

  it("loadCircle returns every stored member", async () => {
    await putMember(makeMember({ pubkey: ALICE, addedAt: 100 }));
    await putMember(makeMember({ pubkey: BOB, addedAt: 200 }));
    const list = await loadCircle();
    const byKey = new Map(list.map((c) => [c.pubkey, c] as const));
    expect(byKey.size).toBe(2);
    expect(byKey.get(ALICE)?.addedAt).toBe(100);
    expect(byKey.get(BOB)?.addedAt).toBe(200);
  });

  it("putMember on an existing pubkey overwrites in place", async () => {
    await putMember(makeMember({ pubkey: ALICE, nickname: "old", addedAt: 1 }));
    await putMember(makeMember({ pubkey: ALICE, nickname: "new", addedAt: 2 }));
    const got = await getMember(ALICE);
    expect(got?.nickname).toBe("new");
    expect(got?.addedAt).toBe(2);
    const list = await loadCircle();
    expect(list.filter((m) => m.pubkey === ALICE)).toHaveLength(1);
  });

  it("deleteMember removes the row", async () => {
    await putMember(makeMember({ pubkey: ALICE }));
    await deleteMember(ALICE);
    expect(await getMember(ALICE)).toBeNull();
  });

  it("deleteMember is idempotent on unknown pubkeys", async () => {
    await expect(deleteMember(ALICE)).resolves.toBeUndefined();
  });

  it("deleteMember also wipes the peer's stored positions", async () => {
    await putMember(makeMember({ pubkey: ALICE }));
    await putMember(makeMember({ pubkey: BOB }));
    await appendFix(ALICE, { lat: 1, lon: 2, accuracy: 5, ts: 1000 });
    await appendFix(ALICE, { lat: 1.1, lon: 2.1, accuracy: 5, ts: 2000 });
    await appendFix(BOB, { lat: 3, lon: 4, accuracy: 5, ts: 1500 });

    await deleteMember(ALICE);

    // Alice's positions should be gone; Bob's untouched.
    expect(await listFixesForMember(ALICE)).toEqual([]);
    const bobFixes = await listFixesForMember(BOB);
    expect(bobFixes).toHaveLength(1);
    expect(bobFixes[0].from).toBe(BOB);
  });
});
