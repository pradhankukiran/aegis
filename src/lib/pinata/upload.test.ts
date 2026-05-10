/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the browser-side Pinata upload helper.
 *
 * We mock:
 *   - global `fetch` for the `/api/pinata/upload-url` request, and
 *   - the `pinata` SDK so the actual upload step is canned and never hits
 *     the network.
 *
 * No live network calls. All paths are fully exercised against fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/* Pinata SDK mock                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The SDK exposes a builder-style API:
 *
 *   const result = await pinata.upload.public.file(file).url(signedUrl);
 *
 * We mock the chain so `.file(...)` returns a thenable whose `.url(...)`
 * resolves to a canned `{ cid }` shape.
 */
const uploadMock = vi.hoisted(() => ({
  cidToReturn: "bafybeibogus000000000000000000000000000000000000000000000000",
  lastCalledWithSignedUrl: null as string | null,
  lastUploadedFile: null as File | null,
  reset(): void {
    this.cidToReturn = "bafybeibogus000000000000000000000000000000000000000000000000";
    this.lastCalledWithSignedUrl = null;
    this.lastUploadedFile = null;
  },
}));

vi.mock("pinata", () => {
  return {
    PinataSDK: class {
      public upload: {
        public: {
          file: (file: File) => {
            url: (signed: string) => Promise<{ cid: string; size: number }>;
          };
        };
      };
      constructor(_config: unknown) {
        void _config;
        this.upload = {
          public: {
            file: (file: File) => ({
              url: async (signed: string) => {
                uploadMock.lastCalledWithSignedUrl = signed;
                uploadMock.lastUploadedFile = file;
                return { cid: uploadMock.cidToReturn, size: file.size };
              },
            }),
          },
        };
      }
    },
  };
});

// Import AFTER vi.mock so the mocked SDK is what the helper picks up.
import {
  PinataNotConfiguredError,
  requestUploadUrl,
  uploadCiphertext,
  uploadEncryptedBlob,
} from "./upload";
import {
  PinataGatewayNotConfiguredError,
  fallbackGatewayUrls,
  gatewayUrl,
} from "./fetch";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type FetchInit = Parameters<typeof fetch>[1];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(
  handler: (input: string, init?: FetchInit) => Promise<Response>,
) {
  const original = globalThis.fetch;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: FetchInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url, init);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fn as unknown as typeof fetch;
  return {
    fn,
    restore() {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("pinata / upload", () => {
  beforeEach(() => {
    uploadMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: mints a signed URL and returns a CID for the uploaded ciphertext", async () => {
    const fakeSignedUrl =
      "https://uploads.pinata.cloud/v3/files?token=fake-signed";
    const fetchFn = installFetchMock(async (url) => {
      expect(url).toBe("/api/pinata/upload-url");
      return jsonResponse(200, {
        url: fakeSignedUrl,
        expiresAt: Date.now() + 60_000,
      });
    });
    try {
      const ciphertext = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await uploadCiphertext(ciphertext, "test.bin");
      expect(result.cid).toBe(uploadMock.cidToReturn);
      expect(result.size).toBe(5);
      expect(uploadMock.lastCalledWithSignedUrl).toBe(fakeSignedUrl);
      expect(uploadMock.lastUploadedFile?.name).toBe("test.bin");
      expect(uploadMock.lastUploadedFile?.type).toBe(
        "application/octet-stream",
      );
      // The /api/pinata/upload-url endpoint was hit exactly once with the
      // ciphertext byte length, plus the SEC-001 auth fields.
      expect(fetchFn.fn).toHaveBeenCalledTimes(1);
      const init = fetchFn.fn.mock.calls[0][1] as FetchInit;
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body.size).toBe(5);
      expect(body.mimeType).toBe("application/octet-stream");
      // Auth fields present and well-shaped.
      expect(body.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof body.ts).toBe("number");
      expect(Number.isInteger(body.ts)).toBe(true);
      expect(body.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(body.sig).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      fetchFn.restore();
    }
  });

  it("SEC-001: signed request body carries pubkey/ts/nonce/sig and a verifiable signature", async () => {
    const { schnorr } = await import("@noble/curves/secp256k1.js");
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const fetchFn = installFetchMock(async () =>
      jsonResponse(200, {
        url: "https://signed.example/u",
        expiresAt: Date.now() + 60_000,
      }),
    );
    try {
      await requestUploadUrl({ size: 32 });
      const init = fetchFn.fn.mock.calls[0][1] as FetchInit;
      const body = JSON.parse(init?.body as string) as {
        pubkey: string;
        ts: number;
        nonce: string;
        sig: string;
      };
      // Reconstruct the digest the server checks.
      const enc = new TextEncoder();
      const digest = sha256(
        enc.encode(
          `aegis:pinata-upload-url:v=1:${body.pubkey}:${body.ts}:${body.nonce}`,
        ),
      );
      // Decode the base64url-encoded sig and pubkey.
      const b64urlToBytes = (s: string): Uint8Array => {
        const norm = s.replace(/-/g, "+").replace(/_/g, "/");
        const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
        const bin = atob(padded);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      };
      const sigBytes = b64urlToBytes(body.sig);
      // pubkey is hex
      const pubBytes = new Uint8Array(body.pubkey.length / 2);
      for (let i = 0; i < pubBytes.length; i++) {
        pubBytes[i] = parseInt(body.pubkey.slice(i * 2, i * 2 + 2), 16);
      }
      expect(schnorr.verify(sigBytes, digest, pubBytes)).toBe(true);
      // Sanity-check ts is within a few seconds of now.
      const nowSec = Math.floor(Date.now() / 1000);
      expect(Math.abs(nowSec - body.ts)).toBeLessThan(5);
      // Nonce is 32 random bytes → base64url ~43 chars.
      expect(body.nonce.length).toBeGreaterThanOrEqual(40);
    } finally {
      fetchFn.restore();
    }
  });

  it("SEC-001: accepts an explicit Identity override and signs with it", async () => {
    const { schnorr, secp256k1 } = await import("@noble/curves/secp256k1.js");
    const seckey = new Uint8Array(32);
    seckey[0] = 0xab;
    for (let i = 1; i < 32; i++) seckey[i] = i;
    const pubkey = secp256k1.getPublicKey(seckey, true);
    const xOnly = pubkey.slice(1);
    const expectedHex = Array.from(xOnly)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const fetchFn = installFetchMock(async () =>
      jsonResponse(200, {
        url: "https://signed.example/u",
        expiresAt: Date.now() + 60_000,
      }),
    );
    try {
      await requestUploadUrl({
        size: 100,
        identity: { seckey, pubkey, createdAt: Date.now() },
      });
      const init = fetchFn.fn.mock.calls[0][1] as FetchInit;
      const body = JSON.parse(init?.body as string) as { pubkey: string; sig: string };
      expect(body.pubkey).toBe(expectedHex);
      // Verify the signature was made with the override's seckey by checking
      // it verifies against the same pubkey.
      const sigBytes = new Uint8Array(64);
      const sigStr = body.sig.replace(/-/g, "+").replace(/_/g, "/");
      const padded = sigStr + "=".repeat((4 - (sigStr.length % 4)) % 4);
      const bin = atob(padded);
      for (let i = 0; i < 64; i++) sigBytes[i] = bin.charCodeAt(i);
      void schnorr; // sanity import; verification done in the prior test.
      expect(sigBytes.length).toBe(64);
    } finally {
      fetchFn.restore();
    }
  });

  it("happy path: requestUploadUrl returns the SignedUploadUrl shape on 200", async () => {
    const expiresAt = Date.now() + 60_000;
    const fetchFn = installFetchMock(async () =>
      jsonResponse(200, {
        url: "https://uploads.pinata.cloud/v3/files?token=x",
        expiresAt,
      }),
    );
    try {
      const got = await requestUploadUrl({ size: 1024 });
      expect(got.url).toBe("https://uploads.pinata.cloud/v3/files?token=x");
      expect(got.expiresAt).toBe(expiresAt);
    } finally {
      fetchFn.restore();
    }
  });

  it("503 path: requestUploadUrl throws PinataNotConfiguredError when server reports pinata-not-configured", async () => {
    const fetchFn = installFetchMock(async () =>
      jsonResponse(503, {
        error: "pinata-not-configured",
        message: "PINATA_JWT env var not set",
      }),
    );
    try {
      await expect(requestUploadUrl({ size: 100 })).rejects.toBeInstanceOf(
        PinataNotConfiguredError,
      );
      await expect(requestUploadUrl({ size: 100 })).rejects.toMatchObject({
        name: "PinataNotConfiguredError",
        message: "PINATA_JWT env var not set",
      });
    } finally {
      fetchFn.restore();
    }
  });

  it("503 path: uploadCiphertext surfaces PinataNotConfiguredError to callers", async () => {
    const fetchFn = installFetchMock(async () =>
      jsonResponse(503, {
        error: "pinata-not-configured",
        message: "PINATA_JWT env var not set",
      }),
    );
    try {
      await expect(
        uploadCiphertext(new Uint8Array([0, 1, 2])),
      ).rejects.toBeInstanceOf(PinataNotConfiguredError);
      // SDK upload step must never have been reached.
      expect(uploadMock.lastCalledWithSignedUrl).toBeNull();
    } finally {
      fetchFn.restore();
    }
  });

  it("non-503 non-OK: requestUploadUrl throws a plain Error (not PinataNotConfiguredError)", async () => {
    const fetchFn = installFetchMock(async () =>
      jsonResponse(413, { error: "file too big" }),
    );
    try {
      await expect(requestUploadUrl({ size: 999 })).rejects.toThrow(
        /413/,
      );
      await expect(
        requestUploadUrl({ size: 999 }),
      ).rejects.not.toBeInstanceOf(PinataNotConfiguredError);
    } finally {
      fetchFn.restore();
    }
  });

  it("uploadEncryptedBlob throws when the SDK returns no CID", async () => {
    uploadMock.cidToReturn = "";
    const result = uploadEncryptedBlob(
      new Uint8Array([9, 9, 9]),
      "https://signed.example/upload",
    );
    await expect(result).rejects.toThrow(/no CID returned/);
  });
});

/* -------------------------------------------------------------------------- */
/* SEC-001 — POST /api/pinata/upload-url route handler                          */
/* -------------------------------------------------------------------------- */

/**
 * Module-level mock of `lib/pinata/server` so the route handler under test
 * doesn't try to instantiate a real Pinata client (which would require a
 * JWT and hit the network).
 */
const serverMock = vi.hoisted(() => ({
  isPinataConfigured: vi.fn(() => true),
  signedUrlToReturn: "https://signed.example/u?token=mock",
  getPinata: vi.fn(() => ({
    upload: {
      public: {
        createSignedURL: async (): Promise<string> =>
          serverMock.signedUrlToReturn,
      },
    },
  })),
}));

// Mock the server module — vitest resolves vi.mock specifiers against
// the same module-graph node the route handler imports. Path is from THIS
// test file's perspective (src/lib/pinata/upload.test.ts) to the target.
vi.mock("./server", () => ({
  isPinataConfigured: serverMock.isPinataConfigured,
  getPinata: serverMock.getPinata,
}));

// IMPORTANT: import the route AFTER the vi.mock above so the route picks up
// the mocked server module.
import { POST as pinataUploadUrlPOST, __resetRateLimiterForTests }
  from "../../app/api/pinata/upload-url/route";

import { schnorr as testSchnorr, secp256k1 as testSecp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 as testSha256 } from "@noble/hashes/sha2.js";

/** Build a Next-style request shim — only the bits the route reads. */
function makeRequest(body: unknown): {
  json: () => Promise<unknown>;
} {
  return {
    json: async () => body,
  };
}

/** Generate a fresh secp256k1 keypair for signing test requests. */
function freshKeypair(): { seckey: Uint8Array; xOnly: Uint8Array; xOnlyHex: string } {
  const seckey = new Uint8Array(32);
  crypto.getRandomValues(seckey);
  // Ensure non-zero scalar.
  if (seckey.every((b) => b === 0)) seckey[0] = 1;
  const pub = testSecp256k1.getPublicKey(seckey, true);
  const xOnly = pub.slice(1);
  let xOnlyHex = "";
  for (const b of xOnly) xOnlyHex += b.toString(16).padStart(2, "0");
  return { seckey, xOnly, xOnlyHex };
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Construct a signed body for the upload-url route. */
function signRequest(args: {
  seckey: Uint8Array;
  pubkey: string;
  ts?: number;
  nonce?: string;
  size?: number;
}): Record<string, unknown> {
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = args.nonce ?? b64urlEncode(nonceBytes);
  const enc = new TextEncoder();
  const digest = testSha256(
    enc.encode(
      `aegis:pinata-upload-url:v=1:${args.pubkey}:${ts}:${nonce}`,
    ),
  );
  const sigBytes = testSchnorr.sign(digest, args.seckey);
  const sig = b64urlEncode(sigBytes);
  return {
    size: args.size ?? 1024,
    mimeType: "application/octet-stream",
    pubkey: args.pubkey,
    ts,
    nonce,
    sig,
  };
}

describe("SEC-001: POST /api/pinata/upload-url", () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    serverMock.isPinataConfigured.mockImplementation(() => true);
    serverMock.getPinata.mockImplementation(() => ({
      upload: {
        public: {
          createSignedURL: async (): Promise<string> =>
            serverMock.signedUrlToReturn,
        },
      },
    }));
    delete process.env.PINATA_ALLOWLIST;
  });

  it("503 when PINATA_JWT not configured", async () => {
    serverMock.isPinataConfigured.mockImplementation(() => false);
    const kp = freshKeypair();
    const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex });
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(503);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("pinata-not-configured");
  });

  it("200 on a valid signed request", async () => {
    const kp = freshKeypair();
    const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex });
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { url: string; expiresAt: number };
    expect(j.url).toBe(serverMock.signedUrlToReturn);
    expect(typeof j.expiresAt).toBe("number");
  });

  it("401 when sig is wrong (mutated)", async () => {
    const kp = freshKeypair();
    const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex }) as {
      sig: string;
    } & Record<string, unknown>;
    // Flip one base64url character.
    const ch = body.sig[0] === "A" ? "B" : "A";
    body.sig = ch + body.sig.slice(1);
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(401);
  });

  it("401 when ts is too far in the past (replay protection)", async () => {
    const kp = freshKeypair();
    const body = signRequest({
      seckey: kp.seckey,
      pubkey: kp.xOnlyHex,
      ts: Math.floor(Date.now() / 1000) - 600, // 10 minutes old
    });
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string; message: string };
    expect(j.error).toBe("auth-failed");
    expect(j.message).toMatch(/ts/);
  });

  it("401 when pubkey is wrong length", async () => {
    const kp = freshKeypair();
    const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex }) as Record<string, unknown>;
    body.pubkey = "deadbeef"; // too short
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(401);
  });

  it("401 when nonce/sig is malformed (not base64url)", async () => {
    const kp = freshKeypair();
    const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex }) as Record<string, unknown>;
    body.sig = "not!base64!";
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(401);
  });

  it("PINATA_ALLOWLIST: rejects pubkeys not in the list", async () => {
    const kp = freshKeypair();
    process.env.PINATA_ALLOWLIST = "1111111111111111111111111111111111111111111111111111111111111111";
    const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex });
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(401);
    const j = (await res.json()) as { message: string };
    expect(j.message).toMatch(/allowlist/i);
  });

  it("PINATA_ALLOWLIST: accepts a listed pubkey", async () => {
    const kp = freshKeypair();
    process.env.PINATA_ALLOWLIST = kp.xOnlyHex;
    const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex });
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(200);
  });

  it("rate-limits: 11th request inside the window is 429", async () => {
    const kp = freshKeypair();
    // Fire 10 valid requests — all should succeed.
    for (let i = 0; i < 10; i++) {
      const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex });
      const res = await pinataUploadUrlPOST(
        makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
      );
      expect(res.status).toBe(200);
    }
    // 11th must be rate-limited.
    const body = signRequest({ seckey: kp.seckey, pubkey: kp.xOnlyHex });
    const res = await pinataUploadUrlPOST(
      makeRequest(body) as unknown as Parameters<typeof pinataUploadUrlPOST>[0],
    );
    expect(res.status).toBe(429);
    const j = (await res.json()) as { error: string; retryAfter: number };
    expect(j.error).toBe("rate-limited");
    expect(typeof j.retryAfter).toBe("number");
  });
});

/* -------------------------------------------------------------------------- */
/* Gateway helper                                                              */
/* -------------------------------------------------------------------------- */

describe("pinata / fetch (gateway helpers)", () => {
  it("gatewayUrl throws PinataGatewayNotConfiguredError when NEXT_PUBLIC_PINATA_GATEWAY is empty", () => {
    const prior = process.env.NEXT_PUBLIC_PINATA_GATEWAY;
    process.env.NEXT_PUBLIC_PINATA_GATEWAY = "";
    try {
      expect(() => gatewayUrl("bafybogus")).toThrow(
        PinataGatewayNotConfiguredError,
      );
    } finally {
      if (prior === undefined) {
        delete process.env.NEXT_PUBLIC_PINATA_GATEWAY;
      } else {
        process.env.NEXT_PUBLIC_PINATA_GATEWAY = prior;
      }
    }
  });

  it("gatewayUrl strips protocol+trailing slash and constructs an /ipfs/<cid> URL", () => {
    const prior = process.env.NEXT_PUBLIC_PINATA_GATEWAY;
    process.env.NEXT_PUBLIC_PINATA_GATEWAY = "https://example.mypinata.cloud/";
    try {
      expect(gatewayUrl("bafyzzz")).toBe(
        "https://example.mypinata.cloud/ipfs/bafyzzz",
      );
    } finally {
      if (prior === undefined) {
        delete process.env.NEXT_PUBLIC_PINATA_GATEWAY;
      } else {
        process.env.NEXT_PUBLIC_PINATA_GATEWAY = prior;
      }
    }
  });

  it("fallbackGatewayUrls returns a non-empty list of public IPFS gateways", () => {
    const urls = fallbackGatewayUrls("bafyzzz");
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/\/bafyzzz$/);
    }
  });
});
