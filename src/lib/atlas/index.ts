/**
 * Atlas — barrel exports for the Phase 4 encrypted live location feature.
 *
 * Layered surfaces (mirrors Herald):
 *   - types     — CircleMember, PositionFix, ReceivedFix, ShareSession.
 *   - geolocation — Promise wrapper around `navigator.geolocation` + the
 *                   friendly error enum.
 *   - circle-store / position-store — IndexedDB CRUD (browser-only).
 *   - share-service — interval-driven encrypt-and-broadcast loop.
 *   - bridge    — wires AegisTransport.subscribeDM to the position store.
 *   - hooks     — React-side state machinery for the page.
 *   - utility   — pubkey hex normalization helpers (parallel to Herald's).
 */

export type {
  CircleMember,
  GeolocationErrorKind,
  GeolocationPermissionState,
  LocationMessage,
  PositionFix,
  ReceivedFix,
  ShareSession,
} from "./types";
export { LOCATION_MESSAGE_TYPE } from "./types";

export {
  GeolocationFetchError,
  getCurrentPosition,
  queryPermission,
} from "./geolocation";

export { clearAll } from "./idb";

export {
  deleteMember,
  getMember,
  loadCircle,
  putMember,
} from "./circle-store";

export {
  appendFix,
  latestForMember,
  latestFixesByMember,
  listFixesForMember,
  MAX_POSITIONS_PER_MEMBER,
} from "./position-store";

export {
  createShareService,
  DEFAULT_SHARE_INTERVAL_MS,
} from "./share-service";
export type { ShareService, ShareServiceHooks, ShareServiceStart } from "./share-service";

export { attachLocationBridge, parseLocationDM } from "./transport-bridge";

export {
  describeGeolocationError,
  isValidPubkeyHex,
  normalizePubkey,
  truncatePubkey,
  useCircle,
  useIdentity,
  useLocationBridge,
  usePermissionState,
  useReceivedFixes,
  useShare,
  useTransport,
} from "./hooks";
export type { TransportStatus } from "./hooks";
