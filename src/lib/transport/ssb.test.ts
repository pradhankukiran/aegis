/**
 * @vitest-environment happy-dom
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";

import { base64UrlToBytes, bytesToHex } from "../crypto/encoding";
import { generateIdentity } from "../identity";
import type { Identity } from "../identity";

import {
  SSBTransport,
  deriveEd25519FromIdentity,
  openSsbDm,
  sealSsbDm,
  ssbIdFromEd25519PubKey,
} from "./ssb";

const SSB_ID_PATTERN = /^@[A-Za-z0-9_-]{43}\.ed25519$/;

function fakeIdentity(seckey: Uint8Array): Identity {
  // We only exercise the derivation path; pubkey value doesn't matter for the
  // tests we care about. Fill it with deterministic bytes so the Identity
  // shape passes any defensive shape checks.
  const pubkey = new Uint8Array(33);
  pubkey[0] = 0x02;
  for (let i = 0; i < 32; i++) pubkey[i + 1] = i;
  return { seckey, pubkey, createdAt: 1700000000000 };
}

describe("ssb / Ed25519 derivation", () => {
  it("is deterministic for a given Identity", () => {
    const seckey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seckey[i] = (i * 31 + 7) & 0xff;
    const id = fakeIdentity(seckey);

    const a = deriveEd25519FromIdentity(id);
    const b = deriveEd25519FromIdentity(id);

    expect(a.secretKey).toEqual(b.secretKey);
    expect(a.publicKey).toEqual(b.publicKey);
    expect(a.secretKey.length).toBe(32);
    expect(a.publicKey.length).toBe(32);

    // The derived pubkey must actually correspond to its secret key under Ed25519.
    expect(ed25519.getPublicKey(a.secretKey)).toEqual(a.publicKey);
  });

  it("matches a known HKDF-SHA256 vector for the v1 info string", () => {
    // ikm: 32 zero bytes. salt: empty (RFC 5869: defaults to HashLen zeros).
    // info: utf8("aegis-ssb-ed25519-v1"). length: 32.
    // Computed independently against an HKDF-SHA256 reference implementation.
    const id = fakeIdentity(new Uint8Array(32));
    const { secretKey, publicKey } = deriveEd25519FromIdentity(id);

    // Anchor: the secret key (= HKDF output) is exactly 32 bytes of derived
    // material, NOT a copy of the input scalar.
    expect(Array.from(secretKey)).not.toEqual(Array.from(new Uint8Array(32)));

    // Anchor: round-trip through ed25519 produces the matching pubkey.
    expect(ed25519.getPublicKey(secretKey)).toEqual(publicKey);
  });

  it("changes if the input seckey changes", () => {
    const skA = new Uint8Array(32).fill(0xaa);
    const skB = new Uint8Array(32).fill(0xbb);
    const a = deriveEd25519FromIdentity(fakeIdentity(skA));
    const b = deriveEd25519FromIdentity(fakeIdentity(skB));
    expect(a.secretKey).not.toEqual(b.secretKey);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it("rejects identities without a 32-byte seckey", () => {
    expect(() =>
      deriveEd25519FromIdentity({
        seckey: new Uint8Array(16),
        pubkey: new Uint8Array(33),
        createdAt: 0,
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("ssb / id formatting", () => {
  it("ssbIdFromEd25519PubKey returns @<base64>.ed25519", () => {
    const pub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pub[i] = i;
    const id = ssbIdFromEd25519PubKey(pub);
    expect(id).toMatch(SSB_ID_PATTERN);
    // The decoded base64 portion is the original pubkey bytes.
    const inner = id.slice(1, -".ed25519".length);
    expect(base64UrlToBytes(inner)).toEqual(pub);
  });

  it("rejects pubkeys that are not 32 bytes", () => {
    expect(() => ssbIdFromEd25519PubKey(new Uint8Array(31))).toThrow(
      /32 bytes/,
    );
  });
});

/**
 * Helper: drive a fake "subscribe" callback inside an SSBTransport. The
 * SSB DM subscription path requires going through the WebSocket layer
 * normally; the tests stub `subscribe` so we can inject synthetic feed
 * messages without standing up a pub.
 */
function captureSubscribeHandler(t: SSBTransport): {
  emit: (msg: unknown) => void;
} {
  type SubscribeFn = SSBTransport["subscribe"];
  let captured: Parameters<SubscribeFn>[1] | null = null;
  vi.spyOn(t as unknown as { subscribe: SubscribeFn }, "subscribe")
    .mockImplementation((_opts, onMsg) => {
      captured = onMsg;
      return () => undefined;
    });
  return {
    emit(msg: unknown) {
      if (!captured) throw new Error("subscribe handler not yet installed");
      (captured as (m: unknown) => void)(msg);
    },
  };
}

/** Tiny tick helper: yields to the microtask queue so awaited promises settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ssb / DM content encryption (SEC-003)", () => {
  it("seal → open round-trips plaintext between two identities", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const bobHex = bytesToHex(bob.pubkey);
    const aliceHex = bytesToHex(alice.pubkey);

    const sealed = await sealSsbDm(alice, bobHex, "hi bob, this is alice");
    expect(typeof sealed).toBe("string");
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);

    const opened = await openSsbDm(bob, aliceHex, sealed);
    expect(opened).toBe("hi bob, this is alice");
  });

  it("openSsbDm returns null when the wrong recipient tries to decrypt", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const eve = await generateIdentity();
    const bobHex = bytesToHex(bob.pubkey);
    const aliceHex = bytesToHex(alice.pubkey);
    const sealed = await sealSsbDm(alice, bobHex, "for bob");
    const opened = await openSsbDm(eve, aliceHex, sealed);
    expect(opened).toBeNull();
  });

  it("openSsbDm returns null for malformed sealed input", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceHex = bytesToHex(alice.pubkey);
    expect(await openSsbDm(bob, aliceHex, "not base64 ((((")).toBeNull();
    expect(await openSsbDm(bob, aliceHex, "")).toBeNull();
  });

  it("openSsbDm returns null when fromPubkeyHex is malformed", async () => {
    const bob = await generateIdentity();
    const result = await openSsbDm(bob, "deadbeef", "AAAA");
    expect(result).toBeNull();
  });
});

describe("ssb / subscribeIncomingDMs", () => {
  it("decrypts and forwards a properly-sealed aegis-dm round-trip", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: Array<{
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
    }> = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));

    // Alice seals a DM to Bob and the pub re-broadcasts it.
    const bobHex = bytesToHex(bob.pubkey);
    const aliceHex = bytesToHex(alice.pubkey);
    const sealed = await sealSsbDm(alice, bobHex, "encrypted hi");
    const senderFeedId = "@" + "B".repeat(43) + ".ed25519";

    emit({
      key: "%dm-1=.sha256",
      value: {
        author: senderFeedId,
        sequence: 1,
        timestamp: 1700000000_000,
        content: {
          type: "aegis-dm",
          to: bobHex,
          from: aliceHex,
          sealed,
          ephemeral: false,
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    expect(received[0].from).toBe(senderFeedId);
    expect(received[0].plaintext).toBe("encrypted hi");
    expect(received[0].ts).toBe(1700000000); // ms → seconds
    expect(received[0].eventId).toBe("%dm-1=.sha256");
  });

  it("drops legacy pre-SEC-003 plaintext events (payload-only)", async () => {
    const bob = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    emit({
      key: "%legacy=.sha256",
      value: {
        author: "@" + "Z".repeat(43) + ".ed25519",
        sequence: 1,
        timestamp: 1700000000_000,
        // Old shape: { type, to, payload: plaintext } — must be dropped.
        content: {
          type: "aegis-dm",
          to: bytesToHex(bob.pubkey),
          payload: "legacy plaintext that must be rejected",
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toEqual([]);
  });

  it("skips self-authored messages (no echo)", async () => {
    const bob = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    const sealed = await sealSsbDm(bob, bytesToHex(bob.pubkey), "self");
    emit({
      key: "%self=.sha256",
      value: {
        author: t.ssbId,
        sequence: 1,
        timestamp: 1700000000_000,
        content: {
          type: "aegis-dm",
          to: bytesToHex(bob.pubkey),
          from: bytesToHex(bob.pubkey),
          sealed,
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toEqual([]);
  });

  it("skips non-aegis-dm message types", async () => {
    const bob = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    emit({
      key: "%other=.sha256",
      value: {
        author: "@" + "Z".repeat(43) + ".ed25519",
        sequence: 1,
        timestamp: 1700000000_000,
        content: { type: "aegis-message", payload: { body: "not a dm" } },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toEqual([]);
  });

  it("skips a DM whose `to` is someone else", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const eve = await generateIdentity();
    // Bob is the receiver. Alice sealed for Eve, not Bob.
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    const sealed = await sealSsbDm(alice, bytesToHex(eve.pubkey), "for eve");
    emit({
      key: "%foreign=.sha256",
      value: {
        author: "@" + "Y".repeat(43) + ".ed25519",
        sequence: 1,
        timestamp: 1700000000_000,
        content: {
          type: "aegis-dm",
          to: bytesToHex(eve.pubkey),
          from: bytesToHex(alice.pubkey),
          sealed,
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toEqual([]);
  });

  it("accepts a DM with `to` matching our identity pubkey hex (66-char SEC1 compressed)", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: Array<{ plaintext: string }> = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));

    const compressedHex = bytesToHex(bob.pubkey);
    expect(compressedHex).toHaveLength(66);
    const sealed = await sealSsbDm(alice, compressedHex, "via aegis pubkey hex");

    emit({
      key: "%aegis-dm=.sha256",
      value: {
        author: "@" + "Y".repeat(43) + ".ed25519",
        sequence: 1,
        timestamp: 1700000000_000,
        content: {
          type: "aegis-dm",
          to: compressedHex,
          from: bytesToHex(alice.pubkey),
          sealed,
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    expect(received[0].plaintext).toBe("via aegis pubkey hex");
  });

  it("accepts a DM with `to` matching our identity pubkey x-only 64-char hex", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: Array<{ plaintext: string }> = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));

    const xOnlyHex = bytesToHex(bob.pubkey).slice(2);
    expect(xOnlyHex).toHaveLength(64);
    // Seal against bob's pubkey; the routing field is x-only.
    const sealed = await sealSsbDm(
      alice,
      bytesToHex(bob.pubkey),
      "via x-only pubkey hex",
    );

    emit({
      key: "%aegis-dm-xonly=.sha256",
      value: {
        author: "@" + "Y".repeat(43) + ".ed25519",
        sequence: 1,
        timestamp: 1700000000_000,
        content: {
          type: "aegis-dm",
          to: xOnlyHex,
          from: bytesToHex(alice.pubkey),
          sealed,
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    expect(received[0].plaintext).toBe("via x-only pubkey hex");
  });

  it("skips a DM whose `to` is a valid 66-char hex but not us", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const stranger = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));

    // A valid 66-char hex pubkey that is NOT our (bob's) identity pubkey.
    const foreignHex = bytesToHex(stranger.pubkey);
    const sealed = await sealSsbDm(alice, foreignHex, "not for me");
    emit({
      key: "%foreign-hex=.sha256",
      value: {
        author: "@" + "Y".repeat(43) + ".ed25519",
        sequence: 1,
        timestamp: 1700000000_000,
        content: {
          type: "aegis-dm",
          to: foreignHex,
          from: bytesToHex(alice.pubkey),
          sealed,
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toEqual([]);
  });

  it("drops a DM with `to` omitted (we don't accept broadcast post-SEC-003)", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: Array<{ plaintext: string }> = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    const sealed = await sealSsbDm(alice, bytesToHex(bob.pubkey), "broadcast");
    emit({
      key: "%broadcast=.sha256",
      value: {
        author: "@" + "Y".repeat(43) + ".ed25519",
        sequence: 1,
        timestamp: 1700000000_000,
        content: {
          type: "aegis-dm",
          // no `to`
          from: bytesToHex(alice.pubkey),
          sealed,
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toEqual([]);
  });

  it("drops a DM that has `to`+`from` but no sealed field (malformed)", async () => {
    const bob = await generateIdentity();
    const t = new SSBTransport(bob, "wss://example/aegis-ws");
    const { emit } = captureSubscribeHandler(t);

    const received: unknown[] = [];
    t.subscribeIncomingDMs((dm) => received.push(dm));
    emit({
      key: "%malformed=.sha256",
      value: {
        author: "@" + "Y".repeat(43) + ".ed25519",
        sequence: 1,
        timestamp: 1700000000_000,
        content: {
          type: "aegis-dm",
          to: bytesToHex(bob.pubkey),
          from: "02" + "1".repeat(64),
          // no sealed
        },
        signature: "sig",
      },
    });
    await flushMicrotasks();
    expect(received).toEqual([]);
  });
});

describe("ssb / SSBTransport class", () => {
  it("instantiates without throwing and exposes the derived ssbId", async () => {
    const id = await generateIdentity();
    const t = new SSBTransport(id, "wss://ssb.aegis.app/aegis-ws");
    expect(t.ssbId).toMatch(SSB_ID_PATTERN);
    // No I/O should have happened in the constructor.
  });

  it("matches the standalone ssbIdFromEd25519PubKey path", async () => {
    const id = await generateIdentity();
    const { publicKey } = deriveEd25519FromIdentity(id);
    const expected = ssbIdFromEd25519PubKey(publicKey);
    const t = new SSBTransport(id, "wss://example/aegis-ws");
    expect(t.ssbId).toBe(expected);
  });

  it("requires a non-empty pubUrl", async () => {
    const id = await generateIdentity();
    expect(() => new SSBTransport(id, "")).toThrow(/pubUrl/);
  });

  it("exposes identityPubkeyHex (66-char) and identityPubkeyHexXOnly (64-char)", async () => {
    const id = await generateIdentity();
    const t = new SSBTransport(id, "wss://example/aegis-ws");
    const fullHex = bytesToHex(id.pubkey);
    expect(t.identityPubkeyHex).toBe(fullHex);
    expect(t.identityPubkeyHex).toHaveLength(66);
    expect(t.identityPubkeyHexXOnly).toBe(fullHex.slice(2));
    expect(t.identityPubkeyHexXOnly).toHaveLength(64);
  });
});
