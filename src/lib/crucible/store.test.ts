/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearAllDrops,
  deleteDrop,
  getDrop,
  loadDrops,
  markDropRead,
  saveDrop,
} from "./store";
import type { DecryptedDrop } from "./types";

/* ---------------------------------------------------------------------------
 * Minimal in-memory IndexedDB shim
 * --------------------------------------------------------------------------
 * Same shape as the shim used in `witness/storage.test.ts` — single store
 * with a primary keyPath + a secondary index that we register but never
 * actually query on (the production `loadDrops` reads getAll and sorts in
 * JS). Scope: this file only; install in beforeEach, restore in afterEach.
 * ------------------------------------------------------------------------ */

type StoredRow = Record<string, unknown>;

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
    if (this.done) throw new Error("fake idb: transaction has finished");
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

function makeDrop(overrides: Partial<DecryptedDrop> = {}): DecryptedDrop {
  return {
    id: "drop-" + Math.random().toString(16).slice(2),
    to: "ab".repeat(33),
    ephemeralPubkey: "02" + "cd".repeat(32),
    cid: "bafy-fake-" + Math.random().toString(16).slice(2),
    ts: Math.floor(Date.now() / 1000),
    plaintext: "hello",
    read: false,
    ...overrides,
  };
}

describe("crucible / store", () => {
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

  it("loadDrops returns [] when nothing is stored", async () => {
    expect(await loadDrops()).toEqual([]);
  });

  it("saveDrop -> getDrop round-trips", async () => {
    const drop = makeDrop({ id: "d1" });
    await saveDrop(drop);
    expect(await getDrop("d1")).toEqual(drop);
  });

  it("saveDrop overwrites by id (idempotent on replay)", async () => {
    await saveDrop(makeDrop({ id: "d2", plaintext: "v1" }));
    await saveDrop(makeDrop({ id: "d2", plaintext: "v2" }));
    const got = await getDrop("d2");
    expect(got?.plaintext).toBe("v2");
  });

  it("loadDrops returns every record sorted desc by ts", async () => {
    await saveDrop(makeDrop({ id: "old", ts: 100 }));
    await saveDrop(makeDrop({ id: "newest", ts: 300 }));
    await saveDrop(makeDrop({ id: "middle", ts: 200 }));
    const all = await loadDrops();
    expect(all.map((d) => d.id)).toEqual(["newest", "middle", "old"]);
  });

  it("getDrop returns null for an unknown id", async () => {
    expect(await getDrop("does-not-exist")).toBeNull();
  });

  it("markDropRead flips `read` to true", async () => {
    await saveDrop(makeDrop({ id: "u1", read: false }));
    await markDropRead("u1");
    expect((await getDrop("u1"))?.read).toBe(true);
  });

  it("markDropRead on an unknown id is a no-op", async () => {
    await expect(markDropRead("nope")).resolves.toBeUndefined();
  });

  it("deleteDrop removes the record (idempotent)", async () => {
    await saveDrop(makeDrop({ id: "x1" }));
    await deleteDrop("x1");
    expect(await getDrop("x1")).toBeNull();
    await expect(deleteDrop("x1")).resolves.toBeUndefined();
  });

  it("clearAllDrops wipes every record", async () => {
    await saveDrop(makeDrop({ id: "a" }));
    await saveDrop(makeDrop({ id: "b" }));
    await clearAllDrops();
    expect(await loadDrops()).toEqual([]);
  });

  it("preserves attachment bytes fidelity through a save/load cycle", async () => {
    const bytes = new Uint8Array([5, 4, 3, 2, 1]);
    await saveDrop(
      makeDrop({
        id: "att",
        attachments: [{ name: "x.bin", size: bytes.length, bytes }],
      }),
    );
    const got = await getDrop("att");
    expect(got?.attachments?.[0].bytes).toEqual(bytes);
  });
});
