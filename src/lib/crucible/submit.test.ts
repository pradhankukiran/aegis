/**
 * @vitest-environment happy-dom
 *
 * Source-side submit pipeline tests.
 *
 * Mocks:
 *   - global `fetch` for `/api/pinata/upload-url` (mints fake signed URLs).
 *   - the `pinata` SDK so the actual upload step is canned and never hits
 *     the network. The CID returned by the mock is what we assert on.
 *   - the `AegisTransport` instance is a hand-rolled stub that records
 *     every `publish(event)` call so we can verify the pointer payload.
 *
 * The newsroom-side round-trip (decrypting what the source published)
 * lives in `transport-bridge.test.ts` (not built in this pass — the
 * critical encrypt/decrypt round-trip is already proven in
 * `ecdh.test.ts` + `envelope.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/* Pinata SDK mock                                                             */
/* -------------------------------------------------------------------------- */

const uploadMock = vi.hoisted(() => ({
  cidToReturn: "bafytestcid000000000000000000000000000000000000000000000",
  lastUploadedFile: null as File | null,
  lastCalledWithSignedUrl: null as string | null,
  reset(): void {
    this.cidToReturn = "bafytestcid000000000000000000000000000000000000000000000";
    this.lastUploadedFile = null;
    this.lastCalledWithSignedUrl = null;
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
                uploadMock.lastUploadedFile = file;
                uploadMock.lastCalledWithSignedUrl = signed;
                return { cid: uploadMock.cidToReturn, size: file.size };
              },
            }),
          },
        };
      }
    },
  };
});

/* -------------------------------------------------------------------------- */
/* Imports (post-mock)                                                         */
/* -------------------------------------------------------------------------- */

import { bytesToHex } from "../crypto/encoding";
import { generateIdentity } from "../identity";
import type {
  AegisEventInput,
  AegisTransport,
  PublishResult,
} from "../transport";

import { deriveSharedKey } from "./ecdh";
import { CRUCIBLE_MAX_ATTACHMENT_BYTES, decryptDrop } from "./envelope";
import {
  CrucibleAttachmentTooLargeError,
  PinataNotConfiguredError,
  describeSubmitError,
  dropIdFromPointer,
  submitDrop,
} from "./submit";
import { CRUCIBLE_EVENT_TYPE, type CruciblePointer } from "./types";

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

/**
 * Hand-rolled stub transport. Only the surface area `submitDrop` uses is
 * implemented; every other method is left untyped because we cast to
 * `AegisTransport` at the call site.
 */
class StubTransport {
  publishedEvents: AegisEventInput[] = [];
  publishResults: PublishResult[] = [
    { network: "nostr", ok: true, reason: "relays ok: 1/1" },
    { network: "matrix", ok: true, id: "$matrix-event-id" },
    { network: "ssb", ok: true, id: "%ssb-msg-id.sha256" },
  ];
  async publish(event: AegisEventInput): Promise<PublishResult[]> {
    this.publishedEvents.push(event);
    return this.publishResults;
  }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("crucible / submit", () => {
  beforeEach(() => {
    uploadMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: encrypts, uploads, publishes a pointer, returns the drop id + CID", async () => {
    const fakeSignedUrl =
      "https://uploads.pinata.cloud/v3/files?token=fake-signed";
    const fetchMock = installFetchMock(async (url) => {
      expect(url).toBe("/api/pinata/upload-url");
      return jsonResponse(200, {
        url: fakeSignedUrl,
        expiresAt: Date.now() + 60_000,
      });
    });
    try {
      const newsroom = await generateIdentity();
      const newsroomHex = bytesToHex(newsroom.pubkey);
      const transport = new StubTransport();
      const result = await submitDrop({
        transport: transport as unknown as AegisTransport,
        newsroomPubkeyHex: newsroomHex,
        message: "the project is over budget",
      });

      // Result shape.
      expect(result.cid).toBe(uploadMock.cidToReturn);
      expect(result.dropId).toBe(
        dropIdFromPointer(uploadMock.cidToReturn, result.ephemeralPubkeyHex),
      );
      expect(result.publishResults.length).toBe(3);

      // Pinata upload was called exactly once with the encrypted blob.
      expect(uploadMock.lastCalledWithSignedUrl).toBe(fakeSignedUrl);
      expect(uploadMock.lastUploadedFile?.name).toBe("aegis-crucible-drop.bin");

      // Transport.publish was called exactly once with the right pointer.
      expect(transport.publishedEvents.length).toBe(1);
      const ev = transport.publishedEvents[0];
      expect(ev.type).toBe(CRUCIBLE_EVENT_TYPE);
      const pointer = ev.content as CruciblePointer;
      expect(pointer.to).toBe(newsroomHex.toLowerCase());
      expect(pointer.ephemeralPubkey).toBe(result.ephemeralPubkeyHex);
      expect(pointer.cid).toBe(uploadMock.cidToReturn);
      expect(typeof pointer.ts).toBe("number");

      // /api/pinata/upload-url got hit exactly once.
      expect(fetchMock.fn).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.restore();
    }
  });

  it("the newsroom can decrypt the sealed bytes the source uploaded", async () => {
    // End-to-end: encrypt with source-side ECDH, capture the uploaded
    // bytes from the mock, then decrypt with newsroom-side ECDH and
    // expect the original plaintext back.
    const fetchMock = installFetchMock(async () =>
      jsonResponse(200, {
        url: "https://uploads.pinata.cloud/v3/files?token=x",
        expiresAt: Date.now() + 60_000,
      }),
    );
    try {
      const newsroom = await generateIdentity();
      const newsroomHex = bytesToHex(newsroom.pubkey);
      const transport = new StubTransport();
      const message = "drop body — leaked memo";
      const result = await submitDrop({
        transport: transport as unknown as AegisTransport,
        newsroomPubkeyHex: newsroomHex,
        message,
      });
      // Capture the sealed bytes from the upload mock.
      const sealedFile = uploadMock.lastUploadedFile;
      expect(sealedFile).not.toBeNull();
      const sealedBytes = new Uint8Array(await sealedFile!.arrayBuffer());

      // Newsroom: re-derive the CEK from its OWN seckey + the source's
      // ephemeralPubkey (carried in the pointer event).
      const pointer = transport.publishedEvents[0]
        .content as CruciblePointer;
      const ephemeralPubkeyBytes = new Uint8Array(33);
      const hex = pointer.ephemeralPubkey;
      for (let i = 0; i < 33; i++) {
        ephemeralPubkeyBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      const cek = deriveSharedKey(newsroom.seckey, ephemeralPubkeyBytes);
      const opened = await decryptDrop(sealedBytes, cek);
      expect(opened.plaintext).toBe(message);
      expect(opened.attachments).toBeUndefined();

      // Sanity: the dropId derivation matches.
      expect(dropIdFromPointer(pointer.cid, pointer.ephemeralPubkey)).toBe(
        result.dropId,
      );
    } finally {
      fetchMock.restore();
    }
  });

  it("Pinata 503: propagates PinataNotConfiguredError; never publishes a pointer", async () => {
    const fetchMock = installFetchMock(async () =>
      jsonResponse(503, {
        error: "pinata-not-configured",
        message: "PINATA_JWT env var not set",
      }),
    );
    try {
      const newsroom = await generateIdentity();
      const transport = new StubTransport();
      await expect(
        submitDrop({
          transport: transport as unknown as AegisTransport,
          newsroomPubkeyHex: bytesToHex(newsroom.pubkey),
          message: "x",
        }),
      ).rejects.toBeInstanceOf(PinataNotConfiguredError);
      // No publish should have fired.
      expect(transport.publishedEvents.length).toBe(0);
    } finally {
      fetchMock.restore();
    }
  });

  it("describeSubmitError maps PinataNotConfiguredError to the friendly UI string", () => {
    expect(describeSubmitError(new PinataNotConfiguredError())).toMatch(
      /temporarily unavailable/i,
    );
    expect(describeSubmitError(new Error("boom"))).toBe("boom");
    expect(describeSubmitError("string error")).toBe("string error");
  });

  it("submitDrop rejects a malformed newsroom pubkey before doing any work", async () => {
    const transport = new StubTransport();
    await expect(
      submitDrop({
        transport: transport as unknown as AegisTransport,
        newsroomPubkeyHex: "not-hex!!!",
        message: "x",
      }),
    ).rejects.toThrow();
    expect(transport.publishedEvents.length).toBe(0);
  });

  it("dropIdFromPointer is deterministic for the same (cid, ephemeralPubkey)", () => {
    const a = dropIdFromPointer("bafy123", "02" + "ab".repeat(32));
    const b = dropIdFromPointer("bafy123", "02" + "ab".repeat(32));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dropIdFromPointer differs when either input changes", () => {
    const e = "02" + "ab".repeat(32);
    expect(dropIdFromPointer("a", e)).not.toBe(dropIdFromPointer("b", e));
    expect(dropIdFromPointer("a", e)).not.toBe(
      dropIdFromPointer("a", "03" + "ab".repeat(32)),
    );
  });

  it("rejects an attachment larger than CRUCIBLE_MAX_ATTACHMENT_BYTES before any work", async () => {
    const transport = new StubTransport();
    const newsroom = await generateIdentity();

    // Fake an oversize File using a Blob whose size property we override —
    // we don't want to actually allocate 100 MiB of bytes in the test
    // process. The `size` property is what `submit.ts` checks, so a
    // synthetic File with `size > CRUCIBLE_MAX_ATTACHMENT_BYTES` is enough.
    const oversize = new File([new Uint8Array(8)], "big.bin", {
      type: "application/octet-stream",
    });
    Object.defineProperty(oversize, "size", {
      value: CRUCIBLE_MAX_ATTACHMENT_BYTES + 1,
      configurable: true,
    });

    const fetchMock = installFetchMock(async () =>
      jsonResponse(200, {
        url: "https://uploads.pinata.cloud/v3/files?token=x",
        expiresAt: Date.now() + 60_000,
      }),
    );
    try {
      await expect(
        submitDrop({
          transport: transport as unknown as AegisTransport,
          newsroomPubkeyHex: bytesToHex(newsroom.pubkey),
          message: "small note, large file",
          file: oversize,
        }),
      ).rejects.toBeInstanceOf(CrucibleAttachmentTooLargeError);

      // Nothing should have been published or uploaded — the throw
      // happens before any keypair generation.
      expect(transport.publishedEvents.length).toBe(0);
      expect(uploadMock.lastUploadedFile).toBeNull();
      expect(fetchMock.fn).not.toHaveBeenCalled();
    } finally {
      fetchMock.restore();
    }
  });

  it("describeSubmitError stringifies a CrucibleAttachmentTooLargeError sensibly", () => {
    const err = new CrucibleAttachmentTooLargeError(
      CRUCIBLE_MAX_ATTACHMENT_BYTES + 1,
      CRUCIBLE_MAX_ATTACHMENT_BYTES,
    );
    const msg = describeSubmitError(err);
    expect(msg).toMatch(/too large/i);
  });
});
