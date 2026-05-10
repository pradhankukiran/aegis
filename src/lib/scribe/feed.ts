/**
 * Scribe feed entries — SSB save + delete markers.
 *
 * Every time the user saves a note we publish an `aegis-note-saved` event
 * to SSB through the AegisTransport facade. The payload is intentionally
 * opaque metadata — note id and timestamp only. The encrypted body never
 * touches the feed (it's persisted to IDB locally and, in the live-infra
 * tier, to Pinata for cross-device sync).
 *
 * Deletes follow the same pattern: a tombstone-shaped `aegis-note-deleted`
 * event whose payload is just `{ note_id, ts }`. The receive side (cross-
 * device sync, when wired) reconciles the tombstone against the local
 * IDB rows by id.
 *
 * Failures are swallowed: a flaky pub connection must not block local saves
 * or deletes. We log to console so devtools surfaces the reason.
 */

import type { AegisTransport } from "../transport";

/** Aegis logical type for a Scribe save marker. */
export const SCRIBE_SAVED_TYPE = "note-saved";

/**
 * Aegis logical type for a Scribe delete tombstone. The receive side keys
 * deletion intent off this type — see the file header.
 */
export const SCRIBE_DELETED_TYPE = "note-deleted";

/**
 * Publish a save marker to SSB. The `aegis-` prefix is added by the SSB
 * transport — the wire form is `type: "aegis-note-saved"`.
 *
 * Returns void; never rejects.
 */
export async function publishSaveMarker(
  transport: AegisTransport | null,
  noteId: string,
  updatedAt: number,
): Promise<void> {
  if (!transport) return;
  try {
    await transport.ssb.publish({
      type: "aegis-" + SCRIBE_SAVED_TYPE,
      payload: { note_id: noteId, updatedAt },
    });
  } catch (err) {
    console.error("[scribe] save-marker publish failed:", err);
  }
}

/**
 * Publish a delete tombstone to SSB. Wire form is
 * `{ type: "aegis-note-deleted", payload: { note_id, ts } }`. The IDB row
 * is also tombstoned locally (see `deleteNote` in `storage.ts`); this
 * marker is what makes the deletion visible to a future cross-device
 * reconciler.
 *
 * Returns void; never rejects.
 */
export async function publishDeleteMarker(
  transport: AegisTransport | null,
  noteId: string,
  ts: number = Date.now(),
): Promise<void> {
  if (!transport) return;
  try {
    await transport.ssb.publish({
      type: "aegis-" + SCRIBE_DELETED_TYPE,
      payload: { note_id: noteId, ts },
    });
  } catch (err) {
    console.error("[scribe] delete-marker publish failed:", err);
  }
}
