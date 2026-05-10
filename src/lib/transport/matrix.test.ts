/**
 * @vitest-environment happy-dom
 */
import { RoomEvent } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToHex, hexToBytes } from "../crypto/encoding";
import type { Identity } from "../identity";

import {
  MatrixTransport,
  clearMatrixSession,
  deriveLocalpart,
  loadMatrixSession,
  mxidFromPubkeyHex,
  saveMatrixSession,
} from "./matrix";

/**
 * A deterministic test fixture: a known 33-byte compressed secp256k1 pubkey.
 * The localpart is the 24 hex chars that follow the SEC1 compression byte.
 *
 * We don't run the full secp256k1 derivation here — the surface under test is
 * `deriveLocalpart`, which is a pure slice of the hex encoding. Using a fixed
 * byte string lets the test be deterministic without dragging the keypair
 * generation path into a happy-dom environment.
 */
function fixtureIdentity(): Identity {
  const pubHex =
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  // 0x02 prefix + 32-byte x. Same length the real keypair generator emits.
  const pubkey = hexToBytes(pubHex);
  const seckey = new Uint8Array(32);
  seckey[0] = 1; // arbitrary; not used by the derivation under test
  return { pubkey, seckey, createdAt: 1700000000000 };
}

describe("matrix transport / MXID derivation", () => {
  it("deriveLocalpart returns the first 24 hex chars after the SEC1 prefix", () => {
    const id = fixtureIdentity();
    expect(deriveLocalpart(id)).toBe("79be667ef9dcbbac55a06295");
  });

  it("deriveLocalpart is deterministic", () => {
    const id = fixtureIdentity();
    const a = deriveLocalpart(id);
    const b = deriveLocalpart(id);
    expect(a).toBe(b);
  });

  it("deriveLocalpart agrees with mxidFromPubkeyHex on the same identity", () => {
    const id = fixtureIdentity();
    const localpart = deriveLocalpart(id);
    const mxid = mxidFromPubkeyHex(bytesToHex(id.pubkey), "aegis.app");
    expect(mxid).toBe(`@${localpart}:aegis.app`);
  });

  it("mxidFromPubkeyHex throws on a wrong-length pubkey hex", () => {
    expect(() => mxidFromPubkeyHex("deadbeef", "aegis.app")).toThrow();
  });

  it("two distinct pubkeys produce distinct localparts", () => {
    const a = fixtureIdentity();
    const b: Identity = {
      ...a,
      pubkey: hexToBytes(
        "03c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
      ),
    };
    expect(deriveLocalpart(a)).not.toBe(deriveLocalpart(b));
  });
});

describe("matrix transport / MatrixTransport getter", () => {
  it("mxid getter returns @<localpart>:<homeserver-domain>", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    expect(t.mxid).toBe("@79be667ef9dcbbac55a06295:matrix.aegis.app");
  });

  it("mxid getter handles a homeserver URL with a trailing slash", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app/");
    expect(t.mxid).toBe("@79be667ef9dcbbac55a06295:matrix.aegis.app");
  });

  it("mxid getter respects a non-Aegis homeserver (BYO support)", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.example.org");
    expect(t.mxid).toBe("@79be667ef9dcbbac55a06295:matrix.example.org");
  });

  it("constructor throws on a malformed homeserver URL", () => {
    const id = fixtureIdentity();
    expect(() => new MatrixTransport(id, "not a url")).toThrow();
  });
});

describe("matrix transport / smoke", () => {
  it("class instantiates without throwing", () => {
    const id = fixtureIdentity();
    expect(() => new MatrixTransport(id, "https://matrix.aegis.app")).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * subscribeIncomingDMs
 *
 * We don't have a real matrix-js-sdk client in this happy-dom environment;
 * the test installs a hand-rolled fake client via the private `.client`
 * field. The fake records the listener so we can drive synthetic timeline
 * events through the same code path the SDK would.
 * ------------------------------------------------------------------------ */

type FakeSdkEvent = {
  getType: () => string;
  getSender: () => string | undefined;
  getRoomId: () => string | undefined;
  getId: () => string | undefined;
  getContent: () => Record<string, unknown>;
  getTs: () => number;
};

type FakeRoom = {
  getMembers: () => Array<{ userId: string }>;
};

function makeFakeMatrixClient(roomsById: Map<string, FakeRoom>) {
  const listeners = new Map<unknown, Array<(...args: unknown[]) => void>>();
  const client = {
    on(eventName: unknown, fn: (...args: unknown[]) => void) {
      let arr = listeners.get(eventName);
      if (!arr) {
        arr = [];
        listeners.set(eventName, arr);
      }
      arr.push(fn);
    },
    off(eventName: unknown, fn: (...args: unknown[]) => void) {
      const arr = listeners.get(eventName);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    getRoom(id: string) {
      return roomsById.get(id) ?? null;
    },
  };
  function emit(eventName: unknown, ...args: unknown[]) {
    const arr = listeners.get(eventName);
    if (!arr) return;
    for (const fn of [...arr]) fn(...args);
  }
  function listenerCount(eventName: unknown): number {
    return listeners.get(eventName)?.length ?? 0;
  }
  return { client, emit, listenerCount };
}

function attachFakeClient(
  t: MatrixTransport,
  client: ReturnType<typeof makeFakeMatrixClient>["client"],
): void {
  // The transport stashes its client in a private field; we set it directly
  // to bypass connect() (which needs HTTP).
  (t as unknown as { client: unknown }).client = client;
}

function makeFakeEvent(over: Partial<{
  type: string;
  sender: string;
  roomId: string;
  eventId: string;
  body: string;
  ts: number;
}> = {}): FakeSdkEvent {
  const content: Record<string, unknown> = over.body !== undefined
    ? { msgtype: "m.text", body: over.body }
    : {};
  return {
    getType: () => over.type ?? "m.room.message",
    getSender: () => over.sender,
    getRoomId: () => over.roomId,
    getId: () => over.eventId,
    getContent: () => content,
    getTs: () => over.ts ?? 1700000000_000,
  };
}

describe("matrix transport / subscribeIncomingDMs", () => {
  it("forwards a 1:1 DM with from/plaintext/ts/eventId/roomId", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    const selfMxid = t.mxid;
    const otherMxid = "@bob:matrix.aegis.app";
    const dmRoom: FakeRoom = {
      getMembers: () => [{ userId: selfMxid }, { userId: otherMxid }],
    };
    const rooms = new Map<string, FakeRoom>([["!dm:matrix.aegis.app", dmRoom]]);
    const { client, emit } = makeFakeMatrixClient(rooms);
    attachFakeClient(t, client);

    const received: Array<{
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
      roomId: string;
    }> = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));

    emit(
      RoomEvent.Timeline,
      makeFakeEvent({
        type: "m.room.message",
        sender: otherMxid,
        roomId: "!dm:matrix.aegis.app",
        eventId: "$evt-1:matrix.aegis.app",
        body: "hi from matrix",
        ts: 1700000000_000,
      }),
      dmRoom,
      false,
    );

    expect(received).toHaveLength(1);
    expect(received[0].from).toBe(otherMxid);
    expect(received[0].plaintext).toBe("hi from matrix");
    expect(received[0].ts).toBe(1700000000);
    expect(received[0].eventId).toBe("$evt-1:matrix.aegis.app");
    expect(received[0].roomId).toBe("!dm:matrix.aegis.app");
  });

  it("skips events authored by us", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    const selfMxid = t.mxid;
    const dmRoom: FakeRoom = {
      getMembers: () => [
        { userId: selfMxid },
        { userId: "@bob:matrix.aegis.app" },
      ],
    };
    const rooms = new Map<string, FakeRoom>([["!r:matrix.aegis.app", dmRoom]]);
    const { client, emit } = makeFakeMatrixClient(rooms);
    attachFakeClient(t, client);
    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    emit(
      RoomEvent.Timeline,
      makeFakeEvent({
        sender: selfMxid, // our own message
        roomId: "!r:matrix.aegis.app",
        eventId: "$self:matrix.aegis.app",
        body: "talking to myself",
      }),
      dmRoom,
      false,
    );
    expect(received).toEqual([]);
  });

  it("skips non-DM rooms (>2 members)", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    const selfMxid = t.mxid;
    const groupRoom: FakeRoom = {
      getMembers: () => [
        { userId: selfMxid },
        { userId: "@bob:matrix.aegis.app" },
        { userId: "@carol:matrix.aegis.app" },
      ],
    };
    const rooms = new Map<string, FakeRoom>([
      ["!group:matrix.aegis.app", groupRoom],
    ]);
    const { client, emit } = makeFakeMatrixClient(rooms);
    attachFakeClient(t, client);
    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    emit(
      RoomEvent.Timeline,
      makeFakeEvent({
        sender: "@bob:matrix.aegis.app",
        roomId: "!group:matrix.aegis.app",
        eventId: "$g:matrix.aegis.app",
        body: "group msg",
      }),
      groupRoom,
      false,
    );
    expect(received).toEqual([]);
  });

  it("skips back-paginated events (toStartOfTimeline=true)", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    const selfMxid = t.mxid;
    const dmRoom: FakeRoom = {
      getMembers: () => [
        { userId: selfMxid },
        { userId: "@bob:matrix.aegis.app" },
      ],
    };
    const rooms = new Map<string, FakeRoom>([["!r:matrix.aegis.app", dmRoom]]);
    const { client, emit } = makeFakeMatrixClient(rooms);
    attachFakeClient(t, client);
    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    emit(
      RoomEvent.Timeline,
      makeFakeEvent({
        sender: "@bob:matrix.aegis.app",
        roomId: "!r:matrix.aegis.app",
        eventId: "$old:matrix.aegis.app",
        body: "history",
      }),
      dmRoom,
      true, // toStartOfTimeline
    );
    expect(received).toEqual([]);
  });

  it("skips non-message event types (state, reactions, etc.)", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    const selfMxid = t.mxid;
    const dmRoom: FakeRoom = {
      getMembers: () => [
        { userId: selfMxid },
        { userId: "@bob:matrix.aegis.app" },
      ],
    };
    const rooms = new Map<string, FakeRoom>([["!r:matrix.aegis.app", dmRoom]]);
    const { client, emit } = makeFakeMatrixClient(rooms);
    attachFakeClient(t, client);
    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    emit(
      RoomEvent.Timeline,
      makeFakeEvent({
        type: "m.reaction",
        sender: "@bob:matrix.aegis.app",
        roomId: "!r:matrix.aegis.app",
        eventId: "$react:matrix.aegis.app",
      }),
      dmRoom,
      false,
    );
    expect(received).toEqual([]);
  });

  it("returns an unsubscribe closure that detaches the listener", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    const rooms = new Map<string, FakeRoom>();
    const { client, listenerCount } = makeFakeMatrixClient(rooms);
    attachFakeClient(t, client);
    const unsub = t.subscribeIncomingDMs(() => undefined);
    expect(listenerCount(RoomEvent.Timeline)).toBe(1);
    unsub();
    expect(listenerCount(RoomEvent.Timeline)).toBe(0);
  });

  it("throws if called before connect (no client)", () => {
    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    expect(() => t.subscribeIncomingDMs(() => undefined)).toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * SEC-002: matrix-session-store round-trip
 *
 * happy-dom doesn't ship IndexedDB, so we install a tiny in-memory shim
 * scoped to the suite. The shim mirrors `lib/herald/store.test.ts` but
 * pared down to the surface our store actually uses (single object
 * store, primary keyPath, get/put/delete).
 * ------------------------------------------------------------------------ */

type StoredRow = Record<string, unknown>;

class TinyTxn {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  pending = 0;
  done = false;
  constructor(private storesByName: Map<string, TinyStore>) {}
  objectStore(name: string): TinyStore {
    const s = this.storesByName.get(name);
    if (!s) throw new Error(`tiny idb: unknown store ${name}`);
    s.txn = this;
    return s;
  }
  register(): void {
    if (this.done) throw new Error("tiny idb: txn finished");
    this.pending += 1;
  }
  settle(): void {
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

class TinyReq<T = unknown> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  fire(result: T, txn?: TinyTxn): void {
    this.result = result;
    queueMicrotask(() => {
      this.onsuccess?.();
      txn?.settle();
    });
  }
}

class TinyStore {
  txn: TinyTxn | null = null;
  constructor(private rows: Map<string, StoredRow>, public keyPath: string) {}
  private req(): TinyTxn {
    if (!this.txn) throw new Error("tiny idb: no txn");
    return this.txn;
  }
  get(key: string): TinyReq<StoredRow | undefined> {
    const txn = this.req();
    txn.register();
    const r = new TinyReq<StoredRow | undefined>();
    r.fire(this.rows.get(key), txn);
    return r;
  }
  put(value: StoredRow): TinyReq<string> {
    const txn = this.req();
    txn.register();
    const k = value[this.keyPath] as string;
    this.rows.set(k, value);
    const r = new TinyReq<string>();
    r.fire(k, txn);
    return r;
  }
  delete(key: string): TinyReq<undefined> {
    const txn = this.req();
    txn.register();
    this.rows.delete(key);
    const r = new TinyReq<undefined>();
    r.fire(undefined, txn);
    return r;
  }
}

class TinyDb {
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  constructor(private stores: Map<string, TinyStore>) {}
  createObjectStore(name: string, opts: { keyPath: string }): TinyStore {
    const s = new TinyStore(new Map(), opts.keyPath);
    this.stores.set(name, s);
    return s;
  }
  transaction(names: string | string[]): TinyTxn {
    const list = Array.isArray(names) ? names : [names];
    const sub = new Map<string, TinyStore>();
    for (const n of list) {
      const s = this.stores.get(n);
      if (!s) throw new Error(`tiny idb: unknown store ${n}`);
      sub.set(n, s);
    }
    return new TinyTxn(sub);
  }
  close(): void {
    /* no-op */
  }
}

class TinyIdb {
  private dbs = new Map<string, Map<string, TinyStore>>();
  open(name: string, _version: number): TinyReq<TinyDb> {
    void _version;
    const r = new TinyReq<TinyDb>();
    let stores = this.dbs.get(name);
    const isNew = !stores;
    if (!stores) {
      stores = new Map();
      this.dbs.set(name, stores);
    }
    const db = new TinyDb(stores);
    r.result = db;
    if (isNew) {
      queueMicrotask(() => {
        r.onupgradeneeded?.();
        queueMicrotask(() => r.onsuccess?.());
      });
    } else {
      queueMicrotask(() => r.onsuccess?.());
    }
    return r;
  }
}

describe("matrix-session-store / round-trip (SEC-002)", () => {
  let priorIdb: typeof globalThis.indexedDB | undefined;
  beforeEach(() => {
    priorIdb = (globalThis as { indexedDB?: typeof globalThis.indexedDB })
      .indexedDB;
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = new TinyIdb();
  });
  afterEach(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = priorIdb;
  });

  it("save → load returns the same accessToken+deviceId", async () => {
    await clearMatrixSession();
    await saveMatrixSession({ accessToken: "token-abc", deviceId: "DEV1" });
    const loaded = await loadMatrixSession();
    expect(loaded).toEqual({ accessToken: "token-abc", deviceId: "DEV1" });
  });

  it("load returns null on an empty store", async () => {
    await clearMatrixSession();
    const loaded = await loadMatrixSession();
    expect(loaded).toBeNull();
  });

  it("save overwrites previous record (single row)", async () => {
    await saveMatrixSession({ accessToken: "v1", deviceId: "D1" });
    await saveMatrixSession({ accessToken: "v2", deviceId: "D2" });
    expect(await loadMatrixSession()).toEqual({
      accessToken: "v2",
      deviceId: "D2",
    });
  });

  it("clear wipes the session", async () => {
    await saveMatrixSession({ accessToken: "x", deviceId: "y" });
    await clearMatrixSession();
    expect(await loadMatrixSession()).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * SEC-002 + SEC-004: connect() reuses stored session and otherwise POSTs to
 * /api/matrix/register (no localStorage, no homeserver UIA flow in the
 * browser).
 * ------------------------------------------------------------------------ */

describe("MatrixTransport.connect / SEC-002 + SEC-004", () => {
  let priorIdb: typeof globalThis.indexedDB | undefined;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    priorIdb = (globalThis as { indexedDB?: typeof globalThis.indexedDB })
      .indexedDB;
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = new TinyIdb();
    originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  });
  afterEach(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = priorIdb;
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs to /api/matrix/register and persists the returned session to IDB", async () => {
    await clearMatrixSession();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push({ url: u, init });
      // Return the registration proxy response shape.
      return new Response(
        JSON.stringify({
          accessToken: "stored-token",
          deviceId: "DEV-A",
          mxid: "@derived:matrix.aegis.app",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    (globalThis as { fetch: unknown }).fetch =
      fetchMock as unknown as typeof fetch;

    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    await t.connect();

    // The proxy was called.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const first = calls.find((c) => c.url === "/api/matrix/register");
    expect(first).toBeDefined();
    // No homeserver-direct call to /_matrix/client/... (we only hit the proxy).
    expect(
      calls.find((c) => c.url.includes("/_matrix/client/")),
    ).toBeUndefined();

    // Session is persisted in IDB.
    const stored = await loadMatrixSession();
    expect(stored).toEqual({ accessToken: "stored-token", deviceId: "DEV-A" });

    // localStorage was NOT touched (SEC-002).
    expect(localStorage.getItem("aegis_matrix_token")).toBeNull();
  });

  it("reuses a stored session and does NOT call the proxy", async () => {
    await saveMatrixSession({ accessToken: "reused", deviceId: "D" });
    const fetchMock = vi.fn(async () => new Response("{}"));
    (globalThis as { fetch: unknown }).fetch =
      fetchMock as unknown as typeof fetch;

    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    await t.connect();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a 503 from the proxy as a connect-time error", async () => {
    await clearMatrixSession();
    (globalThis as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "matrix-register-not-configured",
          message: "AEGIS_MATRIX_REGISTRATION_TOKEN env var not set",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const id = fixtureIdentity();
    const t = new MatrixTransport(id, "https://matrix.aegis.app");
    await expect(t.connect()).rejects.toThrow(
      /AEGIS_MATRIX_REGISTRATION_TOKEN env var not set/,
    );
    // Nothing got persisted.
    expect(await loadMatrixSession()).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * SEC-004: POST /api/matrix/register route handler
 *
 * The route reads two env vars and proxies to the homeserver. We don't
 * stand up a real homeserver; we mock `fetch` so the upstream call
 * receives canned responses.
 * ------------------------------------------------------------------------ */

import { POST as registerPOST } from "../../app/api/matrix/register/route";

function makeRoutedRequest(body: unknown): {
  json: () => Promise<unknown>;
} {
  return { json: async () => body };
}

describe("SEC-004: POST /api/matrix/register", () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let priorToken: string | undefined;
  let priorHomeserver: string | undefined;

  beforeEach(() => {
    originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    priorToken = process.env.AEGIS_MATRIX_REGISTRATION_TOKEN;
    priorHomeserver = process.env.AEGIS_MATRIX_HOMESERVER_URL;
  });
  afterEach(() => {
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    if (priorToken === undefined) {
      delete process.env.AEGIS_MATRIX_REGISTRATION_TOKEN;
    } else {
      process.env.AEGIS_MATRIX_REGISTRATION_TOKEN = priorToken;
    }
    if (priorHomeserver === undefined) {
      delete process.env.AEGIS_MATRIX_HOMESERVER_URL;
    } else {
      process.env.AEGIS_MATRIX_HOMESERVER_URL = priorHomeserver;
    }
    vi.restoreAllMocks();
  });

  it("503 when AEGIS_MATRIX_REGISTRATION_TOKEN is unset", async () => {
    delete process.env.AEGIS_MATRIX_REGISTRATION_TOKEN;
    process.env.AEGIS_MATRIX_HOMESERVER_URL = "https://matrix.aegis.app";
    const res = await registerPOST(
      makeRoutedRequest({
        username: "abc",
        password: "pw",
      }) as unknown as Parameters<typeof registerPOST>[0],
    );
    expect(res.status).toBe(503);
    const j = (await res.json()) as { error: string; message: string };
    expect(j.error).toBe("matrix-register-not-configured");
    expect(j.message).toMatch(/AEGIS_MATRIX_REGISTRATION_TOKEN/);
  });

  it("503 when AEGIS_MATRIX_HOMESERVER_URL is unset", async () => {
    process.env.AEGIS_MATRIX_REGISTRATION_TOKEN = "secret-token";
    delete process.env.AEGIS_MATRIX_HOMESERVER_URL;
    const res = await registerPOST(
      makeRoutedRequest({
        username: "abc",
        password: "pw",
      }) as unknown as Parameters<typeof registerPOST>[0],
    );
    expect(res.status).toBe(503);
  });

  it("400 on a malformed body", async () => {
    process.env.AEGIS_MATRIX_REGISTRATION_TOKEN = "secret-token";
    process.env.AEGIS_MATRIX_HOMESERVER_URL = "https://matrix.aegis.app";
    const res = await registerPOST(
      makeRoutedRequest({ username: "" }) as unknown as Parameters<typeof registerPOST>[0],
    );
    expect(res.status).toBe(400);
  });

  it("400 on bad-character username", async () => {
    process.env.AEGIS_MATRIX_REGISTRATION_TOKEN = "secret-token";
    process.env.AEGIS_MATRIX_HOMESERVER_URL = "https://matrix.aegis.app";
    const res = await registerPOST(
      makeRoutedRequest({
        username: "bad chars!",
        password: "pw",
      }) as unknown as Parameters<typeof registerPOST>[0],
    );
    expect(res.status).toBe(400);
  });

  it("happy path: forwards token to homeserver and surfaces accessToken", async () => {
    process.env.AEGIS_MATRIX_REGISTRATION_TOKEN = "secret-token";
    process.env.AEGIS_MATRIX_HOMESERVER_URL = "https://matrix.aegis.app";

    const calls: Array<{
      url: string;
      body: Record<string, unknown> | null;
    }> = [];
    (globalThis as { fetch: unknown }).fetch = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.toString();
        const parsedBody =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null;
        calls.push({ url: u, body: parsedBody });
        // First call: bare register elicits a 401 with a session id.
        // Second call: includes auth dict — returns access_token.
        if (parsedBody?.auth) {
          return new Response(
            JSON.stringify({
              access_token: "secret-access-token",
              device_id: "DEV99",
              user_id: "@derived:matrix.aegis.app",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ session: "uia-session-id" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
    ) as unknown as typeof fetch;

    const res = await registerPOST(
      makeRoutedRequest({
        username: "derived",
        password: "pw-abc",
      }) as unknown as Parameters<typeof registerPOST>[0],
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      accessToken: string;
      deviceId: string;
      mxid: string;
    };
    expect(j.accessToken).toBe("secret-access-token");
    expect(j.deviceId).toBe("DEV99");
    expect(j.mxid).toBe("@derived:matrix.aegis.app");

    // The second upstream call must have carried the secret token, not
    // anything from the browser side.
    expect(calls.length).toBe(2);
    const authCall = calls.find((c) => c.body?.auth);
    expect(authCall).toBeDefined();
    const authDict = (authCall!.body!.auth as Record<string, unknown>) ?? {};
    expect(authDict.type).toBe("m.login.registration_token");
    expect(authDict.token).toBe("secret-token");
  });

  it("surfaces a homeserver failure as 401 or 502", async () => {
    process.env.AEGIS_MATRIX_REGISTRATION_TOKEN = "secret-token";
    process.env.AEGIS_MATRIX_HOMESERVER_URL = "https://matrix.aegis.app";
    (globalThis as { fetch: unknown }).fetch = vi.fn(async (_url, init?: RequestInit) => {
      const parsed =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      if (parsed?.auth) {
        return new Response(
          JSON.stringify({ errcode: "M_FORBIDDEN" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ session: "uia-session-id" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await registerPOST(
      makeRoutedRequest({
        username: "derived",
        password: "pw",
      }) as unknown as Parameters<typeof registerPOST>[0],
    );
    expect([401, 502]).toContain(res.status);
  });

  it("502 when the homeserver is unreachable", async () => {
    process.env.AEGIS_MATRIX_REGISTRATION_TOKEN = "secret-token";
    process.env.AEGIS_MATRIX_HOMESERVER_URL = "https://matrix.aegis.app";
    (globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await registerPOST(
      makeRoutedRequest({
        username: "derived",
        password: "pw",
      }) as unknown as Parameters<typeof registerPOST>[0],
    );
    expect(res.status).toBe(502);
  });
});
