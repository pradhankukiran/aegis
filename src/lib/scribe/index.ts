/**
 * Scribe — barrel exports for the Phase 4 encrypted-notes feature.
 *
 * Layered surfaces:
 *   - types       — Note, NoteDraft.
 *   - envelope    — wrap/unwrap helpers + Scribe master-key derivation.
 *   - storage     — IndexedDB CRUD primitives (browser-only).
 *   - persistence — Pinata mirror for the encrypted envelope (+ CID load).
 *   - feed        — save/delete-marker hooks (no-op post-SSB; reserved
 *                   for the future feed channel).
 *   - crdt        — Y.js doc factory + Matrix sync attachment.
 *   - bridge      — incoming share-invite listener.
 *   - hooks       — React-side state machinery for the page.
 */

export type { Note, NoteDraft } from "./types";

export {
  SCRIBE_AAD,
  deriveMasterKey,
  unwrapNoteContent,
  wrapNoteContent,
} from "./envelope";

export {
  clearAll,
  deleteNote,
  loadActiveNotes,
  loadNote,
  loadNotes,
  purgeDeletedNotes,
  saveNote,
} from "./storage";

export { loadNoteByCid, persistNote } from "./persistence";
export type { PersistResult } from "./persistence";

export {
  SCRIBE_DELETED_TYPE,
  SCRIBE_SAVED_TYPE,
  publishDeleteMarker,
  publishSaveMarker,
} from "./feed";

export {
  SCRIBE_MATRIX_MSGTYPE,
  SCRIBE_MATRIX_ORIGIN,
  attachMatrixSync,
  disposeDoc,
  encodeUpdate,
  getDoc,
  getText,
  observeText,
  setText,
} from "./crdt";

export {
  SCRIBE_SHARE_INVITE_TYPE,
  attachShareInviteBridge,
  projectInvite,
} from "./transport-bridge";
export type { ScribeShareInvite } from "./transport-bridge";

export {
  deriveTitleFromContent,
  formatRelative,
  mintNoteId,
  useCreateNote,
  useDeleteNote,
  useNote,
  useNotes,
  useShareNote,
  useSharedNoteSync,
} from "./hooks";
