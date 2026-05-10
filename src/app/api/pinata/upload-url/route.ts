import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { NextRequest } from "next/server";

import { getPinata, isPinataConfigured } from "../../../../lib/pinata/server";

/**
 * POST /api/pinata/upload-url
 *
 * Mints a short-lived Pinata signed upload URL. The browser uploads
 * encrypted blobs *directly* to Pinata using this URL — the server-side
 * Pinata JWT never leaves the server.
 *
 * Used by Aegis Beacon (dead-man's broadcast) and Crucible (whistleblower
 * drop) for encrypted-blob persistence.
 *
 * # Auth (SEC-001)
 *
 * Every request must be signed with a BIP-340 Schnorr signature over a
 * canonical digest binding `pubkey`, `ts`, and `nonce`. The server:
 *
 *   1. Validates shape (zod-style hand-rolled checks).
 *   2. Rejects if `|now - ts| > 60s` (replay window).
 *   3. Verifies the signature against `pubkey`.
 *   4. If `PINATA_ALLOWLIST` is set, rejects pubkeys not in it.
 *   5. Rate-limits per-pubkey (in-memory; ~10 reqs/min).
 *
 * Body:
 *   {
 *     size?: number;             // optional, defaults to MAX_BYTES
 *     mimeType?: string;         // must be "application/octet-stream"
 *     pubkey: string;            // 64-char x-only hex (BIP-340)
 *     ts: number;                // unix seconds
 *     nonce: string;             // base64url 32 random bytes
 *     sig: string;               // base64url 64-byte BIP-340 signature
 *   }
 *
 * Response (200): { url: string; expiresAt: number }
 * Response (401): { error: "auth-failed", message: string }
 * Response (429): { error: "rate-limited", retryAfter: number }
 * Response (503, when PINATA_JWT is not configured):
 *   { error: "pinata-not-configured", message: "PINATA_JWT env var not set" }
 *
 * Limits enforced server-side: 100 MiB max, application/octet-stream only.
 * The signed URL itself expires in 60 seconds.
 */

const MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED_MIME = "application/octet-stream";
const EXPIRES_SECONDS = 60;

/** Maximum clock skew (seconds) between caller `ts` and server clock. */
const TIMESTAMP_WINDOW_SECONDS = 60;

/** Domain-separation tag bound into the signed digest. v=1 keeps room for revs. */
const SIGN_PREFIX = "aegis:pinata-upload-url:v=1";

/** Rate-limit window length (ms). */
const RATE_WINDOW_MS = 60_000;
/** Max requests per pubkey per RATE_WINDOW_MS. */
const RATE_MAX_REQUESTS = 10;

/* -------------------------------------------------------------------------- */
/* In-memory rate limiter — per-pubkey sliding window                          */
/* -------------------------------------------------------------------------- */

/**
 * Module-scoped state. In a multi-instance deployment each replica enforces
 * its own window, so the effective limit scales with replica count — that's
 * acceptable for the portfolio-scale Aegis deployment. A Redis-backed
 * limiter is the natural upgrade if/when the deployment grows.
 */
const rateState = new Map<string, number[]>();

/**
 * Check + record a new request for `pubkey` at `now`. Returns whether the
 * request should be allowed and, if not, how many seconds until the oldest
 * entry in the window expires.
 */
function rateCheck(pubkey: string, now: number): {
  allowed: boolean;
  retryAfter: number;
} {
  const cutoff = now - RATE_WINDOW_MS;
  const arr = rateState.get(pubkey) ?? [];
  // Drop entries outside the window.
  const fresh = arr.filter((t) => t > cutoff);
  if (fresh.length >= RATE_MAX_REQUESTS) {
    rateState.set(pubkey, fresh); // persist the pruned list
    const oldest = fresh[0];
    const retryAfter = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfter };
  }
  fresh.push(now);
  rateState.set(pubkey, fresh);
  return { allowed: true, retryAfter: 0 };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isHexString(s: unknown, len: number): s is string {
  return typeof s === "string" && s.length === len && /^[0-9a-fA-F]+$/.test(s);
}

function isBase64UrlString(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64UrlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin =
    typeof atob !== "undefined"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Compute the digest a caller must sign:
 *
 *     sha256("aegis:pinata-upload-url:v=1:" + pubkey + ":" + ts + ":" + nonce)
 *
 * Single canonical form, no JSON, no whitespace — easy for any client to
 * reproduce byte-for-byte.
 */
function computeDigest(pubkey: string, ts: number, nonce: string): Uint8Array {
  return sha256(utf8Encode(`${SIGN_PREFIX}:${pubkey}:${ts}:${nonce}`));
}

function readAllowlist(): Set<string> | null {
  const raw = process.env.PINATA_ALLOWLIST;
  if (!raw) return null;
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed) set.add(trimmed);
  }
  return set.size > 0 ? set : null;
}

/* -------------------------------------------------------------------------- */
/* Route handler                                                               */
/* -------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  // Graceful degradation: when PINATA_JWT is unset, return 503 so feature
  // code (Beacon / Crucible) can detect and degrade rather than crash.
  if (!isPinataConfigured()) {
    return Response.json(
      {
        error: "pinata-not-configured",
        message: "PINATA_JWT env var not set",
      },
      { status: 503 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "auth-failed", message: "invalid JSON body" }, { status: 401 });
  }

  // Auth fields must be present and well-shaped. We return 401 on every
  // auth failure so the surface is uniform — distinguishing "missing field"
  // from "bad signature" leaks signal an attacker could iterate on.
  const pubkey = body.pubkey;
  const ts = body.ts;
  const nonce = body.nonce;
  const sig = body.sig;
  if (!isHexString(pubkey, 64)) {
    return Response.json({ error: "auth-failed", message: "pubkey must be 64 hex chars" }, { status: 401 });
  }
  if (typeof ts !== "number" || !Number.isFinite(ts) || !Number.isInteger(ts)) {
    return Response.json({ error: "auth-failed", message: "ts must be an integer unix seconds" }, { status: 401 });
  }
  if (!isBase64UrlString(nonce)) {
    return Response.json({ error: "auth-failed", message: "nonce must be base64url" }, { status: 401 });
  }
  if (!isBase64UrlString(sig)) {
    return Response.json({ error: "auth-failed", message: "sig must be base64url" }, { status: 401 });
  }

  const pubkeyLower = (pubkey as string).toLowerCase();

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > TIMESTAMP_WINDOW_SECONDS) {
    return Response.json({ error: "auth-failed", message: "ts outside permitted window" }, { status: 401 });
  }

  // Verify the BIP-340 Schnorr signature against the canonical digest.
  let sigOk = false;
  try {
    const sigBytes = base64UrlToBytes(sig as string);
    if (sigBytes.length !== 64) {
      return Response.json({ error: "auth-failed", message: "sig must decode to 64 bytes" }, { status: 401 });
    }
    const pubBytes = hexToBytes(pubkeyLower);
    const digest = computeDigest(pubkeyLower, ts as number, nonce as string);
    sigOk = schnorr.verify(sigBytes, digest, pubBytes);
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return Response.json({ error: "auth-failed", message: "signature verify failed" }, { status: 401 });
  }

  // Optional allow-list: when PINATA_ALLOWLIST is set, only those pubkeys
  // may request signed URLs. When unset, any signed request is accepted
  // (portfolio-mode default).
  const allow = readAllowlist();
  if (allow && !allow.has(pubkeyLower)) {
    return Response.json({ error: "auth-failed", message: "pubkey not in allowlist" }, { status: 401 });
  }

  // Per-pubkey rate limit.
  const rate = rateCheck(pubkeyLower, Date.now());
  if (!rate.allowed) {
    return Response.json(
      {
        error: "rate-limited",
        retryAfter: rate.retryAfter,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfter) },
      },
    );
  }

  // Validate the file-size / mime claims after auth — saves the work for
  // unauthenticated callers and makes the error surface honest about which
  // gate failed.
  const requestedSize = typeof body.size === "number" ? body.size : MAX_BYTES;
  if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
    return Response.json({ error: "invalid size" }, { status: 400 });
  }
  if (requestedSize > MAX_BYTES) {
    return Response.json(
      { error: `file exceeds max size of ${MAX_BYTES} bytes` },
      { status: 413 },
    );
  }

  const requestedMime =
    typeof body.mimeType === "string" ? body.mimeType : ALLOWED_MIME;
  if (requestedMime !== ALLOWED_MIME) {
    return Response.json(
      { error: `mimeType must be ${ALLOWED_MIME}` },
      { status: 400 },
    );
  }

  try {
    const pinata = getPinata();
    const url = await pinata.upload.public.createSignedURL({
      expires: EXPIRES_SECONDS,
      maxFileSize: requestedSize,
      mimeTypes: [ALLOWED_MIME],
    });
    return Response.json({
      url,
      expiresAt: Date.now() + EXPIRES_SECONDS * 1000,
    });
  } catch (error) {
    console.error("[pinata/upload-url]", error);
    return Response.json(
      { error: "failed to mint upload URL" },
      { status: 500 },
    );
  }
}

/**
 * Test-only helper: clear the in-memory rate limiter state. Not part of
 * the route handler's runtime surface — tests reach in via a deep import
 * to reset state between assertions.
 */
export function __resetRateLimiterForTests(): void {
  rateState.clear();
}
