/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendMessage,
  clearAll,
  getConversation,
  loadConversations,
  loadMessages,
  saveConversation,
  updateMessageStatus,
} from "./store";
import type { Conversation, Message } from "./types";

/* ---------------------------------------------------------------------------
 * Minimal in-memory IndexedDB shim
 * --------------------------------------------------------------------------
 * happy-dom does not ship IndexedDB. We don't want to install a fake-indexeddb
 * dep just for tests, so we mount a tiny in-memory shim covering the surface
 * herald/store.ts uses: open() with onupgradeneeded, named object stores
 * with primary keyPath + secondary index, get/getAll/getAll-by-index/put/
 * delete/clear, multi-store transactions.
 *
 * Scope: tests in THIS FILE ONLY. We assign to `globalThis.indexedDB` in
 * `beforeEach` and restore the previous value in `afterEach`.
 * ------------------------------------------------------------------------ */

type StoredRow = Record<string, unknown>;

/**
 * Real IndexedDB fires `tx.oncomplete` only after every request inside the
 * txn has settled AND no new requests have been issued in that microtask.
 * We approximate that by tracking a request counter that goes up on issue
 * and down on settle; when it hits zero we schedule a "complete" check on
 * the next microtask, which fires `oncomplete` if no new request arrived.
 */
class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  pending = 0;
  done = false;
  constructor(private storesByName: Map<string, FakeObjectStore>) {}
  objectStore(name: string): FakeObjectStore {
    const s = this.storesByName.get(name);
    if (!s) throw new Error(`fake idb: unknown store ${name}`);
    s.txn = this;
    return s;
  }
  abort(): void {
    if (this.done) return;
    this.done = true;
    queueMicrotask(() => this.onabort?.());
  }
  /** Called by FakeObjectStore when issuing a new request. */
  registerRequest(): void {
    if (this.done) {
      // After a tx is done, real IDB would throw — surface that.
      throw new Error("fake idb: transaction has finished");
    }
    this.pending += 1;
  }
  /** Called by FakeObjectStore when a request settles. */
  settleRequest(): void {
    this.pending -= 1;
    if (this.pending === 0 && !this.done) {
      // Defer one microtask so any synchronous follow-up request in the
      // request's onsuccess handler can register before we declare complete.
      queueMicrotask(() => {
        if (this.pending === 0 && !this.done) {
          this.done = true;
          this.oncomplete?.();
        }
      });
    }
  }
}

class FakeRequest<T = unknown> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  fire(result: T, txn?: FakeTransaction): void {
    this.result = result;
    queueMicrotask(() => {
      this.onsuccess?.();
      txn?.settleRequest();
    });
  }
}

class FakeIndex {
  constructor(
    private rows: Map<string, StoredRow>,
    private keyPath: string,
    private txn: FakeTransaction,
  ) {}
  getAll(matchValue: unknown): FakeRequest<StoredRow[]> {
    this.txn.registerRequest();
    const out: StoredRow[] = [];
    for (const row of this.rows.values()) {
      if (row[this.keyPath] === matchValue) out.push(row);
    }
    const req = new FakeRequest<StoredRow[]>();
    req.fire(out, this.txn);
    return req;
  }
}

class FakeObjectStore {
  // Map of indexName → secondary keyPath
  private indexes = new Map<string, string>();
  // Set per-request when the store is borrowed via tx.objectStore().
  txn: FakeTransaction | null = null;
  constructor(
    private rows: Map<string, StoredRow>,
    public keyPath: string,
  ) {}
  private requireTxn(): FakeTransaction {
    if (!this.txn) throw new Error("fake idb: no active txn on store");
    return this.txn;
  }
  get(key: string): FakeRequest<StoredRow | undefined> {
    const txn = this.requireTxn();
    txn.registerRequest();
    const req = new FakeRequest<StoredRow | undefined>();
    req.fire(this.rows.get(key), txn);
    return req;
  }
  getAll(): FakeRequest<StoredRow[]> {
    const txn = this.requireTxn();
    txn.registerRequest();
    const req = new FakeRequest<StoredRow[]>();
    req.fire(Array.from(this.rows.values()), txn);
    return req;
  }
  put(value: StoredRow): FakeRequest<string> {
    const txn = this.requireTxn();
    txn.registerRequest();
    const key = value[this.keyPath] as string | undefined;
    if (typeof key !== "string") {
      const r = new FakeRequest<string>();
      r.error = new Error(`fake idb: missing keyPath "${this.keyPath}"`);
      queueMicrotask(() => {
        r.onerror?.();
        txn.settleRequest();
      });
      return r;
    }
    this.rows.set(key, value);
    const req = new FakeRequest<string>();
    req.fire(key, txn);
    return req;
  }
  delete(key: string): FakeRequest<undefined> {
    const txn = this.requireTxn();
    txn.registerRequest();
    this.rows.delete(key);
    const req = new FakeRequest<undefined>();
    req.fire(undefined, txn);
    return req;
  }
  clear(): FakeRequest<undefined> {
    const txn = this.requireTxn();
    txn.registerRequest();
    this.rows.clear();
    const req = new FakeRequest<undefined>();
    req.fire(undefined, txn);
    return req;
  }
  createIndex(name: string, keyPath: string, opts: { unique: boolean }): void {
    void opts;
    this.indexes.set(name, keyPath);
  }
  index(name: string): FakeIndex {
    const path = this.indexes.get(name);
    if (!path) throw new Error(`fake idb: unknown index ${name}`);
    return new FakeIndex(this.rows, path, this.requireTxn());
  }
}

class FakeDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  constructor(private stores: Map<string, FakeObjectStore>) {}
  createObjectStore(
    name: string,
    opts: { keyPath: string },
  ): FakeObjectStore {
    const store = new FakeObjectStore(new Map(), opts.keyPath);
    this.stores.set(name, store);
    return store;
  }
  transaction(
    names: string | string[],
    mode: "readonly" | "readwrite",
  ): FakeTransaction {
    const list = Array.isArray(names) ? names : [names];
    const subset = new Map<string, FakeObjectStore>();
    for (const n of list) {
      const s = this.stores.get(n);
      if (!s) throw new Error(`fake idb: unknown store ${n}`);
      subset.set(n, s);
    }
    void mode;
    return new FakeTransaction(subset);
  }
  close(): void {
    /* no-op for the fake */
  }
}

class FakeIndexedDB {
  private dbs = new Map<string, Map<string, FakeObjectStore>>();
  open(name: string, version: number): FakeRequest<FakeDatabase> {
    void version;
    const req = new FakeRequest<FakeDatabase>();
    let stores = this.dbs.get(name);
    const isNew = !stores;
    if (!stores) {
      stores = new Map();
      this.dbs.set(name, stores);
    }
    const db = new FakeDatabase(stores);
    req.result = db;
    if (isNew) {
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        queueMicrotask(() => req.onsuccess?.());
      });
    } else {
      queueMicrotask(() => req.onsuccess?.());
    }
    return req;
  }
}

/* ------------------------------------------------------------------------ */

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-" + Math.random().toString(16).slice(2),
    convId: ALICE,
    body: "hello",
    ts: Date.now(),
    mine: true,
    status: "sending",
    ...overrides,
  };
}

describe("herald / store", () => {
  let priorIdb: typeof globalThis.indexedDB | undefined;

  beforeEach(() => {
    priorIdb = (globalThis as { indexedDB?: typeof globalThis.indexedDB })
      .indexedDB;
    (
      globalThis as unknown as { indexedDB: unknown }
    ).indexedDB = new FakeIndexedDB();
  });

  afterEach(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = priorIdb;
  });

  it("loadConversations returns [] when nothing is stored", async () => {
    expect(await loadConversations()).toEqual([]);
  });

  it("saveConversation -> getConversation round-trips", async () => {
    const c: Conversation = {
      pubkey: ALICE,
      createdAt: 100,
      lastMessageAt: 100,
    };
    await saveConversation(c);
    const got = await getConversation(ALICE);
    expect(got).toEqual(c);
  });

  it("appendMessage + loadMessages returns sorted ascending by ts", async () => {
    await saveConversation({
      pubkey: ALICE,
      createdAt: 0,
      lastMessageAt: 0,
    });
    await appendMessage(makeMessage({ id: "m3", convId: ALICE, ts: 300 }));
    await appendMessage(makeMessage({ id: "m1", convId: ALICE, ts: 100 }));
    await appendMessage(makeMessage({ id: "m2", convId: ALICE, ts: 200 }));
    const list = await loadMessages(ALICE);
    expect(list.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("loadMessages scopes results to the requested conversation", async () => {
    await saveConversation({
      pubkey: ALICE,
      createdAt: 0,
      lastMessageAt: 0,
    });
    await saveConversation({
      pubkey: BOB,
      createdAt: 0,
      lastMessageAt: 0,
    });
    await appendMessage(makeMessage({ id: "a1", convId: ALICE, ts: 10 }));
    await appendMessage(makeMessage({ id: "b1", convId: BOB, ts: 20 }));
    await appendMessage(makeMessage({ id: "a2", convId: ALICE, ts: 30 }));
    const aliceMessages = await loadMessages(ALICE);
    expect(aliceMessages.map((m) => m.id)).toEqual(["a1", "a2"]);
    const bobMessages = await loadMessages(BOB);
    expect(bobMessages.map((m) => m.id)).toEqual(["b1"]);
  });

  it("appendMessage bumps the conversation's lastMessageAt forward, not backward", async () => {
    await saveConversation({
      pubkey: ALICE,
      createdAt: 0,
      lastMessageAt: 50,
    });
    // Older message — must not move lastMessageAt back.
    await appendMessage(makeMessage({ id: "old", convId: ALICE, ts: 10 }));
    let c = await getConversation(ALICE);
    expect(c?.lastMessageAt).toBe(50);
    // Newer message — should advance lastMessageAt.
    await appendMessage(makeMessage({ id: "new", convId: ALICE, ts: 100 }));
    c = await getConversation(ALICE);
    expect(c?.lastMessageAt).toBe(100);
  });

  it("appendMessage auto-creates a conversation for an unknown convId", async () => {
    expect(await getConversation(BOB)).toBeNull();
    await appendMessage(
      makeMessage({ id: "stub", convId: BOB, ts: 42, mine: false, status: "received" }),
    );
    const c = await getConversation(BOB);
    expect(c).not.toBeNull();
    expect(c?.pubkey).toBe(BOB);
    expect(c?.createdAt).toBe(42);
    expect(c?.lastMessageAt).toBe(42);
  });

  it("updateMessageStatus mutates status and via", async () => {
    await saveConversation({
      pubkey: ALICE,
      createdAt: 0,
      lastMessageAt: 0,
    });
    await appendMessage(makeMessage({ id: "u1", convId: ALICE, ts: 1 }));
    await updateMessageStatus("u1", "sent", "matrix");
    const list = await loadMessages(ALICE);
    expect(list[0].status).toBe("sent");
    expect(list[0].via).toBe("matrix");
  });

  it("updateMessageStatus without `via` leaves any existing via intact", async () => {
    await saveConversation({
      pubkey: ALICE,
      createdAt: 0,
      lastMessageAt: 0,
    });
    await appendMessage(
      makeMessage({ id: "u2", convId: ALICE, ts: 1, via: "nostr" }),
    );
    await updateMessageStatus("u2", "failed");
    const list = await loadMessages(ALICE);
    expect(list[0].status).toBe("failed");
    expect(list[0].via).toBe("nostr");
  });

  it("updateMessageStatus on an unknown id is a no-op (does not throw)", async () => {
    await expect(
      updateMessageStatus("does-not-exist", "sent", "matrix"),
    ).resolves.toBeUndefined();
  });

  it("clearAll wipes both stores", async () => {
    await saveConversation({
      pubkey: ALICE,
      createdAt: 0,
      lastMessageAt: 0,
    });
    await appendMessage(makeMessage({ id: "x", convId: ALICE, ts: 1 }));
    await clearAll();
    expect(await loadConversations()).toEqual([]);
    expect(await loadMessages(ALICE)).toEqual([]);
  });

  it("loadConversations returns every saved conversation (unsorted at the storage layer)", async () => {
    await saveConversation({
      pubkey: ALICE,
      createdAt: 1,
      lastMessageAt: 100,
    });
    await saveConversation({
      pubkey: BOB,
      createdAt: 2,
      lastMessageAt: 50,
    });
    const all = await loadConversations();
    const byKey = new Map(all.map((c) => [c.pubkey, c] as const));
    expect(byKey.size).toBe(2);
    expect(byKey.get(ALICE)?.lastMessageAt).toBe(100);
    expect(byKey.get(BOB)?.lastMessageAt).toBe(50);
  });
});
