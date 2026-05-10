/**
 * Browser-only persistence for the master identity. One IndexedDB database
 * (`aegis`), one object store (`identity`), one fixed primary key (the string
 * "primary") — only one identity per app instance.
 *
 * Why raw IndexedDB and not the `idb` wrapper: keeps the bundle lean and the
 * dependency surface small. The store is tiny (three fields) and the access
 * pattern is single-record CRUD, so the wrapper buys us very little.
 *
 * `Uint8Array` is structured-cloneable, so `pubkey` and `seckey` are stored
 * as raw bytes — no base64/hex round-trip.
 */

import type { Identity } from "./keypair";

const DB_NAME = "aegis";
const DB_VERSION = 1;
const STORE_NAME = "identity";
const PRIMARY_KEY = "primary";

function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("identity storage requires browser environment");
  }
}

/**
 * Open the database, creating the object store on first run. The `primary`
 * keyPath means each record carries its own key inline; we always write
 * exactly one record with `primary === "primary"`.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "primary" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () =>
      reject(new Error("indexedDB.open blocked by another connection"));
  });
}

/**
 * Run `fn` against the object store inside a transaction of the given mode,
 * resolving with the value `fn` returns once the transaction commits.
 */
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    openDb().then(
      (db) => {
        let result: T | null = null;
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const req = fn(store);
        if (req) {
          req.onsuccess = () => {
            result = req.result;
          };
          req.onerror = () =>
            reject(req.error ?? new Error("indexedDB request failed"));
        }
        tx.oncomplete = () => {
          db.close();
          resolve(result);
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
 * Stored shape — adds the `primary` keyPath value, and copies the rest of
 * the Identity verbatim (Uint8Array survives structured cloning).
 */
type StoredIdentity = Identity & { primary: typeof PRIMARY_KEY };

/**
 * Load the stored identity, or `null` if none exists yet (first-run flow).
 */
export async function loadIdentity(): Promise<Identity | null> {
  ensureBrowser();
  const stored = await withStore<StoredIdentity>("readonly", (store) =>
    store.get(PRIMARY_KEY) as IDBRequest<StoredIdentity>,
  );
  if (!stored) return null;
  return {
    pubkey: stored.pubkey,
    seckey: stored.seckey,
    createdAt: stored.createdAt,
  };
}

/**
 * Save (or overwrite) the master identity. There is only ever one record;
 * `put` is upsert by primary key.
 */
export async function saveIdentity(id: Identity): Promise<void> {
  ensureBrowser();
  const record: StoredIdentity = {
    primary: PRIMARY_KEY,
    pubkey: id.pubkey,
    seckey: id.seckey,
    createdAt: id.createdAt,
  };
  await withStore("readwrite", (store) => store.put(record));
}

/**
 * Wipe the identity record (the "start over" flow). Idempotent — calling
 * it on an empty store is fine.
 */
export async function clearIdentity(): Promise<void> {
  ensureBrowser();
  await withStore("readwrite", (store) => store.delete(PRIMARY_KEY));
}
