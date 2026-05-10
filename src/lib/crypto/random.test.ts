import { describe, expect, it } from "vitest";

import { randomBase64Url, randomBytes, randomHex } from "./random";

describe("random", () => {
  it("returns the requested number of bytes", async () => {
    expect((await randomBytes(0)).length).toBe(0);
    expect((await randomBytes(1)).length).toBe(1);
    expect((await randomBytes(32)).length).toBe(32);
    expect((await randomBytes(1000)).length).toBe(1000);
  });

  it("rejects invalid length", async () => {
    await expect(randomBytes(-1)).rejects.toThrow();
    await expect(randomBytes(1.5)).rejects.toThrow();
  });

  it("produces different values across calls", async () => {
    const a = await randomBytes(16);
    const b = await randomBytes(16);
    expect(a).not.toEqual(b);
  });

  it("randomBase64Url produces URL-safe output", async () => {
    const s = await randomBase64Url(16);
    expect(s).not.toContain("+");
    expect(s).not.toContain("/");
    expect(s).not.toContain("=");
    expect(s.length).toBeGreaterThan(0);
  });

  it("randomHex produces lowercase hex", async () => {
    const s = await randomHex(16);
    expect(s).toMatch(/^[0-9a-f]+$/);
    expect(s.length).toBe(32);
  });
});
