/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AegisTransport, IncomingDM } from "../transport";

import { attachIncomingBridge, projectIncoming } from "./transport-bridge";
import {
  getConversation,
  loadConversations,
  loadMessages,
} from "./store";

/* ---------------------------------------------------------------------------
 * Reuse the in-memory IndexedDB shim. We duplicate the minimal fake here
 * rather than importing from the store test (vitest does not share fixtures
 * across files unless explicitly factored). Identical behaviour to
 * store.test.ts — see that file for documentation.
 * ------------------------------------------------------------------------ */

type StoredRow = Record<string, unknown>;

/**
 * IndexedDB transaction shim — same approach as store.test.ts. The txn
 * tracks outstanding requests and fires `oncomplete` only when none are
 * pending. Settlement runs through `queueMicrotask` so onsuccess handlers
 * can register follow-up requests before the txn closes.
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
  registerRequest(): void {
    if (this.done) {
      throw new Error("fake idb: transaction has finished");
    }
    this.pending += 1;
  }
  settleRequest(): void {
    this.pending -= 1;
    if (this.pending === 0 && !this.done) {
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
  private indexes = new Map<string, string>();
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

const SENDER = "c".repeat(64);

function makeDM(over: Partial<IncomingDM> = {}): IncomingDM {
  return {
    id: "dm-" + Math.random().toString(16).slice(2),
    from: SENDER,
    plaintext: "ping",
    network: "nostr",
    ts: 1700000000,
    ...over,
  };
}

/**
 * Build a fake AegisTransport whose `subscribeDM` captures the callback so
 * the test can drive incoming DMs directly.
 */
function makeFakeTransport(): {
  transport: AegisTransport;
  fire: (dm: IncomingDM) => void;
  unsub: () => void;
  subscribeDMMock: ReturnType<typeof vi.fn>;
} {
  let captured: ((dm: IncomingDM) => void) | null = null;
  const unsub = vi.fn();
  const subscribeDMMock = vi.fn((cb: (dm: IncomingDM) => void) => {
    captured = cb;
    return unsub;
  });
  // Cast to AegisTransport — only `subscribeDM` is exercised by attachIncomingBridge.
  const transport = {
    subscribeDM: subscribeDMMock,
  } as unknown as AegisTransport;
  return {
    transport,
    fire: (dm) => {
      if (!captured) throw new Error("subscribeDM was not called");
      captured(dm);
    },
    unsub,
    subscribeDMMock,
  };
}

describe("herald / projectIncoming", () => {
  it("projects a well-formed IncomingDM into a Message", () => {
    const dm = makeDM();
    const m = projectIncoming(dm);
    expect(m).not.toBeNull();
    expect(m!.body).toBe("ping");
    expect(m!.convId).toBe(SENDER);
    expect(m!.mine).toBe(false);
    expect(m!.status).toBe("received");
    expect(m!.via).toBe("nostr");
    // Aegis ts is seconds; Message.ts is ms.
    expect(m!.ts).toBe(1700000000 * 1000);
  });

  it("returns null when plaintext is empty", () => {
    expect(projectIncoming(makeDM({ plaintext: "" }))).toBeNull();
  });

  it("returns null when `from` is empty", () => {
    expect(projectIncoming(makeDM({ from: "" }))).toBeNull();
  });

  it("normalizes hex `from` to lowercase", () => {
    const upper = "AB".repeat(32); // 64 chars uppercase
    const dm = makeDM({ from: upper });
    const m = projectIncoming(dm);
    expect(m?.convId).toBe(upper.toLowerCase());
  });

  it("passes non-hex `from` (Matrix MXID, SSB id) through verbatim", () => {
    const mxid = "@abcd1234abcd1234abcd1234:matrix.aegis.app";
    expect(projectIncoming(makeDM({ from: mxid, network: "matrix" }))?.convId)
      .toBe(mxid);
    const ssbId = "@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ed25519";
    expect(projectIncoming(makeDM({ from: ssbId, network: "ssb" }))?.convId)
      .toBe(ssbId);
  });

  it("converts ts seconds → ms", () => {
    const dm = makeDM({ ts: 1700000123 });
    expect(projectIncoming(dm)?.ts).toBe(1700000123 * 1000);
  });
});

describe("herald / attachIncomingBridge (with IndexedDB)", () => {
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
    vi.restoreAllMocks();
  });

  it("subscribes via subscribeDM and persists incoming messages", async () => {
    const onIncoming = vi.fn();
    const { transport, fire, subscribeDMMock } = makeFakeTransport();
    attachIncomingBridge(transport, onIncoming);
    expect(subscribeDMMock).toHaveBeenCalledTimes(1);
    // subscribeDM takes just a callback (no filter arg).
    expect(subscribeDMMock.mock.calls[0]).toHaveLength(1);
    expect(typeof subscribeDMMock.mock.calls[0][0]).toBe("function");

    fire(
      makeDM({
        plaintext: "hi from nostr",
        ts: 1700000200,
      }),
    );

    // The bridge schedules async work through an unawaited Promise (with a
    // .catch). Wait for it to settle by polling — onIncoming fires only
    // after both the ensureConversation + appendMessage txns complete.
    await waitForCondition(() => onIncoming.mock.calls.length > 0, 200);

    const msgs = await loadMessages(SENDER);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("hi from nostr");
    expect(msgs[0].mine).toBe(false);
    expect(msgs[0].via).toBe("nostr");
  });

  it("auto-creates a conversation for an unknown sender", async () => {
    const onIncoming = vi.fn();
    const { transport, fire } = makeFakeTransport();
    attachIncomingBridge(transport, onIncoming);
    fire(
      makeDM({
        plaintext: "first contact",
        ts: 1700000300,
      }),
    );
    await waitForCondition(() => onIncoming.mock.calls.length > 0, 200);
    const c = await getConversation(SENDER);
    expect(c).not.toBeNull();
    expect(c!.pubkey).toBe(SENDER);
    const list = await loadConversations();
    expect(list).toHaveLength(1);
  });

  it("invokes the optional onIncoming callback after persisting", async () => {
    const onIncoming = vi.fn();
    const { transport, fire } = makeFakeTransport();
    attachIncomingBridge(transport, onIncoming);
    fire(
      makeDM({
        plaintext: "callback-test",
        ts: 1700000400,
      }),
    );
    await waitForCondition(() => onIncoming.mock.calls.length > 0, 200);
    expect(onIncoming).toHaveBeenCalledTimes(1);
    const arg = onIncoming.mock.calls[0][0];
    expect(arg.body).toBe("callback-test");
    expect(arg.convId).toBe(SENDER);
  });

  it("returns the underlying transport unsubscribe handle", () => {
    const { transport, unsub } = makeFakeTransport();
    const teardown = attachIncomingBridge(transport);
    teardown();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("drops malformed DMs without throwing", async () => {
    const onIncoming = vi.fn();
    const { transport, fire } = makeFakeTransport();
    attachIncomingBridge(transport, onIncoming);
    // Empty plaintext — bridge should swallow.
    fire(makeDM({ plaintext: "" }));
    // Give the (no-op) bridge a few ticks to do nothing, then assert.
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(onIncoming).not.toHaveBeenCalled();
    const list = await loadMessages(SENDER);
    expect(list).toEqual([]);
  });
});

/**
 * Poll an in-process predicate until it returns true or the budget elapses.
 * Used to wait for the bridge's unawaited Promise chain (subscribe callback
 * → handleIncoming → store writes) to settle without coupling the test to
 * an exact microtask count.
 */
async function waitForCondition(
  predicate: () => boolean,
  budgetMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  if (!predicate()) {
    throw new Error(`waitForCondition timed out after ${budgetMs}ms`);
  }
}
