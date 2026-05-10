/**
 * Crucible — IndexedDB persistence for the newsroom side.
 *
 * Single database `aegis-crucible-newsroom`, single object store `drops`,
 * primary key `id`, secondary index on `ts` (newest-first sort).
 *
 * # Source side does NOT use this module
 *
 * The whole point of Crucible's source side is no persistence. A source
 * submits a drop, sees a success screen with the drop id + CID, and the
 * page is fire-and-forget. The source-side files in this module
 * (`ephemeral.ts`, `submit.ts`, `SourceDropbox.tsx`, `app/crucible/page.tsx`)
 * MUST NOT call into anything that writes IDB. Grep-friendly assertion:
 * none of those files imports from `./store`.
 *
 * # Newsroom side stores DECRYPTED drops
 *
 * The flow is:
 *
 *   pointer event arrives → fetch ciphertext from Pinata → decrypt with
 *   ECDH(newsroom.seckey, drop.ephemeralPubkey) → persist the decrypted
 *   plaintext + attachments into this store.
 *
 * Storing the *plaintext* in IDB is a deliberate ergonomics trade-off:
 *   - Pro: the newsroom dashboard renders instantly without re-fetching
 *          and re-decrypting on every reload.
 *   - Con: anyone with browser access to the newsroom device can read the
 *          decrypted drops. That's the same threat surface as Herald
 *          (chat plaintexts persisted in `aegis-herald`) and Scribe
 *          (note plaintexts after master-key unwrap). The newsroom is
 *          assumed to be a trusted workstation — that's the whole UX
 *          contract of the signed-in dashboard.
 *
 * # IDB transaction lifecycle gotcha
 *
 * Same pattern as `lib/herald/store.ts`: each public function is a single
 * txn whose requests chain through `onsuccess`, and we resolve once
 * `tx.oncomplete` fires. See `herald/store.ts` file header for the
 * detailed write-up.
 *
 * Browser-only — every public function ensures `indexedDB` exists or
 * rejects before opening the database.
 */
import type { DecryptedDrop } from "./types";

const DB_NAME = "aegis-crucible-newsroom";
const DB_VERSION = 1;
const STORE_DROPS = "drops";
const INDEX_BY_TS = "by-ts";

function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("crucible newsroom storage requires browser environment");
  }
}

/**
 * Open the database, creating the object store + ts index on first run.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DROPS)) {
        const store = db.createObjectStore(STORE_DROPS, { keyPath: "id" });
        store.createIndex(INDEX_BY_TS, "ts", { unique: false });
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
/* Drops                                                                       */
/* -------------------------------------------------------------------------- */

/** Insert or overwrite a decrypted drop. Idempotent on duplicate `id`. */
export async function saveDrop(drop: DecryptedDrop): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_DROPS], "readwrite", (tx) => {
    tx.objectStore(STORE_DROPS).put(drop);
  });
}

/** Look up a single drop by `id`, or `null` if it doesn't exist. */
export async function getDrop(id: string): Promise<DecryptedDrop | null> {
  ensureBrowser();
  return txn<DecryptedDrop | null>(
    [STORE_DROPS],
    "readonly",
    (tx, setResult) => {
      const req = tx
        .objectStore(STORE_DROPS)
        .get(id) as IDBRequest<DecryptedDrop | undefined>;
      req.onsuccess = () => setResult(req.result ?? null);
    },
  );
}

/**
 * Load every drop, sorted newest-first by `ts`. The dashboard renders
 * directly off this order — the index gives us deterministic sort even
 * across heterogeneous timestamp values.
 */
export async function loadDrops(): Promise<DecryptedDrop[]> {
  ensureBrowser();
  return txn<DecryptedDrop[]>([STORE_DROPS], "readonly", (tx, setResult) => {
    const req = tx
      .objectStore(STORE_DROPS)
      .getAll() as IDBRequest<DecryptedDrop[]>;
    req.onsuccess = () => {
      const list = req.result ?? [];
      list.sort((a, b) => b.ts - a.ts);
      setResult(list);
    };
  });
}

/** Mark a drop as read. No-op if the drop doesn't exist. */
export async function markDropRead(id: string): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_DROPS], "readwrite", (tx) => {
    const store = tx.objectStore(STORE_DROPS);
    const getReq = store.get(id) as IDBRequest<DecryptedDrop | undefined>;
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return;
      existing.read = true;
      store.put(existing);
    };
  });
}

/** Remove a single drop. Idempotent. */
export async function deleteDrop(id: string): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_DROPS], "readwrite", (tx) => {
    tx.objectStore(STORE_DROPS).delete(id);
  });
}

/**
 * Wipe every Crucible-newsroom-owned record. Intended for dev / "start
 * over" flows; not currently wired into the UI.
 */
export async function clearAllDrops(): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_DROPS], "readwrite", (tx) => {
    tx.objectStore(STORE_DROPS).clear();
  });
}
