/**
 * Witness — file-hashing entrypoint.
 *
 * `hashFile` returns the SHA-256 of the file contents as a lowercase hex
 * string (the same canonical form Nostr / BIP-340 use everywhere else in
 * Aegis).
 *
 * # Implementation choice: WebCrypto-first
 *
 * The browser's `crypto.subtle.digest("SHA-256", buf)` is implemented in
 * native code (often hardware-accelerated) and runs off the main thread —
 * orders of magnitude faster than a JS implementation for the megabyte-scale
 * files witness will typically see. When it's unavailable (Node, older
 * runtimes, locked-down browsers) we fall back to `@noble/hashes` which is
 * what the rest of the crypto module already uses.
 *
 * # File size limits
 *
 * For v1 we read the whole file into memory before hashing. That's fine up
 * to roughly the order of a few hundred MB on a desktop browser — beyond
 * that we'd need to chunk the read and feed a streaming SHA-256 to keep
 * memory bounded. Streaming SHA-256 isn't natively exposed via
 * `crypto.subtle` (it only does one-shot digests), so the chunked path
 * would need a JS-side streaming hasher (e.g. `@noble/hashes` does support
 * `.update()` + `.digest()`). That refactor is deferred — see the file-level
 * comment in `hooks.ts` for the user-visible knob.
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

import { bytesToHex } from "../crypto/encoding";

/** Soft upper bound we surface to users in the UI. Larger files just hash slower. */
export const RECOMMENDED_MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Test seam: an injectable "subtle digest" implementation. Tests can pass a
 * fake that records its input to assert hash-pipeline behaviour without
 * relying on the runtime's WebCrypto being available.
 */
export type SubtleLike = {
  digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>;
};

/**
 * Hash a `File` (or `Blob`) and return the SHA-256 digest as 64-char
 * lowercase hex. Uses WebCrypto when available, otherwise `@noble/hashes`.
 *
 * The `subtle` parameter is an injection point for tests; production code
 * never passes it. (We accept a `Blob` because `File` extends `Blob`, and
 * `Blob` is the smallest API surface that gives us `.arrayBuffer()`.)
 */
export async function hashFile(
  file: Blob,
  subtle?: SubtleLike,
): Promise<string> {
  const buf = await file.arrayBuffer();
  return hashBytes(new Uint8Array(buf), subtle);
}

/**
 * Hash raw bytes — the kernel `hashFile` is built on. Exposed so tests can
 * exercise the digest path against known vectors without constructing a
 * `Blob` in environments where `Blob` isn't always available.
 */
export async function hashBytes(
  bytes: Uint8Array,
  subtle?: SubtleLike,
): Promise<string> {
  const impl = subtle ?? pickSubtle();
  if (impl) {
    // `subtle.digest` expects a BufferSource. We pass a freshly-allocated
    // ArrayBuffer-backed view to avoid the TS-DOM `ArrayBufferLike` vs
    // `ArrayBuffer` mismatch that bites Uint8Array<ArrayBufferLike>.
    const owned = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const digest = await impl.digest("SHA-256", owned);
    return bytesToHex(new Uint8Array(digest));
  }
  // Fallback for Node / runtimes without WebCrypto. `@noble/hashes`
  // implements SHA-256 in pure JS.
  return bytesToHex(nobleSha256(bytes));
}

/**
 * Resolve the "crypto.subtle" implementation we should use. Returns null if
 * none is reachable — callers fall back to the JS hasher. This lookup is
 * defensive because:
 *  - Server-side render: `crypto` may be the Node `crypto` module which does
 *    NOT have `.subtle` until v15+ (and is exposed differently anyway).
 *  - Older browsers / insecure contexts: `crypto.subtle` is undefined.
 */
function pickSubtle(): SubtleLike | null {
  if (typeof globalThis === "undefined") return null;
  const g = globalThis as typeof globalThis & {
    crypto?: { subtle?: SubtleLike };
  };
  if (g.crypto && g.crypto.subtle) return g.crypto.subtle;
  return null;
}
