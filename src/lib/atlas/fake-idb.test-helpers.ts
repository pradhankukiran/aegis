/**
 * Atlas tests — in-memory IndexedDB shim shared across Atlas test files.
 *
 * Modelled on the Herald test shim but extends it with:
 *   - Compound keyPath support (`["from", "ts"]`) — `position-store.ts`
 *     uses this for natural (peer asc, ts asc) ordering.
 *   - IDBKeyRange.bound() emulation against compound keys.
 *   - Cursor (`openCursor`) support, including `cursor.delete()` and
 *     `cursor.continue()` — `circle-store.deleteMember` and
 *     `position-store.appendFix` both rely on cursors.
 *
 * Scope: Atlas tests only. Each test file mounts a fresh `FakeIndexedDB`
 * via `installFakeIdb()` in `beforeEach` and restores the prior value in
 * `afterEach`.
 *
 * We don't install the `fake-indexeddb` npm dep because (a) the repo's
 * brief forbids new deps and (b) Herald already uses an in-tree shim, so
 * mirroring the pattern keeps the test infrastructure consistent.
 */

type StoredRow = Record<string, unknown>;
/** A row's primary key — string for single-keypath stores, tuple for compound. */
type RowKey = string | readonly unknown[];
type BoundsValue = unknown | readonly unknown[];

/**
 * IDB transactions go inactive between microtask ticks unless a new
 * request is registered from inside the previous's onsuccess. We
 * approximate that by tracking a request counter that goes up on issue
 * and down on settle; when it hits zero we defer one microtask to let
 * any follow-up registrations land before firing `oncomplete`.
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

/**
 * KeyRange shim. Real IDB ranges support `only/lowerBound/upperBound/bound`
 * with `open` flags; this implementation supports only what Atlas uses
 * (`IDBKeyRange.bound(lower, upper)` with inclusive endpoints, compound or
 * scalar). Add new variants only if/when needed.
 */
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

/**
 * Lexicographic comparison of IDB-style keys. Tuples compare componentwise;
 * a shorter prefix sorts before a longer one when all shared components are
 * equal. Scalars use natural `<`/`>` (strings or numbers).
 */
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

class FakeCursor {
  // Live mode: a snapshot of (key, value) tuples taken at openCursor() time.
  // `delete()` writes through to the live `rows` Map.
  private idx = -1;
  private continued = false;
  constructor(
    private snapshot: Array<{ key: RowKey; value: StoredRow }>,
    private rows: Map<string, StoredRow>,
    private keySerializer: (key: RowKey) => string,
    private txn: FakeTransaction,
  ) {}
  get key(): RowKey | undefined {
    return this.snapshot[this.idx]?.key;
  }
  get value(): StoredRow | undefined {
    return this.snapshot[this.idx]?.value;
  }
  delete(): void {
    const entry = this.snapshot[this.idx];
    if (!entry) return;
    this.rows.delete(this.keySerializer(entry.key));
  }
  continue(): void {
    this.continued = true;
  }
  /** Advance the cursor; call onsuccess with `this` or `null`. */
  step(onsuccess: (cursor: FakeCursor | null) => void): void {
    this.continued = false;
    this.idx += 1;
    if (this.idx >= this.snapshot.length) {
      onsuccess(null);
      return;
    }
    queueMicrotask(() => {
      onsuccess(this);
      // If user called continue() within onsuccess, step again.
      if (this.continued) {
        this.step(onsuccess);
      } else {
        this.txn.settleRequest();
      }
    });
  }
}

class FakeObjectStore {
  // For compound keypaths, we serialize to JSON string so Map keys behave.
  // The actual stored row keeps the original (possibly compound) key
  // implicit via its keyPath fields.
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
      // Treat scalar/array as exact-match key probe.
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
  openCursor(range?: FakeKeyRange): FakeRequest<FakeCursor | null> {
    const txn = this.requireTxn();
    txn.registerRequest();
    // Snapshot in compound-key sort order.
    const snapshot: Array<{ key: RowKey; value: StoredRow }> = [];
    for (const v of this.rows.values()) {
      const k = this.rowKey(v);
      if (range && !range.includes(k)) continue;
      snapshot.push({ key: k, value: v });
    }
    snapshot.sort((a, b) => compareKeys(a.key, b.key));
    const req = new FakeRequest<FakeCursor | null>();
    const cursor = new FakeCursor(
      snapshot,
      this.rows,
      (k) => this.serializeKey(k),
      txn,
    );
    queueMicrotask(() => {
      cursor.step((c) => {
        req.result = c;
        req.onsuccess?.();
        if (c === null) txn.settleRequest();
      });
    });
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

/**
 * Tiny poller used by tests that wait on the bridge's unawaited Promise
 * chain to settle. Vitest's `vi.waitFor` is the alternative but we keep
 * the loop hand-rolled to match Herald's pattern.
 */
export async function waitForCondition(
  predicate: () => boolean,
  budgetMs = 300,
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
