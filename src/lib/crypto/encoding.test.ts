import { describe, expect, it } from "vitest";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8Decode,
  utf8Encode,
} from "./encoding";

describe("utf8Encode/utf8Decode", () => {
  it("round-trips ASCII", () => {
    expect(utf8Decode(utf8Encode("hello"))).toBe("hello");
  });

  it("round-trips multibyte UTF-8", () => {
    const input = "héllo 🜂 Ψ ✕";
    expect(utf8Decode(utf8Encode(input))).toBe(input);
  });
});

describe("hex", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 15, 16, 127, 128, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it("rejects odd-length hex", () => {
    expect(() => hexToBytes("abc")).toThrow();
  });

  it("rejects invalid hex characters", () => {
    expect(() => hexToBytes("zz")).toThrow();
  });

  it("uses lowercase output", () => {
    expect(bytesToHex(new Uint8Array([0xab, 0xcd, 0xef]))).toBe("abcdef");
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });

  it("uses URL-safe alphabet (- and _, no padding)", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xff]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("decodes regardless of padding presence", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const encoded = bytesToBase64Url(bytes);
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
    expect(base64UrlToBytes(encoded + "==")).toEqual(bytes);
  });
});

describe("concatBytes", () => {
  it("concatenates in order", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const c = new Uint8Array([6]);
    expect(concatBytes(a, b, c)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("handles empty arrays", () => {
    expect(concatBytes()).toEqual(new Uint8Array([]));
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([]))).toEqual(
      new Uint8Array([1]),
    );
  });
});
