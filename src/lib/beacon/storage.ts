/**
 * Beacon — IndexedDB persistence for `Beacon` rows.
 *
 * Single database `aegis-beacon`, single object store `beacons`, primary key
 * `id`. The transaction-lifecycle helper mirrors `herald/store.ts` and
 * `scribe/storage.ts` — see those files for the full write-up on why we
 * structure each request so the txn stays active across the request
 * boundary.
 *
 * Browser-only — every public function ensures `indexedDB` exists or
 * rejects before opening the database.
 *
 * # Why `id` is the primary key
 *
 * Beacon's natural identifier is the freshly-minted uuid we stamp at
 * create time; everything that crosses the wire (release events,
 * cancellations, the timelocked release envelope) carries this id so
 * observers can correlate. Using it as the keyPath means a duplicate
 * `saveBeacon` (e.g. status update) cleanly overwrites the row.
 */
import type { Beacon } from "./types";

const DB_NAME = "aegis-beacon";
const DB_VERSION = 1;
const STORE_BEACONS = "beacons";

function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("beacon storage requires browser environment");
  }
}

/**
 * Open the database, creating the object store on first run.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BEACONS)) {
        db.createObjectStore(STORE_BEACONS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () =>
      reject(new Error("indexedDB.open blocked by another connection"));
  });
}

/**
 * Run a transaction. Mirrors the helper in herald/scribe/witness store: the
 * body issues its requests synchronously (or chains them through
 * `onsuccess`) and stores the result via `setResult`. We resolve once
 * `tx.oncomplete` fires.
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
/* Beacons                                                                     */
/* -------------------------------------------------------------------------- */

/** Insert or overwrite a beacon row. `put` is upsert by id. */
export async function saveBeacon(beacon: Beacon): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_BEACONS], "readwrite", (tx) => {
    tx.objectStore(STORE_BEACONS).put(beacon);
  });
}

/** Look up a single beacon by id, or null if absent. */
export async function loadBeacon(id: string): Promise<Beacon | null> {
  ensureBrowser();
  return txn<Beacon | null>([STORE_BEACONS], "readonly", (tx, setResult) => {
    const req = tx
      .objectStore(STORE_BEACONS)
      .get(id) as IDBRequest<Beacon | undefined>;
    req.onsuccess = () => setResult(req.result ?? null);
  });
}

/**
 * Load every beacon, sorted by `deadlineUnix` ascending. The list view
 * benefits from seeing the most-imminent beacons first — a beacon firing in
 * 3 hours is more salient than one firing in 7 days.
 *
 * Sorting is done in JS rather than via a secondary index because (a) the
 * dataset is small (personal beacons — handfuls), and (b) it keeps the
 * upgrade path simple if we ever switch the sort key.
 */
export async function loadBeacons(): Promise<Beacon[]> {
  ensureBrowser();
  return txn<Beacon[]>([STORE_BEACONS], "readonly", (tx, setResult) => {
    const req = tx.objectStore(STORE_BEACONS).getAll() as IDBRequest<Beacon[]>;
    req.onsuccess = () => {
      const list = req.result ?? [];
      list.sort((a, b) => a.deadlineUnix - b.deadlineUnix);
      setResult(list);
    };
  });
}

/** Delete a beacon by id. No-op if it doesn't exist. */
export async function deleteBeacon(id: string): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_BEACONS], "readwrite", (tx) => {
    tx.objectStore(STORE_BEACONS).delete(id);
  });
}

/**
 * Wipe every Beacon-owned record. Intended for dev / "start over" flows;
 * not wired into the UI yet.
 */
export async function clearAllBeacons(): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_BEACONS], "readwrite", (tx) => {
    tx.objectStore(STORE_BEACONS).clear();
  });
}
