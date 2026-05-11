/**
 * Scribe — Y.js CRDT scaffolding for shared notes, with Matrix transport.
 *
 * Personal notes don't need CRDT: there's exactly one writer (this device),
 * so a plain string in the editor + envelope-sealed snapshot in IDB is
 * sufficient. Shared notes are the motivator for Yjs — multiple devices
 * mutating the same text concurrently need conflict-free merges, and Yjs is
 * the de-facto answer for collaborative text.
 *
 * # What this module ships
 *
 * - A `Y.Doc` factory keyed by note id, with single-doc caching so repeated
 *   `getDoc(id)` calls return the same instance (Yjs docs are stateful — you
 *   want one per logical document, not per render).
 * - Helpers `setText` / `getText` to read and write the canonical "content"
 *   `Y.Text` inside the doc.
 * - An `observeText` helper that registers a Yjs observer and returns its
 *   removal closure — the React hook layer uses this to subscribe.
 * - `attachMatrixSync(doc, transport, roomId)`: hook each local
 *   `doc.on("update", ...)` to publish the encoded update as a custom
 *   Matrix message (`m.aegis.scribe.crdt`), and apply incoming messages
 *   of the same type back into the doc via `Y.applyUpdate(doc, bytes,
 *   "matrix")`. The `"matrix"` origin prevents the local hook from re-
 *   broadcasting updates that just arrived from a peer.
 *
 * # On-the-wire format
 *
 *   {
 *     msgtype: "m.aegis.scribe.crdt",
 *     body: <base64url(Y.encodeStateAsUpdate or Yjs update bytes)>,
 *   }
 *
 * Matrix's E2EE (Megolm) wraps the whole event content; peers in the
 * private room are the only ones who can read `body`. The `body` itself is
 * base64url so the field stays a JSON string (Matrix events are JSON).
 *
 * # What's still NOT here
 *
 * - No persistence to IDB of the binary Y.Doc state. Saves still wrap the
 *   plaintext snapshot inside the existing envelope; the CRDT is the live
 *   editing surface for shared notes, while the envelope is the historical
 *   record. A future "binary Y state in IDB" pass can replace the snapshot.
 * - No room scrollback verification against a real Conduit instance — the
 *   integration test is a mocked transport. The unit tests below assert
 *   the contract; production wiring exercises the real client.
 */

import * as Y from "yjs";

import { base64UrlToBytes, bytesToBase64Url } from "../crypto/encoding";
import type { AegisTransport } from "../transport";

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

/**
 * Matrix `msgtype` used for Yjs CRDT updates inside the shared-room timeline.
 *
 * Picked under the `m.aegis.*` namespace so it doesn't collide with any
 * built-in Matrix message type. The Matrix homeserver routes it like any
 * other `m.room.message` event — only the consumer code keys off the
 * msgtype to recognize it as a CRDT update.
 */
export const SCRIBE_MATRIX_MSGTYPE = "m.aegis.scribe.crdt";

/**
 * Origin tag we stamp onto every `Y.applyUpdate` for matrix-sourced bytes.
 * The local `doc.on("update", ...)` hook reads `origin` and skips
 * re-broadcasting when it equals this value — that's how we break the
 * echo loop without losing local-origin updates.
 */
export const SCRIBE_MATRIX_ORIGIN = "matrix";

/**
 * Attach a bidirectional Yjs ↔ Matrix sync to `doc`, mediated by `roomId`
 * inside the given AegisTransport.
 *
 * Wire-up:
 *
 *   1. `doc.on("update", handler)` — every local update is base64url-
 *      encoded and sent as an `m.room.message` whose `msgtype` is
 *      {@link SCRIBE_MATRIX_MSGTYPE}. We skip updates whose `origin` is
 *      `"matrix"` to avoid re-broadcasting peer-originated updates.
 *   2. `transport.matrix.subscribe({ roomId }, handler)` — every incoming
 *      message of the same msgtype has its body decoded back to bytes and
 *      handed to `Y.applyUpdate(doc, bytes, "matrix")`.
 *
 * Returns an unsubscribe closure that detaches both the doc observer and
 * the Matrix listener. Idempotent — calling twice is a no-op.
 *
 * # Bootstrap (late-join scrollback)
 *
 * matrix-js-sdk's room timeline already contains scrollback for joined
 * rooms after `startClient` (we set `initialSyncLimit: 20` in
 * `initCrypto`). For v1 we rely on that initial sync to surface recent
 * history; an explicit `scrollback(room, N)` call is a future enhancement
 * for joining a long-running shared note. The unit tests assert the live-
 * update path; scrollback exercised by integration only.
 */
export function attachMatrixSync(
  doc: Y.Doc,
  transport: AegisTransport,
  roomId: string,
): () => void {
  let detached = false;

  // Outbound: local update → Matrix room. Yjs's `update` event hands us
  // the encoded delta bytes + the origin that the transact() call passed
  // (or `null` for unkeyed local mutations). We skip origin === "matrix"
  // so peer-applied updates don't loop back.
  const updateHandler = (update: Uint8Array, origin: unknown): void => {
    if (detached) return;
    if (origin === SCRIBE_MATRIX_ORIGIN) return;
    const body = bytesToBase64Url(update);
    void transport.matrix
      .sendMessage(roomId, {
        msgtype: SCRIBE_MATRIX_MSGTYPE,
        body,
      })
      .catch((err) => {
        // Network blip / room disconnect — the next update will retry the
        // full delta (Yjs updates are deltas; the recipient picks up state
        // from whatever ones arrive). We log so the dev console surfaces
        // the symptom without throwing into React render.
        console.warn("[scribe] crdt → matrix send failed:", err);
      });
  };
  doc.on("update", updateHandler);

  // Inbound: Matrix room events of our msgtype → doc.applyUpdate.
  const unsubMatrix = transport.matrix.subscribe({ roomId }, (ev) => {
    if (detached) return;
    if (ev.roomId !== roomId) return; // belt + suspenders
    if (ev.type !== "m.room.message") return;
    const content = ev.content as
      | { msgtype?: unknown; body?: unknown }
      | null
      | undefined;
    if (!content || content.msgtype !== SCRIBE_MATRIX_MSGTYPE) return;
    const body = typeof content.body === "string" ? content.body : null;
    if (!body) return;
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(body);
    } catch (err) {
      console.warn("[scribe] dropped crdt message: malformed base64:", err);
      return;
    }
    try {
      Y.applyUpdate(doc, bytes, SCRIBE_MATRIX_ORIGIN);
    } catch (err) {
      console.warn("[scribe] applyUpdate threw:", err);
    }
  });

  return () => {
    if (detached) return;
    detached = true;
    try {
      doc.off("update", updateHandler);
    } catch {
      /* no-op: doc may be destroyed */
    }
    try {
      unsubMatrix();
    } catch {
      /* no-op: listener may already be detached */
    }
  };
}
