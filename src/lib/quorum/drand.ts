/**
 * Quorum — drand quicknet round projection.
 *
 * Mirrors Hermetic Echo's projection exactly: we delegate to
 * `roundForDate` from `@/lib/crypto/timelock`, which itself calls
 * `tlock-js`'s `roundAt(ms, defaultChainInfo)`. The chain info is the
 * shared quicknet (3-second period, BLS12-381) used by Aegis Echo too,
 * so a Quorum ballot timelocked to round N opens on the same network
 * signature as anything else Aegis seals. Don't introduce a different
 * chain hash here.
 *
 * # Why a separate file, given it's a one-liner?
 *
 * The plan calls for `roundForUnixTs(unix: number)` as a named export the
 * UI / hooks can import without pulling in the timelock module's encrypt
 * /decrypt surface. Centralizing the projection here also makes the
 * "match Hermetic Echo" invariant easy to audit — anyone reviewing the
 * spec only has to read this file plus `crypto/timelock.ts` to see that
 * both projects compute the same round for the same wall-clock time.
 *
 * `unix` is Unix **milliseconds** (matches `Date.now()` and the
 * `closeUnix` field on PollMeta). drand rounds are integers; the helper
 * is async only to keep the API forward-compatible with a future
 * remote-fetch chain-info path.
 */
import { roundForDate } from "../crypto/timelock";

/**
 * Project a wall-clock Unix-milliseconds timestamp to the drand quicknet
 * round at or after that time. Returns synchronously today; declared
 * async so the surface stays stable if we ever want to refresh chain info
 * from the drand HTTP endpoint at call time.
 */
export async function roundForUnixTs(unix: number): Promise<number> {
  if (!Number.isFinite(unix)) {
    throw new Error("roundForUnixTs: expected finite Unix ms");
  }
  return roundForDate(new Date(unix));
}
