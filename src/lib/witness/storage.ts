/**
 * Witness — IndexedDB persistence for AnchorRecords.
 *
 * Single database `aegis-witness`, single object store `anchors`, primary
 * key `hash`. The transaction lifecycle pattern is the same one
 * `lib/herald/store.ts` uses: every read/write hands its IDBRequest
 * registration off inside an `onsuccess` chain so the txn stays active
 * across the request boundary. See the file-level note in `herald/store.ts`
 * for a longer write-up.
 *
 * Browser-only — every public function ensures `indexedDB` exists or rejects
 * before opening the database.
 *
 * # Why `hash` is the primary key
 *
 * Witness's natural identifier is the content hash itself: anchoring the
 * same file twice yields the same `hash`, and the URL `/witness/<hash>`
 * uniquely names the record. Using `hash` as the keyPath means duplicate
 * anchor attempts (e.g. re-anchoring after a network blip) replace the
 * existing record with the new network results — exactly the merge
 * behaviour the history view wants.
 */
import type { AnchorRecord } from "./types";

const DB_NAME = "aegis-witness";
const DB_VERSION = 1;
const STORE_ANCHORS = "anchors";

function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("witness storage requires browser environment");
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
      if (!db.objectStoreNames.contains(STORE_ANCHORS)) {
        db.createObjectStore(STORE_ANCHORS, { keyPath: "hash" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () =>
      reject(new Error("indexedDB.open blocked by another connection"));
  });
}

/**
 * Run a transaction. Mirrors the helper in `herald/store.ts`: the body
 * issues its requests synchronously (or chains them through `onsuccess`)
 * and stores the result via `setResult`. We resolve once `tx.oncomplete`
 * fires.
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
/* Anchors                                                                      */
/* -------------------------------------------------------------------------- */

/** Insert or overwrite an anchor record. */
export async function saveAnchor(record: AnchorRecord): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_ANCHORS], "readwrite", (tx) => {
    tx.objectStore(STORE_ANCHORS).put(record);
  });
}

/** Look up a single anchor record by hash, or null if absent. */
export async function getAnchor(hash: string): Promise<AnchorRecord | null> {
  ensureBrowser();
  return txn<AnchorRecord | null>([STORE_ANCHORS], "readonly", (tx, setResult) => {
    const req = tx
      .objectStore(STORE_ANCHORS)
      .get(hash) as IDBRequest<AnchorRecord | undefined>;
    req.onsuccess = () => setResult(req.result ?? null);
  });
}

/** Load every stored anchor. History UI sorts by `createdAt` desc. */
export async function loadAnchors(): Promise<AnchorRecord[]> {
  ensureBrowser();
  return txn<AnchorRecord[]>(
    [STORE_ANCHORS],
    "readonly",
    (tx, setResult) => {
      const req = tx
        .objectStore(STORE_ANCHORS)
        .getAll() as IDBRequest<AnchorRecord[]>;
      req.onsuccess = () => setResult(req.result ?? []);
    },
  );
}

/** Remove a single anchor record. Idempotent. */
export async function deleteAnchor(hash: string): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_ANCHORS], "readwrite", (tx) => {
    tx.objectStore(STORE_ANCHORS).delete(hash);
  });
}

/**
 * Wipe every Witness-owned record. Intended for dev / "start over" flows;
 * not currently wired into the UI.
 */
export async function clearAllAnchors(): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_ANCHORS], "readwrite", (tx) => {
    tx.objectStore(STORE_ANCHORS).clear();
  });
}
