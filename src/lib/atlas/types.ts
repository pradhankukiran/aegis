/**
 * Atlas — type definitions for the Phase 4 encrypted live location sharing
 * feature (plan §3.3).
 *
 * Each user maintains a small "circle" of trusted peer pubkeys. While a share
 * session is active, the user's browser fetches its geolocation on a fixed
 * interval and pushes a per-recipient encrypted DM to every circle member via
 * `AegisTransport.directMessage`. Incoming aegis.location DMs from other peers
 * are appended to a bounded per-peer position log and shown as live markers.
 *
 * Pubkey canonicalization mirrors Herald: the user pastes any 64-char x-only
 * or 66-char SEC1-compressed hex, we strip the parity byte at the input
 * boundary, and every downstream surface (IDB key, marker key, DM target)
 * sees a single canonical lowercase 64-char x-only form.
 */

/**
 * A trusted peer in the circle. Pubkey is the canonical 64-char lowercase
 * x-only hex. Nickname is a free-form display string. addedAt is the local
 * insertion timestamp (Unix ms) for sort stability.
 */
export type CircleMember = {
  pubkey: string;
  nickname?: string;
  addedAt: number;
};

/**
 * A single geolocation sample. `lat` and `lon` are WGS-84 decimal degrees,
 * `accuracy` is in meters (browser-supplied 1-sigma radius), `ts` is Unix ms.
 *
 * We deliberately drop the rest of the GeolocationCoordinates fields
 * (altitude, heading, speed) — none are well-supported across browsers and
 * none move the v1 needle.
 */
export type PositionFix = {
  lat: number;
  lon: number;
  accuracy: number;
  ts: number;
};

/**
 * A position fix received from a circle member. `from` is the sender's
 * canonical pubkey in whatever form the origin transport surfaced (Nostr →
 * 64-char x-only hex; Matrix MXID / SSB feed id for those origins — same
 * caveat as Herald's `from` canonicalization).
 */
export type ReceivedFix = PositionFix & { from: string };

/**
 * Live share session state. `active` flips on/off via the ShareToggle. While
 * active, a `setInterval` is running and pushes one DM per tick to each
 * circle member.
 */
export type ShareSession = {
  active: boolean;
  startedAt?: number;
  intervalMs: number;
};

/** Friendly enum for geolocation failure modes (see `geolocation.ts`). */
export type GeolocationErrorKind =
  | "permission-denied"
  | "unavailable"
  | "timeout"
  | "unsupported";

/** Permission state proxy for `navigator.permissions.query({name: "geolocation"})`. */
export type GeolocationPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "unknown";

/**
 * Wire envelope embedded inside the directMessage plaintext. We use a
 * stable shape so multiple Aegis features can share `subscribeDM` without
 * stepping on each other — the bridge skips anything whose `type` does not
 * match.
 */
export const LOCATION_MESSAGE_TYPE = "aegis.location" as const;

export type LocationMessage = {
  type: typeof LOCATION_MESSAGE_TYPE;
  fix: PositionFix;
};
