/**
 * @vitest-environment happy-dom
 *
 * Quorum — seal/unseal round-trip tests.
 *
 * We mock `@/lib/crypto/timelock` so encryption/decryption is a fixed,
 * deterministic transform that doesn't hit the drand HTTP endpoint. The
 * point of these tests is the *signing-then-sealing* protocol on top of
 * tlock-js — does the embedded signature verify? does a tampered ballot
 * fail? does the wrong-poll case get rejected? — not tlock itself, which
 * is exercised live by Hermetic.
 *
 * Mock contract:
 *   - `timelockEncryptBytes(bytes, round)` returns the ASCII string
 *     `"tlock|<round>|<base64url(bytes)>"`.
 *   - `timelockDecryptString(str)` reverses that, returning the original
 *     bytes when the prefix matches and throwing otherwise (so the unseal
 *     fail-path test still works).
 *
 * The mock is set up via `vi.hoisted` so it's installed before the
 * modules under test import their dependencies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  utf8Decode,
  utf8Encode,
} from "../crypto/encoding";

const TLOCK_PREFIX = "tlock|";

vi.mock("../crypto/timelock", () => {
  return {
    DRAND_CHAIN_HASH: "mock-chain-hash",
    DRAND_PERIOD_SECONDS: 3,
    DRAND_GENESIS_SECONDS: 0,
    roundForDate: (d: Date): number => Math.floor(d.getTime() / 1000),
    dateForRound: (round: number): Date => new Date(round * 1000),
    timelockEncryptBytes: async (
      bytes: Uint8Array,
      round: number,
    ): Promise<string> => {
      return `${TLOCK_PREFIX}${round}|${bytesToBase64Url(bytes)}`;
    },
    timelockDecryptString: async (str: string): Promise<Uint8Array> => {
      if (!str.startsWith(TLOCK_PREFIX)) {
        throw new Error("mock tlock: bad prefix");
      }
      const rest = str.slice(TLOCK_PREFIX.length);
      const sep = rest.indexOf("|");
      if (sep === -1) throw new Error("mock tlock: malformed");
      const b64 = rest.slice(sep + 1);
      return base64UrlToBytes(b64);
    },
  };
});

// Static import after the mock is registered. `vi.hoisted` would also
// work but the mock above is sufficient — vitest hoists `vi.mock` calls
// to the top of the module automatically.
import { mintVoteNonce, sealVote, voteDigest } from "./seal";
import { unsealVote } from "./unseal";
import type { Vote } from "./types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function makeIdentity(): { seckey: Uint8Array; voterHex: string } {
  // Deterministic-ish seckey via a fixed seed. secp256k1 accepts any 32-byte
  // scalar in [1, n-1]; this one falls comfortably in range.
  const seckey = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) seckey[i] = i + 1;
  const compressed = secp256k1.getPublicKey(seckey, true);
  const xOnly = compressed.subarray(1); // strip SEC1 parity byte
  return { seckey, voterHex: bytesToHex(xOnly) };
}

const POLL_ID = "poll-test-1";
const DRAND_ROUND = 1234567;

async function makeVote(over: Partial<Vote> = {}): Promise<Vote> {
  const { voterHex } = makeIdentity();
  return {
    pollId: POLL_ID,
    optionIndex: 0,
    voter: voterHex,
    nonce: await mintVoteNonce(),
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("quorum / seal", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("voteDigest is deterministic for the same vote", async () => {
    const v = await makeVote();
    const d1 = voteDigest(v);
    const d2 = voteDigest(v);
    expect(bytesToHex(d1)).toBe(bytesToHex(d2));
    expect(d1.length).toBe(32);
  });

  it("voteDigest differs when optionIndex changes", async () => {
    const v1 = await makeVote({ optionIndex: 0 });
    const v2 = { ...v1, optionIndex: 1 };
    expect(bytesToHex(voteDigest(v1))).not.toBe(bytesToHex(voteDigest(v2)));
  });

  it("mintVoteNonce produces unique 32-hex-char nonces", async () => {
    const a = await mintVoteNonce();
    const b = await mintVoteNonce();
    expect(a).not.toBe(b);
    expect(/^[0-9a-f]{32}$/.test(a)).toBe(true);
    expect(/^[0-9a-f]{32}$/.test(b)).toBe(true);
  });

  it("seal → unseal round-trips a valid vote", async () => {
    const { seckey, voterHex } = makeIdentity();
    const vote = await makeVote({ voter: voterHex });
    const sealedB64 = await sealVote(vote, DRAND_ROUND, seckey);
    expect(typeof sealedB64).toBe("string");
    expect(sealedB64.length).toBeGreaterThan(0);

    const recovered = await unsealVote(sealedB64, DRAND_ROUND);
    expect(recovered).not.toBeNull();
    expect(recovered!.pollId).toBe(vote.pollId);
    expect(recovered!.optionIndex).toBe(vote.optionIndex);
    expect(recovered!.voter).toBe(vote.voter);
    expect(recovered!.nonce).toBe(vote.nonce);
  });

  it("sealVote rejects non-integer optionIndex", async () => {
    const { seckey, voterHex } = makeIdentity();
    const vote = await makeVote({ voter: voterHex, optionIndex: 1.5 as number });
    await expect(sealVote(vote, DRAND_ROUND, seckey)).rejects.toThrow();
  });

  it("sealVote rejects a seckey of the wrong length", async () => {
    const vote = await makeVote();
    await expect(sealVote(vote, DRAND_ROUND, new Uint8Array(16))).rejects.toThrow();
  });

  it("unsealVote returns null on a malformed base64", async () => {
    const result = await unsealVote("not-a-real-sealed-payload!!", DRAND_ROUND);
    expect(result).toBeNull();
  });

  it("unsealVote returns null when the embedded signature is forged", async () => {
    const { seckey, voterHex } = makeIdentity();
    const vote = await makeVote({ voter: voterHex });
    const sealedB64 = await sealVote(vote, DRAND_ROUND, seckey);

    // Tamper with the inner payload: claim a different voter pubkey
    // (one that didn't produce the signature). The sealed payload still
    // decrypts (the mocked tlock just unwraps), but the signature check
    // inside unsealVote sees a mismatch between sig and voter.
    const armored = utf8Decode(base64UrlToBytes(sealedB64));
    const rest = armored.slice(TLOCK_PREFIX.length);
    const sep = rest.indexOf("|");
    const innerBytes = base64UrlToBytes(rest.slice(sep + 1));
    const inner = JSON.parse(utf8Decode(innerBytes));
    inner.vote.voter = "f".repeat(64); // wrong pubkey
    const tamperedInner = utf8Encode(JSON.stringify(inner));
    const tamperedArmored =
      TLOCK_PREFIX + DRAND_ROUND + "|" + bytesToBase64Url(tamperedInner);
    const tamperedSealedB64 = bytesToBase64Url(utf8Encode(tamperedArmored));

    const recovered = await unsealVote(tamperedSealedB64, DRAND_ROUND);
    expect(recovered).toBeNull();
  });

  it("unsealVote returns null when optionIndex is tampered post-sign", async () => {
    const { seckey, voterHex } = makeIdentity();
    const vote = await makeVote({ voter: voterHex, optionIndex: 0 });
    const sealedB64 = await sealVote(vote, DRAND_ROUND, seckey);

    // Same surgery — flip optionIndex but leave the sig intact. The sig
    // was over the original (option=0); changing it to 1 makes the
    // signature no longer cover the new digest.
    const armored = utf8Decode(base64UrlToBytes(sealedB64));
    const rest = armored.slice(TLOCK_PREFIX.length);
    const sep = rest.indexOf("|");
    const innerBytes = base64UrlToBytes(rest.slice(sep + 1));
    const inner = JSON.parse(utf8Decode(innerBytes));
    inner.vote.optionIndex = 1;
    const tamperedArmored =
      TLOCK_PREFIX +
      DRAND_ROUND +
      "|" +
      bytesToBase64Url(utf8Encode(JSON.stringify(inner)));
    const tamperedSealedB64 = bytesToBase64Url(utf8Encode(tamperedArmored));

    const recovered = await unsealVote(tamperedSealedB64, DRAND_ROUND);
    expect(recovered).toBeNull();
  });

  it("unsealVote returns null when the inner version disagrees", async () => {
    const { seckey, voterHex } = makeIdentity();
    const vote = await makeVote({ voter: voterHex });
    const sealedB64 = await sealVote(vote, DRAND_ROUND, seckey);

    const armored = utf8Decode(base64UrlToBytes(sealedB64));
    const rest = armored.slice(TLOCK_PREFIX.length);
    const sep = rest.indexOf("|");
    const innerBytes = base64UrlToBytes(rest.slice(sep + 1));
    const inner = JSON.parse(utf8Decode(innerBytes));
    inner.v = 999; // future / unsupported version
    const bumped =
      TLOCK_PREFIX +
      DRAND_ROUND +
      "|" +
      bytesToBase64Url(utf8Encode(JSON.stringify(inner)));
    const bumpedB64 = bytesToBase64Url(utf8Encode(bumped));

    expect(await unsealVote(bumpedB64, DRAND_ROUND)).toBeNull();
  });

  it("seal output differs across two votes with different nonces", async () => {
    const { seckey, voterHex } = makeIdentity();
    const v1 = await makeVote({ voter: voterHex, nonce: "0".repeat(32) });
    const v2 = await makeVote({ voter: voterHex, nonce: "f".repeat(32) });
    const s1 = await sealVote(v1, DRAND_ROUND, seckey);
    const s2 = await sealVote(v2, DRAND_ROUND, seckey);
    expect(s1).not.toBe(s2);
  });
});
