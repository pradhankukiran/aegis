/**
 * Atlas — bounded per-peer position log. Each circle member's recent fixes
 * are appended here; once we cross {@link MAX_POSITIONS_PER_MEMBER} for a
 * given peer the oldest entry is evicted FIFO-style.
 *
 * Keypath is the compound `[from, ts]`. That gives us:
 *   - Natural ordering of (peer asc, timestamp asc) — perfect for the
 *     latest-N-per-peer access pattern.
 *   - `appendFix` idempotence on `(from, ts)` collisions (a peer's
 *     in-network duplicate from `subscribeDM` is a no-op `put`).
 *
 * Cap rationale: 50 fixes × 5-minute interval ≈ 4 hours of trail per peer,
 * which is enough for a glanceable "where have they been" history without
 * unbounded growth. The cap is a constant so a config story can be bolted
 * on later (e.g. a UI slider) without schema churn.
 */

import {
  ensureBrowser,
  STORE_POSITIONS,
  txn,
} from "./idb";
import type { PositionFix, ReceivedFix } from "./types";

/** Per-peer retention cap. See file-level rationale. */
export const MAX_POSITIONS_PER_MEMBER = 50;

/**
 * Append a position fix for `from`. Enforces the per-peer cap by deleting
 * oldest entries until the total (existing + new) is ≤ cap.
 *
 * One-shot algorithm (single txn, single cursor):
 *   1. openCursor() over the keyRange for this peer to count + collect
 *      keys, skipping any pre-existing record with the same `ts`
 *      (those will be overwritten in-place by `put` and shouldn't count
 *      as new entries against the cap).
 *   2. Once the cursor reports `null`, compute overflow = (count + 1) - cap.
 *   3. Delete the first `overflow` keys (= oldest entries) and `put` the
 *      new fix.
 *
 * `put` is upsert on `(from, ts)`, so a network-duplicate fix lands as a
 * harmless overwrite. The cap arithmetic deliberately skips that record so
 * a flood of duplicates doesn't accidentally evict good history.
 */
export async function appendFix(
  from: string,
  fix: PositionFix,
): Promise<void> {
  ensureBrowser();
  await txn<void>(
    [STORE_POSITIONS],
    "readwrite",
    (tx) => {
      const positions = tx.objectStore(STORE_POSITIONS);
      // KeyRange spans `[from]` (inclusive) to `[from, MAX_SAFE_INTEGER]`
      // (inclusive) — that's the full slice for this peer regardless of
      // future ts magnitudes (Date.now() in 285,000 years is safe).
      const range = IDBKeyRange.bound([from], [from, Number.MAX_SAFE_INTEGER]);
      const keys: Array<[string, number]> = [];
      const cursorReq = positions.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const value = cursor.value as ReceivedFix;
          // `put` will overwrite a same-ts row in-place; treating it as a
          // count of "rows that will still exist after the put" excludes
          // duplicates so we don't over-evict.
          if (value.ts !== fix.ts) {
            keys.push([value.from, value.ts]);
          }
          cursor.continue();
          return;
        }
        // Cursor exhausted — apply cap and insert.
        const projected = keys.length + 1;
        const overflow = projected - MAX_POSITIONS_PER_MEMBER;
        for (let i = 0; i < overflow; i += 1) {
          const k = keys[i];
          positions.delete(k);
        }
        const record: ReceivedFix = {
          from,
          lat: fix.lat,
          lon: fix.lon,
          accuracy: fix.accuracy,
          ts: fix.ts,
        };
        positions.put(record);
      };
    },
  );
}

/**
 * Load every stored fix for `from`, sorted ascending by ts. Returns `[]`
 * when no fixes are stored for that peer.
 *
 * Prefer `latestForMember` for the common case of "where are they now" —
 * this getter is mainly for trail rendering / debugging.
 */
export async function listFixesForMember(
  from: string,
): Promise<ReceivedFix[]> {
  ensureBrowser();
  return txn<ReceivedFix[]>(
    [STORE_POSITIONS],
    "readonly",
    (tx, setResult) => {
      const positions = tx.objectStore(STORE_POSITIONS);
      const range = IDBKeyRange.bound([from], [from, Number.MAX_SAFE_INTEGER]);
      const req = positions.getAll(range) as IDBRequest<ReceivedFix[]>;
      req.onsuccess = () => {
        const list = req.result ?? [];
        list.sort((a, b) => a.ts - b.ts);
        setResult(list);
      };
    },
  );
}

/** Return the newest fix for `from`, or `null` when nothing is stored. */
export async function latestForMember(
  from: string,
): Promise<ReceivedFix | null> {
  const all = await listFixesForMember(from);
  if (all.length === 0) return null;
  return all[all.length - 1] ?? null;
}

/**
 * Load the latest fix for every peer that has at least one stored sample.
 * Returns `Record<from, ReceivedFix>` so the UI can:
 *   - `Object.values()` for the marker list, or
 *   - `byFrom[member.pubkey]` for the circle-panel last-seen badge.
 *
 * Single linear scan; sufficient for circles of realistic size.
 */
export async function latestFixesByMember(): Promise<Record<string, ReceivedFix>> {
  ensureBrowser();
  return txn<Record<string, ReceivedFix>>(
    [STORE_POSITIONS],
    "readonly",
    (tx, setResult) => {
      const out: Record<string, ReceivedFix> = {};
      const req = tx
        .objectStore(STORE_POSITIONS)
        .openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          setResult(out);
          return;
        }
        const value = cursor.value as ReceivedFix;
        const prior = out[value.from];
        if (!prior || prior.ts < value.ts) {
          out[value.from] = value;
        }
        cursor.continue();
      };
    },
  );
}
