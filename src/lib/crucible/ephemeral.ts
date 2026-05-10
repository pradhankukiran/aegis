/**
 * Crucible — one-shot ephemeral keypair generation for the source side.
 *
 * # Why a separate "ephemeral" function
 *
 * The standard `lib/identity/generateIdentity` is the right primitive for
 * the persistent Aegis identity, but it returns the same `Identity` shape
 * the rest of Aegis expects (`createdAt`, pubkey-as-compressed-33-byte).
 * Crucible needs a smaller, in-memory-only shape that is *guaranteed* to
 * never reach IDB.
 *
 *   - `generateEphemeralIdentity()` returns `{pubkey, seckey}` — NO
 *     `createdAt`, no persistence hooks, no Identity-typed return that
 *     might accidentally flow into `saveIdentity`.
 *
 * The caller is contractually responsible for zeroing `seckey` after use.
 * The submit pipeline in `submit.ts` does this in a `finally` block on
 * both success and error paths, so a thrown Pinata error or transport
 * failure still scrubs the secret.
 *
 * # Memory hygiene
 *
 * `seckey.fill(0)` overwrites every byte of the backing buffer in place.
 * JS engines can still hold a copy of the original bytes in past stack
 * frames / garbage-collectable buffers — we cannot defeat the engine —
 * but zeroing the only authoritative reference is the standard practical
 * mitigation. Doing it in a finally block makes the guarantee defensible
 * in a code review.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { randomBytes } from "../crypto/random";

/** Length of a secp256k1 secret scalar. */
export const EPHEMERAL_SECKEY_BYTES = 32;
/** Length of a compressed secp256k1 public point (SEC1: 0x02/0x03 prefix + x). */
export const EPHEMERAL_PUBKEY_BYTES = 33;

/**
 * One-shot ephemeral keypair. Stays in memory; never touches IDB.
 *
 *  - `pubkey`  33-byte SEC1-compressed point (parity prefix + x-coord)
 *  - `seckey`  32-byte scalar
 *
 * Deliberately NOT named `Identity` so a developer typing `ephemeral`
 * cannot tab-complete it into a function that expects the persistent
 * Aegis identity.
 */
export type EphemeralIdentity = {
  pubkey: Uint8Array;
  seckey: Uint8Array;
};

/**
 * Generate a fresh ephemeral keypair. Source side ONLY — every call mints
 * a new throwaway identity for a single drop. Returns the keypair to the
 * caller, who must `seckey.fill(0)` after the drop is published.
 */
export async function generateEphemeralIdentity(): Promise<EphemeralIdentity> {
  const seckey = await randomBytes(EPHEMERAL_SECKEY_BYTES);
  const pubkey = secp256k1.getPublicKey(seckey, true);
  if (pubkey.length !== EPHEMERAL_PUBKEY_BYTES) {
    throw new Error(
      `generateEphemeralIdentity: unexpected pubkey length ${pubkey.length}`,
    );
  }
  return { pubkey, seckey };
}

/**
 * Best-effort in-place secret wipe. Call this in a `finally` block after
 * the seckey is no longer needed.
 *
 * Returns void; we do NOT return a "did it succeed" boolean because there
 * is nothing the caller can do if it can't (the seckey is already in
 * memory from prior code paths). A no-op on an already-zero buffer.
 */
export function wipeEphemeralSeckey(seckey: Uint8Array): void {
  seckey.fill(0);
}
