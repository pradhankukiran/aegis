import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { concatBytes, utf8Encode } from "./encoding";
import { randomBytes } from "./random";

/**
 * Schnorr non-interactive zero-knowledge proof of knowledge of a discrete log,
 * over secp256k1. Fiat-Shamir transform of the classic Schnorr Σ-protocol.
 *
 *    Public commitment to witness:  P = x · G    (x is the witness scalar)
 *    Prover picks random r,         R = r · G
 *    Challenge:                     e = H(R || P || ctx)
 *    Response:                      s = r + e · x   (mod n)
 *    Verifier checks:               s · G == R + e · P
 *
 * What this proves: whoever produced the proof knew x such that x·G = P,
 * and they did so without revealing x. (Soundness rests on the discrete log
 * problem; zero-knowledge rests on the random oracle model for SHA-256.)
 *
 * Available as a generic primitive — callers can use this to prove
 * knowledge of a witness without revealing it (e.g. proving possession of a
 * passphrase to a server without ever sending the passphrase). The domain
 * tag below scopes proofs to this codebase's protocol space.
 *
 * Why secp256k1: it's already widely deployed (e.g. Bitcoin/Ethereum keys),
 * so adopting it here adds no exotic dependency and reuses well-audited
 * curve code from @noble/curves.
 */

/**
 * Domain-separation tag bound into every Schnorr challenge. Prevents proofs
 * generated for a different protocol or version from being replayed against
 * this one — the verifier hashes the same tag so a mismatched tag yields a
 * different challenge and the proof fails to verify.
 */
const SCHNORR_DOMAIN_TAG = "aegis:schnorr:v=1";

/** Encoded length of a compressed secp256k1 point (the "commitment"). */
export const SCHNORR_POINT_BYTES = 33;
/** Length of a 256-bit scalar (challenge or response). */
export const SCHNORR_SCALAR_BYTES = 32;

/**
 * A non-interactive Schnorr proof. Each field is raw bytes:
 *
 *   commitment — R = r·G, compressed SEC1 (33 bytes)
 *   challenge  — e, big-endian 32 bytes
 *   response   — s, big-endian 32 bytes
 */
export type SchnorrProof = {
  commitment: Uint8Array;
  challenge: Uint8Array;
  response: Uint8Array;
};

/**
 * The secp256k1 group order n. Scalars live in [1, n−1].
 */
const CURVE_ORDER: bigint = secp256k1.Point.Fn.ORDER;

// BigInt constants. Constructed at module load to avoid bigint *literal*
// syntax (which requires ES2020+ and the project's tsconfig still targets
// ES2017 for downlevel-iterable compatibility).
const ZERO = BigInt(0);
const EIGHT = BigInt(8);
const BYTE_MASK = BigInt(0xff);

function bigintToBytes32(x: bigint): Uint8Array {
  const out = new Uint8Array(SCHNORR_SCALAR_BYTES);
  let v = x;
  for (let i = SCHNORR_SCALAR_BYTES - 1; i >= 0; i--) {
    out[i] = Number(v & BYTE_MASK);
    v >>= EIGHT;
  }
  return out;
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let v = ZERO;
  for (let i = 0; i < bytes.length; i++) {
    v = (v << EIGHT) | BigInt(bytes[i]);
  }
  return v;
}

/**
 * Map arbitrary witness bytes to a non-zero scalar mod n.
 * SHA-256 yields a uniformly-distributed 256-bit value; reducing mod n is
 * safe — n is so close to 2^256 that the bias is negligible (<2^−127). On
 * the astronomically unlikely chance of x = 0, we re-hash with a counter.
 */
function witnessToScalar(witness: Uint8Array): bigint {
  // Re-hash with a counter byte if x = 0 (vanishingly unlikely). Bounded loop
  // for static-analysis friendliness; in practice the first iteration always
  // returns since SHA-256 output ≡ 0 (mod n) has probability ~2^-256.
  for (let counter = 0; counter < 256; counter++) {
    const tagged = concatBytes(
      utf8Encode(`${SCHNORR_DOMAIN_TAG}:scalar:${counter}`),
      witness,
    );
    const h = sha256(tagged);
    const x = bytesToBigint(h) % CURVE_ORDER;
    if (x !== ZERO) return x;
  }
  throw new Error("witnessToScalar: exhausted retries (impossible)");
}

/**
 * Compute the public commitment to a witness: P = witnessToScalar(w) · G,
 * encoded as a 33-byte compressed secp256k1 point. This is what the prover
 * publishes once (e.g. baked into a sigil envelope) so the verifier has
 * something to check the proof against.
 */
export function commitmentFromWitness(witness: Uint8Array): Uint8Array {
  const x = witnessToScalar(witness);
  const P = secp256k1.Point.BASE.multiply(x);
  return P.toBytes();
}

/**
 * Hash R, P, and the domain tag into a 256-bit challenge scalar.
 * The challenge MUST cover both points so swapping either invalidates the
 * proof — this is what binds R to P (i.e. prevents an attacker who learned
 * P from forging a proof for a different P').
 */
function challengeScalar(
  R: Uint8Array,
  P: Uint8Array,
): { e: bigint; eBytes: Uint8Array } {
  const tag = utf8Encode(SCHNORR_DOMAIN_TAG);
  const h = sha256(concatBytes(tag, R, P));
  const e = bytesToBigint(h) % CURVE_ORDER;
  return { e, eBytes: bigintToBytes32(e) };
}

/**
 * Produce a Schnorr proof of knowledge of the witness scalar x such that
 * x·G = commitmentFromWitness(witness).
 *
 * Implementation:
 *   1. Map witness bytes → x ∈ [1, n−1].
 *   2. Sample random r ∈ [1, n−1]; compute R = r·G.
 *   3. Compute P = x·G (the public commitment).
 *   4. e = H(SCHNORR_DOMAIN_TAG || R || P) (Fiat–Shamir).
 *   5. s = (r + e·x) mod n.
 *   6. Output {commitment: R, challenge: e, response: s}.
 *
 * Note: r MUST be uniformly random and independent per call. Reusing r
 * across two proofs would leak x via two equations in two unknowns.
 */
export async function proveKnowledge(
  witness: Uint8Array,
): Promise<SchnorrProof> {
  const x = witnessToScalar(witness);
  const P = secp256k1.Point.BASE.multiply(x);
  const PBytes = P.toBytes();

  // Sample r ∈ [1, n−1]. Reject the (vanishing-probability) zero case.
  let r = ZERO;
  while (r === ZERO) {
    const rBytes = await randomBytes(SCHNORR_SCALAR_BYTES);
    r = bytesToBigint(rBytes) % CURVE_ORDER;
  }
  const R = secp256k1.Point.BASE.multiply(r);
  const RBytes = R.toBytes();

  const { e, eBytes } = challengeScalar(RBytes, PBytes);
  const s = (r + e * x) % CURVE_ORDER;

  return {
    commitment: RBytes,
    challenge: eBytes,
    response: bigintToBytes32(s),
  };
}

/**
 * Verify a Schnorr proof against a public commitment P (33-byte compressed
 * secp256k1 point — the value returned by `commitmentFromWitness`).
 *
 * Verifier:
 *   1. Re-derive e = H(SCHNORR_DOMAIN_TAG || R || P).
 *   2. Check s·G == R + e·P.
 *   3. Sanity-check that the challenge in the proof matches e (otherwise
 *      a malformed proof could pass step 2 with a hand-rolled e').
 *
 * Returns false on any malformed input rather than throwing — verifiers
 * typically want a boolean, and exception-on-bad-input is awkward for them.
 */
export function verifyKnowledge(
  proof: SchnorrProof,
  commitment: Uint8Array,
): boolean {
  if (proof.commitment.length !== SCHNORR_POINT_BYTES) return false;
  if (proof.challenge.length !== SCHNORR_SCALAR_BYTES) return false;
  if (proof.response.length !== SCHNORR_SCALAR_BYTES) return false;
  if (commitment.length !== SCHNORR_POINT_BYTES) return false;

  let R, P;
  try {
    R = secp256k1.Point.fromBytes(proof.commitment);
    P = secp256k1.Point.fromBytes(commitment);
  } catch {
    return false;
  }

  const sScalar = bytesToBigint(proof.response) % CURVE_ORDER;
  const eClaimed = bytesToBigint(proof.challenge) % CURVE_ORDER;
  if (sScalar === ZERO) return false;

  // Re-derive the challenge — a forged proof might claim any e, so we must
  // recompute it ourselves and compare.
  const { e: eDerived } = challengeScalar(proof.commitment, commitment);
  if (eClaimed !== eDerived) return false;

  // Verify s·G == R + e·P (using multiplyUnsafe is fine here: the scalars
  // are public and we just need a boolean answer; constant-time isn't a
  // requirement for the verifier).
  const lhs = secp256k1.Point.BASE.multiplyUnsafe(sScalar);
  const rhs = R.add(P.multiplyUnsafe(eDerived));
  return lhs.equals(rhs);
}
