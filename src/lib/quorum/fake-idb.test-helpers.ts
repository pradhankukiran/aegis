/**
 * Quorum tests — in-memory IndexedDB shim. Mirrors Atlas's
 * `fake-idb.test-helpers.ts` exactly (compound keypaths, indexes,
 * cursors, IDBKeyRange.bound emulation) — Quorum's `ballots` store uses
 * compound `[pollId, voter]` keys and a `by-poll` index, both of which
 * the Atlas shim already supports.
 *
 * We duplicate (rather than import) so the strict file-constraint
 * boundary — Quorum touches only its own directory — stays clean. The
 * shim is small enough that the duplication doesn't hurt; both modules
 * will move under a shared test-helpers tree the next time we touch
 * cross-module test infra.
 */

type StoredRow = Record<string, unknown>;
type RowKey = string | readonly unknown[];
type BoundsValue = unknown | readonly unknown[];

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

class FakeKeyRange {
  constructor(
    public lower: BoundsValue | null,
    public upper: BoundsValue | null,
    public lowerOpen: boolean,
    public upperOpen: boolean,
  ) {}
  includes(key: RowKey): boolean {
    if (this.lower !== null) {
      const cmp = compareKeys(key, this.lower);
      if (this.lowerOpen ? cmp <= 0 : cmp < 0) return false;
    }
    if (this.upper !== null) {
      const cmp = compareKeys(key, this.upper);
      if (this.upperOpen ? cmp >= 0 : cmp > 0) return false;
    }
    return true;
  }
  static bound(
    lower: BoundsValue,
    upper: BoundsValue,
    lowerOpen = false,
    upperOpen = false,
  ): FakeKeyRange {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
}

function compareKeys(a: RowKey | BoundsValue, b: RowKey | BoundsValue): number {
  const aArr = Array.isArray(a) ? a : [a];
  const bArr = Array.isArray(b) ? b : [b];
  const n = Math.min(aArr.length, bArr.length);
  for (let i = 0; i < n; i += 1) {
    const ai = aArr[i] as string | number;
    const bi = bArr[i] as string | number;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  if (aArr.length < bArr.length) return -1;
  if (aArr.length > bArr.length) return 1;
  return 0;
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
    public keyPath: string | string[],
  ) {}
  private requireTxn(): FakeTransaction {
    if (!this.txn) throw new Error("fake idb: no active txn on store");
    return this.txn;
  }
  private rowKey(value: StoredRow): RowKey {
    if (Array.isArray(this.keyPath)) {
      return this.keyPath.map((p) => value[p] as string | number);
    }
    return value[this.keyPath] as string;
  }
  private serializeKey(key: RowKey): string {
    if (Array.isArray(key)) return JSON.stringify(key);
    return String(key);
  }
  get(key: RowKey): FakeRequest<StoredRow | undefined> {
    const txn = this.requireTxn();
    txn.registerRequest();
    const req = new FakeRequest<StoredRow | undefined>();
    req.fire(this.rows.get(this.serializeKey(key)), txn);
    return req;
  }
  getAll(rangeOrKey?: FakeKeyRange | RowKey): FakeRequest<StoredRow[]> {
    const txn = this.requireTxn();
    txn.registerRequest();
    const all = Array.from(this.rows.values());
    let filtered: StoredRow[];
    if (!rangeOrKey) {
      filtered = all;
    } else if (rangeOrKey instanceof FakeKeyRange) {
      filtered = all.filter((row) => rangeOrKey.includes(this.rowKey(row)));
    } else {
      const targetSer = this.serializeKey(rangeOrKey);
      filtered = all.filter(
        (row) => this.serializeKey(this.rowKey(row)) === targetSer,
      );
    }
    const req = new FakeRequest<StoredRow[]>();
    req.fire(filtered, txn);
    return req;
  }
  put(value: StoredRow): FakeRequest<RowKey> {
    const txn = this.requireTxn();
    txn.registerRequest();
    let key: RowKey;
    try {
      key = this.rowKey(value);
    } catch {
      const r = new FakeRequest<RowKey>();
      r.error = new Error(`fake idb: missing keyPath`);
      queueMicrotask(() => {
        r.onerror?.();
        txn.settleRequest();
      });
      return r;
    }
    if (Array.isArray(key) && key.some((v) => v === undefined)) {
      const r = new FakeRequest<RowKey>();
      r.error = new Error(`fake idb: missing keyPath component`);
      queueMicrotask(() => {
        r.onerror?.();
        txn.settleRequest();
      });
      return r;
    }
    if (key === undefined) {
      const r = new FakeRequest<RowKey>();
      r.error = new Error(`fake idb: missing keyPath value`);
      queueMicrotask(() => {
        r.onerror?.();
        txn.settleRequest();
      });
      return r;
    }
    this.rows.set(this.serializeKey(key), value);
    const req = new FakeRequest<RowKey>();
    req.fire(key, txn);
    return req;
  }
  delete(key: RowKey): FakeRequest<undefined> {
    const txn = this.requireTxn();
    txn.registerRequest();
    this.rows.delete(this.serializeKey(key));
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
    opts: { keyPath: string | string[] },
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

/**
 * Install the fake on globalThis.indexedDB + IDBKeyRange. Returns a
 * teardown closure that restores prior values.
 */
export function installFakeIdb(): () => void {
  type WithIdb = {
    indexedDB?: unknown;
    IDBKeyRange?: unknown;
  };
  const g = globalThis as unknown as WithIdb;
  const priorIdb = g.indexedDB;
  const priorKr = g.IDBKeyRange;
  g.indexedDB = new FakeIndexedDB();
  g.IDBKeyRange = FakeKeyRange;
  return () => {
    g.indexedDB = priorIdb;
    g.IDBKeyRange = priorKr;
  };
}
