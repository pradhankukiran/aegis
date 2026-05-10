import { describe, expect, it } from "vitest";

import { utf8Encode } from "./encoding";
import {
  SCHNORR_POINT_BYTES,
  SCHNORR_SCALAR_BYTES,
  commitmentFromWitness,
  proveKnowledge,
  verifyKnowledge,
} from "./schnorr";

describe("schnorr (proof-of-knowledge over secp256k1)", () => {
  it("commitmentFromWitness produces a 33-byte compressed point", () => {
    const witness = utf8Encode("the moon is blue");
    const P = commitmentFromWitness(witness);
    expect(P).toBeInstanceOf(Uint8Array);
    expect(P.length).toBe(SCHNORR_POINT_BYTES);
    // First byte of a compressed point is 0x02 or 0x03 (parity prefix).
    expect([0x02, 0x03]).toContain(P[0]);
  });

  it("commitment is deterministic for the same witness", () => {
    const w = utf8Encode("hello");
    expect(commitmentFromWitness(w)).toEqual(commitmentFromWitness(w));
  });

  it("commitment differs for different witnesses", () => {
    const a = commitmentFromWitness(utf8Encode("answer A"));
    const b = commitmentFromWitness(utf8Encode("answer B"));
    expect(a).not.toEqual(b);
  });

  it("proof has the documented field shapes", async () => {
    const witness = utf8Encode("knowing-the-passphrase");
    const proof = await proveKnowledge(witness);
    expect(proof.commitment.length).toBe(SCHNORR_POINT_BYTES);
    expect(proof.challenge.length).toBe(SCHNORR_SCALAR_BYTES);
    expect(proof.response.length).toBe(SCHNORR_SCALAR_BYTES);
  });

  it("round-trip: proveKnowledge -> verifyKnowledge with matching commitment succeeds", async () => {
    const witness = utf8Encode("the moon is blue");
    const P = commitmentFromWitness(witness);
    const proof = await proveKnowledge(witness);
    expect(verifyKnowledge(proof, P)).toBe(true);
  });

  it("verification fails when the wrong witness's commitment is used", async () => {
    const right = utf8Encode("right answer");
    const wrong = utf8Encode("wrong answer");
    const proof = await proveKnowledge(right);
    const wrongP = commitmentFromWitness(wrong);
    expect(verifyKnowledge(proof, wrongP)).toBe(false);
  });

  it("verification fails when a proof for one witness is checked against another's commitment", async () => {
    const witnessA = utf8Encode("alice's secret");
    const witnessB = utf8Encode("bob's secret");
    const proofA = await proveKnowledge(witnessA);
    const PB = commitmentFromWitness(witnessB);
    expect(verifyKnowledge(proofA, PB)).toBe(false);
  });

  it("verification fails on tampered challenge", async () => {
    const witness = utf8Encode("witness-x");
    const P = commitmentFromWitness(witness);
    const proof = await proveKnowledge(witness);
    proof.challenge[0] ^= 0x01;
    expect(verifyKnowledge(proof, P)).toBe(false);
  });

  it("verification fails on tampered response", async () => {
    const witness = utf8Encode("witness-y");
    const P = commitmentFromWitness(witness);
    const proof = await proveKnowledge(witness);
    proof.response[10] ^= 0x80;
    expect(verifyKnowledge(proof, P)).toBe(false);
  });

  it("verification fails on tampered commitment R", async () => {
    const witness = utf8Encode("witness-z");
    const P = commitmentFromWitness(witness);
    const proof = await proveKnowledge(witness);
    proof.commitment[5] ^= 0x10;
    expect(verifyKnowledge(proof, P)).toBe(false);
  });

  it("verification rejects malformed inputs without throwing", async () => {
    const witness = utf8Encode("ok");
    const P = commitmentFromWitness(witness);
    const proof = await proveKnowledge(witness);
    expect(verifyKnowledge(proof, new Uint8Array(10))).toBe(false);
    expect(
      verifyKnowledge(
        { ...proof, commitment: new Uint8Array(5) },
        P,
      ),
    ).toBe(false);
  });

  it("two proofs of the same witness use different randomness (commitments differ)", async () => {
    const witness = utf8Encode("same witness");
    const proof1 = await proveKnowledge(witness);
    const proof2 = await proveKnowledge(witness);
    expect(proof1.commitment).not.toEqual(proof2.commitment);
    // But both must verify against the same public commitment.
    const P = commitmentFromWitness(witness);
    expect(verifyKnowledge(proof1, P)).toBe(true);
    expect(verifyKnowledge(proof2, P)).toBe(true);
  });
});
