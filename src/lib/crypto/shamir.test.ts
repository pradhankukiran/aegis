import { describe, expect, it } from "vitest";

import { generateSymmetricKey } from "./symmetric";
import { combineShares, splitSecret } from "./shamir";

describe("shamir", () => {
  it("3-of-5 round-trips a symmetric key with any 3 of 5 shares", async () => {
    const secret = await generateSymmetricKey();
    const shares = await splitSecret(secret, { shares: 5, threshold: 3 });
    expect(shares).toHaveLength(5);

    const combos = [
      [0, 1, 2],
      [0, 2, 4],
      [1, 3, 4],
      [2, 3, 4],
    ];
    for (const idxs of combos) {
      const subset = idxs.map((i) => shares[i]);
      const recovered = await combineShares(subset);
      expect(recovered).toEqual(secret);
    }
  });

  it("any K of N reconstructs identically", async () => {
    const secret = new TextEncoder().encode("seal me");
    const shares = await splitSecret(secret, { shares: 4, threshold: 2 });
    const a = await combineShares([shares[0], shares[2]]);
    const b = await combineShares([shares[1], shares[3]]);
    expect(a).toEqual(secret);
    expect(b).toEqual(secret);
  });

  it("rejects threshold > shares", async () => {
    await expect(
      splitSecret(new Uint8Array([1]), { shares: 3, threshold: 5 }),
    ).rejects.toThrow();
  });

  it("rejects fewer than two shares passed to combine", async () => {
    const shares = await splitSecret(new Uint8Array([1, 2, 3]), {
      shares: 3,
      threshold: 2,
    });
    await expect(combineShares([shares[0]])).rejects.toThrow();
  });
});
