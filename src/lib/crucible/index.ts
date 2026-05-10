/**
 * Crucible — barrel exports for the Phase 5 anonymous whistleblower drop
 * feature (plan §3.5).
 *
 * Layered surfaces:
 *
 *   - types       — CruciblePointer, CrucibleDrop, DecryptedDrop, AAD constant.
 *   - ephemeral   — one-shot in-memory keypair generation + seckey wipe.
 *   - ecdh        — ECDH + HKDF-SHA256 CEK derivation (info: "aegis-crucible-ecdh-v1").
 *   - envelope    — XChaCha20-Poly1305 envelope over the packed (text + files) payload.
 *   - submit      — source-side full pipeline (ephemeral → ECDH → encrypt → Pinata → publish).
 *   - receive     — newsroom-side subscribe + decrypt wrapper.
 *   - store       — IndexedDB persistence for newsroom-side DECRYPTED drops.
 *   - transport-bridge — wires AegisTransport.subscribe to the store.
 *   - hooks       — React state machinery for both surfaces.
 */

export type {
  CruciblePointer,
  CrucibleDrop,
  DecryptedDrop,
  DecryptedAttachment,
} from "./types";
export { CRUCIBLE_EVENT_TYPE } from "./types";

export {
  EPHEMERAL_PUBKEY_BYTES,
  EPHEMERAL_SECKEY_BYTES,
  generateEphemeralIdentity,
  wipeEphemeralSeckey,
} from "./ephemeral";
export type { EphemeralIdentity } from "./ephemeral";

export {
  CRUCIBLE_CEK_BYTES,
  CRUCIBLE_KDF_INFO,
  deriveSharedKey,
  normalizePeerPubkey,
  peerPubkeyBytesFromHex,
} from "./ecdh";

export {
  CRUCIBLE_AAD,
  CRUCIBLE_MAX_ATTACHMENT_BYTES,
  decryptDrop,
  encryptDrop,
  packPayload,
  unpackPayload,
} from "./envelope";
export type { EnvelopeAttachment } from "./envelope";

export {
  CrucibleAttachmentTooLargeError,
  PinataNotConfiguredError,
  describeSubmitError,
  dropIdFromPointer,
  submitDrop,
} from "./submit";
export type { SubmitResult } from "./submit";

export { createDropReceiver } from "./receive";

export {
  clearAllDrops,
  deleteDrop,
  getDrop,
  loadDrops,
  markDropRead,
  saveDrop,
} from "./store";

export {
  attachNewsroomBridge,
  parseCruciblePointer,
} from "./transport-bridge";

export {
  isOnTor,
  isValidPubkeyHex,
  normalizePubkeyInput,
  truncatePubkey,
  useDropReceiver,
  useDrops,
  useIdentity,
  useSubmitDrop,
  useTorIndicator,
  useTransport,
} from "./hooks";
export type { TransportStatus } from "./hooks";
