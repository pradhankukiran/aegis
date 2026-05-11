/**
 * Unit tests for the Scribe Yjs ↔ Matrix sync.
 *
 * We don't spin up a real Matrix homeserver — that's the integration tier.
 * Instead we hand `attachMatrixSync` a hand-rolled `AegisTransport`-shaped
 * mock whose `matrix.sendMessage` and `matrix.subscribe` we can drive
 * from the test body. This pins the contract:
 *
 *   - Local Y.Doc mutation → matrix.sendMessage(roomId, { msgtype, body })
 *   - Incoming `m.aegis.scribe.crdt` event → Y.applyUpdate(doc, bytes, "matrix")
 *   - Origin guard: peer-origin updates don't re-broadcast
 *   - Unsubscribe detaches both halves
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { base64UrlToBytes, bytesToBase64Url } from "../crypto/encoding";

import {
  SCRIBE_MATRIX_MSGTYPE,
  SCRIBE_MATRIX_ORIGIN,
  attachMatrixSync,
} from "./crdt";

/* -------------------------------------------------------------------------- */
/* Fake transport                                                              */
/* -------------------------------------------------------------------------- */

type SubscribeFn = (
  opts: { roomId?: string },
  onEvent: (e: {
    type: string;
    roomId: string;
    content: { msgtype?: string; body?: string } | null;
    sender: string;
    eventId: string;
    origin: number;
  }) => void,
) => () => void;

type FakeTransport = {
  matrix: {
    sendMessage: ReturnType<typeof vi.fn>;
    subscribe: SubscribeFn;
  };
  /** Hook so tests can fire a synthetic Matrix event into the subscriber. */
  __emit: (
    ev: {
      type: string;
      roomId: string;
      content: { msgtype?: string; body?: string } | null;
      sender?: string;
      eventId?: string;
      origin?: number;
    },
  ) => void;
  /** Hook so tests can observe + count subscribe attachments. */
  __subscribers: Array<{
    opts: { roomId?: string };
    onEvent: (e: {
      type: string;
      roomId: string;
      content: { msgtype?: string; body?: string } | null;
      sender: string;
      eventId: string;
      origin: number;
    }) => void;
  }>;
};

function makeFakeTransport(): FakeTransport {
  const subscribers: FakeTransport["__subscribers"] = [];
  const sendMessage = vi.fn(async (_roomId: string, _content: object) => {
    void _roomId;
    void _content;
    return "evt-" + Math.random().toString(16).slice(2);
  });
  const t: FakeTransport = {
    matrix: {
      sendMessage,
      subscribe: (opts, onEvent) => {
        const entry = { opts, onEvent };
        subscribers.push(entry);
        return () => {
          const idx = subscribers.indexOf(entry);
          if (idx >= 0) subscribers.splice(idx, 1);
        };
      },
    },
    __emit: (ev) => {
      const full = {
        type: ev.type,
        roomId: ev.roomId,
        content: ev.content,
        sender: ev.sender ?? "@peer:home",
        eventId: ev.eventId ?? "evt-" + Math.random().toString(16).slice(2),
        origin: ev.origin ?? Date.now(),
      };
      for (const s of [...subscribers]) {
        if (s.opts.roomId && s.opts.roomId !== ev.roomId) continue;
        s.onEvent(full);
      }
    },
    __subscribers: subscribers,
  };
  return t;
}

/** Cast our fake into the AegisTransport shape `attachMatrixSync` expects. */
function asTransport(t: FakeTransport): import("../transport").AegisTransport {
  return t as unknown as import("../transport").AegisTransport;
}

/* -------------------------------------------------------------------------- */
/* tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("scribe / crdt — attachMatrixSync", () => {
  let warn: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn?.mockRestore();
    warn = null;
  });

  it("local doc.transact → matrix.sendMessage called with the encoded update", async () => {
    const doc = new Y.Doc();
    const t = makeFakeTransport();
    const detach = attachMatrixSync(doc, asTransport(t), "!room:home");
    try {
      doc.transact(() => {
        doc.getText("content").insert(0, "hello");
      });
      // Yjs fires the `update` event synchronously inside transact.
      expect(t.matrix.sendMessage).toHaveBeenCalledTimes(1);
      const call = t.matrix.sendMessage.mock.calls[0];
      expect(call[0]).toBe("!room:home");
      const sent = call[1] as { msgtype: string; body: string };
      expect(sent.msgtype).toBe(SCRIBE_MATRIX_MSGTYPE);
      expect(typeof sent.body).toBe("string");
      expect(sent.body.length).toBeGreaterThan(0);
      // The body decodes to bytes that, applied to a fresh doc, reproduces
      // the same text — that's the canonical Yjs update contract.
      const bytes = base64UrlToBytes(sent.body);
      const replay = new Y.Doc();
      Y.applyUpdate(replay, bytes);
      expect(replay.getText("content").toString()).toBe("hello");
    } finally {
      detach();
    }
  });

  it("incoming matrix message → Y.applyUpdate brings the local doc up to date", async () => {
    const doc = new Y.Doc();
    const t = makeFakeTransport();
    const detach = attachMatrixSync(doc, asTransport(t), "!room:home");
    try {
      // Build a peer doc with some content, encode its state, and emit it
      // as a synthetic Matrix message.
      const peer = new Y.Doc();
      peer.getText("content").insert(0, "from a peer");
      const update = Y.encodeStateAsUpdate(peer);
      const body = bytesToBase64Url(update);
      t.__emit({
        type: "m.room.message",
        roomId: "!room:home",
        content: { msgtype: SCRIBE_MATRIX_MSGTYPE, body },
      });
      expect(doc.getText("content").toString()).toBe("from a peer");
    } finally {
      detach();
    }
  });

  it("origin guard: applying a 'matrix'-origin update does not echo back to Matrix", async () => {
    const doc = new Y.Doc();
    const t = makeFakeTransport();
    const detach = attachMatrixSync(doc, asTransport(t), "!room:home");
    try {
      // Hand-craft a peer update and apply it with the "matrix" origin —
      // that's what the inbound branch does. The outbound handler must
      // skip this update so we don't re-publish what the peer just sent.
      const peer = new Y.Doc();
      peer.getText("content").insert(0, "loopback");
      const update = Y.encodeStateAsUpdate(peer);
      Y.applyUpdate(doc, update, SCRIBE_MATRIX_ORIGIN);
      expect(doc.getText("content").toString()).toBe("loopback");
      expect(t.matrix.sendMessage).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it("ignores events with the wrong room id, msgtype, or body shape", async () => {
    const doc = new Y.Doc();
    const t = makeFakeTransport();
    const detach = attachMatrixSync(doc, asTransport(t), "!room:home");
    try {
      // Wrong msgtype.
      t.__emit({
        type: "m.room.message",
        roomId: "!room:home",
        content: { msgtype: "m.text", body: "hi" },
      });
      // Missing body (matrix-js-sdk sometimes hands us partial decrypts).
      t.__emit({
        type: "m.room.message",
        roomId: "!room:home",
        content: { msgtype: SCRIBE_MATRIX_MSGTYPE },
      });
      // Wrong event type (e.g. m.reaction).
      t.__emit({
        type: "m.reaction",
        roomId: "!room:home",
        content: { msgtype: SCRIBE_MATRIX_MSGTYPE, body: "AAA" },
      });
      // Wrong roomId — our subscribe filter should swallow it, but the
      // inner handler guards anyway.
      t.__emit({
        type: "m.room.message",
        roomId: "!other:home",
        content: { msgtype: SCRIBE_MATRIX_MSGTYPE, body: "AAA" },
      });
      // None of these should have changed the doc.
      expect(doc.getText("content").toString()).toBe("");
      // Malformed base64 — should log a warning but not throw.
      t.__emit({
        type: "m.room.message",
        roomId: "!room:home",
        content: { msgtype: SCRIBE_MATRIX_MSGTYPE, body: "###not-base64###" },
      });
      expect(doc.getText("content").toString()).toBe("");
    } finally {
      detach();
    }
  });

  it("detach() stops further send + listen", async () => {
    const doc = new Y.Doc();
    const t = makeFakeTransport();
    const detach = attachMatrixSync(doc, asTransport(t), "!room:home");

    // Sanity: subscription registered.
    expect(t.__subscribers.length).toBe(1);
    detach();
    expect(t.__subscribers.length).toBe(0);

    // After detach, local mutations don't fire matrix.sendMessage.
    doc.getText("content").insert(0, "after-detach");
    expect(t.matrix.sendMessage).not.toHaveBeenCalled();

    // detach() is idempotent.
    expect(() => detach()).not.toThrow();
  });

  it("round trip: peer A → peer B → peer A is stable (no oscillation)", async () => {
    // Two docs sharing a single fake room: each one's sendMessage forwards
    // into the other's __emit. This is the canonical "two browsers in a
    // shared note" topology, exercised end-to-end without a real Matrix
    // homeserver.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const tA = makeFakeTransport();
    const tB = makeFakeTransport();

    // Wire A's outbound into B's inbound, and vice versa. The shared room
    // is "!shared:home" on both sides.
    tA.matrix.sendMessage = vi.fn(async (_room, content) => {
      tB.__emit({
        type: "m.room.message",
        roomId: "!shared:home",
        content: content as { msgtype?: string; body?: string },
      });
      return "evt-from-a";
    });
    tB.matrix.sendMessage = vi.fn(async (_room, content) => {
      tA.__emit({
        type: "m.room.message",
        roomId: "!shared:home",
        content: content as { msgtype?: string; body?: string },
      });
      return "evt-from-b";
    });

    const detachA = attachMatrixSync(docA, asTransport(tA), "!shared:home");
    const detachB = attachMatrixSync(docB, asTransport(tB), "!shared:home");
    try {
      docA.transact(() => {
        docA.getText("content").insert(0, "AA");
      });
      // A → B applied.
      expect(docB.getText("content").toString()).toBe("AA");
      docB.transact(() => {
        docB.getText("content").insert(2, "BB");
      });
      // B → A applied.
      expect(docA.getText("content").toString()).toBe("AABB");

      // No infinite oscillation: each peer sent exactly one update for
      // their own transact (the inbound applies under "matrix" origin and
      // the outbound handler skips it).
      expect(tA.matrix.sendMessage).toHaveBeenCalledTimes(1);
      expect(tB.matrix.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      detachA();
      detachB();
    }
  });
});
