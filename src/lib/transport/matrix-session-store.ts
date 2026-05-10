/**
 * Browser-only IndexedDB persistence for the Matrix session credentials
 * (access token + device id).
 *
 * # Why this exists (SEC-002)
 *
 * The Matrix access token was previously kept in `localStorage` under
 * `aegis_matrix_token`. Any XSS on the origin trivially exfiltrates a
 * `localStorage` value via `localStorage.getItem`. IndexedDB doesn't
 * literally defeat in-page JS (an XSS payload can also open an IDB
 * transaction), but it raises the bar:
 *
 *   - Legacy extension APIs that expose `localStorage` to permissioned
 *     extensions don't expose IDB the same way.
 *   - `document.domain`-quirk-driven leakage across subdomains is far
 *     harder to pull off against IDB.
 *   - Console-paste / clipboard-sync exfiltration patterns that lean on
 *     a synchronous string read don't compose with the IDB async cursor.
 *
 * So IDB is the more defensible default.
 *
 * # Storage shape
 *
 * One database (`aegis-matrix-session`), one object store
 * (`session`), one fixed primary key (`"primary"`). At most one row exists
 * — when a new Matrix device registers, it overwrites the previous record.
 *
 * The pattern follows `src/lib/identity/storage.ts` exactly so the code is
 * predictable across the codebase.
 */

const DB_NAME = "aegis-matrix-session";
const DB_VERSION = 1;
const STORE_NAME = "session";
const PRIMARY_KEY = "primary";

/** The fields we persist. */
export type MatrixSession = {
  accessToken: string;
  deviceId: string;
};

/**
 * IDB row shape. `primary` is the keyPath value, the rest is the session
 * data verbatim.
 */
type StoredSession = MatrixSession & { primary: typeof PRIMARY_KEY };

function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("matrix-session-store requires browser environment");
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
 * Load the stored Matrix session, or `null` if none exists yet (first-run
 * Matrix flow, or after a clear).
 */
export async function loadMatrixSession(): Promise<MatrixSession | null> {
  ensureBrowser();
  const stored = await withStore<StoredSession>("readonly", (store) =>
    store.get(PRIMARY_KEY) as IDBRequest<StoredSession>,
  );
  if (!stored) return null;
  // Defensive: a row with no accessToken is treated as "no session" so a
  // partial write or a manually-corrupted record can't trip us up.
  if (typeof stored.accessToken !== "string" || stored.accessToken === "") {
    return null;
  }
  return {
    accessToken: stored.accessToken,
    deviceId: typeof stored.deviceId === "string" ? stored.deviceId : "",
  };
}

/**
 * Save (or overwrite) the Matrix session. There is only ever one record;
 * `put` is upsert by primary key.
 */
export async function saveMatrixSession(session: MatrixSession): Promise<void> {
  ensureBrowser();
  const record: StoredSession = {
    primary: PRIMARY_KEY,
    accessToken: session.accessToken,
    deviceId: session.deviceId,
  };
  await withStore("readwrite", (store) => store.put(record));
}

/**
 * Wipe the session record (the "log out / restart matrix" flow).
 * Idempotent — calling it on an empty store is fine.
 */
export async function clearMatrixSession(): Promise<void> {
  ensureBrowser();
  await withStore("readwrite", (store) => store.delete(PRIMARY_KEY));
}
