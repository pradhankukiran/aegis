/**
 * Beacon — type definitions for the Phase 5 dead-man's broadcast feature.
 *
 * A Beacon is a *pre-encoded* message that fires across all three Aegis
 * networks if the user fails to check in by `deadlineUnix`. The trigger
 * architecture is two-layered:
 *
 *   Layer A — client-side watchdog (fast path).
 *     While Aegis is open in any browser tab, a 60-second interval evaluates
 *     `shouldFire(beacon)` and, when true, publishes the cleartext
 *     `ReleasePayload` (CID + key + firedAt) on all three networks via the
 *     transport facade. Subscribers see the release immediately, decrypt the
 *     Pinata blob, and they're done.
 *
 *   Layer B — network-anchored deadline (slow path / unattended).
 *     At create time, the release event is also wrapped with `tlock-js`
 *     against the drand round at `deadline + grace`, then published to all
 *     three networks. After that round is signed by drand (~3s rounds on
 *     quicknet), any subscribing node can decrypt the release event without
 *     the user being online — no server, no cron, no Aegis instance has to
 *     stay up.
 *
 * Cancellation: before the deadline, the user can publish a signed
 * `aegis.beacon.cancelled` event. Subscribers observing the cancellation
 * MUST ignore any later (timelocked) release for the same beacon id.
 *
 * # Why store the key locally
 *
 * `unwrapKeyHex` is the symmetric XChaCha20-Poly1305 key for `payloadCid`.
 * Keeping it client-side lets the fast path publish the cleartext release
 * the instant the watchdog trips — no extra crypto work, no IDB round-trip
 * for the timelocked envelope. The slow path stamps the same key into a
 * tlock-encrypted envelope at create time, so the network-anchored release
 * carries the key explicitly. Either way, the key only escapes Aegis after
 * the deadline passes — same end-state, two reach mechanisms.
 *
 * # Status lifecycle
 *
 *   pending     → freshly created; deadline is in the future.
 *   checked-in  → user pressed "I'm alive"; deadline has been bumped
 *                 forward. (Visually distinct from `pending` for one render
 *                 cycle so the UI can flash a confirmation; from the
 *                 watchdog's POV `checked-in` is effectively `pending`.)
 *   fired       → release events have been published (by us or by an
 *                 observer noticing the timelocked release unlocked).
 *   cancelled   → user cancelled before the deadline.
 *   expired     → terminal grace exceeded without firing. v1 doesn't write
 *                 this state automatically; the type is included so future
 *                 cleanup flows can mark abandoned beacons without a schema
 *                 migration.
 */

/** Status flow: pending → checked-in → pending → fired/cancelled/expired. */
export type BeaconStatus =
  | "pending"
  | "checked-in"
  | "fired"
  | "cancelled"
  | "expired";

/**
 * Locally-persisted beacon row.
 *
 *  - `id`                          uuid v4. Primary key in IndexedDB and the
 *                                  stable identifier carried in every
 *                                  release/cancellation event.
 *  - `title`                       free-form plaintext label for the UI.
 *                                  Not encrypted — the user wants to see
 *                                  what each pending beacon is.
 *  - `payloadCid`                  Pinata CID of the XChaCha20-Poly1305
 *                                  ciphertext.
 *  - `unwrapKeyHex`                hex (64 chars) of the 32-byte symmetric
 *                                  key. Stays local until the release fires.
 *  - `deadlineUnix`                Unix seconds. Past this, the watchdog
 *                                  fires; past `deadline + grace`, the
 *                                  timelocked release unlocks too.
 *  - `graceSeconds`                seconds added to `deadlineUnix` to project
 *                                  the drand round. Default 3600 (1h).
 *  - `drandRound`                  the drand round computed at create time
 *                                  from `deadline + grace`. The timelocked
 *                                  release decrypts when this round is signed.
 *  - `checkinIntervalSeconds`      how far forward to bump the deadline on
 *                                  check-in. Defaults to the original
 *                                  `deadline - createdAt/1000` so each
 *                                  check-in renews the same window.
 *  - `timelockedReleasesPublished` set to true after we successfully
 *                                  publish the timelock-encrypted release
 *                                  events on at least one network. Used by
 *                                  the UI to warn "Layer B not anchored
 *                                  yet" if Pinata-or-transport failed.
 *  - `status`                      see BeaconStatus.
 *  - `lastCheckinUnix`             Unix seconds of the most recent check-in,
 *                                  or 0 if the beacon has never been
 *                                  checked in.
 *  - `createdAt`                   Unix seconds at creation.
 */
export type Beacon = {
  id: string;
  title: string;
  payloadCid: string;
  unwrapKeyHex: string;
  deadlineUnix: number;
  graceSeconds: number;
  drandRound: number;
  checkinIntervalSeconds: number;
  timelockedReleasesPublished: boolean;
  status: BeaconStatus;
  lastCheckinUnix: number;
  createdAt: number;
};

/**
 * The cleartext release payload broadcast across every network when a beacon
 * fires (either via watchdog or via the timelock auto-unlock).
 *
 *  - `beaconId`     uuid; matches the Beacon row id so observers can
 *                   deduplicate against earlier cancellations.
 *  - `payloadCid`   Pinata CID of the encrypted message.
 *  - `unwrapKeyHex` hex of the symmetric key. Observers fetch the CID,
 *                   decrypt with this key + AAD, and they have the
 *                   plaintext.
 *  - `firedAt`      Unix seconds when the watchdog tripped (or when the
 *                   timelock release was authored — both code paths stamp
 *                   the same field).
 */
export type ReleasePayload = {
  beaconId: string;
  payloadCid: string;
  unwrapKeyHex: string;
  firedAt: number;
};

/**
 * The Schnorr-signed cancellation payload. `sigHex` is the BIP-340 (x-only)
 * signature over `sha256(canonicalize({beaconId, ts}))`. `signerHex` is the
 * 32-byte x-only pubkey of the user who created the beacon. Observers verify
 * the signature before honouring a cancellation — without that gate, anyone
 * could silence anyone else's beacon by publishing a forged event.
 */
export type CancellationPayload = {
  beaconId: string;
  ts: number;
  sigHex: string;
  signerHex: string;
};

/**
 * Input shape for `useCreateBeacon`. Plaintext lives in this struct only until
 * the create flow seals it into the envelope.
 *
 *  - `title`                  plaintext label shown in the UI list.
 *  - `message`                the plaintext body to seal in the envelope.
 *  - `deadlineUnix`           Unix seconds the watchdog tests against.
 *  - `graceSeconds`           seconds added to `deadlineUnix` to compute
 *                             the drand round. Defaults to 3600 if omitted.
 *  - `checkinIntervalSeconds` how far to bump the deadline on each
 *                             check-in. Defaults to `deadline - now`.
 */
export type NewBeaconInput = {
  title: string;
  message: string;
  deadlineUnix: number;
  graceSeconds?: number;
  checkinIntervalSeconds?: number;
};

/** Aegis event type for cleartext release broadcasts. */
export const BEACON_FIRED_TYPE = "aegis.beacon.fired";

/** Aegis event type for signed cancellations. */
export const BEACON_CANCELLED_TYPE = "aegis.beacon.cancelled";

/**
 * Aegis event type carrying the timelock-encrypted release envelope. The
 * `content` for these events is the age-armored string returned by
 * `tlock-js#timelockEncrypt`.
 */
export const BEACON_TIMELOCKED_RELEASE_TYPE = "aegis.beacon.timelocked-release";
