/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PUBKEY_BYTES,
  SECKEY_BYTES,
  exportIdentity,
  generateIdentity,
  importIdentity,
  pubkeyBase64Url,
  pubkeyHex,
} from "./index";
import { clearIdentity, loadIdentity, saveIdentity } from "./storage";

/* ---------------------------------------------------------------------------
 * Minimal in-memory IndexedDB shim
 * --------------------------------------------------------------------------
 * happy-dom does not ship IndexedDB. We don't want to install a fake-indexeddb
 * dep just for tests, so we mount a tiny in-memory shim covering the exact
 * surface storage.ts uses: open() with onupgradeneeded, single object store
 * with a string keyPath, readonly/readwrite transactions, get/put/delete.
 *
 * Scope: tests in THIS FILE ONLY. We assign to `globalThis.indexedDB` in
 * `beforeEach` and restore the previous value in `afterEach`.
 * ------------------------------------------------------------------------ */

type StoredRow = Record<string, unknown> & { primary?: string };

class FakeRequest<T = unknown> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  fire(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.());
  }
}

class FakeObjectStore {
  constructor(
    private rows: Map<string, StoredRow>,
    public keyPath: string,
  ) {}
  get(key: string): FakeRequest<StoredRow | undefined> {
    const req = new FakeRequest<StoredRow | undefined>();
    req.fire(this.rows.get(key));
    return req;
  }
  put(value: StoredRow): FakeRequest<string> {
    const key = value[this.keyPath as keyof StoredRow] as string | undefined;
    if (typeof key !== "string") {
      const r = new FakeRequest<string>();
      r.error = new Error(`fake idb: missing keyPath "${this.keyPath}"`);
      queueMicrotask(() => r.onerror?.());
      return r;
    }
    this.rows.set(key, value);
    const req = new FakeRequest<string>();
    req.fire(key);
    return req;
  }
  delete(key: string): FakeRequest<undefined> {
    this.rows.delete(key);
    const req = new FakeRequest<undefined>();
    req.fire(undefined);
    return req;
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  constructor(private store: FakeObjectStore) {
    // The real IndexedDB fires `tx.oncomplete` AFTER every request in the txn
    // has settled. Defer through two microtask cycles so any request scheduled
    // during this same tick runs first (one tick for the request to fire its
    // onsuccess, the next for the transaction to complete).
    queueMicrotask(() => queueMicrotask(() => this.oncomplete?.()));
  }
  objectStore(): FakeObjectStore {
    return this.store;
  }
}

class FakeDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  constructor(private stores: Map<string, FakeObjectStore>) {}
  createObjectStore(name: string, opts: { keyPath: string }): FakeObjectStore {
    const store = new FakeObjectStore(new Map(), opts.keyPath);
    this.stores.set(name, store);
    return store;
  }
  transaction(name: string, mode: "readonly" | "readwrite"): FakeTransaction {
    const store = this.stores.get(name);
    if (!store) throw new Error(`fake idb: unknown store ${name}`);
    void mode;
    return new FakeTransaction(store);
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

describe("identity / keypair", () => {
  it("generateIdentity returns 33-byte pubkey + 32-byte seckey + sane timestamp", async () => {
    const before = Date.now();
    const id = await generateIdentity();
    const after = Date.now();
    expect(id.pubkey).toBeInstanceOf(Uint8Array);
    expect(id.seckey).toBeInstanceOf(Uint8Array);
    expect(id.pubkey.length).toBe(PUBKEY_BYTES);
    expect(id.seckey.length).toBe(SECKEY_BYTES);
    expect([0x02, 0x03]).toContain(id.pubkey[0]);
    expect(id.createdAt).toBeGreaterThanOrEqual(before);
    expect(id.createdAt).toBeLessThanOrEqual(after);
  });

  it("two generations produce different keys", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    expect(a.seckey).not.toEqual(b.seckey);
    expect(a.pubkey).not.toEqual(b.pubkey);
  });

  it("pubkeyHex is 66 lowercase hex chars; pubkeyBase64Url is URL-safe", async () => {
    const id = await generateIdentity();
    const hex = pubkeyHex(id);
    expect(hex).toMatch(/^[0-9a-f]{66}$/);
    const b64 = pubkeyBase64Url(id);
    expect(b64).not.toContain("+");
    expect(b64).not.toContain("/");
    expect(b64).not.toContain("=");
    expect(b64.length).toBeGreaterThan(0);
  });
});

describe("identity / portable export+import", () => {
  it("export -> import round-trips the seckey, pubkey, and createdAt", async () => {
    const id = await generateIdentity();
    const blob = exportIdentity(id);
    expect(blob.startsWith("aegis:id:v=1:")).toBe(true);
    const restored = importIdentity(blob);
    expect(restored.seckey).toEqual(id.seckey);
    expect(restored.pubkey).toEqual(id.pubkey);
    expect(restored.createdAt).toBe(id.createdAt);
  });

  it("importIdentity throws on garbage input", () => {
    expect(() => importIdentity("not-a-blob")).toThrow();
  });

  it("importIdentity throws on a wrong / future version prefix", () => {
    expect(() => importIdentity("aegis:id:v=2:abc")).toThrow();
  });

  it("importIdentity throws on malformed payload base64url/JSON", () => {
    expect(() => importIdentity("aegis:id:v=1:!!!notbase64!!!")).toThrow();
  });

  it("importIdentity throws on a payload with the wrong shape", () => {
    // valid base64url of a JSON object that doesn't have the expected fields
    const bad = "aegis:id:v=1:eyJmb28iOiJiYXIifQ"; // {"foo":"bar"}
    expect(() => importIdentity(bad)).toThrow();
  });
});

describe("identity / storage (IndexedDB)", () => {
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

  it("loadIdentity returns null when nothing is stored", async () => {
    expect(await loadIdentity()).toBeNull();
  });

  it("save -> load returns the same bytes and timestamp", async () => {
    const id = await generateIdentity();
    await saveIdentity(id);
    const loaded = await loadIdentity();
    expect(loaded).not.toBeNull();
    expect(loaded!.pubkey).toEqual(id.pubkey);
    expect(loaded!.seckey).toEqual(id.seckey);
    expect(loaded!.createdAt).toBe(id.createdAt);
  });

  it("save then save (overwrite) keeps only the latest", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    await saveIdentity(a);
    await saveIdentity(b);
    const loaded = await loadIdentity();
    expect(loaded!.seckey).toEqual(b.seckey);
    expect(loaded!.seckey).not.toEqual(a.seckey);
  });

  it("clear -> load returns null", async () => {
    const id = await generateIdentity();
    await saveIdentity(id);
    await clearIdentity();
    expect(await loadIdentity()).toBeNull();
  });
});
