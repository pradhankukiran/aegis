/**
 * Crucible envelope — XChaCha20-Poly1305 with AAD `aegis:crucible:v=1`.
 *
 * # On-the-wire format
 *
 * The plaintext that goes into XChaCha20-Poly1305 is a packed binary
 * payload, NOT JSON. JSON would force base64-encoding every attachment,
 * which doubles the size of a 5MB PDF. Layout:
 *
 *   magic        4 bytes   ASCII "ACV1" (Aegis Crucible Version 1)
 *   textLen      4 bytes   big-endian uint32 — UTF-8 byte length of the message
 *   textBytes    textLen bytes
 *   fileCount    2 bytes   big-endian uint16 — number of attachments (0..N)
 *   for each file:
 *     nameLen    2 bytes   big-endian uint16 — UTF-8 byte length of the filename
 *     nameBytes  nameLen bytes
 *     fileSize   4 bytes   big-endian uint32 — uncompressed byte size (same as len(fileBytes))
 *     fileBytes  fileSize bytes
 *
 * The whole packed payload is encrypted with XChaCha20-Poly1305 under the
 * caller-provided 32-byte CEK and AAD bound to `aegis:crucible:v=1`. The
 * sealed bytes returned by `encryptDrop` are exactly what `encryptBytes`
 * returns: 24-byte nonce || ciphertext || 16-byte Poly1305 tag.
 *
 * # AAD binding
 *
 * All Crucible ciphertexts are sealed with AAD `aegis:crucible:v=1`. A
 * future v=2 envelope (different layout) cannot be silently downgraded
 * into a v=1 reader because the AAD won't match.
 *
 * # Why not gzip first
 *
 * Plaintext compression before encryption can leak information through
 * size side-channels (CRIME/BREACH-style). Source drops are typically a
 * short markdown + one document attachment — the bandwidth cost of
 * skipping compression is acceptable and the security gain is real.
 *
 * # Size limits
 *
 * - Message text is bounded by uint32 (~4 GiB) which is effectively
 *   unlimited; UI clamps to a sensible UX cap (see SourceDropbox).
 * - Each filename is bounded by uint16 (65 535 bytes) — far beyond any
 *   sane filename length.
 * - Each file is bounded by uint32 (~4 GiB) — well above Pinata's free
 *   tier cap, also effectively unlimited.
 */

import {
  decryptBytes,
  encryptBytes,
  SYMMETRIC_KEY_BYTES,
} from "../crypto/symmetric";
import { utf8Decode, utf8Encode } from "../crypto/encoding";

/** AAD bound to every Crucible envelope. */
export const CRUCIBLE_AAD = utf8Encode("aegis:crucible:v=1");

/**
 * Maximum attachment size accepted by the source-side submit pipeline.
 *
 * The wire format supports uint32 (~4 GiB) but the UX cap is far lower:
 * a single browser tab encrypting + uploading a multi-GB file would
 * exhaust memory and hang the page. 100 MiB is well above the practical
 * size of leaked documents (memos, PDFs, audio clips) and well below
 * Pinata's free-tier limits.
 *
 * Enforced in `submit.ts` (throws `CrucibleAttachmentTooLargeError` before
 * encryption begins) and surfaced in the UI placeholder text via
 * `SourceDropbox.tsx`.
 */
export const CRUCIBLE_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Magic prefix in the packed payload (ACV1 = Aegis Crucible v1). */
const MAGIC = utf8Encode("ACV1");

/**
 * One attachment in the packed payload. `bytes.length` must equal the
 * advertised `size` — `encryptDrop` derives `size` from `bytes.length`
 * so this is automatic on the encrypt side; `decryptDrop` validates.
 */
export type EnvelopeAttachment = {
  name: string;
  /** Same as `bytes.length`. Carried explicitly so the on-the-wire format is self-describing. */
  size: number;
  bytes: Uint8Array;
};

/**
 * Pack the (text, attachments) payload into a single Uint8Array using
 * the layout described in the file header. Caller-only helper; exported
 * for tests so the layout is independently checkable.
 */
export function packPayload(
  text: string,
  attachments: EnvelopeAttachment[],
): Uint8Array {
  const textBytes = utf8Encode(text);
  if (textBytes.length > 0xffff_ffff) {
    throw new Error("packPayload: text exceeds uint32 byte length");
  }
  // First pass — sum up the total byte length so we can allocate exactly.
  let total = MAGIC.length + 4 + textBytes.length + 2;
  type PreparedAtt = { nameBytes: Uint8Array; bytes: Uint8Array };
  const prepared: PreparedAtt[] = [];
  for (const att of attachments) {
    const nameBytes = utf8Encode(att.name);
    if (nameBytes.length > 0xffff) {
      throw new Error("packPayload: attachment name exceeds uint16 byte length");
    }
    if (att.bytes.length > 0xffff_ffff) {
      throw new Error("packPayload: attachment exceeds uint32 byte length");
    }
    if (att.size !== att.bytes.length) {
      throw new Error("packPayload: attachment size mismatch (size != bytes.length)");
    }
    total += 2 + nameBytes.length + 4 + att.bytes.length;
    prepared.push({ nameBytes, bytes: att.bytes });
  }
  if (attachments.length > 0xffff) {
    throw new Error("packPayload: fileCount exceeds uint16 limit");
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let cursor = 0;
  out.set(MAGIC, cursor); cursor += MAGIC.length;
  view.setUint32(cursor, textBytes.length, /* littleEndian */ false); cursor += 4;
  out.set(textBytes, cursor); cursor += textBytes.length;
  view.setUint16(cursor, prepared.length, false); cursor += 2;
  for (const p of prepared) {
    view.setUint16(cursor, p.nameBytes.length, false); cursor += 2;
    out.set(p.nameBytes, cursor); cursor += p.nameBytes.length;
    view.setUint32(cursor, p.bytes.length, false); cursor += 4;
    out.set(p.bytes, cursor); cursor += p.bytes.length;
  }
  return out;
}

/** Inverse of `packPayload`. Throws if any length field is inconsistent. */
export function unpackPayload(packed: Uint8Array): {
  text: string;
  attachments: EnvelopeAttachment[];
} {
  if (packed.length < MAGIC.length + 4 + 2) {
    throw new Error("unpackPayload: payload too short");
  }
  const view = new DataView(
    packed.buffer,
    packed.byteOffset,
    packed.byteLength,
  );
  let cursor = 0;
  for (let i = 0; i < MAGIC.length; i++) {
    if (packed[cursor + i] !== MAGIC[i]) {
      throw new Error("unpackPayload: magic prefix mismatch");
    }
  }
  cursor += MAGIC.length;
  const textLen = view.getUint32(cursor, false); cursor += 4;
  if (cursor + textLen + 2 > packed.length) {
    throw new Error("unpackPayload: text length exceeds buffer");
  }
  const text = utf8Decode(packed.subarray(cursor, cursor + textLen));
  cursor += textLen;
  const fileCount = view.getUint16(cursor, false); cursor += 2;
  const attachments: EnvelopeAttachment[] = [];
  for (let i = 0; i < fileCount; i++) {
    if (cursor + 2 > packed.length) {
      throw new Error("unpackPayload: filename length header truncated");
    }
    const nameLen = view.getUint16(cursor, false); cursor += 2;
    if (cursor + nameLen + 4 > packed.length) {
      throw new Error("unpackPayload: filename body / size header truncated");
    }
    const name = utf8Decode(packed.subarray(cursor, cursor + nameLen));
    cursor += nameLen;
    const size = view.getUint32(cursor, false); cursor += 4;
    if (cursor + size > packed.length) {
      throw new Error("unpackPayload: attachment body truncated");
    }
    // Copy into an independent Uint8Array so the caller can keep it after
    // we discard `packed` (e.g. for IDB persistence).
    const bytes = packed.slice(cursor, cursor + size);
    cursor += size;
    attachments.push({ name, size, bytes });
  }
  if (cursor !== packed.length) {
    // Trailing garbage means the format is wrong or the ciphertext is
    // mismatched. Treat as a parse failure.
    throw new Error(
      `unpackPayload: ${packed.length - cursor} trailing bytes after parse`,
    );
  }
  return { text, attachments };
}

/**
 * Encrypt a Crucible drop. Accepts the markdown body and zero-or-one
 * `File` attachment (multi-attachment is reserved — the packed format
 * supports it, but the source UI v1 only exposes a single picker).
 *
 * The returned `Uint8Array` is the full sealed payload (nonce || ct ||
 * tag) ready to upload to Pinata.
 */
export async function encryptDrop(
  plaintext: string,
  file: File | undefined,
  cek: Uint8Array,
): Promise<Uint8Array> {
  if (cek.length !== SYMMETRIC_KEY_BYTES) {
    throw new Error(
      `encryptDrop: cek must be ${SYMMETRIC_KEY_BYTES} bytes, got ${cek.length}`,
    );
  }
  const attachments: EnvelopeAttachment[] = [];
  if (file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    attachments.push({ name: file.name, size: bytes.length, bytes });
  }
  const packed = packPayload(plaintext, attachments);
  return encryptBytes(cek, packed, CRUCIBLE_AAD);
}

/**
 * Decrypt a Crucible drop. Returns the plaintext markdown and any
 * attachments. AAD mismatch or CEK mismatch surfaces as a thrown error
 * from `decryptBytes`.
 */
export async function decryptDrop(
  ciphertext: Uint8Array,
  cek: Uint8Array,
): Promise<{ plaintext: string; attachments?: EnvelopeAttachment[] }> {
  if (cek.length !== SYMMETRIC_KEY_BYTES) {
    throw new Error(
      `decryptDrop: cek must be ${SYMMETRIC_KEY_BYTES} bytes, got ${cek.length}`,
    );
  }
  const packed = await decryptBytes(cek, ciphertext, CRUCIBLE_AAD);
  const { text, attachments } = unpackPayload(packed);
  if (attachments.length === 0) {
    return { plaintext: text };
  }
  return { plaintext: text, attachments };
}
