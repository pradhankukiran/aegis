/**
 * Atlas — circle-member CRUD. The circle is the list of trusted peers whose
 * pubkeys we encrypt and ship our position to. One record per pubkey.
 *
 * Pubkey canonicalization: every public function expects the canonical
 * 64-char lowercase x-only hex form. The `hooks.ts` layer normalizes at
 * the input boundary (paste box) via the same `normalizePubkey` Herald
 * exposes. We don't re-normalize here so a buggy caller surfaces loudly
 * with a key-mismatch instead of silently double-storing.
 *
 * Schema + transaction plumbing live in `idb.ts` so this module focuses on
 * the CRUD surface only.
 */

import {
  ensureBrowser,
  STORE_CIRCLE,
  STORE_POSITIONS,
  txn,
} from "./idb";
import type { CircleMember, ReceivedFix } from "./types";

/** Load every circle member. UI sorts by `addedAt` desc. */
export async function loadCircle(): Promise<CircleMember[]> {
  ensureBrowser();
  return txn<CircleMember[]>(
    [STORE_CIRCLE],
    "readonly",
    (tx, setResult) => {
      const req = tx
        .objectStore(STORE_CIRCLE)
        .getAll() as IDBRequest<CircleMember[]>;
      req.onsuccess = () => setResult(req.result ?? []);
    },
  );
}

/**
 * Insert or update a circle member. `pubkey` is the keyPath — the caller
 * normalizes to canonical 64-hex lowercase x-only form before passing in
 * (see hooks `addMember`).
 */
export async function putMember(m: CircleMember): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_CIRCLE], "readwrite", (tx) => {
    tx.objectStore(STORE_CIRCLE).put(m);
  });
}

/** Look up a single member by pubkey. Returns `null` if not present. */
export async function getMember(pubkey: string): Promise<CircleMember | null> {
  ensureBrowser();
  return txn<CircleMember | null>(
    [STORE_CIRCLE],
    "readonly",
    (tx, setResult) => {
      const req = tx
        .objectStore(STORE_CIRCLE)
        .get(pubkey) as IDBRequest<CircleMember | undefined>;
      req.onsuccess = () => setResult(req.result ?? null);
    },
  );
}

/**
 * Remove a circle member. Idempotent — deleting a missing key is a no-op.
 *
 * Sweeps any stored positions whose `from` matches the removed pubkey so
 * a stale trail doesn't keep rendering on the map. Both deletions happen
 * in the same readwrite txn across `circle` + `positions` so the user
 * never observes "removed from list but still pinned on the map".
 *
 * The position sweep walks via openCursor() (rather than a range scan on
 * the compound key) because a range scan would need the implicit lower
 * bound `[pubkey]` and an upper bound `[pubkey, MAX_TS]` — readable but
 * brittle to schema changes. A single linear scan over the whole store is
 * fine: total positions are bounded by N peers × 50 fixes (see
 * `position-store.ts`), so even at full saturation we're walking
 * thousands of rows at worst, not millions.
 */
export async function deleteMember(pubkey: string): Promise<void> {
  ensureBrowser();
  await txn<void>(
    [STORE_CIRCLE, STORE_POSITIONS],
    "readwrite",
    (tx) => {
      tx.objectStore(STORE_CIRCLE).delete(pubkey);
      const positions = tx.objectStore(STORE_POSITIONS);
      const cursorReq = positions.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const value = cursor.value as ReceivedFix;
        if (value.from === pubkey) {
          cursor.delete();
        }
        cursor.continue();
      };
    },
  );
}
