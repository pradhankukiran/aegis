import { describe, expect, it } from "vitest";

import { hashBytes, hashFile } from "./hash";

/* ---------------------------------------------------------------------------
 * Known vectors
 * --------------------------------------------------------------------------
 * Empty input → "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".
 * "abc"       → "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".
 * Both are FIPS 180-4 test vectors, identical to what `lib/crypto/hash.ts`
 * asserts. We re-assert here against the Witness wrappers so a regression
 * in either the WebCrypto path or the `@noble/hashes` fallback shows up in
 * the feature module's own test file.
 * ------------------------------------------------------------------------ */

describe("witness / hash", () => {
  it("hashBytes returns the empty-string vector for an empty Uint8Array", async () => {
    const hex = await hashBytes(new Uint8Array(0));
    expect(hex).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('hashBytes returns the "abc" vector', async () => {
    const hex = await hashBytes(new TextEncoder().encode("abc"));
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashBytes works with an injected subtle (delegates to it)", async () => {
    // The injected impl is a thin shim around the global crypto.subtle. The
    // test proves that hashBytes correctly threads its argument through and
    // returns the same digest the default path would.
    let called = false;
    const fake = {
      digest: async (
        algorithm: AlgorithmIdentifier,
        data: BufferSource,
      ): Promise<ArrayBuffer> => {
        called = true;
        return await globalThis.crypto.subtle.digest(algorithm, data);
      },
    };
    const hex = await hashBytes(new TextEncoder().encode("abc"), fake);
    expect(called).toBe(true);
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashFile hashes a Blob's bytes", async () => {
    const blob = new Blob([new TextEncoder().encode("abc")]);
    const hex = await hashFile(blob as unknown as File);
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashFile is deterministic — same bytes → same hash", async () => {
    const a = await hashFile(
      new Blob([new Uint8Array([1, 2, 3])]) as unknown as File,
    );
    const b = await hashFile(
      new Blob([new Uint8Array([1, 2, 3])]) as unknown as File,
    );
    expect(a).toBe(b);
  });

  it("hashFile differs across different byte streams", async () => {
    const a = await hashFile(
      new Blob([new Uint8Array([1, 2, 3])]) as unknown as File,
    );
    const b = await hashFile(
      new Blob([new Uint8Array([4, 5, 6])]) as unknown as File,
    );
    expect(a).not.toBe(b);
  });
});
