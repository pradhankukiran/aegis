/**
 * Browser-side fetch helpers for retrieving ciphertext by CID.
 *
 * Uses the configured Pinata gateway as the primary source because public
 * IPFS gateways like ipfs.io often rate-limit or strip CORS. The retrieved
 * bytes are ciphertext — the gateway sees only encrypted data — so a public
 * gateway URL is fine for sharing.
 */

const FALLBACK_GATEWAYS = [
  "https://ipfs.io/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
  "https://dweb.link/ipfs",
];

/**
 * Thrown when no gateway is configured and the caller asks for the primary
 * (configured) URL. The fallback helper does NOT throw — it returns the
 * public gateway list unconditionally.
 */
export class PinataGatewayNotConfiguredError extends Error {
  override readonly name = "PinataGatewayNotConfiguredError";
  constructor(
    message = "NEXT_PUBLIC_PINATA_GATEWAY env var is not set",
  ) {
    super(message);
  }
}

/**
 * Construct the configured gateway URL for a CID.
 *
 * @throws {PinataGatewayNotConfiguredError} if `NEXT_PUBLIC_PINATA_GATEWAY`
 *   is missing. Callers that want a guaranteed URL even without
 *   configuration should use `fallbackGatewayUrls` directly.
 */
export function gatewayUrl(cid: string): string {
  const configured = process.env.NEXT_PUBLIC_PINATA_GATEWAY;
  if (!configured) {
    throw new PinataGatewayNotConfiguredError();
  }
  const host = configured.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${host}/ipfs/${cid}`;
}

/**
 * Public IPFS gateways usable as fallbacks. Always returns a non-empty
 * list — never throws.
 */
export function fallbackGatewayUrls(cid: string): string[] {
  return FALLBACK_GATEWAYS.map((g) => `${g}/${cid}`);
}

/**
 * Fetch a CID's bytes via the configured Pinata gateway.
 *
 * The bytes are expected to be ciphertext (Aegis only uploads encrypted
 * blobs); decryption happens in feature code.
 *
 * @throws {PinataGatewayNotConfiguredError} if `NEXT_PUBLIC_PINATA_GATEWAY`
 *   is missing.
 * @throws {Error} if the gateway returns a non-2xx response.
 */
export async function fetchCiphertext(cid: string): Promise<Uint8Array> {
  const url = gatewayUrl(cid); // throws if gateway not configured
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchCiphertext: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
