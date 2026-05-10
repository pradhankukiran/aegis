import "server-only";

import { PinataSDK } from "pinata";

/**
 * Server-side Pinata client for Aegis.
 *
 * IMPORTANT: this module must NEVER be imported from a Client Component.
 * The `import "server-only"` at the top will surface that as a build error.
 *
 * The browser uploads ciphertext directly to Pinata via short-lived signed
 * URLs minted here; the JWT never leaves the server.
 *
 * Used by Beacon (dead-man's broadcast) and Crucible (whistleblower drop)
 * for encrypted-blob persistence that survives device loss and spans
 * newsroom devices.
 */

let cached: PinataSDK | null = null;

/**
 * Whether Pinata is configured on this deployment. Callers (API routes)
 * should check this and return 503 when false rather than throwing.
 */
export function isPinataConfigured(): boolean {
  return typeof process.env.PINATA_JWT === "string" && process.env.PINATA_JWT.length > 0;
}

export function getPinata(): PinataSDK {
  if (cached) return cached;

  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    // API routes should call isPinataConfigured() first and 503; this throw
    // is a defensive guard for direct callers.
    throw new Error("PINATA_JWT is not set");
  }

  // The gateway env var is optional on the server — uploads work without it.
  // The browser uses NEXT_PUBLIC_PINATA_GATEWAY for retrieval; the server
  // mirrors that here if present so `publicGatewayUrl` can construct URLs.
  const gateway = process.env.PINATA_GATEWAY ?? process.env.NEXT_PUBLIC_PINATA_GATEWAY;

  cached = new PinataSDK({
    pinataJwt: jwt,
    pinataGateway: gateway ?? "",
  });
  return cached;
}

/**
 * Public IPFS gateway URL for a given CID, constructed from the server-side
 * `PINATA_GATEWAY` (or `NEXT_PUBLIC_PINATA_GATEWAY` as a fallback).
 *
 * The retrieved bytes are still ciphertext — the gateway sees only encrypted
 * data — so a public-gateway URL is fine for sharing.
 */
export function publicGatewayUrl(cid: string): string {
  const gateway = process.env.PINATA_GATEWAY ?? process.env.NEXT_PUBLIC_PINATA_GATEWAY;
  if (!gateway) {
    throw new Error(
      "PINATA_GATEWAY (or NEXT_PUBLIC_PINATA_GATEWAY) is not set",
    );
  }
  const host = gateway.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${host}/ipfs/${cid}`;
}
