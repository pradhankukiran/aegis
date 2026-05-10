import { describe, expect, it } from "vitest";

import { shouldFire } from "./trigger-check";
import type { Beacon, BeaconStatus } from "./types";

function makeBeacon(overrides: Partial<Beacon> = {}): Beacon {
  return {
    id: "b1",
    title: "test",
    payloadCid: "bafy",
    unwrapKeyHex: "ab".repeat(32),
    deadlineUnix: 1_000,
    graceSeconds: 3600,
    drandRound: 12345,
    checkinIntervalSeconds: 3600,
    timelockedReleasesPublished: false,
    status: "pending" as BeaconStatus,
    lastCheckinUnix: 0,
    createdAt: 500,
    ...overrides,
  };
}

describe("beacon / shouldFire", () => {
  it("returns false when now is strictly before the deadline", () => {
    const b = makeBeacon({ deadlineUnix: 1000 });
    expect(shouldFire(b, 999)).toBe(false);
  });

  it("returns false at exactly the deadline (boundary is strict `>`)", () => {
    const b = makeBeacon({ deadlineUnix: 1000 });
    expect(shouldFire(b, 1000)).toBe(false);
  });

  it("returns true one second after the deadline", () => {
    const b = makeBeacon({ deadlineUnix: 1000 });
    expect(shouldFire(b, 1001)).toBe(true);
  });

  it("returns true far past the deadline", () => {
    const b = makeBeacon({ deadlineUnix: 1000 });
    expect(shouldFire(b, 1_000_000)).toBe(true);
  });

  it("treats `checked-in` like `pending` (still arms a future fire)", () => {
    const b = makeBeacon({ deadlineUnix: 1000, status: "checked-in" });
    expect(shouldFire(b, 1001)).toBe(true);
    expect(shouldFire(b, 999)).toBe(false);
  });

  it("returns false for a fired beacon, regardless of clock", () => {
    const b = makeBeacon({ deadlineUnix: 1000, status: "fired" });
    expect(shouldFire(b, 999)).toBe(false);
    expect(shouldFire(b, 1001)).toBe(false);
    expect(shouldFire(b, 1_000_000)).toBe(false);
  });

  it("returns false for a cancelled beacon", () => {
    const b = makeBeacon({ deadlineUnix: 1000, status: "cancelled" });
    expect(shouldFire(b, 1001)).toBe(false);
  });

  it("returns false for an expired beacon", () => {
    const b = makeBeacon({ deadlineUnix: 1000, status: "expired" });
    expect(shouldFire(b, 1001)).toBe(false);
  });

  it("uses Date.now()/1000 by default", () => {
    // Construct one well in the past — the default-clock branch should
    // return true. (Tests in the same process can't really pin Date.now,
    // but a deadline of 1 (epoch) is unambiguously past.)
    const b = makeBeacon({ deadlineUnix: 1 });
    expect(shouldFire(b)).toBe(true);
  });

  it("uses Date.now()/1000 by default — future deadline returns false", () => {
    const b = makeBeacon({ deadlineUnix: Math.floor(Date.now() / 1000) + 86_400 });
    expect(shouldFire(b)).toBe(false);
  });
});
