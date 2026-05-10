/**
 * Beacon — Pinata wrapper.
 *
 * Thin pass-through over `lib/pinata`. The reason to have a feature-local
 * wrapper instead of importing the upload helper directly is consistency
 * with Witness/Scribe/Crucible, where each feature's outbound IO lives in
 * a one-liner module. Lets us refactor the upload path later (e.g. add
 * Lighthouse as a second pin provider — `aegis-plan.md §5`) without
 * touching feature-level code.
 *
 * Both helpers surface the same error types as the underlying Pinata
 * module:
 *   - `PinataNotConfiguredError` — server lacks `PINATA_JWT`. The create
 *     flow must catch this and refuse to save a half-built beacon locally
 *     (the release path requires a CID).
 *   - `PinataGatewayNotConfiguredError` — `NEXT_PUBLIC_PINATA_GATEWAY` is
 *     missing on the browser side. Observers (who fetch the released CID)
 *     will hit this if they're on a poorly-configured deployment; the
 *     fallback gateway list in `lib/pinata/fetch.ts` is a manual escape
 *     hatch they can use directly.
 */

import {
  PinataNotConfiguredError,
  PinataGatewayNotConfiguredError,
  fetchCiphertext,
  uploadCiphertext,
  type UploadResult,
} from "../pinata";

/**
 * Upload a sealed Beacon ciphertext to Pinata. Filename is informational —
 * the bytes are opaque to the IPFS gateway either way.
 */
export async function uploadBeaconCiphertext(
  ciphertext: Uint8Array,
): Promise<UploadResult> {
  return uploadCiphertext(ciphertext, "beacon.bin");
}

/**
 * Fetch a Beacon ciphertext blob by CID. The caller decrypts via
 * `envelope.decryptPayload`. Re-exported here so feature code never has to
 * pull from `lib/pinata` directly.
 */
export async function fetchBeaconCiphertext(cid: string): Promise<Uint8Array> {
  return fetchCiphertext(cid);
}

export { PinataNotConfiguredError, PinataGatewayNotConfiguredError };
export type { UploadResult };
