import { combine as ssCombine, split as ssSplit } from "shamir-secret-sharing";

/**
 * Shamir's Secret Sharing — split a secret into N shares such that any K
 * of them can reconstruct it, while fewer than K shares reveal nothing.
 *
 * Used for Switch mode (dead-man's switch): the symmetric key encrypting
 * the user's content is split across N trustees, with threshold K. The
 * server never holds any share — they're emailed to trustees at creation
 * time and entered back by trustees when the switch fires.
 *
 * Library: shamir-secret-sharing (TypeScript impl over GF(256)).
 *  - secret must be at least 1 byte
 *  - shares and threshold must be in [2, 255]
 *  - each share is `secret.length + 1` bytes
 */

export const MIN_SHARES = 2;
export const MAX_SHARES = 255;

export type SplitOptions = {
  shares: number; // N
  threshold: number; // K
};

export async function splitSecret(
  secret: Uint8Array,
  options: SplitOptions,
): Promise<Uint8Array[]> {
  const { shares, threshold } = options;
  if (
    shares < MIN_SHARES ||
    shares > MAX_SHARES ||
    threshold < MIN_SHARES ||
    threshold > MAX_SHARES
  ) {
    throw new Error(
      `splitSecret: shares and threshold must be in [${MIN_SHARES}, ${MAX_SHARES}]`,
    );
  }
  if (threshold > shares) {
    throw new Error("splitSecret: threshold cannot exceed shares");
  }
  return ssSplit(secret, shares, threshold);
}

export async function combineShares(
  shares: Uint8Array[],
): Promise<Uint8Array> {
  if (shares.length < MIN_SHARES) {
    throw new Error("combineShares: need at least 2 shares");
  }
  return ssCombine(shares);
}
