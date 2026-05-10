/**
 * Herald — barrel exports for the Phase 3 real-time chat feature.
 *
 * Layered surfaces:
 *   - types       — Conversation, Message, MessageStatus.
 *   - store       — IndexedDB CRUD primitives (browser-only).
 *   - bridge      — wires AegisTransport.subscribe to the store.
 *   - hooks       — React-side state machinery for the page.
 *   - utility     — pubkey hex normalization / truncation helpers.
 */

export type { Conversation, Message, MessageStatus } from "./types";

export {
  appendMessage,
  clearAll,
  getConversation,
  loadConversations,
  loadMessages,
  saveConversation,
  updateMessageStatus,
} from "./store";

export { attachIncomingBridge, projectIncoming } from "./transport-bridge";

export {
  isValidPubkeyHex,
  normalizePubkey,
  truncatePubkey,
  useConversations,
  useIdentity,
  useIncomingBridge,
  useMessages,
  useSendMessage,
  useTransport,
} from "./hooks";
export type { TransportStatus } from "./hooks";
