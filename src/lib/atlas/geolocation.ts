/**
 * Atlas — thin wrappers around the browser Geolocation + Permissions APIs.
 *
 * Two surfaces:
 *
 *   - `getCurrentPosition()` — Promise-based replacement for the
 *     callback-flavoured `navigator.geolocation.getCurrentPosition`. Errors
 *     are mapped to a friendly {@link GeolocationErrorKind} enum so the UI
 *     can show stable copy without poking at native error codes.
 *
 *   - `queryPermission()` — best-effort probe of the current geolocation
 *     permission state. Falls back to `"prompt"` (or `"unknown"`) on
 *     browsers that don't implement Permissions.query — Safari and older
 *     Firefox notably don't expose the geolocation name reliably.
 *
 * Both functions are browser-only; on the server they reject with the
 * `"unsupported"` enum / return `"unknown"` so the SSR pass never touches the
 * native API.
 */

import type { GeolocationErrorKind, GeolocationPermissionState, PositionFix } from "./types";

/** Custom error class with a categorical `kind` for stable UI copy. */
export class GeolocationFetchError extends Error {
  readonly kind: GeolocationErrorKind;
  constructor(kind: GeolocationErrorKind, message: string) {
    super(message);
    this.name = "GeolocationFetchError";
    this.kind = kind;
  }
}

/**
 * Defaults for `getCurrentPosition`. `maximumAge: 0` forces a fresh sample
 * each tick — we don't want the browser handing back the same minute-old fix
 * to every circle member. `timeout: 15s` is the worst-case GPS warm-up
 * window on a cold-started device; if the browser hasn't returned by then we
 * surface a `"timeout"` and let the caller skip this tick.
 *
 * `enableHighAccuracy` defaults to `false`: better battery, and accuracy
 * within ~100m is plenty for "where is my friend right now" v1.
 */
const DEFAULT_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 0,
  timeout: 15_000,
};

/**
 * Resolve to a single PositionFix or reject with a {@link GeolocationFetchError}.
 *
 * Maps native Geolocation error codes:
 *   - 1 / PERMISSION_DENIED  → "permission-denied"
 *   - 2 / POSITION_UNAVAILABLE → "unavailable"
 *   - 3 / TIMEOUT            → "timeout"
 *   - missing API            → "unsupported"
 */
export function getCurrentPosition(
  options?: PositionOptions,
): Promise<PositionFix> {
  return new Promise<PositionFix>((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(
        new GeolocationFetchError(
          "unsupported",
          "Geolocation API is not available in this environment.",
        ),
      );
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // `pos.timestamp` is browser-supplied wall-clock ms — ideal because
        // the fix is timestamped at fetch time, not at marshalling time.
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          ts: pos.timestamp,
        });
      },
      (err) => {
        reject(mapPositionError(err));
      },
      { ...DEFAULT_OPTIONS, ...(options ?? {}) },
    );
  });
}

/**
 * Map the native `GeolocationPositionError` to our friendly enum. Code
 * constants are hardcoded (1/2/3) so we don't rely on the prototype's
 * class-level fields being present in tests.
 */
function mapPositionError(err: GeolocationPositionError): GeolocationFetchError {
  switch (err.code) {
    case 1:
      return new GeolocationFetchError(
        "permission-denied",
        "Geolocation permission was denied.",
      );
    case 2:
      return new GeolocationFetchError(
        "unavailable",
        "Geolocation is currently unavailable.",
      );
    case 3:
      return new GeolocationFetchError(
        "timeout",
        "Geolocation request timed out.",
      );
    default:
      return new GeolocationFetchError(
        "unavailable",
        err.message || "Geolocation failed.",
      );
  }
}

/**
 * Best-effort query of the current geolocation permission state.
 *
 * Browsers fall into three buckets:
 *   - Full Permissions API support → returns "granted" / "denied" / "prompt".
 *   - Permissions API present but no "geolocation" name → returns "unknown".
 *   - No Permissions API at all → returns "unknown".
 *
 * On the server returns "unknown" without touching any native API.
 */
export async function queryPermission(): Promise<GeolocationPermissionState> {
  if (typeof navigator === "undefined") return "unknown";
  const perms = (navigator as { permissions?: Permissions }).permissions;
  if (!perms || typeof perms.query !== "function") return "unknown";
  try {
    const status = await perms.query({ name: "geolocation" as PermissionName });
    switch (status.state) {
      case "granted":
      case "denied":
      case "prompt":
        return status.state;
      default:
        return "unknown";
    }
  } catch {
    // Some browsers reject when given "geolocation" as the descriptor name.
    return "unknown";
  }
}
