/**
 * Scribe — Y.js CRDT scaffolding for shared notes.
 *
 * Personal notes don't need CRDT: there's exactly one writer (this device),
 * so a plain string in the editor + envelope-sealed snapshot in IDB is
 * sufficient. Shared notes are the motivator for Yjs — multiple devices
 * mutating the same text concurrently need conflict-free merges, and Yjs is
 * the de-facto answer for collaborative text.
 *
 * # What this module ships in v1
 *
 * - A `Y.Doc` factory keyed by note id, with single-doc caching so repeated
 *   `getDoc(id)` calls return the same instance (Yjs docs are stateful — you
 *   want one per logical document, not per render).
 * - Helpers `setText` / `getText` to read and write the canonical "content"
 *   `Y.Text` inside the doc.
 * - An `observeText` helper that registers a Yjs observer and returns its
 *   removal closure — the React hook layer uses this to subscribe.
 *
 * # What's intentionally NOT here (live-infra deferred)
 *
 * - No transport binding. A future `bindMatrixCRDT(doc, transport, roomId)`
 *   will hook `doc.on("update", ...)` to publish encoded updates into a
 *   Matrix room as custom-typed events, and forward incoming updates back
 *   into the doc via `Y.applyUpdate`. We can't verify that loop without a
 *   live Conduit homeserver — Wave 4a defers it.
 * - No persistence to IDB. `Y.Doc` state can be serialized via
 *   `Y.encodeStateAsUpdate`; we'll layer that into `storage.ts` once shared
 *   notes have a stable on-disk shape. v1 sticks with the plaintext-snapshot
 *   model in `envelope.ts` for both personal and shared notes — sharing
 *   just adds a Matrix room id and the in-memory CRDT mirror.
 */

import * as Y from "yjs";

/**
 * Conventional name of the `Y.Text` field inside every Scribe Y.Doc. All
 * three layers (factory, setText/getText, future transport binding) agree
 * on this name so any reader can pull the content out the same way.
 */
const TEXT_FIELD = "content";

/**
 * Per-note Y.Doc cache. Yjs docs hold state (insert positions, undo stack,
 * observers), so we want one instance per logical document for the lifetime
 * of the page. Cleared on `disposeDoc(id)`.
 *
 * Module-level state is acceptable here because the Scribe page is the
 * only consumer; if/when CRDT moves to a worker we'll relocate the map.
 */
const docCache = new Map<string, Y.Doc>();

/**
 * Get-or-create the Y.Doc for `noteId`. Returns the same instance on
 * subsequent calls within the same page lifetime.
 */
export function getDoc(noteId: string): Y.Doc {
  let doc = docCache.get(noteId);
  if (!doc) {
    doc = new Y.Doc();
    docCache.set(noteId, doc);
  }
  return doc;
}

/** Discard a cached doc. Call when a note is deleted or the page unmounts. */
export function disposeDoc(noteId: string): void {
  const doc = docCache.get(noteId);
  if (!doc) return;
  doc.destroy();
  docCache.delete(noteId);
}

/** Read the current content as a plain string. */
export function getText(doc: Y.Doc): string {
  return doc.getText(TEXT_FIELD).toString();
}

/**
 * Replace the doc's content with `content`. We compute and apply a minimal
 * diff (delete-all + insert-new) inside a single transaction so any
 * observers fire exactly once.
 *
 * For v1 we don't try to compute a granular character diff — the personal-
 * note save path overwrites in full on each save, and the shared-note path
 * (Yjs-native edits) goes through `Y.Text` ops directly. This helper is
 * mainly for "seed the doc from a plaintext snapshot" cases.
 */
export function setText(doc: Y.Doc, content: string): void {
  const text = doc.getText(TEXT_FIELD);
  doc.transact(() => {
    const len = text.length;
    if (len > 0) text.delete(0, len);
    if (content.length > 0) text.insert(0, content);
  });
}

/**
 * Subscribe to text changes on the doc. Fires `onChange(currentText)` after
 * each commit. Returns the unsubscribe closure.
 *
 * Integration point: future `bindMatrixCRDT` will also call `doc.on("update")`
 * to ship encoded updates to peers — that's the lower-level Yjs event,
 * orthogonal to this text-observer.
 */
export function observeText(
  doc: Y.Doc,
  onChange: (text: string) => void,
): () => void {
  const yText = doc.getText(TEXT_FIELD);
  const handler = () => onChange(yText.toString());
  yText.observe(handler);
  return () => yText.unobserve(handler);
}

/**
 * Encode the doc's state as a binary update for transport.
 *
 * Live-infra integration point — `bindMatrixCRDT(doc, transport, roomId)`
 * will call this on every local update and ship the bytes into a Matrix
 * room as a custom `aegis.scribe.update` event. The inverse path is
 * `Y.applyUpdate(doc, bytes)` on incoming bytes.
 */
export function encodeUpdate(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}
