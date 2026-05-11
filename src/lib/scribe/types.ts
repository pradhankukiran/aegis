/**
 * Scribe — type definitions for the Phase 4 encrypted-notes feature.
 *
 * A `Note` is the persisted shape (IDB row): metadata in the clear, content
 * sealed inside an XChaCha20-Poly1305 envelope. `NoteDraft` is the in-memory
 * plaintext working copy the UI mutates while the user is editing — it never
 * touches IndexedDB unsealed.
 *
 * # Why two shapes?
 *
 * Encryption lives at the storage boundary: every IDB write seals the
 * plaintext, every read unseals it. Carrying a "decrypted Note" type alongside
 * the persisted one would make it easy to accidentally write plaintext to
 * disk; instead we keep `Note` as the on-disk form (envelope only) and
 * `NoteDraft` as the live editor state.
 */

/**
 * On-disk note shape. The envelope holds the encrypted content + a wrapped
 * per-note key; metadata stays in the clear so the list view can render
 * without unsealing every note.
 *
 * - `id`              uuid v4-ish (see `mintNoteId` in `hooks.ts`). IDB key.
 * - `title`           plaintext display title. The first line of the body, or
 *                     whatever the user explicitly sets. Not encrypted — the
 *                     list view needs to render it without unsealing every
 *                     note.
 * - `contentEnvelope` base64url-encoded envelope, see `envelope.ts`.
 * - `sharedRoomId`    Matrix room id when the note is shared; undefined for
 *                     personal-only notes.
 * - `sharedWith`      Recipient pubkey hex strings (66-char SEC1-compressed
 *                     form, matching `pubkeyHex(identity)`). Only populated
 *                     when the note is shared — used by the toolbar badge
 *                     ("SHARED · N peers") and as the source of truth for
 *                     who the share-invite directMessages were sent to.
 * - `sharedAt`        Unix ms when the share-room was minted.
 * - `pinataCid`       Content-id of the encrypted envelope blob pinned to
 *                     IPFS via Pinata, when present. Cross-device load can
 *                     restore the row from this CID alone (the envelope is
 *                     self-contained and decrypts under the master key
 *                     derived from `identity.seckey`).
 * - `pinataUploadedAt` Unix ms when the most recent successful upload of
 *                      `contentEnvelope` to Pinata completed. Drives the
 *                      "is the cloud copy stale?" heuristic — if it's older
 *                      than `updatedAt`, the local envelope hasn't been
 *                      mirrored yet.
 * - `createdAt`       Unix ms.
 * - `updatedAt`       Unix ms. Sort key for the list (secondary index).
 * - `deletedMarker`   Soft-delete tombstone. When `true`, the row exists in
 *                     IDB only so cross-device sync can propagate the
 *                     deletion; the active-notes filter excludes it from
 *                     the UI list. See `deleteNote` / `loadActiveNotes`.
 * - `deletedAt`       Unix ms — when the tombstone was created. Paired with
 *                     `deletedMarker`; used by `purgeDeletedNotes` to
 *                     reclaim tombstones older than a chosen window.
 */
export type Note = {
  id: string;
  title: string;
  contentEnvelope: string;
  sharedRoomId?: string;
  sharedWith?: string[];
  sharedAt?: number;
  pinataCid?: string;
  pinataUploadedAt?: number;
  createdAt: number;
  updatedAt: number;
  deletedMarker?: boolean;
  deletedAt?: number;
};

/**
 * In-memory working copy for the editor. The `content` field is plaintext —
 * never written to disk in this shape. `useNote` keeps a draft alongside the
 * persisted `Note`, calls `save()` to seal+persist, and uses dirty-tracking
 * to gate the autosave / "unsaved changes" UI.
 */
export type NoteDraft = {
  id: string;
  title: string;
  content: string;
};
