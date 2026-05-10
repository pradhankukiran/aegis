import { describe, expect, it } from "vitest";

import { generateIdentity } from "../identity";

import {
  cancellationDigest,
  signCancellation,
  signerHexFromIdentity,
  verifyCancellation,
} from "./cancel";

describe("beacon / cancellation signature", () => {
  it("signCancellation produces a payload that verifies", async () => {
    const id = await generateIdentity();
    const payload = signCancellation(id, "beacon-xyz", 1_700_000_000);
    expect(payload.beaconId).toBe("beacon-xyz");
    expect(payload.ts).toBe(1_700_000_000);
    expect(payload.signerHex).toBe(signerHexFromIdentity(id));
    expect(payload.sigHex).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyCancellation(payload)).toBe(true);
  });

  it("verifyCancellation rejects when ts is altered", async () => {
    const id = await generateIdentity();
    const payload = signCancellation(id, "beacon-xyz", 1_700_000_000);
    expect(verifyCancellation({ ...payload, ts: 1_700_000_001 })).toBe(false);
  });

  it("verifyCancellation rejects when beaconId is altered", async () => {
    const id = await generateIdentity();
    const payload = signCancellation(id, "beacon-xyz", 1_700_000_000);
    expect(
      verifyCancellation({ ...payload, beaconId: "different-id" }),
    ).toBe(false);
  });

  it("verifyCancellation rejects when signerHex is altered (different identity claim)", async () => {
    const idA = await generateIdentity();
    const idB = await generateIdentity();
    const payload = signCancellation(idA, "b1", 100);
    expect(
      verifyCancellation({
        ...payload,
        signerHex: signerHexFromIdentity(idB),
      }),
    ).toBe(false);
  });

  it("verifyCancellation rejects a malformed sigHex (wrong length)", async () => {
    const id = await generateIdentity();
    const payload = signCancellation(id, "b1", 100);
    expect(verifyCancellation({ ...payload, sigHex: "abcd" })).toBe(false);
  });

  it("verifyCancellation rejects a non-hex sigHex", async () => {
    const id = await generateIdentity();
    const payload = signCancellation(id, "b1", 100);
    expect(verifyCancellation({ ...payload, sigHex: "z".repeat(128) })).toBe(
      false,
    );
  });

  it("verifyCancellation rejects a malformed signerHex", async () => {
    const id = await generateIdentity();
    const payload = signCancellation(id, "b1", 100);
    expect(
      verifyCancellation({ ...payload, signerHex: "g".repeat(64) }),
    ).toBe(false);
  });

  it("cancellationDigest is deterministic for the same inputs", () => {
    const a = cancellationDigest("id-1", 12345);
    const b = cancellationDigest("id-1", 12345);
    expect(a).toEqual(b);
  });

  it("cancellationDigest differs for different beaconIds", () => {
    const a = cancellationDigest("id-1", 12345);
    const b = cancellationDigest("id-2", 12345);
    expect(a).not.toEqual(b);
  });

  it("cancellationDigest differs for different timestamps", () => {
    const a = cancellationDigest("id-1", 12345);
    const b = cancellationDigest("id-1", 99999);
    expect(a).not.toEqual(b);
  });

  it("signerHexFromIdentity returns the 32-byte x-only form", async () => {
    const id = await generateIdentity();
    const hex = signerHexFromIdentity(id);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
