/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearAllAnchors,
  deleteAnchor,
  getAnchor,
  loadAnchors,
  saveAnchor,
} from "./storage";
import type { AnchorRecord } from "./types";

/* ---------------------------------------------------------------------------
 * Minimal in-memory IndexedDB shim
 * --------------------------------------------------------------------------
 * happy-dom does not ship IndexedDB. The Herald store test file documents
 * the same pattern; this is a focused adaptation: single store (no
 * secondary indexes), keyPath-based primary key, get/getAll/put/delete/
 * clear, single-store transactions.
 *
 * Scope: tests in THIS FILE ONLY. `beforeEach` installs the shim on
 * `globalThis.indexedDB`; `afterEach` restores the prior value.
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

const SAMPLE_HASH_A =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SAMPLE_HASH_B =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function makeRecord(overrides: Partial<AnchorRecord> = {}): AnchorRecord {
  return {
    hash: SAMPLE_HASH_A,
    sig: "1".repeat(128),
    signer: "2".repeat(64),
    ts: 1_700_000_000,
    fileName: "doc.pdf",
    fileSize: 12345,
    networkResults: [
      { network: "nostr", ok: true, eventId: "n-1" },
      { network: "matrix", ok: false, reason: "not connected" },
    ],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("witness / storage", () => {
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

  it("loadAnchors returns [] when nothing is stored", async () => {
    expect(await loadAnchors()).toEqual([]);
  });

  it("saveAnchor -> getAnchor round-trips the record", async () => {
    const rec = makeRecord();
    await saveAnchor(rec);
    const got = await getAnchor(SAMPLE_HASH_A);
    expect(got).toEqual(rec);
  });

  it("saveAnchor overwrites by hash (the primary key)", async () => {
    await saveAnchor(makeRecord({ fileName: "v1.pdf" }));
    await saveAnchor(makeRecord({ fileName: "v2.pdf" }));
    const got = await getAnchor(SAMPLE_HASH_A);
    expect(got?.fileName).toBe("v2.pdf");
  });

  it("loadAnchors returns every stored record", async () => {
    await saveAnchor(makeRecord({ hash: SAMPLE_HASH_A }));
    await saveAnchor(makeRecord({ hash: SAMPLE_HASH_B }));
    const all = await loadAnchors();
    const hashes = all.map((r) => r.hash).sort();
    expect(hashes).toEqual([SAMPLE_HASH_B, SAMPLE_HASH_A].sort());
  });

  it("getAnchor returns null for an unknown hash", async () => {
    expect(await getAnchor(SAMPLE_HASH_B)).toBeNull();
  });

  it("deleteAnchor removes the record (idempotent)", async () => {
    await saveAnchor(makeRecord());
    await deleteAnchor(SAMPLE_HASH_A);
    expect(await getAnchor(SAMPLE_HASH_A)).toBeNull();
    // Double-delete must not throw.
    await expect(deleteAnchor(SAMPLE_HASH_A)).resolves.toBeUndefined();
  });

  it("clearAllAnchors wipes every record", async () => {
    await saveAnchor(makeRecord({ hash: SAMPLE_HASH_A }));
    await saveAnchor(makeRecord({ hash: SAMPLE_HASH_B }));
    await clearAllAnchors();
    expect(await loadAnchors()).toEqual([]);
  });

  it("saveAnchor preserves networkResults fidelity (per-network shape round-trips)", async () => {
    const rec = makeRecord({
      networkResults: [
        { network: "nostr", ok: true, reason: "relays ok: 3/3" },
        { network: "matrix", ok: false, reason: "homeserver unreachable" },
      ],
    });
    await saveAnchor(rec);
    const got = await getAnchor(SAMPLE_HASH_A);
    expect(got?.networkResults).toEqual(rec.networkResults);
  });
});
