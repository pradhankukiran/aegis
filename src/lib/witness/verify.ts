/**
 * Witness — signature + multi-network verification.
 *
 * # Signature check
 *
 * `verifySignature(anchor)` re-derives the BIP-340 digest from
 * `{anchor.hash, anchor.ts}` via the same `anchorDigest` helper signing
 * uses, then verifies the hex-encoded `sig` against the x-only `signer`.
 *
 * # Multi-network presence check
 *
 * `verifyAnchor(transport, hash)` runs the presence check.
 *
 * ## Nostr leg — relay-side `#d` filter (Phase 6 Wave 6b)
 *
 * `publishAnchor` writes witness anchors with a per-hash NIP-78 d-tag
 * (`aegis:aegis.witness:<hash>`). We pair that on the verify side by
 * subscribing directly via `transport.nostr.subscribe` with `#d` set to the
 * same per-hash value — the relay returns only the matching event, no
 * scan-and-filter needed. Cuts the response from "every witness anchor
 * the user ever published, filtered locally by hash" to "exactly the
 * event(s) that anchor this hash".
 *
 * ## Matrix + SSB legs — facade scan
 *
 * The Matrix/SSB legs don't have a relay-side filter that knows about
 * Aegis-level content; we keep the cross-network subscribe for those two
 * (it does its own type-level filtering on the wire) and post-filter the
 * inbound events by `content.hash`.
 *
 * ## Why we still keep a short timeout
 *
 * Even with the per-hash d-tag, relays don't have an "I'm done" signal on
 * a subscription — they hold the socket open for new matches. The timeout
 * (`VERIFY_TIMEOUT_MS`) bounds how long we wait for recent history to
 * stream in before scoring per-network presence. Short enough that the
 * verify route stays snappy in the UI, long enough that a known anchor
 * comes back from a real relay's recent window.
 */
import { schnorr } from "@noble/curves/secp256k1.js";

import type { AegisEvent, AegisTransport, Network } from "../transport";

import {
  anchorDigest,
  sigBytesFromHex,
  signerBytesFromHex,
  witnessNostrDTag,
} from "./anchor";
import type {
  Anchor,
  NetworkVerification,
  Verification,
} from "./types";
import { WITNESS_EVENT_TYPE } from "./types";

/** NIP-78 kind used for Aegis events — matches the publish-side constant in `anchor.ts`. */
const NOSTR_AEGIS_KIND = 30078;

/* -------------------------------------------------------------------------- */
/* Signature                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Verify the BIP-340 Schnorr signature embedded in an Anchor. Returns false
 * for any malformed input rather than throwing — the verify-page UI wants a
 * boolean, and a verification UI that throws on a bad URL would be jarring.
 */
export function verifySignature(anchor: Anchor): boolean {
  try {
    if (!anchor || typeof anchor !== "object") return false;
    if (!/^[0-9a-f]{64}$/i.test(anchor.hash)) return false;
    if (!/^[0-9a-f]{64}$/i.test(anchor.signer)) return false;
    if (!/^[0-9a-f]{128}$/i.test(anchor.sig)) return false;
    if (!Number.isFinite(anchor.ts)) return false;
    const digest = anchorDigest(anchor.hash, anchor.ts);
    const sig = sigBytesFromHex(anchor.sig.toLowerCase());
    const signer = signerBytesFromHex(anchor.signer.toLowerCase());
    return schnorr.verify(sig, digest, signer);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Multi-network presence                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How long we keep the cross-network subscription open while looking for an
 * event matching the requested hash. Picked to be roughly the upper bound
 * of relay-side replay latency while still feeling snappy in the UI.
 */
export const VERIFY_TIMEOUT_MS = 4000;

/**
 * Shape the subscribe payload converts into for the matcher. We accept the
 * loosest possible JSON because each transport's serializer may surface
 * the `content` as `{ hash, sig, ... }` directly (Nostr/Matrix) or as a
 * nested record (SSB sometimes wraps additional metadata).
 */
type RawAnchorLike = {
  hash?: unknown;
  sig?: unknown;
  signer?: unknown;
  ts?: unknown;
};

/**
 * Find every `aegis.witness` event on every connected network whose
 * `content.hash` equals `hash`, then aggregate per-network presence into a
 * single `Verification`.
 *
 * The function is fault-tolerant by design: each step that could throw
 * (transport not connected, malformed event, etc.) is caught locally so the
 * verify UI can always render *something*.
 */
export async function verifyAnchor(
  transport: AegisTransport,
  hash: string,
  options: { timeoutMs?: number } = {},
): Promise<Verification> {
  const targetHash = hash.toLowerCase();
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;

  // Per-network "best" event we've seen so far. We score by "found + valid"
  // > "found + signature-failed" > "not found"; the first valid match wins.
  const byNetwork: Record<
    "nostr" | "matrix" | "ssb",
    NetworkVerification
  > = {
    nostr: { network: "nostr", found: false },
    matrix: { network: "matrix", found: false },
    ssb: { network: "ssb", found: false },
  };

  const recordSighting = (
    network: Network,
    anchor: Anchor,
  ): void => {
    const sigValid = verifySignature(anchor);
    const candidate: NetworkVerification = {
      network,
      found: true,
      signatureValid: sigValid,
      ts: anchor.ts,
    };
    const existing = byNetwork[network];
    // Promote only if the new sighting is strictly better. Already-valid
    // entries stay sticky so a later forged duplicate can't downgrade.
    if (!existing.found) {
      byNetwork[network] = candidate;
    } else if (existing.signatureValid !== true && sigValid) {
      byNetwork[network] = candidate;
    }
  };

  const unsubs: Array<() => void> = [];

  // Nostr leg: subscribe with the per-hash `#d` filter so the relay only
  // returns the matching event(s). Far cheaper than the cross-network
  // scan-and-filter the v1 path used.
  try {
    const nostrUnsub = transport.nostr.subscribe(
      {
        kinds: [NOSTR_AEGIS_KIND],
        "#d": [witnessNostrDTag(targetHash)],
      },
      (ne) => {
        let parsed: unknown = null;
        try {
          parsed = ne.content === "" ? null : JSON.parse(ne.content);
        } catch {
          parsed = ne.content;
        }
        const anchor = extractAnchorFromContent(parsed, targetHash);
        if (!anchor) return;
        recordSighting("nostr", anchor);
      },
    );
    unsubs.push(nostrUnsub);
  } catch {
    /* nostr unavailable — fall through to the assembly path */
  }

  // Matrix + SSB leg: keep the facade subscribe. Neither transport has a
  // relay-side hash filter we can lean on; the facade's type-level filter
  // + our content.hash post-filter is the right shape.
  try {
    const facadeUnsub = transport.subscribe(
      { type: WITNESS_EVENT_TYPE, since: 0 },
      (event) => {
        // The nostr leg is handled above; ignore the facade's nostr stream
        // so we don't double-count and so anchors written under the *old*
        // shared d-tag don't bleed in.
        if (event.origin === "nostr") return;
        const anchor = extractAnchor(event, targetHash);
        if (!anchor) return;
        recordSighting(event.origin, anchor);
      },
    );
    unsubs.push(facadeUnsub);
  } catch {
    /* facade subscribe failed — likely no networks connected at all */
  }

  if (unsubs.length > 0) {
    // Sleep `timeoutMs` while events stream in. We deliberately don't break
    // early on the first hit because we want per-network presence, not just
    // "yes/no".
    await new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    });
    for (const u of unsubs) {
      try {
        u();
      } catch {
        /* ignore — best-effort teardown */
      }
    }
  }

  const networks: NetworkVerification[] = [
    byNetwork.nostr,
    byNetwork.matrix,
    byNetwork.ssb,
  ];
  const anyValidMatch = networks.some(
    (n) => n.found && n.signatureValid === true,
  );
  const fullyAnchored = networks.every(
    (n) => n.found && n.signatureValid === true,
  );
  return {
    hash: targetHash,
    networks,
    overallOk: anyValidMatch,
    fullyAnchored,
  };
}

/**
 * Variant of `extractAnchor` that operates on a raw content object (the
 * already-JSON-parsed Nostr event content). Returns null when the shape
 * doesn't match or the hash mismatches.
 */
function extractAnchorFromContent(
  content: unknown,
  targetHash: string,
): Anchor | null {
  if (!content || typeof content !== "object") return null;
  const c = content as RawAnchorLike;
  if (typeof c.hash !== "string") return null;
  if (c.hash.toLowerCase() !== targetHash) return null;
  if (typeof c.sig !== "string") return null;
  if (typeof c.signer !== "string") return null;
  if (typeof c.ts !== "number") return null;
  return {
    hash: c.hash.toLowerCase(),
    sig: c.sig.toLowerCase(),
    signer: c.signer.toLowerCase(),
    ts: c.ts,
  };
}

/**
 * Project an inbound AegisEvent into an `Anchor` if its content matches the
 * expected hash. Returns null otherwise so the caller can ignore unrelated
 * events on the cross-network stream.
 *
 * Defensive about types: AegisEvent.content is `unknown` since each
 * transport's payload deserializer is independent.
 */
function extractAnchor(
  event: AegisEvent,
  targetHash: string,
): Anchor | null {
  const c = event.content as RawAnchorLike | null;
  if (!c || typeof c !== "object") return null;
  if (typeof c.hash !== "string") return null;
  if (c.hash.toLowerCase() !== targetHash) return null;
  if (typeof c.sig !== "string") return null;
  if (typeof c.signer !== "string") return null;
  if (typeof c.ts !== "number") return null;
  return {
    hash: c.hash.toLowerCase(),
    sig: c.sig.toLowerCase(),
    signer: c.signer.toLowerCase(),
    ts: c.ts,
  };
}
