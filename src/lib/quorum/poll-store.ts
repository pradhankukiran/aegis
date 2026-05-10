/**
 * Quorum — IndexedDB persistence for polls and ballots.
 *
 * Single database `aegis-quorum` with two object stores:
 *
 *   - `polls`   — primary key is the poll id (string).
 *   - `ballots` — primary key is the compound `[pollId, voter]`; secondary
 *                 index `by-poll` on `pollId` (non-unique) drives the
 *                 "ballots for this poll" lookup.
 *
 * Modelled on `atlas/idb.ts` — which itself mirrors `herald/store.ts`. We
 * keep the txn helper inline (rather than importing Atlas's) so the strict
 * file-constraint boundary stays clean (Quorum touches only its own
 * directory).
 *
 * # IDB transaction lifecycle (same gotcha as Herald / Atlas)
 *
 * IDB transactions go inactive between microtask ticks unless a new
 * request is issued from inside the previous request's callback. Async/
 * await across requests in the same txn will fail with "transaction has
 * finished". The `txn` helper here applies the same pattern: caller
 * issues every request synchronously (or chains through `onsuccess`),
 * we resolve the outer promise on `tx.oncomplete`.
 *
 * # Ballot dedup
 *
 * The compound `[pollId, voter]` keyPath gives us "one ballot per voter
 * per poll" for free: a re-submission `put`s the same key and overwrites
 * in place. The tally treats the most-recently-written row as
 * authoritative. That matches the spec ("keep the latest").
 */
import type { Ballot, PollMeta } from "./types";

const DB_NAME = "aegis-quorum";
const DB_VERSION = 1;
const STORE_POLLS = "polls";
const STORE_BALLOTS = "ballots";
const INDEX_BY_POLL = "by-poll";

function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("quorum storage requires browser environment");
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_POLLS)) {
        db.createObjectStore(STORE_POLLS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_BALLOTS)) {
        // Compound keypath `[pollId, voter]` enforces one-ballot-per-voter
        // per-poll at the IDB layer. The non-unique `by-poll` index gives
        // us O(log n) lookup of "every ballot for poll X" without scanning.
        const store = db.createObjectStore(STORE_BALLOTS, {
          keyPath: ["pollId", "voter"],
        });
        store.createIndex(INDEX_BY_POLL, "pollId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () =>
      reject(new Error("indexedDB.open blocked by another connection"));
  });
}

/**
 * Run a transaction. Body must issue every request synchronously (or chain
 * through onsuccess). Returns the value the body set via `setResult` (or
 * undefined if it didn't). Resolves on `tx.oncomplete`.
 */
function txn<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction, setResult: (v: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    openDb().then(
      (db) => {
        let result: T | undefined;
        let resultSet = false;
        const tx = db.transaction(storeNames, mode);
        const setResult = (v: T) => {
          result = v;
          resultSet = true;
        };
        try {
          body(tx, setResult);
        } catch (err) {
          try {
            tx.abort();
          } catch {
            /* may already be done */
          }
          db.close();
          reject(err);
          return;
        }
        tx.oncomplete = () => {
          db.close();
          if (resultSet) resolve(result as T);
          else resolve(undefined as unknown as T);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("indexedDB transaction failed"));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("indexedDB transaction aborted"));
        };
      },
      (err) => reject(err),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Polls                                                                       */
/* -------------------------------------------------------------------------- */

/** Load every persisted poll. UI sorts by createdAt desc. */
export async function loadPolls(): Promise<PollMeta[]> {
  ensureBrowser();
  return txn<PollMeta[]>([STORE_POLLS], "readonly", (tx, setResult) => {
    const req = tx.objectStore(STORE_POLLS).getAll() as IDBRequest<PollMeta[]>;
    req.onsuccess = () => setResult(req.result ?? []);
  });
}

/** Insert or update a poll. Idempotent via the `id` keyPath. */
export async function savePoll(poll: PollMeta): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_POLLS], "readwrite", (tx) => {
    tx.objectStore(STORE_POLLS).put(poll);
  });
}

/** Look up a single poll by id, or null if not stored. */
export async function getPoll(id: string): Promise<PollMeta | null> {
  ensureBrowser();
  return txn<PollMeta | null>(
    [STORE_POLLS],
    "readonly",
    (tx, setResult) => {
      const req = tx
        .objectStore(STORE_POLLS)
        .get(id) as IDBRequest<PollMeta | undefined>;
      req.onsuccess = () => setResult(req.result ?? null);
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Ballots                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Insert or replace a ballot. The compound key `[pollId, voter]` means a
 * re-submission overwrites the previous entry — the latest write wins.
 */
export async function saveBallot(ballot: Ballot): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_BALLOTS], "readwrite", (tx) => {
    tx.objectStore(STORE_BALLOTS).put(ballot);
  });
}

/**
 * Look up the ballot a specific voter submitted for a specific poll.
 * Returns null if the voter hasn't voted yet (which is the common case
 * for `useSubmitBallot`'s "has the current user voted?" check).
 */
export async function getBallot(
  pollId: string,
  voter: string,
): Promise<Ballot | null> {
  ensureBrowser();
  return txn<Ballot | null>(
    [STORE_BALLOTS],
    "readonly",
    (tx, setResult) => {
      const req = tx
        .objectStore(STORE_BALLOTS)
        .get([pollId, voter]) as IDBRequest<Ballot | undefined>;
      req.onsuccess = () => setResult(req.result ?? null);
    },
  );
}

/** Load every ballot for a poll, in IDB insertion order. */
export async function loadBallots(pollId: string): Promise<Ballot[]> {
  ensureBrowser();
  return txn<Ballot[]>(
    [STORE_BALLOTS],
    "readonly",
    (tx, setResult) => {
      const idx = tx.objectStore(STORE_BALLOTS).index(INDEX_BY_POLL);
      const req = idx.getAll(pollId) as IDBRequest<Ballot[]>;
      req.onsuccess = () => setResult(req.result ?? []);
    },
  );
}

/**
 * Wipe both stores. Exposed as a debug helper / "start over" hook; not
 * wired into the UI.
 */
export async function clearAll(): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_POLLS, STORE_BALLOTS], "readwrite", (tx) => {
    tx.objectStore(STORE_POLLS).clear();
    tx.objectStore(STORE_BALLOTS).clear();
  });
}
