/**
 * Herald — IndexedDB persistence for conversations and messages.
 *
 * Single database `aegis-herald` with two object stores:
 *
 *   - `conversations` — primary key is the x-only pubkey hex.
 *   - `messages`      — primary key is the message id; secondary index on
 *                       `convId` (non-unique) drives `loadMessages(convId)`.
 *
 * Modelled on `identity/storage.ts`: raw IndexedDB (no `idb` wrapper).
 *
 * # IDB transaction lifecycle gotcha
 *
 * IndexedDB transactions go inactive between microtask ticks unless a new
 * request is issued from inside the previous request's callback. That
 * means async/await across requests inside the same transaction will fail
 * with "transaction has finished". To stay safe we structure each public
 * function as either:
 *
 *   1. A single request inside a single transaction, or
 *   2. A sequence of requests where each subsequent request is registered
 *      inside the previous one's `onsuccess` (so the txn stays active).
 *
 * The helper `txn` opens the DB and returns a Promise that resolves once
 * `tx.oncomplete` fires; the caller hands back any result they need via
 * the txn body's closure.
 *
 * Browser-only — every public function ensures `indexedDB` exists or rejects
 * before opening the database.
 */
import type { Conversation, Message, MessageStatus } from "./types";
import type { Network } from "../transport";

const DB_NAME = "aegis-herald";
const DB_VERSION = 1;
const STORE_CONVERSATIONS = "conversations";
const STORE_MESSAGES = "messages";
const INDEX_BY_CONV = "by-conv";

function ensureBrowser(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error("herald storage requires browser environment");
  }
}

/**
 * Open the database, creating object stores + indexes on first run.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        db.createObjectStore(STORE_CONVERSATIONS, { keyPath: "pubkey" });
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const store = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
        store.createIndex(INDEX_BY_CONV, "convId", { unique: false });
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
 * them through onsuccess) before the current microtask completes — see
 * the lifecycle note above. The body returns a value through the result
 * channel (an in-closure variable) and we resolve once `tx.oncomplete`
 * fires.
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
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

/** Load every conversation. UI sorts by `lastMessageAt` desc. */
export async function loadConversations(): Promise<Conversation[]> {
  ensureBrowser();
  return txn<Conversation[]>(
    [STORE_CONVERSATIONS],
    "readonly",
    (tx, setResult) => {
      const req = tx
        .objectStore(STORE_CONVERSATIONS)
        .getAll() as IDBRequest<Conversation[]>;
      req.onsuccess = () => setResult(req.result ?? []);
    },
  );
}

/**
 * Insert or update a conversation. `pubkey` (the keyPath) must be x-only
 * 64-hex form; the caller normalizes at the input boundary.
 */
export async function saveConversation(c: Conversation): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_CONVERSATIONS], "readwrite", (tx) => {
    tx.objectStore(STORE_CONVERSATIONS).put(c);
  });
}

/** Look up a single conversation by pubkey, or `null` if it doesn't exist. */
export async function getConversation(
  pubkey: string,
): Promise<Conversation | null> {
  ensureBrowser();
  return txn<Conversation | null>(
    [STORE_CONVERSATIONS],
    "readonly",
    (tx, setResult) => {
      const req = tx
        .objectStore(STORE_CONVERSATIONS)
        .get(pubkey) as IDBRequest<Conversation | undefined>;
      req.onsuccess = () => setResult(req.result ?? null);
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Append a message. If a record with the same `id` already exists, this
 * overwrites — useful for inbound dedup where the AegisEvent id is the
 * primary key (replays are no-ops).
 *
 * Also bumps the conversation's `lastMessageAt` if the new message is
 * newer, and auto-creates a stub conversation if none exists. Both happen
 * in the same transaction so the sortable list never sees a transient
 * "message exists, conversation missing" state.
 */
export async function appendMessage(m: Message): Promise<void> {
  ensureBrowser();
  await txn<void>(
    [STORE_MESSAGES, STORE_CONVERSATIONS],
    "readwrite",
    (tx) => {
      const messages = tx.objectStore(STORE_MESSAGES);
      const conversations = tx.objectStore(STORE_CONVERSATIONS);
      messages.put(m);
      const getReq = conversations.get(m.convId) as IDBRequest<
        Conversation | undefined
      >;
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          if (m.ts > existing.lastMessageAt) {
            existing.lastMessageAt = m.ts;
            conversations.put(existing);
          }
        } else {
          // Auto-create a stub conversation for unknown convIds.
          const stub: Conversation = {
            pubkey: m.convId,
            createdAt: m.ts,
            lastMessageAt: m.ts,
          };
          conversations.put(stub);
        }
      };
    },
  );
}

/**
 * Update an existing message's status (and optionally record which network
 * it went out over). No-op if the message doesn't exist.
 */
export async function updateMessageStatus(
  id: string,
  status: MessageStatus,
  via?: Network,
): Promise<void> {
  ensureBrowser();
  await txn<void>([STORE_MESSAGES], "readwrite", (tx) => {
    const messages = tx.objectStore(STORE_MESSAGES);
    const getReq = messages.get(id) as IDBRequest<Message | undefined>;
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return;
      existing.status = status;
      if (via) existing.via = via;
      messages.put(existing);
    };
  });
}

/** Load all messages for a conversation, sorted ascending by ts. */
export async function loadMessages(convId: string): Promise<Message[]> {
  ensureBrowser();
  return txn<Message[]>([STORE_MESSAGES], "readonly", (tx, setResult) => {
    const idx = tx.objectStore(STORE_MESSAGES).index(INDEX_BY_CONV);
    const req = idx.getAll(convId) as IDBRequest<Message[]>;
    req.onsuccess = () => {
      const list = req.result ?? [];
      list.sort((a, b) => a.ts - b.ts);
      setResult(list);
    };
  });
}

/**
 * Wipe every Herald-owned record. Intended for dev / "start over" flows;
 * not wired into the UI yet.
 */
export async function clearAll(): Promise<void> {
  ensureBrowser();
  await txn<void>(
    [STORE_CONVERSATIONS, STORE_MESSAGES],
    "readwrite",
    (tx) => {
      tx.objectStore(STORE_CONVERSATIONS).clear();
      tx.objectStore(STORE_MESSAGES).clear();
    },
  );
}
