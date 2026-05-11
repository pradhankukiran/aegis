/**
 * Scribe — Pinata mirror for the encrypted-envelope blob.
 *
 * # Why a separate layer?
 *
 * IDB persistence (storage.ts) is the local source of truth — every save
 * writes the envelope to the user's browser. Pinata is an opportunistic
 * cross-device mirror: the envelope is already ciphertext (XChaCha20-Poly1305
 * under a master key derived from `identity.seckey`), so the bytes on IPFS
 * are opaque to the gateway and to anyone observing the pinning service.
 * Restoring on a fresh device only needs the identity + the CID.
 *
 * # Failure modes (and why this layer swallows some of them)
 *
 *   - `PinataNotConfiguredError` (HTTP 503 from the signed-URL route):
 *     the deployment has no PINATA_JWT, so we have no cloud path. We log
 *     a warning and return the note unchanged — the IDB row is still good,
 *     personal-note workflow stays usable. Caller does NOT roll back.
 *   - Any other error (network, signed-URL rejection, SDK throw): we
 *     rethrow. The caller (the save hook) decides whether to fail-soft
 *     (fire-and-forget, keep the local write) or fail-hard.
 *
 * # CID lifecycle
 *
 * Each save re-uploads. We don't compute content-equality and skip — the
 * envelope's per-note key + nonce are fresh on every wrap, so two saves of
 * the same plaintext produce two different byte strings and two different
 * CIDs. That's fine: Pinata charges per pin, but the prior CID can be
 * unpinned by a background job; v1 leaves them.
 *
 * # What's NOT here
 *
 *   - Tombstone propagation (delete a note → unpin on Pinata). The IDB
 *     tombstone is the canonical local state; cross-device delete is the
 *     Phase 6+ open question.
 *   - "Browse all my remote notes" discovery. We persist the CID into the
 *     local row so a future device with the same identity can re-fetch via
 *     `loadNoteByCid`, but the cross-device handshake (how does the second
 *     device know the CID list?) is deferred — see the `aegis.scribe.share-
 *     invite` direct-message path for the partial story.
 */

import {
  PinataNotConfiguredError,
  fetchCiphertext,
  uploadCiphertext,
} from "../pinata";
import type { Identity } from "../identity";

import { unwrapNoteContent, deriveMasterKey } from "./envelope";
import type { Note } from "./types";
import { utf8Encode, utf8Decode } from "../crypto/encoding";

/**
 * Result of a `persistNote` call. The `mode` field disambiguates the three
 * happy outcomes:
 *   - `"uploaded"`: blob was pushed to Pinata, CID returned. Caller should
 *     persist the updated Note (with `pinataCid` + `pinataUploadedAt`) back
 *     to IDB so subsequent saves can dedupe / future loads can fall back.
 *   - `"skipped"`: deployment isn't configured for Pinata (no PINATA_JWT
 *     on the server). The Note is returned unchanged. Local-only mode.
 *   - `"already-uploaded"`: reserved — current v1 always re-uploads on
 *     every save, but the helper's signature is forward-compatible.
 */
export type PersistResult = {
  note: Note;
  mode: "uploaded" | "skipped" | "already-uploaded";
};

/**
 * Upload `note.contentEnvelope` to Pinata and return a Note stamped with
 * the resulting CID. On `PinataNotConfiguredError`, returns the note
 * unchanged with `mode: "skipped"`.
 *
 * Throws for any other error — the caller decides whether to surface or
 * swallow.
 *
 * @param note     The Note whose envelope will be uploaded. We read
 *                 `contentEnvelope` (already ciphertext) and treat it as
 *                 opaque bytes; no plaintext is touched here.
 * @param identity Used by `uploadCiphertext` to sign the upload-URL
 *                 request. If a `PINATA_ALLOWLIST` is configured server-
 *                 side, this identity's pubkey must be on it.
 */
export async function persistNote(
  note: Note,
  identity: Identity,
): Promise<PersistResult> {
  if (!note.contentEnvelope) {
    throw new Error("persistNote: note.contentEnvelope is empty");
  }
  // The envelope is a base64url string; we ship the raw UTF-8 bytes of that
  // string as the opaque blob. (Pinata sees the same byte sequence the
  // browser would write to disk — no double-encoding required.)
  const blob = utf8Encode(note.contentEnvelope);
  try {
    const result = await uploadCiphertext(blob, `scribe-${note.id}.bin`, {
      identity,
    });
    return {
      note: {
        ...note,
        pinataCid: result.cid,
        pinataUploadedAt: Date.now(),
      },
      mode: "uploaded",
    };
  } catch (err) {
    if (err instanceof PinataNotConfiguredError) {
      console.warn(
        "[scribe] Pinata not configured; note saved locally only:",
        note.id,
      );
      return { note, mode: "skipped" };
    }
    throw err;
  }
}

/**
 * Fetch + decrypt a note's envelope by its Pinata CID. Used to reconstruct
 * a Note in memory on a fresh device (cold IDB) when the only known handle
 * is the CID — e.g. a share invite carried the CID alongside its room id.
 *
 * The returned Note is the on-disk shape (envelope-only) with `pinataCid`
 * set; the caller is responsible for unwrapping the envelope (via
 * `unwrapNoteContent`) before showing plaintext to the user, and for
 * deciding whether to persist this row to IDB.
 *
 * `id` and `title` must be supplied by the caller — they're metadata that
 * live alongside the CID (e.g. in the share-invite payload). `title` falls
 * back to `"Shared note"` if the caller has nothing better; the user can
 * rename after opening.
 *
 * Throws on:
 *   - PinataGatewayNotConfiguredError (no NEXT_PUBLIC_PINATA_GATEWAY)
 *   - any gateway HTTP error
 *   - master-key decryption failure (wrong identity, tampered blob)
 */
export async function loadNoteByCid(args: {
  cid: string;
  id: string;
  title?: string;
  identity: Identity;
}): Promise<{ note: Note; plaintext: string }> {
  const { cid, id, title, identity } = args;
  if (!cid) throw new Error("loadNoteByCid: cid is required");
  if (!id) throw new Error("loadNoteByCid: id is required");
  const bytes = await fetchCiphertext(cid);
  const envelope = utf8Decode(bytes);
  const masterKey = deriveMasterKey(identity);
  // Round-trip the envelope through unwrap to validate the master key /
  // AAD / version. Returning the plaintext alongside the Note saves the
  // caller from immediately re-unwrapping it.
  const plaintext = await unwrapNoteContent(masterKey, envelope);
  const now = Date.now();
  const note: Note = {
    id,
    title: title ?? "Shared note",
    contentEnvelope: envelope,
    pinataCid: cid,
    pinataUploadedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  return { note, plaintext };
}
