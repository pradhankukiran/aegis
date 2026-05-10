/**
 * Beacon — barrel exports for the Phase 5 dead-man's broadcast feature.
 *
 * Layered surfaces:
 *   - types        — Beacon, BeaconStatus, ReleasePayload, CancellationPayload,
 *                    NewBeaconInput, and the event-type constants.
 *   - envelope     — encryptPayload / decryptPayload (AAD `aegis:beacon:v=1`).
 *   - pinata-blob  — uploadBeaconCiphertext / fetchBeaconCiphertext.
 *   - storage      — IndexedDB CRUD primitives (browser-only).
 *   - trigger      — `shouldFire` (pure predicate).
 *   - fire         — fast-path release publisher.
 *   - cancel       — sign/verify/publish cancellation events.
 *   - timelock     — slow-path tlock-encrypted release publisher.
 *   - watchdog     — interval-driven evaluator.
 *   - bridge       — observe inbound fire/cancel events for our own beacons.
 *   - hooks        — React-side state machinery for the page.
 */

export type {
  Beacon,
  BeaconStatus,
  CancellationPayload,
  NewBeaconInput,
  ReleasePayload,
} from "./types";
export {
  BEACON_CANCELLED_TYPE,
  BEACON_FIRED_TYPE,
  BEACON_TIMELOCKED_RELEASE_TYPE,
} from "./types";

export {
  BEACON_AAD,
  BEACON_KEY_HEX_LENGTH,
  decryptPayload,
  encryptPayload,
} from "./envelope";

export {
  PinataGatewayNotConfiguredError,
  PinataNotConfiguredError,
  fetchBeaconCiphertext,
  uploadBeaconCiphertext,
  type UploadResult,
} from "./pinata-blob";

export {
  clearAllBeacons,
  deleteBeacon,
  loadBeacon,
  loadBeacons,
  saveBeacon,
} from "./storage";

export { shouldFire } from "./trigger-check";

export { buildReleasePayload, fireBeacon } from "./fire";

export {
  cancelBeacon,
  cancellationDigest,
  signCancellation,
  signerHexFromIdentity,
  verifyCancellation,
} from "./cancel";

export {
  buildTimelockedReleaseEnvelope,
  buildTimelockedReleasePayload,
  publishTimelockedRelease,
} from "./timelock-release";

export {
  DEFAULT_WATCHDOG_INTERVAL_MS,
  runTick,
  startWatchdog,
} from "./watchdog";

export {
  attachBeaconBridge,
  projectCancellationPayload,
  projectReleasePayload,
} from "./transport-bridge";

export {
  DEFAULT_GRACE_SECONDS,
  formatCountdown,
  formatTimestamp,
  mintBeaconId,
  secondsUntilDeadline,
  useBeacons,
  useCancelBeacon,
  useCheckin,
  useCreateBeacon,
  useDeleteBeacon,
  useFireBeacon,
  useWatchdog,
} from "./hooks";
