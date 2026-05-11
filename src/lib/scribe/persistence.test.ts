/**
 * Unit tests for the Scribe Pinata mirror.
 *
 * The persistence layer wraps `uploadCiphertext` + `fetchCiphertext` (real
 * Pinata + IPFS gateway calls) with Scribe-shaped Note handling. We mock
 * both functions here so the tests don't touch network — the boundary
 * we care about is "given a Note, did we hand the right bytes to Pinata
 * and stamp the right CID back onto the row?".
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { utf8Decode } from "../crypto/encoding";

/* -------------------------------------------------------------------------- */
/* pinata mocks                                                                */
/* -------------------------------------------------------------------------- */

const pinataMock = vi.hoisted(() => ({
  uploadCalls: [] as Array<{ bytes: Uint8Array; filename: string }>,
  uploadResult: {
    cid: "bafytest000000000000000000000000000000000000000000000000",
    size: 0,
  } as { cid: string; size: number },
  uploadShouldThrow: null as null | (() => Error),
  fetchCalls: [] as string[],
  fetchResult: new Uint8Array(0),
  reset(): void {
    this.uploadCalls = [];
    this.uploadResult = {
      cid: "bafytest000000000000000000000000000000000000000000000000",
      size: 0,
    };
    this.uploadShouldThrow = null;
    this.fetchCalls = [];
    this.fetchResult = new Uint8Array(0);
  },
}));

/**
 * Mock the Pinata barrel — every helper persistence.ts depends on funnels
 * through `../pinata`. We preserve the `PinataNotConfiguredError` class so
 * the `instanceof` check in `persistNote` continues to do real work.
 */
vi.mock("../pinata", async () => {
  class PinataNotConfiguredError extends Error {
    override readonly name = "PinataNotConfiguredError";
  }
  return {
    PinataNotConfiguredError,
    uploadCiphertext: vi.fn(
      async (bytes: Uint8Array, filename: string): Promise<{ cid: string; size: number }> => {
        if (pinataMock.uploadShouldThrow) {
          throw pinataMock.uploadShouldThrow();
        }
        pinataMock.uploadCalls.push({ bytes, filename });
        return pinataMock.uploadResult;
      },
    ),
    fetchCiphertext: vi.fn(async (cid: string): Promise<Uint8Array> => {
      pinataMock.fetchCalls.push(cid);
      return pinataMock.fetchResult;
    }),
  };
});

/* -------------------------------------------------------------------------- */
/* Imports under test (after mocks)                                            */
/* -------------------------------------------------------------------------- */

import { loadNoteByCid, persistNote } from "./persistence";
import { deriveMasterKey, wrapNoteContent } from "./envelope";
import type { Note } from "./types";
import type { Identity } from "../identity";
import { PinataNotConfiguredError } from "../pinata";

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function stubIdentity(byte: number): Identity {
  return {
    pubkey: new Uint8Array(33).fill(byte === 0 ? 1 : byte),
    seckey: new Uint8Array(32).fill(byte === 0 ? 1 : byte),
    createdAt: 0,
  };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  const now = Date.now();
  return {
    id: "n-" + Math.random().toString(16).slice(2),
    title: "Test note",
    contentEnvelope: "stub-envelope-base64url",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("scribe / persistence — persistNote", () => {
  beforeEach(() => {
    pinataMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: uploads the envelope and stamps the CID + uploadedAt onto the note", async () => {
    const note = makeNote({ id: "n1", contentEnvelope: "abc.def" });
    pinataMock.uploadResult = {
      cid: "bafyhappyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      size: 7,
    };
    const before = Date.now();
    const res = await persistNote(note, stubIdentity(0xa1));
    const after = Date.now();
    expect(res.mode).toBe("uploaded");
    expect(res.note.pinataCid).toBe(pinataMock.uploadResult.cid);
    expect(typeof res.note.pinataUploadedAt).toBe("number");
    expect(res.note.pinataUploadedAt).toBeGreaterThanOrEqual(before);
    expect(res.note.pinataUploadedAt).toBeLessThanOrEqual(after);
    // Original fields preserved.
    expect(res.note.id).toBe("n1");
    expect(res.note.contentEnvelope).toBe("abc.def");
  });

  it("ships the envelope string's UTF-8 bytes verbatim to Pinata", async () => {
    const envelope = "envelope-base64url-payload-deadbeef";
    const note = makeNote({ contentEnvelope: envelope });
    await persistNote(note, stubIdentity(0xb2));
    expect(pinataMock.uploadCalls.length).toBe(1);
    const sent = pinataMock.uploadCalls[0];
    expect(utf8Decode(sent.bytes)).toBe(envelope);
    expect(sent.filename).toBe(`scribe-${note.id}.bin`);
  });

  it("graceful degrade: PinataNotConfiguredError → mode='skipped', note unchanged", async () => {
    const note = makeNote({ id: "n2" });
    pinataMock.uploadShouldThrow = () =>
      new PinataNotConfiguredError("PINATA_JWT env var not set");
    // Silence the console warning so the test output stays clean.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await persistNote(note, stubIdentity(0xc3));
      expect(res.mode).toBe("skipped");
      expect(res.note).toBe(note); // same reference — truly unchanged
      expect(res.note.pinataCid).toBeUndefined();
      expect(res.note.pinataUploadedAt).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("non-503 errors propagate (caller decides whether to roll back)", async () => {
    const note = makeNote();
    pinataMock.uploadShouldThrow = () => new Error("network failure");
    await expect(persistNote(note, stubIdentity(0xd4))).rejects.toThrow(
      "network failure",
    );
  });

  it("rejects when contentEnvelope is empty (no point uploading)", async () => {
    const note = makeNote({ contentEnvelope: "" });
    await expect(persistNote(note, stubIdentity(0xa1))).rejects.toThrow(
      /contentEnvelope is empty/,
    );
    expect(pinataMock.uploadCalls.length).toBe(0);
  });
});

describe("scribe / persistence — loadNoteByCid", () => {
  beforeEach(() => {
    pinataMock.reset();
  });

  it("round-trips a real envelope: fetch → unwrap → plaintext", async () => {
    const id = stubIdentity(0xe5);
    const masterKey = deriveMasterKey(id);
    const plaintext = "a note that took the long way home";
    const envelope = await wrapNoteContent(masterKey, plaintext);
    // Mock the gateway to return the same envelope bytes.
    const enc = new TextEncoder();
    pinataMock.fetchResult = enc.encode(envelope);
    const { note, plaintext: opened } = await loadNoteByCid({
      cid: "bafyfetched",
      id: "n-roundtrip",
      title: "Reloaded",
      identity: id,
    });
    expect(opened).toBe(plaintext);
    expect(note.id).toBe("n-roundtrip");
    expect(note.title).toBe("Reloaded");
    expect(note.pinataCid).toBe("bafyfetched");
    expect(note.contentEnvelope).toBe(envelope);
    expect(pinataMock.fetchCalls).toEqual(["bafyfetched"]);
  });

  it("defaults title to 'Shared note' when none is supplied", async () => {
    const id = stubIdentity(0xa1);
    const masterKey = deriveMasterKey(id);
    const envelope = await wrapNoteContent(masterKey, "x");
    const enc = new TextEncoder();
    pinataMock.fetchResult = enc.encode(envelope);
    const { note } = await loadNoteByCid({
      cid: "bafyz",
      id: "n-no-title",
      identity: id,
    });
    expect(note.title).toBe("Shared note");
  });

  it("rejects an envelope that doesn't decrypt under the supplied identity", async () => {
    const author = stubIdentity(0xa1);
    const stranger = stubIdentity(0xff);
    const masterKey = deriveMasterKey(author);
    const envelope = await wrapNoteContent(masterKey, "secret");
    const enc = new TextEncoder();
    pinataMock.fetchResult = enc.encode(envelope);
    await expect(
      loadNoteByCid({
        cid: "bafyfetched",
        id: "n-evil",
        identity: stranger,
      }),
    ).rejects.toThrow();
  });

  it("rejects empty cid / id arguments", async () => {
    const id = stubIdentity(0xa1);
    await expect(
      loadNoteByCid({ cid: "", id: "n1", identity: id }),
    ).rejects.toThrow(/cid is required/);
    await expect(
      loadNoteByCid({ cid: "bafyz", id: "", identity: id }),
    ).rejects.toThrow(/id is required/);
  });
});
