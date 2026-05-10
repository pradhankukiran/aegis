/**
 * Atlas — shared IndexedDB plumbing. Both `circle-store.ts` and
 * `position-store.ts` open the same `aegis-atlas` database (two stores) so
 * a single `onupgradeneeded` provisions both at once. Co-locating the
 * open/txn helpers in this module keeps the schema declaration single-source
 * and lets each feature module focus on its CRUD surface.
 *
 * The transaction wrapper mirrors `herald/store.ts` verbatim — see that
 * file for the lifecycle commentary. The short version: IDB requests must
 * be issued synchronously (or chained inside `onsuccess`) to keep the txn
 * alive across microtask boundaries, so each helper here either uses one
 * request per txn or chains follow-ups in `onsuccess`.
 *
 * Browser-only: every public function in the dependent modules guards on
 * `typeof indexedDB` before calling these helpers. We re-export the guard
 * here so the dependents stay terse.
 */

export const DB_NAME = "aegis-atlas";
export const DB_VERSION = 1;
export const STORE_CIRCLE = "circle";
export const STORE_POSITIONS = "positions";

/** Throws if `indexedDB` is not present (SSR / Node without polyfill). */
export function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("atlas storage requires browser environment");
  }
}

/**
 * Open the database. Provisioning both object stores in a single upgrade
 * keeps `DB_VERSION` consistent across both feature modules — bumping the
 * version once would otherwise require a coordinated upgrade across two
 * `onupgradeneeded` handlers.
 */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CIRCLE)) {
        db.createObjectStore(STORE_CIRCLE, { keyPath: "pubkey" });
      }
      if (!db.objectStoreNames.contains(STORE_POSITIONS)) {
        // Compound keypath `[from, ts]` gives us (peer asc, ts asc) ordering
        // for free — exactly the order we want for the latest-N-per-peer
        // scans. Each `(peer, fix-timestamp)` pair is unique.
        db.createObjectStore(STORE_POSITIONS, { keyPath: ["from", "ts"] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () =>
      reject(new Error("indexedDB.open blocked by another connection"));
  });
}

/**
 * Run a transaction. Body issues every request synchronously (or chains
 * through onsuccess); we resolve once `tx.oncomplete` fires. See the
 * file-level note for the lifecycle rationale.
 */
export function txn<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  body: (
    tx: IDBTransaction,
    setResult: (v: T) => void,
  ) => void,
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

/**
 * Top-level wipe — both object stores in one txn. Exposed as a debugging
 * helper; not wired into the UI.
 */
export async function clearAll(): Promise<void> {
  ensureBrowser();
  await txn<void>(
    [STORE_CIRCLE, STORE_POSITIONS],
    "readwrite",
    (tx) => {
      tx.objectStore(STORE_CIRCLE).clear();
      tx.objectStore(STORE_POSITIONS).clear();
    },
  );
}
