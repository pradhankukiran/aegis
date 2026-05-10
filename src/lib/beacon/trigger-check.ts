/**
 * Beacon — pure trigger evaluator.
 *
 * `shouldFire(beacon, now?)` returns true iff the beacon is still pending
 * AND `now > deadlineUnix`. That's the entire fast-path predicate; the
 * watchdog calls it once per pending beacon per tick.
 *
 * Pure / side-effect-free / deterministic — the only inputs are the beacon
 * and the clock. That makes it the obvious unit to test: boundary cases
 * (now < deadline, now == deadline, now > deadline) plus non-pending
 * statuses (already fired, cancelled, expired).
 *
 * # `"checked-in"` is treated as pending
 *
 * The status `"checked-in"` is a transient UI state — it lasts one render
 * cycle so the page can flash "You've been counted." From the watchdog's
 * POV a checked-in beacon is still arming a future fire, so we evaluate it
 * the same way as `"pending"`. Use `cancelled`/`fired`/`expired` for the
 * actually-terminal states.
 */
import type { Beacon } from "./types";

/**
 * Returns true iff `beacon` should fire right now.
 *
 * @param beacon — the beacon to evaluate.
 * @param now    — Unix seconds. Defaults to wall-clock time. Tests pass
 *                 explicit values to pin behaviour without freezing time
 *                 globally.
 */
export function shouldFire(
  beacon: Beacon,
  now: number = Date.now() / 1000,
): boolean {
  if (beacon.status !== "pending" && beacon.status !== "checked-in") {
    return false;
  }
  return now > beacon.deadlineUnix;
}
