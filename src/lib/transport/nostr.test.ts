/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the Nostr transport wrapper. We deliberately avoid any tests
 * that require live relays — the `SimplePool` is exercised indirectly via the
 * pubkey accessor, the BIP-340 signing path, and the NIP-44 v2 round-trip.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import * as nip44 from "nostr-tools/nip44";
import { describe, expect, it, vi } from "vitest";

import { hexToBytes, utf8Encode } from "../crypto";
import { generateIdentity, pubkeyHex } from "../identity";

import { NostrTransport } from "./nostr";

describe("NostrTransport / pubkey accessor", () => {
  it("returns 64-char x-only hex (parity byte stripped)", async () => {
    const id = await generateIdentity();
    const t = new NostrTransport(id);
    expect(t.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the x-coordinate of the identity's compressed pubkey", async () => {
    const id = await generateIdentity();
    const t = new NostrTransport(id);
    // Compressed pubkey is 33 bytes (66 hex chars): parity byte + 32-byte x.
    const fullHex = pubkeyHex(id);
    expect(fullHex.length).toBe(66);
    const parityByte = fullHex.slice(0, 2);
    const xOnlyExpected = fullHex.slice(2);
    expect(["02", "03"]).toContain(parityByte);
    expect(t.pubkey).toBe(xOnlyExpected);
  });

  it("two distinct identities produce two distinct x-only pubkeys", async () => {
    const a = new NostrTransport(await generateIdentity());
    const b = new NostrTransport(await generateIdentity());
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});

describe("NostrTransport / drop-byte conversion", () => {
  // Black-box check: build several identities, verify the public conversion
  // logic is exactly "strip the first byte" of the 33-byte compressed key.
  // Catches accidental endianness flips, off-by-one slicing, double parity
  // stripping, etc.
  it("strips the SEC1 parity byte; the rest is the literal x coordinate", async () => {
    for (let i = 0; i < 8; i++) {
      const id = await generateIdentity();
      const t = new NostrTransport(id);
      // Hand-rolled drop-byte: first byte gone, hex of the remaining 32.
      const tail = id.pubkey.subarray(1);
      let expected = "";
      for (const b of tail) expected += b.toString(16).padStart(2, "0");
      expect(t.pubkey).toBe(expected);
      expect(t.pubkey.length).toBe(64);
    }
  });
});

describe("NostrTransport / NIP-44 v2 round-trip", () => {
  it("encrypts on Alice's side and decrypts on Bob's side", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();

    const aliceT = new NostrTransport(alice);
    const bobT = new NostrTransport(bob);

    // Build a kind-14 event ourselves so we don't need a live pool. We
    // mirror what `directMessage` does internally:
    const plaintext = "hi bob, this is alice — meet at midnight";
    const aliceConvKey = nip44.v2.utils.getConversationKey(
      alice.seckey,
      bobT.pubkey,
    );
    const ciphertext = nip44.v2.encrypt(plaintext, aliceConvKey);

    // Construct an unsigned-but-shape-correct event Bob will see on the wire.
    // The id/sig fields aren't validated by `decryptDirectMessage` — the
    // wrapper only needs the pubkey + content + tags fields — so we can
    // populate placeholders for the shape.
    const event = {
      id: "0".repeat(64),
      pubkey: aliceT.pubkey,
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", bobT.pubkey]],
      content: ciphertext,
      sig: "0".repeat(128),
    };

    const decrypted = await bobT.decryptDirectMessage(event);
    expect(decrypted).toBe(plaintext);
  });

  it("decrypts an outgoing event using the `p` tag as the counterparty", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceT = new NostrTransport(alice);
    const bobT = new NostrTransport(bob);

    const plaintext = "alice talking to herself about bob";
    const convKey = nip44.v2.utils.getConversationKey(
      alice.seckey,
      bobT.pubkey,
    );
    const ciphertext = nip44.v2.encrypt(plaintext, convKey);

    // Outbox view of a message Alice sent to Bob: pubkey is Alice's own,
    // counterparty is read off the `p` tag.
    const event = {
      id: "0".repeat(64),
      pubkey: aliceT.pubkey,
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", bobT.pubkey]],
      content: ciphertext,
      sig: "0".repeat(128),
    };

    const decrypted = await aliceT.decryptDirectMessage(event);
    expect(decrypted).toBe(plaintext);
  });

  it("throws if the toPubkey is not 64-char hex", async () => {
    const id = await generateIdentity();
    const t = new NostrTransport(id);
    await expect(t.directMessage("not-hex", "hi")).rejects.toThrow();
    await expect(
      t.directMessage("0".repeat(63), "hi"), // wrong length
    ).rejects.toThrow();
    await expect(
      t.directMessage("Z".repeat(64), "hi"), // non-hex char
    ).rejects.toThrow();
  });
});

describe("NostrTransport / subscribeIncomingDMs", () => {
  it("decrypts a kind-14 DM and surfaces from/plaintext/ts/eventId", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceT = new NostrTransport(alice);
    const bobT = new NostrTransport(bob);

    // Stub Bob's NostrTransport.subscribe so we can drive an inbound event
    // without a real relay pool.
    type SubscribeFn = NostrTransport["subscribe"];
    let captured:
      | Parameters<SubscribeFn>[1]
      | null = null;
    const subscribeSpy = vi
      .spyOn(bobT as unknown as { subscribe: SubscribeFn }, "subscribe")
      .mockImplementation((_filter, onEvent) => {
        captured = onEvent;
        return () => undefined;
      });

    const received: Array<{
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
    }> = [];
    bobT.subscribeIncomingDMs((dm) => received.push(dm));

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    // The filter should be kinds=[14], #p=[bob.pubkey].
    const filter = subscribeSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.kinds).toEqual([14]);
    expect(filter["#p"]).toEqual([bobT.pubkey]);

    // Encrypt a payload as Alice would, then drive Bob's captured callback.
    const plaintext = "from alice to bob";
    const convKey = nip44.v2.utils.getConversationKey(
      alice.seckey,
      bobT.pubkey,
    );
    const ciphertext = nip44.v2.encrypt(plaintext, convKey);
    const event = {
      id: "e".repeat(64),
      pubkey: aliceT.pubkey,
      kind: 14,
      created_at: 1700000000,
      tags: [["p", bobT.pubkey]],
      content: ciphertext,
      sig: "0".repeat(128),
    };

    captured!(event);

    // Decrypt happens asynchronously through a Promise — let it settle.
    await waitForCondition(() => received.length > 0, 200);

    expect(received).toHaveLength(1);
    expect(received[0].from).toBe(aliceT.pubkey);
    expect(received[0].plaintext).toBe(plaintext);
    expect(received[0].ts).toBe(1700000000);
    expect(received[0].eventId).toBe("e".repeat(64));
  });

  it("skips events authored by us (no self-echo)", async () => {
    const me = await generateIdentity();
    const meT = new NostrTransport(me);

    type SubscribeFn = NostrTransport["subscribe"];
    let captured:
      | Parameters<SubscribeFn>[1]
      | null = null;
    vi.spyOn(
      meT as unknown as { subscribe: SubscribeFn },
      "subscribe",
    ).mockImplementation((_filter, onEvent) => {
      captured = onEvent;
      return () => undefined;
    });

    const received: unknown[] = [];
    meT.subscribeIncomingDMs((dm) => received.push(dm));

    captured!({
      id: "f".repeat(64),
      pubkey: meT.pubkey, // ourselves
      kind: 14,
      created_at: 1700000000,
      tags: [["p", meT.pubkey]],
      content: "doesn't matter — should be skipped before decrypt",
      sig: "0".repeat(128),
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(received).toEqual([]);
  });

  it("swallows decrypt failures without crashing the subscription", async () => {
    const me = await generateIdentity();
    const meT = new NostrTransport(me);

    type SubscribeFn = NostrTransport["subscribe"];
    let captured:
      | Parameters<SubscribeFn>[1]
      | null = null;
    vi.spyOn(
      meT as unknown as { subscribe: SubscribeFn },
      "subscribe",
    ).mockImplementation((_filter, onEvent) => {
      captured = onEvent;
      return () => undefined;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const received: unknown[] = [];
    meT.subscribeIncomingDMs((dm) => received.push(dm));

    // Bogus ciphertext authored by a fake "other" pubkey.
    captured!({
      id: "0".repeat(64),
      pubkey: "1".repeat(64),
      kind: 14,
      created_at: 1700000000,
      tags: [["p", meT.pubkey]],
      content: "not a valid nip44 v2 ciphertext",
      sig: "0".repeat(128),
    });

    // Let the rejection settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns an unsubscribe closure that detaches the underlying sub", async () => {
    const me = await generateIdentity();
    const meT = new NostrTransport(me);

    type SubscribeFn = NostrTransport["subscribe"];
    const innerUnsub = vi.fn();
    vi.spyOn(
      meT as unknown as { subscribe: SubscribeFn },
      "subscribe",
    ).mockImplementation(() => innerUnsub);

    const unsub = meT.subscribeIncomingDMs(() => undefined);
    unsub();
    expect(innerUnsub).toHaveBeenCalledTimes(1);
  });
});

async function waitForCondition(
  predicate: () => boolean,
  budgetMs: number,
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

describe("NostrTransport / BIP-340 signing", () => {
  // We exercise the private signEvent via directMessage-like build:
  // construct an event input, route it through publish (with no relays
  // connected, publish becomes a no-op fan-out) and verify by re-deriving
  // the id and checking the signature with @noble/curves' BIP-340 verify.
  //
  // Since signEvent is private, we can't call it directly. Instead we
  // exercise the public `directMessage` which builds + signs an event,
  // then verify the returned signed event.
  it("produces a verifiable BIP-340 signature on the returned event", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceT = new NostrTransport(alice);
    const bobT = new NostrTransport(bob);

    // No `connect()` — this is purely the signing path. Publish is a no-op
    // when no relays are connected, so we don't touch the network.
    const event = await aliceT.directMessage(bobT.pubkey, "hello, world");

    // Shape checks.
    expect(event.kind).toBe(14);
    expect(event.pubkey).toBe(aliceT.pubkey);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(event.tags).toContainEqual(["p", bobT.pubkey]);

    // BIP-340 verification: schnorr.verify(sig, msg, pubkey).
    const valid = schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
    expect(valid).toBe(true);
  });

  it("event id matches SHA-256 of the canonical serialization", async () => {
    // Belt-and-braces: independently compute the id and ensure it matches.
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceT = new NostrTransport(alice);
    const bobT = new NostrTransport(bob);

    const event = await aliceT.directMessage(bobT.pubkey, "verify-the-id");
    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content,
    ]);
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const idBytes = sha256(utf8Encode(serialized));
    let expected = "";
    for (const b of idBytes) expected += b.toString(16).padStart(2, "0");
    expect(event.id).toBe(expected);
  });

  it("flipping one bit of the signature makes it invalid", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceT = new NostrTransport(alice);
    const bobT = new NostrTransport(bob);

    const event = await aliceT.directMessage(bobT.pubkey, "tamper-me");
    const sig = hexToBytes(event.sig);
    sig[0] ^= 0x01;
    const valid = schnorr.verify(
      sig,
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
    expect(valid).toBe(false);
  });
});
