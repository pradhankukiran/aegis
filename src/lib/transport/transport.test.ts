/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the unified Aegis transport facade. We stub the three
 * underlying transports via `vi.mock` so no real network I/O happens — the
 * facade's job is fan-out, dedup, and fallback orchestration, all of which
 * can be exercised against canned per-transport responses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Identity } from "../identity";

/* -------------------------------------------------------------------------- */
/* Per-transport mocks                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The `vi.fn()` instances below are deliberately untyped (no generic param)
 * so `mockImplementation` accepts whatever shape each test wants. We pin
 * default behaviour in `beforeEach` rather than at construction.
 */
const nostrMock = vi.hoisted(() => ({
  pubkey: "a".repeat(64),
  connect: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
  subscribeIncomingDMs: vi.fn(),
  directMessage: vi.fn(),
  decryptDirectMessage: vi.fn(),
  close: vi.fn(),
}));

const matrixMock = vi.hoisted(() => ({
  mxid: "@aaaaaaaaaaaaaaaaaaaaaaaa:matrix.test",
  connect: vi.fn(),
  initCrypto: vi.fn(),
  createRoom: vi.fn(),
  sendMessage: vi.fn(),
  subscribe: vi.fn(),
  subscribeIncomingDMs: vi.fn(),
  directMessage: vi.fn(),
  close: vi.fn(),
}));

const ssbMock = vi.hoisted(() => ({
  ssbId: "@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ed25519",
  connect: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
  subscribeIncomingDMs: vi.fn(),
  close: vi.fn(),
}));

vi.mock("./nostr", () => ({
  NostrTransport: class {
    constructor() {
      return nostrMock as unknown as object;
    }
  },
}));
vi.mock("./matrix", () => ({
  MatrixTransport: class {
    constructor() {
      return matrixMock as unknown as object;
    }
  },
}));
vi.mock("./ssb", () => ({
  SSBTransport: class {
    constructor() {
      return ssbMock as unknown as object;
    }
  },
  // SEC-003: AegisTransport's SSB fallback in `directMessage` now seals
  // the payload via `sealSsbDm`. The mock returns a deterministic stub
  // ciphertext so tests can assert that the wire shape carries the new
  // fields without doing actual ECDH+AEAD.
  sealSsbDm: vi.fn(async () => "sealed-stub-base64url"),
  openSsbDm: vi.fn(async () => null),
}));

// IMPORTANT: import the facade AFTER `vi.mock` so the mocked transports are
// installed by the time the facade's `import { ... } from "./nostr"` runs.
import { AegisTransport, aegisEventId, canonicalize } from "./index";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function makeIdentity(): Identity {
  const pub = new Uint8Array(33);
  pub[0] = 0x02;
  for (let i = 0; i < 32; i++) pub[i + 1] = i;
  const sec = new Uint8Array(32).fill(7);
  return { pubkey: pub, seckey: sec, createdAt: 1700000000000 };
}

function fullConfig() {
  return {
    nostr: { relays: ["wss://relay.test"] },
    matrix: {
      homeserver: "https://matrix.test",
      registrationToken: "tok",
    },
    ssb: { pubUrl: "wss://ssb.test/aegis-ws" },
  };
}

beforeEach(() => {
  // Reset call history but keep default implementations.
  for (const m of [nostrMock, matrixMock, ssbMock]) {
    for (const v of Object.values(m)) {
      if (typeof v === "function" && "mockClear" in (v as object)) {
        (v as { mockClear: () => void }).mockClear();
      }
    }
  }
  // Re-install the default success behaviours (tests below may override).
  nostrMock.connect.mockImplementation(async () => ["wss://relay.test"]);
  nostrMock.publish.mockImplementation(async () => [
    { relay: "wss://relay.test", ok: true },
  ]);
  nostrMock.subscribe.mockImplementation(() => () => undefined);
  nostrMock.directMessage.mockImplementation(async () => ({
    id: "a".repeat(64),
    pubkey: "a".repeat(64),
    kind: 14,
    created_at: 0,
    tags: [["p", "b".repeat(64)]],
    content: "",
    sig: "0".repeat(128),
  }));
  matrixMock.connect.mockImplementation(async () => undefined);
  matrixMock.createRoom.mockImplementation(async () => "!room:matrix.test");
  matrixMock.sendMessage.mockImplementation(async () => "$evt:matrix.test");
  matrixMock.subscribe.mockImplementation(() => () => undefined);
  matrixMock.directMessage.mockImplementation(async () => "$dm:matrix.test");
  ssbMock.connect.mockImplementation(async () => undefined);
  ssbMock.publish.mockImplementation(async () => ({
    id: "%ssb-msg-id=.sha256",
    sequence: 1,
  }));
  ssbMock.subscribe.mockImplementation(() => () => undefined);
  // subscribeIncomingDMs defaults — return a no-op unsubscribe.
  nostrMock.subscribeIncomingDMs.mockImplementation(() => () => undefined);
  matrixMock.subscribeIncomingDMs.mockImplementation(() => () => undefined);
  ssbMock.subscribeIncomingDMs.mockImplementation(() => () => undefined);
  // close() defaults — each transport returns void.
  nostrMock.close.mockImplementation(async () => undefined);
  matrixMock.close.mockImplementation(async () => undefined);
  ssbMock.close.mockImplementation(async () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* canonicalize                                                                */
/* -------------------------------------------------------------------------- */

describe("canonicalize is order-independent", () => {
  it("produces the same id for two equivalent objects with reordered keys", () => {
    const a = { b: 1, a: 2, nested: { z: [3, 2, 1], y: "yo" } };
    const b = { nested: { y: "yo", z: [3, 2, 1] }, a: 2, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(aegisEventId("alice", "aegis.message", a)).toBe(
      aegisEventId("alice", "aegis.message", b),
    );
  });

  it("differs when content actually differs", () => {
    const a = { x: 1 };
    const b = { x: 2 };
    expect(aegisEventId("alice", "t", a)).not.toBe(
      aegisEventId("alice", "t", b),
    );
  });

  it("differs when sender or type differs even with identical content", () => {
    const c = { x: 1 };
    expect(aegisEventId("alice", "t", c)).not.toBe(
      aegisEventId("bob", "t", c),
    );
    expect(aegisEventId("alice", "t", c)).not.toBe(
      aegisEventId("alice", "u", c),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* publish                                                                     */
/* -------------------------------------------------------------------------- */

describe("AegisTransport.publish", () => {
  it("fans out to every connected network and returns one result per network", async () => {
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const results = await t.publish({
      type: "aegis.message",
      content: { body: "hello" },
    });

    const byNet = Object.fromEntries(results.map((r) => [r.network, r]));
    expect(Object.keys(byNet).sort()).toEqual(["matrix", "nostr", "ssb"]);
    expect(byNet.nostr.ok).toBe(true);
    expect(byNet.matrix.ok).toBe(true);
    expect(byNet.ssb.ok).toBe(true);

    expect(nostrMock.publish).toHaveBeenCalledTimes(1);
    expect(matrixMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(ssbMock.publish).toHaveBeenCalledTimes(1);
  });

  it("returns ok=false for the failing network and ok=true for the rest", async () => {
    matrixMock.sendMessage.mockImplementation(async () => {
      throw new Error("matrix boom");
    });
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const results = await t.publish({
      type: "aegis.message",
      content: { body: "partial" },
    });
    const byNet = Object.fromEntries(results.map((r) => [r.network, r]));
    expect(byNet.matrix.ok).toBe(false);
    expect(byNet.matrix.reason).toContain("matrix boom");
    expect(byNet.nostr.ok).toBe(true);
    expect(byNet.ssb.ok).toBe(true);
  });

  it("honours the `channels` field to restrict the publish set", async () => {
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const results = await t.publish({
      type: "aegis.message",
      content: { body: "only-nostr" },
      channels: ["nostr"],
    });
    expect(results.map((r) => r.network)).toEqual(["nostr"]);
    expect(nostrMock.publish).toHaveBeenCalledTimes(1);
    expect(matrixMock.sendMessage).not.toHaveBeenCalled();
    expect(ssbMock.publish).not.toHaveBeenCalled();
  });

  it("skips a network with no config — no connect attempt, not in results", async () => {
    const t = new AegisTransport(makeIdentity(), {
      nostr: { relays: ["wss://relay.test"] },
    });
    const connected = await t.connect();
    expect(connected).toEqual({ nostr: true, matrix: false, ssb: false });

    const results = await t.publish({
      type: "aegis.message",
      content: { body: "n-only" },
    });
    expect(results.map((r) => r.network)).toEqual(["nostr"]);
    expect(matrixMock.connect).not.toHaveBeenCalled();
    expect(ssbMock.connect).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* subscribe / dedup                                                           */
/* -------------------------------------------------------------------------- */

describe("AegisTransport.subscribe", () => {
  it("dedupes events seen on two networks — onEvent fires exactly once", async () => {
    // Capture the per-transport callbacks so we can drive them directly.
    let nostrCb: ((e: unknown) => void) | null = null;
    let ssbCb: ((m: unknown) => void) | null = null;

    nostrMock.subscribe.mockImplementation((_filter, onEvent) => {
      nostrCb = onEvent as (e: unknown) => void;
      return () => undefined;
    });
    ssbMock.subscribe.mockImplementation((_opts, onMsg) => {
      ssbCb = onMsg as (m: unknown) => void;
      return () => undefined;
    });

    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const received: unknown[] = [];
    t.subscribe({ type: "aegis.message" }, (e) => {
      received.push(e);
    });

    expect(nostrCb).toBeTruthy();
    expect(ssbCb).toBeTruthy();

    // Same sender/type/content delivered via two networks: only one dispatch.
    const senderHex = "c".repeat(64); // Nostr x-only
    const content = { body: "ping", n: 7 };
    nostrCb!({
      id: "n-id",
      pubkey: senderHex,
      created_at: 1700000000,
      kind: 30078,
      tags: [
        ["d", "aegis:aegis.message"],
        ["aegis-type", "aegis.message"],
      ],
      content: JSON.stringify(content),
      sig: "x",
    });
    ssbCb!({
      key: "%abc=.sha256",
      value: {
        author: senderHex,
        sequence: 1,
        timestamp: 1700000000_000,
        content: { type: "aegis-aegis.message", payload: content },
        signature: "sig",
      },
    });

    expect(received).toHaveLength(1);
    const ev = received[0] as { type: string; content: unknown };
    expect(ev.type).toBe("aegis.message");
    expect(ev.content).toEqual(content);
  });

  it("filters out events whose Aegis type doesn't match the subscribe filter", async () => {
    let nostrCb: ((e: unknown) => void) | null = null;
    nostrMock.subscribe.mockImplementation((_filter, onEvent) => {
      nostrCb = onEvent as (e: unknown) => void;
      return () => undefined;
    });
    const t = new AegisTransport(makeIdentity(), {
      nostr: { relays: ["wss://relay.test"] },
    });
    await t.connect();

    const received: unknown[] = [];
    t.subscribe({ type: "aegis.location" }, (e) => {
      received.push(e);
    });

    nostrCb!({
      id: "n1",
      pubkey: "d".repeat(64),
      created_at: 1700000000,
      kind: 30078,
      tags: [
        ["d", "aegis:aegis.message"],
        ["aegis-type", "aegis.message"],
      ],
      content: JSON.stringify({ x: 1 }),
      sig: "x",
    });

    expect(received).toHaveLength(0);
  });

  it("unsubscribe is idempotent and tears down per-network subs", async () => {
    const nostrUnsub = vi.fn();
    const ssbUnsub = vi.fn();
    const matrixUnsub = vi.fn();
    nostrMock.subscribe.mockImplementation(() => nostrUnsub);
    matrixMock.subscribe.mockImplementation(() => matrixUnsub);
    ssbMock.subscribe.mockImplementation(() => ssbUnsub);

    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const unsub = t.subscribe({}, () => undefined);
    unsub();
    unsub(); // second call must not throw and must not double-invoke teardown.

    expect(nostrUnsub).toHaveBeenCalledTimes(1);
    expect(matrixUnsub).toHaveBeenCalledTimes(1);
    expect(ssbUnsub).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* subscribeDM                                                                 */
/* -------------------------------------------------------------------------- */

describe("AegisTransport.subscribeDM", () => {
  it("aggregates incoming DMs across every connected transport", async () => {
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    t.subscribeDM(() => undefined);

    expect(nostrMock.subscribeIncomingDMs).toHaveBeenCalledTimes(1);
    expect(matrixMock.subscribeIncomingDMs).toHaveBeenCalledTimes(1);
    expect(ssbMock.subscribeIncomingDMs).toHaveBeenCalledTimes(1);
  });

  it("skips transports that aren't connected", async () => {
    // Only nostr connects; matrix/ssb absent from config.
    const t = new AegisTransport(makeIdentity(), {
      nostr: { relays: ["wss://relay.test"] },
    });
    await t.connect();

    t.subscribeDM(() => undefined);

    expect(nostrMock.subscribeIncomingDMs).toHaveBeenCalledTimes(1);
    expect(matrixMock.subscribeIncomingDMs).not.toHaveBeenCalled();
    expect(ssbMock.subscribeIncomingDMs).not.toHaveBeenCalled();
  });

  it("dedupes DMs that arrive on two networks — fires the callback once", async () => {
    type DMCb = (dm: {
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
    }) => void;
    let nostrCb: DMCb | null = null;
    let ssbCb: DMCb | null = null;

    nostrMock.subscribeIncomingDMs.mockImplementation((cb: DMCb) => {
      nostrCb = cb;
      return () => undefined;
    });
    ssbMock.subscribeIncomingDMs.mockImplementation((cb: DMCb) => {
      ssbCb = cb;
      return () => undefined;
    });

    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const received: unknown[] = [];
    t.subscribeDM((dm) => received.push(dm));

    expect(nostrCb).toBeTruthy();
    expect(ssbCb).toBeTruthy();

    const from = "c".repeat(64);
    const plaintext = "hello-dup";
    const ts = 1700000000;
    nostrCb!({ from, plaintext, ts, eventId: "n-evt" });
    ssbCb!({ from, plaintext, ts, eventId: "%ssb=.sha256" });

    expect(received).toHaveLength(1);
    const dm = received[0] as { plaintext: string; network: string };
    expect(dm.plaintext).toBe(plaintext);
    // First arrival wins — nostr in this ordering.
    expect(dm.network).toBe("nostr");
  });

  it("does NOT dedupe distinct DMs (different plaintext)", async () => {
    type DMCb = (dm: {
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
    }) => void;
    let nostrCb: DMCb | null = null;
    nostrMock.subscribeIncomingDMs.mockImplementation((cb: DMCb) => {
      nostrCb = cb;
      return () => undefined;
    });

    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const received: unknown[] = [];
    t.subscribeDM((dm) => received.push(dm));

    const from = "c".repeat(64);
    const ts = 1700000000;
    nostrCb!({ from, plaintext: "one", ts, eventId: "a" });
    nostrCb!({ from, plaintext: "two", ts, eventId: "b" });
    expect(received).toHaveLength(2);
  });

  it("unsubscribe propagates to every per-transport listener", async () => {
    const nostrUnsub = vi.fn();
    const matrixUnsub = vi.fn();
    const ssbUnsub = vi.fn();
    nostrMock.subscribeIncomingDMs.mockImplementation(() => nostrUnsub);
    matrixMock.subscribeIncomingDMs.mockImplementation(() => matrixUnsub);
    ssbMock.subscribeIncomingDMs.mockImplementation(() => ssbUnsub);

    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const unsub = t.subscribeDM(() => undefined);
    unsub();
    unsub(); // idempotent — must not double-invoke

    expect(nostrUnsub).toHaveBeenCalledTimes(1);
    expect(matrixUnsub).toHaveBeenCalledTimes(1);
    expect(ssbUnsub).toHaveBeenCalledTimes(1);
  });

  it("surfaces the origin network on each delivered DM", async () => {
    type DMCb = (dm: {
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
    }) => void;
    let matrixCb: DMCb | null = null;
    matrixMock.subscribeIncomingDMs.mockImplementation((cb: DMCb) => {
      matrixCb = cb;
      return () => undefined;
    });

    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const received: { network: string; from: string }[] = [];
    t.subscribeDM((dm) => received.push({ network: dm.network, from: dm.from }));

    matrixCb!({
      from: "@alice:matrix.test",
      plaintext: "matrix-hi",
      ts: 1700000005,
      eventId: "$evt:m.test",
    });

    expect(received).toHaveLength(1);
    expect(received[0].network).toBe("matrix");
    expect(received[0].from).toBe("@alice:matrix.test");
  });
});

/* -------------------------------------------------------------------------- */
/* directMessage fallback chain                                                */
/* -------------------------------------------------------------------------- */

describe("AegisTransport.directMessage", () => {
  it("returns matrix on the happy path", async () => {
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const recipientCompressedHex = "02" + "b".repeat(64); // 66 chars
    const res = await t.directMessage(recipientCompressedHex, "hi");
    expect(res.network).toBe("matrix");
    expect(res.id).toBe("$dm:matrix.test");
    expect(matrixMock.directMessage).toHaveBeenCalledTimes(1);
    expect(nostrMock.directMessage).not.toHaveBeenCalled();
    expect(ssbMock.publish).not.toHaveBeenCalled();
  });

  it("falls through to nostr when matrix throws", async () => {
    matrixMock.directMessage.mockImplementation(async () => {
      throw new Error("matrix down");
    });
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const recipient = "03" + "c".repeat(64); // valid 66-char compressed hex
    const res = await t.directMessage(recipient, "hi");
    expect(res.network).toBe("nostr");
    expect(res.id).toMatch(/^[0-9a-f]{64}$/);
    expect(matrixMock.directMessage).toHaveBeenCalledTimes(1);
    expect(nostrMock.directMessage).toHaveBeenCalledTimes(1);
    // Nostr should have been called with the x-only (64-char) form.
    expect(nostrMock.directMessage.mock.calls[0][0]).toHaveLength(64);
  });

  it("falls through to ssb when matrix and nostr both throw", async () => {
    matrixMock.directMessage.mockImplementation(async () => {
      throw new Error("matrix down");
    });
    nostrMock.directMessage.mockImplementation(async () => {
      throw new Error("nostr down");
    });
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const recipient = "02" + "d".repeat(64);
    const res = await t.directMessage(recipient, "hi");
    expect(res.network).toBe("ssb");
    expect(res.id).toBe("%ssb-msg-id=.sha256");
  });

  it("SEC-003: SSB fallback publishes the sealed envelope (never plaintext)", async () => {
    matrixMock.directMessage.mockImplementation(async () => {
      throw new Error("matrix down");
    });
    nostrMock.directMessage.mockImplementation(async () => {
      throw new Error("nostr down");
    });
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const recipient = "02" + "d".repeat(64);
    await t.directMessage(recipient, "secret plaintext that must not leak");

    expect(ssbMock.publish).toHaveBeenCalledTimes(1);
    const publishedArg = ssbMock.publish.mock.calls[0][0] as {
      type: string;
      to: string;
      from?: unknown;
      sealed?: unknown;
      payload?: unknown;
      ephemeral?: unknown;
    };
    expect(publishedArg.type).toBe("aegis-dm");
    expect(publishedArg.to).toBe(recipient);
    // The new wire format MUST carry `sealed` and `from`; the old
    // `payload: plaintext` field MUST be gone.
    expect(typeof publishedArg.sealed).toBe("string");
    expect(typeof publishedArg.from).toBe("string");
    expect(publishedArg.ephemeral).toBe(false);
    expect(publishedArg.payload).toBeUndefined();
    // Sanity: no plaintext anywhere in the published payload.
    const serialized = JSON.stringify(publishedArg);
    expect(serialized).not.toContain("secret plaintext that must not leak");
  });

  it("throws an aggregate error when every network fails", async () => {
    matrixMock.directMessage.mockImplementation(async () => {
      throw new Error("matrix boom");
    });
    nostrMock.directMessage.mockImplementation(async () => {
      throw new Error("nostr boom");
    });
    ssbMock.publish.mockImplementation(async () => {
      throw new Error("ssb boom");
    });
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();

    const recipient = "02" + "e".repeat(64);
    await expect(t.directMessage(recipient, "hi")).rejects.toThrow(
      /matrix boom[\s\S]*nostr boom[\s\S]*ssb boom/,
    );
  });

  it("skips matrix entirely when no matrix config was supplied", async () => {
    const t = new AegisTransport(makeIdentity(), {
      nostr: { relays: ["wss://relay.test"] },
      ssb: { pubUrl: "wss://ssb.test/aegis-ws" },
    });
    await t.connect();

    const recipient = "02" + "f".repeat(64);
    const res = await t.directMessage(recipient, "hi");
    expect(res.network).toBe("nostr");
    expect(matrixMock.directMessage).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* connect / close                                                             */
/* -------------------------------------------------------------------------- */

describe("AegisTransport.connect", () => {
  it("returns per-network success and continues past failed transports", async () => {
    matrixMock.connect.mockImplementation(async () => {
      throw new Error("homeserver unreachable");
    });
    const t = new AegisTransport(makeIdentity(), fullConfig());
    const status = await t.connect();
    expect(status).toEqual({ nostr: true, matrix: false, ssb: true });
  });

  it("reports nostr=false when zero relays accepted the socket", async () => {
    nostrMock.connect.mockImplementation(async () => []);
    const t = new AegisTransport(makeIdentity(), {
      nostr: { relays: ["wss://offline"] },
    });
    const status = await t.connect();
    expect(status.nostr).toBe(false);
  });
});

describe("AegisTransport.close", () => {
  it("closes every connected transport and swallows individual errors", async () => {
    matrixMock.close.mockImplementation(async () => {
      throw new Error("matrix close error");
    });
    const t = new AegisTransport(makeIdentity(), fullConfig());
    await t.connect();
    await expect(t.close()).resolves.toBeUndefined();
    expect(nostrMock.close).toHaveBeenCalledTimes(1);
    expect(matrixMock.close).toHaveBeenCalledTimes(1);
    expect(ssbMock.close).toHaveBeenCalledTimes(1);
  });
});
