import { describe, expect, it } from "vitest";

import { generateIdentity } from "../identity";
import type {
  AegisEventInput,
  AegisTransport,
  PublishResult,
} from "../transport";

import {
  anchorDigest,
  isValidHash,
  normalizeHash,
  publishAnchor,
  signAnchor,
  signerHexFromIdentity,
  witnessNostrDTag,
} from "./anchor";
import type { Anchor } from "./types";
import { WITNESS_EVENT_TYPE } from "./types";
import { verifySignature } from "./verify";

/* ---------------------------------------------------------------------------
 * signAnchor + verifySignature round-trip
 * --------------------------------------------------------------------------
 * The signer-side and verifier-side code MUST agree on the canonical digest.
 * These tests pin the round-trip and prove that any single-bit tamper to
 * `hash`, `ts`, `sig`, or `signer` breaks verification.
 * ------------------------------------------------------------------------ */

const SAMPLE_HASH =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // sha256("abc")
const SAMPLE_HASH_B =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // sha256("")

describe("witness / anchor", () => {
  it("anchorDigest is deterministic for a (hash, ts) pair", () => {
    const a = anchorDigest(SAMPLE_HASH, 100);
    const b = anchorDigest(SAMPLE_HASH, 100);
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it("anchorDigest differs when ts changes", () => {
    const a = anchorDigest(SAMPLE_HASH, 100);
    const b = anchorDigest(SAMPLE_HASH, 101);
    expect(a).not.toEqual(b);
  });

  it("signerHexFromIdentity strips the SEC1 parity byte (64 hex chars)", async () => {
    const id = await generateIdentity();
    const hex = signerHexFromIdentity(id);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signAnchor + verifySignature round-trip succeeds", async () => {
    const id = await generateIdentity();
    const anchor = signAnchor(id, SAMPLE_HASH, 1_700_000_000);
    expect(anchor.hash).toBe(SAMPLE_HASH);
    expect(anchor.ts).toBe(1_700_000_000);
    expect(anchor.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(anchor.signer).toBe(signerHexFromIdentity(id));
    expect(verifySignature(anchor)).toBe(true);
  });

  it("verifySignature fails when the hash is tampered post-signing", async () => {
    const id = await generateIdentity();
    const anchor = signAnchor(id, SAMPLE_HASH, 1_700_000_000);
    const tampered = { ...anchor, hash: SAMPLE_HASH_B };
    expect(verifySignature(tampered)).toBe(false);
  });

  it("verifySignature fails when ts is tampered post-signing", async () => {
    const id = await generateIdentity();
    const anchor = signAnchor(id, SAMPLE_HASH, 1_700_000_000);
    const tampered = { ...anchor, ts: 1_700_000_001 };
    expect(verifySignature(tampered)).toBe(false);
  });

  it("verifySignature fails when sig bits are flipped", async () => {
    const id = await generateIdentity();
    const anchor = signAnchor(id, SAMPLE_HASH, 1_700_000_000);
    // Flip the leading nibble of the signature hex.
    const flipped =
      (parseInt(anchor.sig[0], 16) ^ 0x1).toString(16) + anchor.sig.slice(1);
    expect(verifySignature({ ...anchor, sig: flipped })).toBe(false);
  });

  it("verifySignature fails when the signer is a different identity", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const anchor = signAnchor(a, SAMPLE_HASH, 1_700_000_000);
    const wrongSigner = { ...anchor, signer: signerHexFromIdentity(b) };
    expect(verifySignature(wrongSigner)).toBe(false);
  });

  it("verifySignature rejects malformed shapes without throwing", () => {
    expect(verifySignature({} as never)).toBe(false);
    expect(
      verifySignature({
        hash: "short",
        sig: "x".repeat(128),
        signer: "x".repeat(64),
        ts: 1,
      } as never),
    ).toBe(false);
    expect(
      verifySignature({
        hash: SAMPLE_HASH,
        sig: "x".repeat(127),
        signer: "x".repeat(64),
        ts: 1,
      } as never),
    ).toBe(false);
  });

  it("isValidHash accepts 64-hex and 0x-prefixed forms", () => {
    expect(isValidHash(SAMPLE_HASH)).toBe(true);
    expect(isValidHash("0x" + SAMPLE_HASH)).toBe(true);
    expect(isValidHash(SAMPLE_HASH.toUpperCase())).toBe(true);
    expect(isValidHash("abc")).toBe(false);
    expect(isValidHash(SAMPLE_HASH + "00")).toBe(false);
  });

  it("normalizeHash canonicalizes to 64 lowercase hex", () => {
    expect(normalizeHash(SAMPLE_HASH.toUpperCase())).toBe(SAMPLE_HASH);
    expect(normalizeHash("0x" + SAMPLE_HASH.toUpperCase())).toBe(SAMPLE_HASH);
    expect(normalizeHash("  " + SAMPLE_HASH + "  ")).toBe(SAMPLE_HASH);
    expect(() => normalizeHash("zz")).toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * publishAnchor — per-hash NIP-78 d-tag
 * --------------------------------------------------------------------------
 * The replaceable-event problem: NIP-78 (kind 30078) keeps only the latest
 * event per (pubkey, d-tag) tuple. If two anchors share a d-tag, the second
 * overwrites the first on the relay. Witness anchors must persist, so we
 * stamp a per-hash d-tag and verify here that the publish call lands the
 * expected tag shape — and that two anchors get *distinct* d-tags.
 * ------------------------------------------------------------------------ */

/**
 * Minimal stub of `AegisTransport` that captures every `publish` invocation
 * (facade + native-nostr) without actually opening a socket. The shape only
 * implements the surface `publishAnchor` touches.
 */
class StubTransport {
  /** Captured calls into the facade's cross-network `publish`. */
  public facadeCalls: AegisEventInput[] = [];
  /** Captured calls into the native nostr.publish (per-hash d-tag path). */
  public nostrCalls: Array<{
    kind: number;
    content: string;
    tags: string[][];
  }> = [];

  public nostr = {
    publish: async (input: {
      kind: number;
      content: string;
      tags: string[][];
    }): Promise<Array<{ relay: string; ok: boolean; reason?: string }>> => {
      this.nostrCalls.push(input);
      return [{ relay: "wss://example/relay", ok: true, reason: "ok" }];
    },
  };

  async publish(event: AegisEventInput): Promise<PublishResult[]> {
    this.facadeCalls.push(event);
    const channels = event.channels ?? ["nostr", "matrix"];
    return channels.map((network) => ({
      network,
      ok: true,
      id: `${network}-event-id`,
    }));
  }
}

describe("witness / publishAnchor per-hash d-tag", () => {
  it("stamps a unique nostr `d` tag per hash so anchors don't overwrite", async () => {
    const id = await generateIdentity();
    const anchorA: Anchor = signAnchor(id, SAMPLE_HASH, 1_700_000_000);
    const anchorB: Anchor = signAnchor(id, SAMPLE_HASH_B, 1_700_000_001);

    const transport = new StubTransport();
    const recordA = await publishAnchor(
      transport as unknown as AegisTransport,
      anchorA,
    );
    const recordB = await publishAnchor(
      transport as unknown as AegisTransport,
      anchorB,
    );

    // Two distinct nostr publishes occurred — one per anchor.
    expect(transport.nostrCalls.length).toBe(2);
    const dTagA = transport.nostrCalls[0].tags.find((t) => t[0] === "d")?.[1];
    const dTagB = transport.nostrCalls[1].tags.find((t) => t[0] === "d")?.[1];
    expect(dTagA).toBe(witnessNostrDTag(SAMPLE_HASH));
    expect(dTagB).toBe(witnessNostrDTag(SAMPLE_HASH_B));
    expect(dTagA).not.toBe(dTagB);

    // Both records assemble cleanly with per-network results for every
    // network we know about.
    for (const r of [recordA, recordB]) {
      const networks = r.networkResults.map((n) => n.network).sort();
      expect(networks).toEqual(["matrix", "nostr"]);
      const nostrResult = r.networkResults.find((n) => n.network === "nostr");
      expect(nostrResult?.ok).toBe(true);
    }
  });

  it("matrix goes through the facade (no nostr channel)", async () => {
    const id = await generateIdentity();
    const anchor = signAnchor(id, SAMPLE_HASH, 1_700_000_000);
    const transport = new StubTransport();
    await publishAnchor(transport as unknown as AegisTransport, anchor);

    // Exactly one facade call, scoped to non-nostr channels so the
    // per-hash leg owns Nostr exclusively.
    expect(transport.facadeCalls.length).toBe(1);
    expect(transport.facadeCalls[0].channels).toEqual(["matrix"]);
    expect(transport.facadeCalls[0].type).toBe(WITNESS_EVENT_TYPE);
  });

  it("witnessNostrDTag is stable and lowercases the hash", () => {
    const lower =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const upper = lower.toUpperCase();
    expect(witnessNostrDTag(lower)).toBe(witnessNostrDTag(upper));
    expect(witnessNostrDTag(lower)).toBe(
      `aegis:${WITNESS_EVENT_TYPE}:${lower}`,
    );
  });
});
