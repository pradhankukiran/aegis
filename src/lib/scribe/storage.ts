/**
 * Scribe — IndexedDB persistence for encrypted notes.
 *
 * Single database `aegis-scribe`, one object store:
 *
 *   - `notes` — primary key is the note id (uuid-ish string).
 *               Secondary index `by-updated` on `updatedAt` drives the list
 *               view's "most recently edited" sort.
 *
 * Modelled on `herald/store.ts`: raw IndexedDB (no `idb` wrapper) and the
 * same callback-style txn helper that keeps every request inside a single
 * active transaction. See that file for the lifecycle-gotcha write-up — the
 * same constraints apply here.
 *
 * # Encryption boundary
 *
 * Storage works exclusively with `Note` (envelope-only) rows. Plaintext
 * `NoteDraft` records never reach IDB. The seal/unseal calls live one layer
 * up in `hooks.ts` so the storage layer stays pure key-value.
 */

import type { Note } from "./types";

const DB_NAME = "aegis-scribe";
const DB_VERSION = 1;
const STORE_NOTES = "notes";
const INDEX_BY_UPDATED = "by-updated";

function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("scribe storage requires browser environment");
  }
}

/**
 * Open the database, creating the object store + index on first run.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        const store = db.createObjectStore(STORE_NOTES, { keyPath: "id" });
        store.createIndex(INDEX_BY_UPDATED, "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () =>
      reject(new Error("indexedDB.open blocked by another connection"));
  });
}

/**
 * Run a transaction. The body callback is invoked once with the open
 * transaction; it MUST issue every needed request synchronously (or chain
 * them through onsuccess) before the current microtask completes. See
 * herald/store.ts for the full lifecycle write-up.
 */
function txn<T>(
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

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Insert or update a note. `put` is upsert — the caller controls whether
 * `id` collides intentionally (re-save of an existing note) or accidentally.
 */
export async function saveNote(note: Note): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_NOTES], "readwrite", (tx) => {
    tx.objectStore(STORE_NOTES).put(note);
  });
}

/** Look up a single note by id, or `null` if it doesn't exist. */
export async function loadNote(id: string): Promise<Note | null> {
  ensureBrowser();
  return txn<Note | null>([STORE_NOTES], "readonly", (tx, setResult) => {
    const req = tx
      .objectStore(STORE_NOTES)
      .get(id) as IDBRequest<Note | undefined>;
    req.onsuccess = () => setResult(req.result ?? null);
  });
}

/**
 * Load every note, sorted by `updatedAt` descending (most recent first).
 *
 * We sort in JS rather than walking the `by-updated` index in reverse:
 * - The dataset is small (personal notes — dozens, not millions).
 * - JS-side sort keeps the path stable across IDB engines whose
 *   `openCursor(null, "prev")` behaviour on a non-unique index has had
 *   subtle bugs in older browsers.
 */
export async function loadNotes(): Promise<Note[]> {
  ensureBrowser();
  return txn<Note[]>([STORE_NOTES], "readonly", (tx, setResult) => {
    const req = tx.objectStore(STORE_NOTES).getAll() as IDBRequest<Note[]>;
    req.onsuccess = () => {
      const list = req.result ?? [];
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      setResult(list);
    };
  });
}

/**
 * Soft-delete a note. Rather than removing the IDB row, we stamp
 * `deletedMarker: true` + `deletedAt: now` on it. This is the "tombstone"
 * pattern: the row stays so cross-device sync (when wired) can propagate
 * the deletion to the user's other devices.
 *
 * No-op if the id doesn't exist — keeps the contract identical to a hard
 * delete from the caller's perspective. Use `purgeDeletedNotes` to fully
 * reclaim tombstones once they've been disseminated.
 */
export async function deleteNote(id: string): Promise<void> {
  ensureBrowser();
  const existing = await loadNote(id);
  if (!existing) return;
  const tombstoned: Note = {
    ...existing,
    deletedMarker: true,
    deletedAt: Date.now(),
  };
  await saveNote(tombstoned);
}

/**
 * Load every non-tombstoned note, sorted by `updatedAt` descending.
 *
 * This is what the list-view UI wants in practice — the raw `loadNotes`
 * still returns tombstones so the sync/admin layers can introspect them,
 * but `useNotes` calls `loadActiveNotes` so deleted rows never reach the
 * rendered list.
 */
export async function loadActiveNotes(): Promise<Note[]> {
  const all = await loadNotes();
  return all.filter((n) => n.deletedMarker !== true);
}

/**
 * Hard-delete tombstoned notes whose `deletedAt` is older than
 * `olderThanMs` ago. Intended for a periodic cleanup pass once the
 * cross-device sync layer is wired in and has had time to propagate the
 * tombstone. Not invoked anywhere in the current UI; provided so callers
 * have a clean reclaim path the moment they need one.
 *
 * Returns the number of rows removed.
 */
export async function purgeDeletedNotes(olderThanMs: number): Promise<number> {
  ensureBrowser();
  const now = Date.now();
  const all = await loadNotes();
  const stale = all.filter(
    (n) =>
      n.deletedMarker === true &&
      typeof n.deletedAt === "number" &&
      now - n.deletedAt > olderThanMs,
  );
  if (stale.length === 0) return 0;
  await txn<void>([STORE_NOTES], "readwrite", (tx) => {
    const store = tx.objectStore(STORE_NOTES);
    for (const n of stale) {
      store.delete(n.id);
    }
  });
  return stale.length;
}

/**
 * Wipe every Scribe-owned record. Intended for dev / "start over" flows;
 * not wired into the UI yet.
 */
export async function clearAll(): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_NOTES], "readwrite", (tx) => {
    tx.objectStore(STORE_NOTES).clear();
  });
}
