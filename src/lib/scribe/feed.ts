/**
 * Scribe feed entries — save + delete markers.
 *
 * # Historical context
 *
 * Phase 4 originally used the SSB pub for save/delete markers. The SSB
 * transport was removed during Phase 5 (Conduit deprecation took SSB along
 * with it), but the call sites in this module's API surface remained so
 * features depending on the marker semantics didn't need a coordinated
 * rewrite.
 *
 * # Current behaviour (post-SSB removal)
 *
 * Both `publishSaveMarker` and `publishDeleteMarker` are no-ops at the
 * wire level. They preserve the function signature + return-shape contract
 * so the existing call sites (in `useSaveNote` / `useDeleteNote`) still
 * compile and run, but they perform no I/O. The Pinata mirror in
 * `persistence.ts` carries cross-device save semantics; tombstone
 * propagation across devices is a Phase 6+ open question (see the
 * persistence module's docs).
 *
 * Keeping these as well-typed no-ops (rather than removing them outright)
 * means a future feed-channel reintroduction — e.g. publishing to a
 * Nostr-replaceable kind, or to a CRDT-side update — only needs to fill in
 * the body of each function. Callers don't change.
 */

import type { AegisTransport } from "../transport";

/** Aegis logical type for a Scribe save marker. Kept for forward
 * compatibility — see file header. */
export const SCRIBE_SAVED_TYPE = "note-saved";

/**
 * Aegis logical type for a Scribe delete tombstone. The receive side keys
 * deletion intent off this type — see the file header.
 */
export const SCRIBE_DELETED_TYPE = "note-deleted";

/**
 * Publish a save marker. Currently a no-op (SSB removed). Returns a
 * resolved promise; never rejects.
 *
 * The arguments are accepted as-is so call sites don't need to change
 * when the feed channel is reintroduced.
 */
export async function publishSaveMarker(
  transport: AegisTransport | null,
  noteId: string,
  updatedAt: number,
): Promise<void> {
  void transport;
  void noteId;
  void updatedAt;
  return;
}

/**
 * Publish a delete tombstone. Currently a no-op (SSB removed). Returns a
 * resolved promise; never rejects.
 */
export async function publishDeleteMarker(
  transport: AegisTransport | null,
  noteId: string,
  ts: number = Date.now(),
): Promise<void> {
  void transport;
  void noteId;
  void ts;
  return;
}
