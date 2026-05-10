/**
 * Witness — barrel exports for the Phase 4 multi-network notary feature.
 *
 * Layered surfaces:
 *   - types       — Anchor, AnchorRecord, Verification.
 *   - hash        — File → SHA-256 hex.
 *   - anchor      — Sign + publish primitives.
 *   - verify      — Signature + cross-network presence check.
 *   - storage     — IndexedDB CRUD for AnchorRecord.
 *   - hooks       — React state machinery for the page.
 */

export type {
  Anchor,
  AnchorNetworkResult,
  AnchorRecord,
  NetworkVerification,
  Verification,
} from "./types";
export { WITNESS_EVENT_TYPE } from "./types";

export { RECOMMENDED_MAX_FILE_BYTES, hashBytes, hashFile } from "./hash";

export {
  anchorDigest,
  isValidHash,
  normalizeHash,
  publishAnchor,
  signAnchor,
  signerHexFromIdentity,
  sigBytesFromHex,
  signerBytesFromHex,
  witnessNostrDTag,
} from "./anchor";

export { VERIFY_TIMEOUT_MS, verifyAnchor, verifySignature } from "./verify";

export {
  clearAllAnchors,
  deleteAnchor,
  getAnchor,
  loadAnchors,
  saveAnchor,
} from "./storage";

export { useAnchorFile, useAnchorHistory, useVerify } from "./hooks";
