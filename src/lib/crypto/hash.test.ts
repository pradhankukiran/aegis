import { describe, expect, it } from "vitest";

import { bytesToHex } from "./encoding";
import { hashEmail, sha256 } from "./hash";

describe("hash", () => {
  it("sha256 matches known vector for empty string", () => {
    expect(bytesToHex(sha256(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("sha256 matches known vector for 'abc'", () => {
    expect(bytesToHex(sha256("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("sha256 accepts Uint8Array input", () => {
    const a = sha256("hi");
    const b = sha256(new TextEncoder().encode("hi"));
    expect(a).toEqual(b);
  });

  it("hashEmail normalizes case and whitespace", () => {
    const a = hashEmail("Alice@Example.com");
    const b = hashEmail("  alice@example.com  ");
    const c = hashEmail("ALICE@EXAMPLE.COM");
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it("hashEmail differs for different emails", () => {
    expect(hashEmail("a@x.com")).not.toEqual(hashEmail("b@x.com"));
  });
});
