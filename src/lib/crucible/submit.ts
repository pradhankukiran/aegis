/**
 * Crucible — source-side submission pipeline.
 *
 * Composes:
 *
 *   ephemeral identity → ECDH shared key → XChaCha20-Poly1305 envelope →
 *   Pinata upload → pointer event on all three Aegis transports.
 *
 * # Memory hygiene
 *
 * The ephemeral seckey AND the derived CEK are wiped in a `finally` block
 * before this function returns (success or error). That happens
 * unconditionally — a thrown Pinata error or a transport rejection still
 * scrubs the secret. Documented in `ephemeral.ts`.
 *
 * # NO IDB persistence
 *
 * This module never imports from `./store`. Verifiable by reading the
 * imports below. The whole point of the source side is fire-and-forget:
 * the source publishes the drop, sees a success screen with the IDs they
 * need to write down, and the browser tab can be closed without leaving
 * a trace on disk.
 *
 * # Drop ID derivation
 *
 * `id = sha256_hex(cid + ":" + ephemeralPubkeyHex)`. We use the same
 * value on the newsroom side (computed from the pointer event content),
 * so the source and newsroom see the same drop id without either side
 * having to send it on the wire.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToHex, utf8Encode } from "../crypto/encoding";
import {
  PinataNotConfiguredError,
  uploadCiphertext,
} from "../pinata";
import type { AegisTransport, PublishResult } from "../transport";

import { deriveSharedKey, peerPubkeyBytesFromHex } from "./ecdh";
import { CRUCIBLE_MAX_ATTACHMENT_BYTES, encryptDrop } from "./envelope";
import {
  generateEphemeralIdentity,
  wipeEphemeralSeckey,
} from "./ephemeral";
import { CRUCIBLE_EVENT_TYPE, type CruciblePointer } from "./types";

/** Re-exported so UI code can surface graceful-degradation copy. */
export { PinataNotConfiguredError } from "../pinata";

/**
 * Thrown by `submitDrop` when the attachment exceeds the
 * `CRUCIBLE_MAX_ATTACHMENT_BYTES` cap. Pre-encryption guard — the
 * ephemeral keypair is never generated and no Pinata round-trip is fired,
 * so a rejected oversize submit leaves the network completely cold.
 *
 * UI code does an `instanceof` check to render the brutalist cap warning;
 * see `SourceDropbox.tsx`.
 */
export class CrucibleAttachmentTooLargeError extends Error {
  public readonly size: number;
  public readonly limit: number;
  constructor(size: number, limit: number) {
    super(
      `Crucible attachment too large: ${size} bytes (limit ${limit} bytes).`,
    );
    this.name = "CrucibleAttachmentTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

/**
 * Result of a successful submission. The `cid` is what the source saves
 * for future status checks; the `dropId` is the same value the newsroom
 * will see when the pointer event arrives.
 *
 * `publishResults` is the per-network publish outcome — useful for
 * debugging in dev but the source UI doesn't surface it (an anonymous
 * source has no actionable response if Nostr accepted but Matrix didn't).
 */
export type SubmitResult = {
  dropId: string;
  cid: string;
  ephemeralPubkeyHex: string;
  ts: number;
  publishResults: PublishResult[];
};

/**
 * Filename used when uploading the sealed ciphertext to Pinata. Pinata
 * indexes by name in their dashboard; we use a stable name with no
 * personally identifying information so the upload metadata reveals no
 * more than the CID does.
 */
const PINATA_UPLOAD_FILENAME = "aegis-crucible-drop.bin";

/**
 * Compute the synthetic drop id from a pointer's `cid` + `ephemeralPubkey`.
 * Both sides agree on this derivation — `submit.ts` uses it on the source
 * side; `transport-bridge.ts` uses it on the newsroom side.
 */
export function dropIdFromPointer(
  cid: string,
  ephemeralPubkeyHex: string,
): string {
  return bytesToHex(sha256(utf8Encode(cid + ":" + ephemeralPubkeyHex)));
}

/**
 * Submit a Crucible drop. Performs the full pipeline:
 *
 *   1. Generate a fresh ephemeral keypair (in-memory only).
 *   2. Derive ECDH(ephemeral.seckey, newsroomPubkey) → CEK.
 *   3. `encryptDrop(plaintext, file, CEK)` → sealed ciphertext.
 *   4. `uploadCiphertext(sealed)` → CID.
 *   5. `transport.publish({ type: "aegis.crucible.drop", content: pointer })`
 *      fan-out across whatever networks are connected.
 *   6. Wipe ephemeral seckey + CEK in a finally block.
 *
 * @throws {PinataNotConfiguredError} when the server can't mint upload URLs.
 *         UI surfaces a "service temporarily unavailable" message; the
 *         error bubbles up unmodified so callers can `instanceof`-discriminate.
 */
export async function submitDrop(opts: {
  transport: AegisTransport;
  newsroomPubkeyHex: string;
  message: string;
  file?: File;
}): Promise<SubmitResult> {
  const { transport, newsroomPubkeyHex, message, file } = opts;

  // Validate the newsroom pubkey shape up front — fail before doing any
  // work the caller can't undo. `peerPubkeyBytesFromHex` accepts both
  // 64- and 66-char hex forms.
  const newsroomPubkeyBytes = peerPubkeyBytesFromHex(newsroomPubkeyHex);

  // Enforce the attachment size cap BEFORE any keypair generation or
  // encryption. The throw is observable to the caller as a typed error
  // they can `instanceof`-check; UI maps it to a brutalist warning.
  if (file && file.size > CRUCIBLE_MAX_ATTACHMENT_BYTES) {
    throw new CrucibleAttachmentTooLargeError(
      file.size,
      CRUCIBLE_MAX_ATTACHMENT_BYTES,
    );
  }

  const ephemeral = await generateEphemeralIdentity();
  let cek: Uint8Array | null = null;

  try {
    cek = deriveSharedKey(ephemeral.seckey, newsroomPubkeyBytes);
    const sealed = await encryptDrop(message, file, cek);
    const upload = await uploadCiphertext(sealed, PINATA_UPLOAD_FILENAME);
    const ts = Math.floor(Date.now() / 1000);
    const ephemeralPubkeyHex = bytesToHex(ephemeral.pubkey);
    // Keep the newsroom pubkey verbatim in the pointer so the subscriber
    // can compare against either canonical form (66- or 64-char hex)
    // without us pre-canonicalizing here.
    const pointer: CruciblePointer = {
      to: newsroomPubkeyHex.trim().toLowerCase(),
      ephemeralPubkey: ephemeralPubkeyHex,
      cid: upload.cid,
      ts,
    };
    const publishResults = await transport.publish({
      type: CRUCIBLE_EVENT_TYPE,
      content: pointer,
    });
    const dropId = dropIdFromPointer(upload.cid, ephemeralPubkeyHex);
    return {
      dropId,
      cid: upload.cid,
      ephemeralPubkeyHex,
      ts,
      publishResults,
    };
  } finally {
    // Wipe both secrets unconditionally, on success and on every error
    // path. This is the documented memory-hygiene contract from the
    // file header + `ephemeral.ts`.
    wipeEphemeralSeckey(ephemeral.seckey);
    if (cek) {
      cek.fill(0);
    }
  }
}

/**
 * Friendly error string for the source UI when `submitDrop` rejects.
 * Specifically maps `PinataNotConfiguredError` to a deployment-flavored
 * "temporarily unavailable" message that does NOT leak the missing env
 * var name. Other errors fall through to their `message`.
 */
export function describeSubmitError(err: unknown): string {
  if (err instanceof PinataNotConfiguredError) {
    return "Drop service temporarily unavailable. Please try again later.";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
