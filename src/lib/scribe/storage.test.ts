/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearAll,
  deleteNote,
  loadActiveNotes,
  loadNote,
  loadNotes,
  purgeDeletedNotes,
  saveNote,
} from "./storage";
import type { Note } from "./types";

/* ---------------------------------------------------------------------------
 * Minimal in-memory IndexedDB shim
 * --------------------------------------------------------------------------
 * happy-dom doesn't ship IndexedDB. Mirrors the same approach used by
 * herald/store.test.ts — see that file for the rationale on the request-
 * counter txn lifecycle. Only the surface scribe/storage.ts uses is covered:
 *   - open() with onupgradeneeded
 *   - named object store with primary keyPath + non-unique index
 *   - get / getAll / put / delete / clear
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

function makeNote(overrides: Partial<Note> = {}): Note {
  const now = Date.now();
  return {
    id: "n-" + Math.random().toString(16).slice(2),
    title: "Test note",
    contentEnvelope: "stub-envelope",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("scribe / storage", () => {
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

  it("loadNotes returns [] when nothing is stored", async () => {
    expect(await loadNotes()).toEqual([]);
  });

  it("loadNote returns null for an unknown id", async () => {
    expect(await loadNote("missing")).toBeNull();
  });

  it("saveNote -> loadNote round-trips", async () => {
    const note = makeNote({ id: "n1" });
    await saveNote(note);
    const got = await loadNote("n1");
    expect(got).toEqual(note);
  });

  it("saveNote is upsert (put-by-id)", async () => {
    await saveNote(makeNote({ id: "n2", title: "v1", updatedAt: 100 }));
    await saveNote(makeNote({ id: "n2", title: "v2", updatedAt: 200 }));
    const got = await loadNote("n2");
    expect(got?.title).toBe("v2");
    expect(got?.updatedAt).toBe(200);
    // Only one row total.
    expect((await loadNotes()).length).toBe(1);
  });

  it("loadNotes is sorted by updatedAt descending", async () => {
    await saveNote(makeNote({ id: "old", updatedAt: 100 }));
    await saveNote(makeNote({ id: "newest", updatedAt: 300 }));
    await saveNote(makeNote({ id: "mid", updatedAt: 200 }));
    const list = await loadNotes();
    expect(list.map((n) => n.id)).toEqual(["newest", "mid", "old"]);
  });

  it("deleteNote soft-deletes (tombstone), no-op on a missing id", async () => {
    await saveNote(makeNote({ id: "kill", title: "kill me" }));
    await deleteNote("kill");
    // The row is still there — it's a tombstone now.
    const row = await loadNote("kill");
    expect(row).not.toBeNull();
    expect(row?.deletedMarker).toBe(true);
    expect(typeof row?.deletedAt).toBe("number");
    // The non-tombstone fields are preserved so cross-device sync can
    // surface "we deleted this — here's what it was".
    expect(row?.title).toBe("kill me");
    // Second delete on the same id resolves cleanly.
    await expect(deleteNote("kill")).resolves.toBeUndefined();
    // No-op on an id that never existed.
    await expect(deleteNote("never")).resolves.toBeUndefined();
  });

  it("loadActiveNotes excludes tombstoned rows", async () => {
    await saveNote(makeNote({ id: "live", title: "alive", updatedAt: 100 }));
    await saveNote(makeNote({ id: "dead", title: "dead", updatedAt: 50 }));
    await deleteNote("dead");
    const active = await loadActiveNotes();
    expect(active.map((n) => n.id)).toEqual(["live"]);
    // Raw loadNotes still returns both rows.
    const all = await loadNotes();
    expect(all.length).toBe(2);
  });

  it("purgeDeletedNotes removes only stale tombstones", async () => {
    await saveNote(makeNote({ id: "a" }));
    await deleteNote("a");
    // Re-tombstone with a very old deletedAt so we can prove the age filter.
    const aged = await loadNote("a");
    expect(aged?.deletedMarker).toBe(true);
    await saveNote({
      ...(aged as Note),
      deletedAt: 1, // ~1970, well past any reasonable purge window
    });

    await saveNote(makeNote({ id: "b" }));
    await deleteNote("b");

    // 1 day window — "a" is past, "b" is fresh.
    const purged = await purgeDeletedNotes(24 * 60 * 60 * 1000);
    expect(purged).toBe(1);
    expect(await loadNote("a")).toBeNull();
    expect(await loadNote("b")).not.toBeNull();
  });

  it("purgeDeletedNotes is a no-op when nothing is stale", async () => {
    await saveNote(makeNote({ id: "x" }));
    await deleteNote("x");
    // 10-year window — nothing should purge.
    const purged = await purgeDeletedNotes(10 * 365 * 24 * 60 * 60 * 1000);
    expect(purged).toBe(0);
    expect(await loadNote("x")).not.toBeNull();
  });

  it("clearAll wipes the store", async () => {
    await saveNote(makeNote({ id: "a" }));
    await saveNote(makeNote({ id: "b" }));
    await clearAll();
    expect(await loadNotes()).toEqual([]);
  });

  it("preserves sharedRoomId when present", async () => {
    await saveNote(makeNote({ id: "shared", sharedRoomId: "!room:home" }));
    const got = await loadNote("shared");
    expect(got?.sharedRoomId).toBe("!room:home");
  });
});
