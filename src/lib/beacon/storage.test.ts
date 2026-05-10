/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFakeIdb } from "../atlas/fake-idb.test-helpers";

import {
  clearAllBeacons,
  deleteBeacon,
  loadBeacon,
  loadBeacons,
  saveBeacon,
} from "./storage";
import type { Beacon, BeaconStatus } from "./types";

/**
 * Build a Beacon row. Defaults are sensible for storage tests; individual
 * cases override the fields they care about. We mint random ids inside
 * each call so two `makeBeacon()`s in the same test don't collide.
 */
function makeBeacon(overrides: Partial<Beacon> = {}): Beacon {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "b-" + Math.random().toString(16).slice(2),
    title: "Test beacon",
    payloadCid: "bafy-stub",
    unwrapKeyHex: "ab".repeat(32),
    deadlineUnix: now + 3600,
    graceSeconds: 3600,
    drandRound: 12345,
    checkinIntervalSeconds: 3600,
    timelockedReleasesPublished: false,
    status: "pending" as BeaconStatus,
    lastCheckinUnix: 0,
    createdAt: now,
    ...overrides,
  };
}

describe("beacon / storage", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFakeIdb();
  });

  afterEach(() => {
    restore();
  });

  it("loadBeacons returns [] when nothing is stored", async () => {
    expect(await loadBeacons()).toEqual([]);
  });

  it("loadBeacon returns null for an unknown id", async () => {
    expect(await loadBeacon("missing")).toBeNull();
  });

  it("saveBeacon -> loadBeacon round-trips", async () => {
    const b = makeBeacon({ id: "b1" });
    await saveBeacon(b);
    const got = await loadBeacon("b1");
    expect(got).toEqual(b);
  });

  it("saveBeacon is upsert by id", async () => {
    await saveBeacon(makeBeacon({ id: "b2", title: "v1", status: "pending" }));
    await saveBeacon(makeBeacon({ id: "b2", title: "v2", status: "fired" }));
    const got = await loadBeacon("b2");
    expect(got?.title).toBe("v2");
    expect(got?.status).toBe("fired");
    // Only one row total.
    expect((await loadBeacons()).length).toBe(1);
  });

  it("loadBeacons sorts by deadlineUnix ascending", async () => {
    await saveBeacon(makeBeacon({ id: "later", deadlineUnix: 3000 }));
    await saveBeacon(makeBeacon({ id: "soonest", deadlineUnix: 1000 }));
    await saveBeacon(makeBeacon({ id: "middle", deadlineUnix: 2000 }));
    const list = await loadBeacons();
    expect(list.map((b) => b.id)).toEqual(["soonest", "middle", "later"]);
  });

  it("deleteBeacon removes a row; no-op on missing id", async () => {
    await saveBeacon(makeBeacon({ id: "kill" }));
    await deleteBeacon("kill");
    expect(await loadBeacon("kill")).toBeNull();
    await expect(deleteBeacon("kill")).resolves.toBeUndefined();
  });

  it("clearAllBeacons wipes the store", async () => {
    await saveBeacon(makeBeacon({ id: "a" }));
    await saveBeacon(makeBeacon({ id: "b" }));
    await clearAllBeacons();
    expect(await loadBeacons()).toEqual([]);
  });

  it("preserves all fields verbatim (timelockedReleasesPublished, lastCheckinUnix, etc.)", async () => {
    const b = makeBeacon({
      id: "fields",
      timelockedReleasesPublished: true,
      lastCheckinUnix: 555,
      status: "checked-in",
    });
    await saveBeacon(b);
    const got = await loadBeacon("fields");
    expect(got).toEqual(b);
    expect(got?.timelockedReleasesPublished).toBe(true);
    expect(got?.lastCheckinUnix).toBe(555);
    expect(got?.status).toBe("checked-in");
  });
});
